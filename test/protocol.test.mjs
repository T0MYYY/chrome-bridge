// 协议测试: 正常配对 / 重连免配对 / 各类攻击. 运行: node test/protocol.test.mjs
import * as P from '../extension/protocol.js';
import { ConnectorSide, ExtensionSide } from '../extension/session.js';

const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(ok ? 'PASS' : 'FAIL', name, extra); };
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// 一对内存传输: a.sendX -> b.receive. tap 可拦截/改写 (模拟中间人)
function wire(tap = {}) {
  const ends = {};
  const mk = (self, other) => ({
    sendText: (s) => (tap[self]?.text ? tap[self].text(s) : ends[other].receive(s)),
    sendBinary: (b) => (tap[self]?.bin ? tap[self].bin(b) : ends[other].receive(b)),
    close: (code, reason) => { ends[self].closedWith = { code, reason }; },
  });
  return { ends, tC: mk('C', 'E'), tE: mk('E', 'C') };
}

async function identity() {
  const kp = await P.newSigningKey();
  return { sk: kp.privateKey, pub: await P.exportPub(kp.publicKey) };
}

function connectorState() {
  const s = { trustedExt: new Set(), code: P.newCode(), fails: 0, rotations: 0 };
  s.newKey = () => (s.key = P.codeKey(s.code, s.idPub));
  return s;
}

function makePair({ cid, eid, cs, extTrust, tap }) {
  const w = wire(tap);
  const log = { cMsgs: [], eMsgs: [], cReady: false, eReady: false, ePending: false, revoked: false };
  const C = new ConnectorSide(w.tC, {
    identity: cid,
    info: { agent: { label: 'test-agent' } },
    isTrustedExt: (p) => cs.trustedExt.has(p),
    trustExt: (p) => cs.trustedExt.add(p),
    pairing: () => ({ code: cs.code, key: cs.key }),
    pairFailed: () => { if (++cs.fails >= 3) { cs.code = P.newCode(); cs.fails = 0; cs.rotations++; cs.newKey(); } },
    onReady: () => (log.cReady = true),
    onMessage: (m) => log.cMsgs.push(m),
    onRevoked: () => (log.revoked = true),
  });
  const E = new ExtensionSide(w.tE, {
    identity: eid,
    trustOf: (p) => extTrust.get(p) || null,
    onTrusted: (p) => extTrust.set(p, 'trusted'),
    onReady: () => (log.eReady = true),
    onPending: () => (log.ePending = true),
    onMessage: (m) => log.eMsgs.push(m),
  });
  w.ends.C = C; w.ends.E = E;
  return { C, E, log, w };
}

const cid = await identity(), eid = await identity();
const cs = connectorState(); cs.idPub = cid.pub; cs.newKey();
const extTrust = new Map();

// 1. 首次: 双方都不信任 -> 待配对
let { C, E, log } = makePair({ cid, eid, cs, extTrust });
await C.start(); await tick();
check('首次连接进入待配对, 不就绪', log.ePending && !log.cReady && !log.eReady && E.state === 'secure');
await C.send({ x: 1 }).then(() => check('未就绪时业务消息被拒', false), () => check('未就绪时业务消息被拒', true));

// 2. 错误的码
let ok = await E.pair('WRONG123');
check('错误配对码被拒', ok === false && !log.eReady);

// 3. 正确的码 (用户输入格式宽松: 小写, 带横杠)
const typed = P.formatCode(cs.code).toLowerCase();
ok = await E.pair(typed); await tick();
check('正确配对码 -> 双方就绪', ok && log.cReady && log.eReady, typed);
await C.send({ cmd: 'tabs.list' }); await E.send({ reply: 42 }); await tick();
check('就绪后加密收发正常', log.eMsgs[0]?.cmd === 'tabs.list' && log.cMsgs[0]?.reply === 42);

// 4. 重连: 双方已互信 -> 直接就绪, 不用配对
({ C, E, log } = makePair({ cid, eid, cs, extTrust }));
await C.start(); await tick();
check('重连免配对, 直接就绪', log.cReady && log.eReady && !log.ePending);

