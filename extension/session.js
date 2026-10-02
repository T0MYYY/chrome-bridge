// 一条连接上的握手、配对与加密收发 — 连接器端 (ConnectorSide) 与扩展端 (ExtensionSide).
// 与 Chrome、Node 的具体 API 无关: 通过 transport { sendText, sendBinary, close } 收发,
// 收到的数据交给 receive(). 两端共用这个文件, 测试也直接用它.
//
// 状态: hello → secure (加密通道已建立) → ready (双方都信任对方的静态公钥).
// secure 但未 ready = 待配对: 只接受配对消息, 不收发业务消息.

import * as P from './protocol.js';

const PAIR_TIMEOUT_MS = 15000;

// 收到的帧必须按顺序解密 (序号校验), 而解密是异步的: 串起来
class Serial {
  constructor() {
    this.q = Promise.resolve();
  }
  run(fn) {
    const p = this.q.then(fn);
    this.q = p.catch(() => {});
    return p;
  }
}

class Side {
  constructor(transport) {
    this.t = transport;
    this.state = 'hello';
    this.ch = null;
    this.th = null;
    this.myTrust = false;
    this.peerTrust = false;
    this.serial = new Serial();
  }

  receive(data) {
    return this.serial.run(async () => {
      if (this.state === 'closed') return;
      try {
        if (typeof data === 'string') await this.onText(JSON.parse(data));
        else await this.onFrame(await this.ch.open(data));
      } catch (e) {
        this.fail('协议错误: ' + ((e && e.message) || e));
      }
    });
  }

  async onFrame() {}

  async sendSecure(m) {
    if (!this.ch || this.state === 'closed') return;
    const buf = await this.ch.seal(m);
    if (this.state !== 'closed') this.t.sendBinary(buf);
  }

  // 业务消息只在 ready 后收发
  send(obj) {
    if (this.state !== 'ready') return Promise.reject(new Error('连接尚未就绪'));
    return this.sendSecure({ t: 'msg', d: obj });
  }

  checkReady() {
    if (this.state === 'secure' && this.myTrust && this.peerTrust) {
      this.state = 'ready';
      this.o.onReady?.();
    }
  }

  fail(reason, code = 4002) {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.o.onFail?.(reason);
    try {
      this.t.close(code, String(reason).slice(0, 120));
    } catch {}
  }
}

// ---------------- 连接器端 ----------------
// opts: identity { sk, pub }, info, isTrustedExt(pub), trustExt(pub),
//       pairing() -> { code, key }, pairFailed(), onReady, onPending, onMessage, onRevoked, onFail

export class ConnectorSide extends Side {
  constructor(transport, opts) {
    super(transport);
    this.o = opts;
  }

  async start() {
    this.eph = await P.newEphemeral();
    this.eC = await P.exportPub(this.eph.publicKey);
    this.t.sendText(
      JSON.stringify({ t: 'hello', bridge: 'chrome-bridge', protocol: P.PROTOCOL, sC: this.o.identity.pub, eC: this.eC })
    );
  }

  async onText(m) {
    if (this.state !== 'hello' || m.t !== 'auth') throw new Error('意外的明文消息');
    this.sE = m.sE;
    this.th = await P.transcript({ sC: this.o.identity.pub, eC: this.eC, sE: m.sE, eE: m.eE });
    if (!(await P.verify(m.sE, m.sig, 'E', this.th))) throw new Error('扩展签名无效');
    this.ch = await P.deriveChannel(this.eph.privateKey, m.eE, this.th, 'C');
    this.t.sendText(JSON.stringify({ t: 'auth', sig: await P.sign(this.o.identity.sk, 'C', this.th) }));
    this.state = 'secure';
    this.myTrust = !!this.o.isTrustedExt(this.sE);
    // agent 信息 (目录、pid 等) 只走加密通道, 不在明文 hello 里暴露
    await this.sendSecure({ t: 'state', trusts: this.myTrust, info: this.o.info });
  }

