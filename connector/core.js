// Chrome Bridge 连接器核心: 端口与发现、握手与配对、与扩展之间的请求/事件.
//
// 不含任何 MCP 工具. chrome-bridge 自己的 index.js 和其他连接器 (如 apply-bridge)
// 都通过 createBridge() 接入同一个扩展; 扩展把每个连接器当作一个独立会话.
// 凭据按 agent 身份保存 (见 agent.js), 所以同一个 agent 下的所有连接器共用一次配对.
//
// 注意: stdout 专属于 MCP 协议, 所有日志必须走 stderr.

import http from 'node:http';
import { WebSocketServer } from 'ws';
import * as P from '../extension/protocol.js';
import { ConnectorSide } from '../extension/session.js';
import { identifyAgent, loadCredential, saveCredential } from './agent.js';

const BASE_PORT = Number(process.env.CHROME_BRIDGE_PORT || 9333);
const PORT_SPAN = 20; // 必须与扩展 background.js 的 PORT_SPAN 一致
const EXT_WAIT_MS = 35000; // 扩展的 service worker 休眠时靠 30 秒一次的 alarm 唤醒, 留足余量
const HEARTBEAT_MS = 15000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{ name: string, version: string,
 *           onCdpEvent?: (tabId, sessionId, method, params, from) => void,
 *           onChromeEvent?: (ev: { path, at, args }) => void }} opts
 */