// 5. 冒充连接器: 照抄合法连接器的公钥, 但没有私钥 -> 签名对不上
{
  const fake = await identity();
  const w = wire();
  const E2 = new ExtensionSide(w.tE, { identity: eid, trustOf: (p) => extTrust.get(p) || null, onTrusted: () => {}, onReady: () => {}, onMessage: () => {} });
  const C2 = new ConnectorSide(w.tC, { identity: { sk: fake.sk, pub: cid.pub }, info: {}, isTrustedExt: () => true, trustExt: () => {}, pairing: () => ({}), pairFailed: () => {}, onMessage: () => {} });
  w.ends.C = C2; w.ends.E = E2;
  await C2.start(); await tick();
  check('冒用已信任公钥的假连接器被识破', E2.state === 'closed' && /签名无效/.test(E2.closedWith?.reason || ''), E2.closedWith?.reason);
}

// 6. 假连接器 (自己的密钥): 扩展不信任 -> 待配对; 用户输入真码也配不上 (它给不出证明)
{
  const fake = await identity();
  const fcs = connectorState(); fcs.idPub = fake.pub; fcs.newKey();
  const m = makePair({ cid: fake, eid, cs: fcs, extTrust });
  await m.C.start(); await tick();
  const r = await m.E.pair(cs.code); await tick();
  check('假连接器拿不到信任 (真码配不上它)', m.log.ePending && r === false && !m.log.eReady && !extTrust.has(fake.pub));
}

// 7. 中间人原样转发握手, 然后往通道里注入伪造帧 / 重放旧帧
{
  let lastToE = null;
  const tap = { C: { bin: (b) => { lastToE = b; m.E.receive(b); } } };
  const m = makePair({ cid, eid, cs, extTrust, tap });
  await m.C.start(); await tick();
  check('中间人转发下双方照常就绪 (它只是管道)', m.log.cReady && m.log.eReady);
  await m.C.send({ n: 1 }); await tick();
  m.E.receive(lastToE); await tick();
  check('重放旧帧 -> 连接被断开', m.E.state === 'closed', m.E.closedWith?.reason);
}
{
  const m = makePair({ cid, eid, cs, extTrust });
  await m.C.start(); await tick();
  const forged = new Uint8Array(64); crypto.getRandomValues(forged);
  m.E.receive(forged.buffer); await tick();
  check('注入伪造帧 -> 连接被断开', m.E.state === 'closed');
}

// 8. 中间人替换临时公钥 (想自己做两段 ECDH) -> 签名覆盖了临时公钥, 对不上
{
  const evil = await P.newEphemeral(); const evilPub = await P.exportPub(evil.publicKey);
  const tap = { C: { text: (s) => { const j = JSON.parse(s); if (j.t === 'hello') j.eC = evilPub; m.E.receive(JSON.stringify(j)); } } };
  const m = makePair({ cid, eid, cs, extTrust, tap });
  await m.C.start(); await tick(80);
  check('替换临时公钥的中间人被识破', m.E.state === 'closed' || m.C.state === 'closed', (m.E.closedWith || m.C.closedWith)?.reason);
}

// 9. 假扩展对真连接器在线猜码: 3 次错误后码自动轮换
{
  const fakeExt = await identity();
  const before = cs.rotations; const oldCode = cs.code;
  for (let i = 0; i < 3; i++) {
    const m = makePair({ cid, eid: fakeExt, cs, extTrust: new Map() });
    await m.C.start(); await tick();
    await m.E.pair(P.newCode());
  }
  check('连续 3 次错码后配对码轮换', cs.rotations === before + 1 && cs.code !== oldCode);
  check('假扩展没有被信任', !cs.trustedExt.has(fakeExt.pub));
}

// 10. 扩展撤销了这个 agent -> 连接器收到 revoked, 不能直接重新配对同一把密钥
{
  const t2 = new Map(extTrust); t2.set(cid.pub, 'revoked');
  const m = makePair({ cid, eid, cs, extTrust: t2 });
  await m.C.start(); await tick();
  check('被撤销的 agent 收到 revoked 通知, 不进入待配对', m.log.revoked && !m.log.ePending && !m.log.eReady);
}

// 11. 配对码: 40 bit 熵, 格式宽松
{
  const c = P.newCode();
  check('配对码 8 位 Crockford base32', /^[0-9A-HJKMNP-TV-Z]{8}$/.test(c), c);
  check('输入容错 (o→0, i/l→1, 大小写, 横杠)', P.normalizeCode('ab1o-il2z') === 'AB10112Z');
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