  async onFrame(m) {
    switch (m.t) {
      case 'state':
        this.peerTrust = !!m.trusts;
        if (m.revoked) return this.o.onRevoked?.();
        this.checkReady();
        if (this.state === 'secure') this.o.onPending?.();
        return;
      case 'pair': {
        if (this.state !== 'secure') return;
        const { key } = this.o.pairing();
        if (!(await P.checkPairProof(await key, 'E', this.th, m.proof))) {
          this.o.pairFailed();
          return this.sendSecure({ t: 'pair-fail' });
        }
        this.myTrust = true;
        this.o.trustExt(this.sE);
        // 扩展验过我们的证明后会发 state{trusts:true}, 那时才进入 ready
        return this.sendSecure({ t: 'pair-ok', proof: await P.pairProof(await key, 'C', this.th) });
      }
      case 'msg':
        if (this.state === 'ready') this.o.onMessage(m.d);
        return;
    }
  }
}

// ---------------- 扩展端 ----------------
// opts: identity { sk, pub }, trustOf(sC) -> 'trusted' | 'revoked' | null,
//       onReady, onPending, onMessage, onTrusted(sC, info), onFail

export class ExtensionSide extends Side {
  constructor(transport, opts) {
    super(transport);
    this.o = opts;
    this.pairWaiter = null;
  }

  async onText(m) {
    if (this.state === 'hello' && m.t === 'hello') {
      if (m.bridge !== 'chrome-bridge' || m.protocol !== P.PROTOCOL) return this.fail('不是兼容的连接器', 4003);
      this.sC = m.sC;
      this.eC = m.eC;
      this.info = {};
      this.eph = await P.newEphemeral();
      const eE = await P.exportPub(this.eph.publicKey);
      this.th = await P.transcript({ sC: m.sC, eC: m.eC, sE: this.o.identity.pub, eE });
      this.t.sendText(JSON.stringify({ t: 'auth', sE: this.o.identity.pub, eE, sig: await P.sign(this.o.identity.sk, 'E', this.th) }));
      this.state = 'authsent';
      return;
    }
    if (this.state === 'authsent' && m.t === 'auth') {
      if (!(await P.verify(this.sC, m.sig, 'C', this.th))) throw new Error('连接器签名无效');
      this.ch = await P.deriveChannel(this.eph.privateKey, this.eC, this.th, 'E');
      this.state = 'secure';
      const trust = this.o.trustOf(this.sC);
      this.myTrust = trust === 'trusted';
      return this.sendSecure({ t: 'state', trusts: this.myTrust, revoked: trust === 'revoked' });
    }
    throw new Error('意外的明文消息');
  }

  async onFrame(m) {
    switch (m.t) {
      case 'state':
        this.peerTrust = !!m.trusts;
        if (m.info) this.info = m.info;
        this.checkReady();
        if (this.state === 'secure' && this.o.trustOf(this.sC) !== 'revoked') this.o.onPending?.();
        return;
      case 'pair-ok': {
        const w = this.pairWaiter;
        if (!w) return;
        this.pairWaiter = null;
        // 连接器也必须证明它知道这个码: 否则冒充者只要回一句 pair-ok 就能被信任
        if (!(await P.checkPairProof(w.key, 'C', this.th, m.proof))) return w.resolve(false);
        this.myTrust = true;
        this.peerTrust = true;
        this.o.onTrusted(this.sC, this.info);
        await this.sendSecure({ t: 'state', trusts: true });
        this.checkReady();
        return w.resolve(true);
      }
      case 'pair-fail': {
        const w = this.pairWaiter;
        this.pairWaiter = null;
        return w?.resolve(false);
      }
      case 'msg':
        if (this.state === 'ready') this.o.onMessage(m.d);
        return;
    }
  }

  // 用户输入的码: 若与这个连接器显示的码一致, 双方互相信任
  async pair(code) {
    if (this.state !== 'secure' || this.pairWaiter) return false;
    const key = await P.codeKey(code, this.sC);
    const proof = await P.pairProof(key, 'E', this.th);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pairWaiter?.key === key) this.pairWaiter = null;
        resolve(false);
      }, PAIR_TIMEOUT_MS);
      this.pairWaiter = {
        key,
        resolve: (ok) => {
          clearTimeout(timer);
          resolve(ok);
        },
      };
      this.sendSecure({ t: 'pair', proof });
    });
  }
}
