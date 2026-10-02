// Chrome Bridge 鉴权协议 (v3) — 扩展与连接器共用这一份实现, 只依赖 WebCrypto
// (浏览器与 Node 都有 globalThis.crypto.subtle).
//
// 身份: 连接器每次启动在内存里生成一把 P-256 签名密钥 (= 一个智能体会话),
//       扩展有一把持久、不可导出的签名密钥.
// 握手 (SIGMA 结构):
//   C → E  hello  { sC, eC, info }             sC 静态签名公钥, eC 临时 ECDH 公钥
//   E → C  auth   { sE, eE, sig_E(th) }        th = H(所有公钥)
//   C → E  auth   { sig_C(th) }
//   会话密钥 = HKDF(ECDH(eC, eE), th), 两个方向各一把 AES-GCM 密钥.
//   中间人即使原样转发握手, 也算不出 ECDH 共享密钥; 换掉临时公钥, 签名就对不上 th.
// 之后每帧加密, 明文带递增序号, 防篡改、防重放、防反射.
// 配对: 双方互不信任对方公钥时, 用户把连接器显示的 8 位码输进扩展.
//   K = PBKDF2(码, salt = sC), 证明 = HMAC(K, 角色 ‖ th), 绑定到这条加密通道.
//   码有 40 bit 熵且过 PBKDF2, 截获证明也无法离线穷举; 连接器端限制错误次数.

export const PROTOCOL = 3;
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32
const PBKDF2_ITERATIONS = 300000;
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

const SIGN = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN_ALG = { name: 'ECDSA', hash: 'SHA-256' };
const DH = { name: 'ECDH', namedCurve: 'P-256' };

// ---------- 编码 ----------

export function b64(buf) {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

export function unb64(s) {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

function concat(...parts) {
  const bufs = parts.map((p) => (typeof p === 'string' ? enc.encode(p) : new Uint8Array(p)));
  const out = new Uint8Array(bufs.reduce((n, b) => n + 4 + b.length, 0));
  let o = 0;
  for (const b of bufs) {
    new DataView(out.buffer).setUint32(o, b.length);
    out.set(b, o + 4);
    o += 4 + b.length;
  }
  return out;
}

// ---------- 密钥 ----------

export const newSigningKey = (extractable = false) => subtle.generateKey(SIGN, extractable, ['sign', 'verify']);
export const newEphemeral = () => subtle.generateKey(DH, false, ['deriveBits']);
export const exportPub = async (key) => b64(await subtle.exportKey('raw', key));

export async function fingerprint(pubB64) {
  const h = new Uint8Array(await subtle.digest('SHA-256', unb64(pubB64)));
  return [...h.subarray(0, 4)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export async function transcript({ sC, eC, sE, eE }) {
  return new Uint8Array(await subtle.digest('SHA-256', concat('chrome-bridge/3', unb64(sC), unb64(eC), unb64(sE), unb64(eE))));
}

export async function sign(privKey, role, th) {
  return b64(await subtle.sign(SIGN_ALG, privKey, concat('sig-' + role, th)));
}

export async function verify(pubB64, sigB64, role, th) {
  try {
    const pub = await subtle.importKey('raw', unb64(pubB64), SIGN, false, ['verify']);
    return await subtle.verify(SIGN_ALG, pub, unb64(sigB64), concat('sig-' + role, th));
  } catch {
    return false;
  }
}

// 两个方向各一把密钥: send/recv 由角色决定, 一方发的帧不能被反射回给它自己
export async function deriveChannel(ephPriv, peerEphB64, th, role) {
  const peer = await subtle.importKey('raw', unb64(peerEphB64), DH, false, []);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: peer }, ephPriv, 256);
  const base = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = (label) =>
    subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: th, info: enc.encode(label) },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  const [c2e, e2c] = await Promise.all([key('c2e'), key('e2c')]);
  return role === 'C' ? new Channel(c2e, e2c) : new Channel(e2c, c2e);
}

export class Channel {
  constructor(sendKey, recvKey) {
    this.sendKey = sendKey;
    this.recvKey = recvKey;
    this.sendSeq = 0;
    this.recvSeq = 0;
    this.queue = Promise.resolve(); // 加密是异步的, 串行化以保证序号与发送顺序一致
  }

  seal(obj) {
    const seq = this.sendSeq++;
    const p = this.queue.then(async () => {
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
      const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, this.sendKey, enc.encode(JSON.stringify({ seq, m: obj })));
      const out = new Uint8Array(12 + ct.byteLength);
      out.set(iv);
      out.set(new Uint8Array(ct), 12);
      return out;
    });
    this.queue = p.catch(() => {});
    return p;
  }

  // 解密失败或序号不对 (篡改、重放、丢帧) 一律抛错, 调用方应断开连接
  async open(buf) {
    const u = new Uint8Array(buf);
    if (u.length < 29) throw new Error('帧过短');
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: u.subarray(0, 12) }, this.recvKey, u.subarray(12));
    const { seq, m } = JSON.parse(dec.decode(pt));
    if (seq !== this.recvSeq) throw new Error(`序号错误: 期望 ${this.recvSeq}, 收到 ${seq}`);
    this.recvSeq++;
    return m;
  }
}

// ---------- 配对码 ----------

export function newCode() {
  const r = globalThis.crypto.getRandomValues(new Uint8Array(8));
  return [...r].map((x) => CODE_ALPHABET[x & 31]).join('');
}

export const formatCode = (code) => code.slice(0, 4) + '-' + code.slice(4);

// 容错: 大小写、分隔符, 以及 Crockford 规则 O→0, I/L→1
export function normalizeCode(s) {
  return String(s)
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

export async function codeKey(code, sCb64) {
  const base = await subtle.importKey('raw', enc.encode(normalizeCode(code)), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: concat('pair', unb64(sCb64)), iterations: PBKDF2_ITERATIONS },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify']
  );
}

export async function pairProof(k, role, th) {
  return b64(await subtle.sign('HMAC', k, concat('pair-' + role, th)));
}

export async function checkPairProof(k, role, th, proofB64) {
  try {
    return await subtle.verify('HMAC', k, unb64(proofB64), concat('pair-' + role, th));
  } catch {
    return false;
  }
}