export function createBridge({ name, version, onCdpEvent = () => {}, onChromeEvent = () => {} }) {
  const err = (...a) => console.error(`[${name}]`, ...a);
  const startedAt = Date.now();

  let port = null;
  let httpServer = null;
  let wsServer = null;
  let heartbeatTimer = null;
  let closed = false;
  let nextId = 1;
  const pending = new Map();
  const mySubs = new Set(); // 本会话订阅的 chrome.* 事件, 扩展重连后自动补订
  const sessionInfo = new Map(); // CDP 子会话 sessionId -> { type, url }

  // ---------------- 身份与配对 ----------------
  // 身份按 agent 持久化 (见 agent.js): 同一个 agent 的所有会话共用一把签名密钥,
  // 与扩展配对一次后, 之后的会话握手即就绪. 无法识别 agent 时用只在本进程有效的临时身份.

  let agent = null; // { id, label, strength } | null
  let cred = null; // { sk: pkcs8 b64, pub, trustedExt: [扩展公钥] }
  let identity = null; // { sk: CryptoKey, pub }
  let clientInfo = null; // MCP initialize 里 agent 自报的名字与版本, 只用于显示
  let pairing = null; // { code, key, fails }

  async function newCredential() {
    const kp = await P.newSigningKey(true);
    return { sk: P.b64(await crypto.subtle.exportKey('pkcs8', kp.privateKey)), pub: await P.exportPub(kp.publicKey), trustedExt: [] };
  }

  async function persist() {
    if (!agent) return;
    await saveCredential(agent.id, cred).catch((e) => err('保存凭据失败:', e.message));
  }

  async function useCredential(c) {
    cred = c;
    const sk = await crypto.subtle.importKey('pkcs8', P.unb64(c.sk), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    identity = { sk, pub: c.pub };
  }

  async function loadIdentity() {
    agent = await identifyAgent().catch(() => null);
    let c = agent && (await loadCredential(agent.id));
    if (!c?.sk) {
      c = await newCredential();
      if (agent) {
        try {
          await saveCredential(agent.id, c);
        } catch (e) {
          err('保存凭据失败, 退回临时身份:', e.message);
          agent = null;
        }
      }
    }
    await useCredential(c);
    err('agent 身份:', agent ? `${agent.label} [${agent.strength}]` : '未识别 (临时身份, 仅本会话有效)');
  }

  // 扩展撤销了这个 agent: 换一把新密钥 (旧的可能已泄露), 断开后重新配对
  async function rotateIdentity() {
    err('扩展已撤销本 agent 的配对, 更换密钥');
    await useCredential({ ...(await newCredential()), trustedExt: cred.trustedExt });
    await persist();
    for (const c of sides) c.ws.close(4004, 'rotated');
  }

  function getPairing() {
    if (!pairing) {
      const code = P.newCode();
      pairing = { code, key: P.codeKey(code, identity.pub), fails: 0 };
    }
    return pairing;
  }

  // 在线猜码: 连续 3 次错误就作废这个码, 下次调用工具时显示新码
  function pairFailed() {
    if (pairing && ++pairing.fails >= 3) {
      err('配对码连续错误 3 次, 已作废');
      pairing = null;
    }
  }

  function agentInfo() {
    return {
      agent: {
        label: agent?.label || '未识别的 agent',
        strength: agent?.strength || 'ephemeral',
        client: clientInfo ? `${clientInfo.name} ${clientInfo.version || ''}`.trim() : null,
      },
      connector: name,
      pid: process.pid,
      cwd: process.cwd(),
      version,
      startedAt,
    };
  }

  // ---------------- 与扩展的连接 ----------------

  let side = null; // 已就绪的连接
  let pendingSide = null; // 加密通道已建立、等待用户配对的连接
  const sides = new Set();
  const stateWaiters = new Set();

  const wake = () => {
    for (const w of stateWaiters) w();
  };

  // 端口: 从 BASE_PORT 起找第一个空闲的; 整段都被占就每 2 秒重试, 不需要人工重连.
  function tryListen(p) {
    return new Promise((resolve) => {
      const srv = http.createServer((req, res) => {
        // 扩展先 GET 这个地址确认端口上是连接器, 再建 WebSocket (见扩展 probe()).
        // 扩展按 bridge 字段识别, connector 字段只标明是哪个连接器.
        // 不加 CORS 头: 网页读不到响应, 也就探不出这里有什么.
        if (req.method === 'GET' && req.url === '/chrome-bridge') {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ bridge: 'chrome-bridge', protocol: P.PROTOCOL, connector: name }));
        }
        res.writeHead(426, { 'content-type': 'text/plain' });
        res.end('chrome-bridge connector: WebSocket only\n');
      });
      srv.once('error', () => resolve(null));
      srv.listen(p, '127.0.0.1', () => resolve(srv));
    });
  }

  async function listen() {
    await identityReady;
    while (!closed) {
      for (let p = BASE_PORT; p < BASE_PORT + PORT_SPAN; p++) {
        const srv = await tryListen(p);
        if (srv && closed) return srv.close();
        if (srv) return serve(srv, p);
      }
      err(`端口 ${BASE_PORT}-${BASE_PORT + PORT_SPAN - 1} 全被占用, 2 秒后重试`);
      await sleep(2000);
    }
  }

  function serve(srv, p) {
    port = p;
    httpServer = srv;
    const wss = (wsServer = new WebSocketServer({
      server: srv,
      maxPayload: 256 * 1024 * 1024,
      // 第一道筛子: 网页也能连 127.0.0.1, 但带不了 chrome-extension:// 来源. 真正的鉴权在握手里
      verifyClient: ({ origin }) => typeof origin === 'string' && origin.startsWith('chrome-extension://'),
    }));
    srv.on('error', (e) => err('监听出错:', e.message));
    wss.on('connection', onConnection);
    heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
    heartbeatTimer.unref();
    err(`WebSocket 服务已就绪 127.0.0.1:${p}, 等待扩展接入`);
  }

  // 对端异常消失 (没有正常关闭) 时, 靠心跳发现并清掉, 让扩展能重新接入
  function heartbeat() {
    for (const c of sides) {
      if (c.ws.alive === false) {
        c.ws.terminate();
        continue;
      }
      c.ws.alive = false;
      try {
        c.ws.ping();
      } catch {}
    }
  }

  function onConnection(ws) {
    // 未就绪的连接也占资源: 限个数, 防止被大量空连接拖住
    if (sides.size >= 8) return ws.close(4005, 'too many connections');
    ws.alive = true;
    ws.on('pong', () => (ws.alive = true));
    const c = new ConnectorSide(
      { sendText: (d) => ws.send(d), sendBinary: (d) => ws.send(d), close: (code) => ws.close(code) },
      {
        identity,
        get info() {
          return agentInfo();
        },
        isTrustedExt: (pub) => cred.trustedExt.includes(pub),
        trustExt: (pub) => {
          if (!cred.trustedExt.includes(pub)) cred.trustedExt.push(pub);
          pairing = null;
          persist();
          err('配对成功');
        },
        pairing: getPairing,
        pairFailed,
        onReady: () => {
          // 同一时刻只服务一个扩展实例 (例如两个 Chrome profile 都装了扩展), 先到先得
          if (side && side !== c) return ws.close(4001, 'busy');
          side = c;
          if (pendingSide === c) pendingSide = null;
          err('扩展已接入');
          wake();
          for (const path of mySubs) callExt('events.subscribe', { path }).catch((e) => err('补订失败', path, e.message));
        },
        onPending: () => {
          pendingSide = c;
          wake();
        },
        onMessage: onExtMessage,
        onRevoked: () => rotateIdentity(),
        onFail: (reason) => err('连接被拒:', reason),
      }
    );
    c.ws = ws;
    sides.add(c);
    ws.on('message', (raw, isBinary) => {
      ws.alive = true;
      c.receive(isBinary ? raw : raw.toString());
    });
    ws.on('close', () => {
      sides.delete(c);
      if (pendingSide === c) pendingSide = null;
      if (side !== c) return;
      side = null;
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('与扩展的连接中断 (扩展被重新加载或 Chrome 已关闭), 请重试'));
      }
      pending.clear();
      err('扩展已断开');
    });
    c.start().catch((e) => err('握手失败:', e.message));
  }

  // CDP 事件先维护子会话表, 再交给使用方
  function cdpEvent(tabId, sessionId, method, p) {
    if (method === 'Target.attachedToTarget' && p.sessionId) {
      sessionInfo.set(p.sessionId, { type: p.targetInfo?.type, url: p.targetInfo?.url });
      return;
    }
    if (method === 'Target.detachedFromTarget' && p.sessionId) return;
    if (tabId === undefined) return;
    // 子会话刚附加时 iframe 还没导航, 地址为空; 它的默认执行上下文带着真实 origin, 用来补上
    if (method === 'Runtime.executionContextCreated' && sessionId && p.context?.auxData?.isDefault) {
      const info = sessionInfo.get(sessionId);
      if (info && !info.url) info.url = p.context.origin;
    }
    const from = sessionId ? sessionInfo.get(sessionId) || { type: 'child' } : null;
    onCdpEvent(tabId, sessionId, method, p, from);
  }

  function onExtMessage(msg) {
    if (msg.event === 'cdp') return cdpEvent(msg.tabId, msg.sessionId, msg.method, msg.params || {});
    if (msg.event === 'chrome') return onChromeEvent({ path: msg.path, at: msg.at, args: msg.args });
    if (msg.event === 'detached') return err('调试器已被解除:', msg.key, msg.reason || '');
    if (msg.event) return;
    const p = pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error || '扩展返回错误'));
  }

  function waitFor(cond, ms) {
    if (cond()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const check = () => {
        if (!cond()) return;
        clearTimeout(timer);
        stateWaiters.delete(check);
        resolve(true);
      };
      const timer = setTimeout(() => {
        stateWaiters.delete(check);
        resolve(false);
      }, ms);
      stateWaiters.add(check);
    });
  }

  function pairingMessage() {
    const { code } = getPairing();
    return (
      `Chrome Bridge 还没有与这个 agent 配对 (每个 agent 只需配对一次)。` +
      `请把配对码告诉用户: 在 Chrome 工具栏点 Chrome Bridge 图标, 输入配对码 ${P.formatCode(code)}。用户完成后重试即可。` +
      (agent ? '' : ' (未能识别 agent 身份, 这次配对只在当前会话有效)')
    );
  }

  async function callExt(method, params = {}, timeoutMs = 60000) {
    if (!side) {
      await waitFor(() => side || pendingSide, EXT_WAIT_MS);
      if (!side && pendingSide) throw new Error(pairingMessage());
      if (!side) {
        throw new Error(
          `扩展未接入 (已等 ${EXT_WAIT_MS / 1000} 秒)。本会话的连接器` +
            (port ? `监听在 127.0.0.1:${port}` : `还没抢到 ${BASE_PORT}-${BASE_PORT + PORT_SPAN - 1} 中的空闲端口`) +
            '。请确认 Chrome 里 Chrome Bridge 扩展 (v3) 已启用; 点开它的弹窗能看到已接入的会话。'
        );
      }
    }
    const c = side;
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('扩展响应超时: ' + method));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      c.send({ id, method, params }).catch((e) => {
        clearTimeout(timer);
        pending.delete(id);
        reject(e);
      });
    });
  }

  const cdp = (tabId, cdpMethod, cdpParams = {}) => callExt('cdp.send', { tabId, cdpMethod, cdpParams });

  async function status() {
    await identityReady;
    const me = {
      连接器: name,
      版本: version,
      pid: process.pid,
      端口: port,
      agent: agentInfo().agent,
      状态: side ? '已配对, 已接入' : pendingSide ? '已接入, 待配对' : '扩展未接入',
    };
    if (pendingSide) me.配对码 = P.formatCode(getPairing().code);
    if (!side) return me;
    return { ...me, ...(await callExt('bridge.status')) };
  }

  async function subscribe(path) {
    const r = await callExt('events.subscribe', { path });
    mySubs.add(path);
    return r;
  }

  function unsubscribe(path) {
    mySubs.delete(path);
    return callExt('events.unsubscribe', { path });
  }

  // 进程内使用 (如测试) 时释放端口与连接, 让进程能自然退出
  async function close() {
    closed = true;
    clearInterval(heartbeatTimer);
    for (const c of sides) c.ws.terminate();
    await new Promise((r) => (wsServer ? wsServer.close(() => r()) : r()));
    await new Promise((r) => (httpServer ? httpServer.close(() => r()) : r()));
  }

  const identityReady = loadIdentity();
  listen().catch((e) => err('监听失败:', e));

  return {
    ready: identityReady,
    callExt,
    cdp,
    status,
    agentInfo,
    setClientInfo: (info) => (clientInfo = info || null),
    pairingMessage,
    sessionInfo,
    subscribe,
    unsubscribe,
    close,
    get port() {
      return port;
    },
  };
}

// 会话结束 (stdin 关闭, 或父进程消失被过继给 launchd) 就退出, 不留孤儿进程占着端口
export function exitWithParent() {
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('close', () => process.exit(0));
  setInterval(() => process.ppid === 1 && process.exit(0), 5000).unref();
}
