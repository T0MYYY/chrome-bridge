#!/usr/bin/env node
// Chrome Bridge MCP 连接器
//
// 一头是 MCP (stdio, 接任意支持 MCP 的 agent), 另一头是 WebSocket 服务 (接 Chrome 扩展).
// 扩展用 chrome.debugger 提供 CDP 能力, 所以不需要 --remote-debugging-port,
// 可以直接操作日常使用的默认 profile.
//
// 除便捷工具外, chrome_cdp / chrome_api / chrome_events 三个通用出口覆盖任意
// CDP 方法、任意 chrome.* API 与事件, 新需求不必再改代码.
//
// 多会话: 每个 agent 会话各起一个连接器, 各自占用 9333 起第一个空闲端口.
// 扩展扫描整个端口区间, 对每个连接器各维持一条连接, 互不干扰; 会话退出,
// 它的连接断开, 扩展随即释放它占用的调试器附加与事件订阅.
//
// 注意: stdout 专属于 MCP 协议, 所有日志必须走 stderr.

import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { WebSocketServer } from 'ws';
import * as P from '../extension/protocol.js';
import { ConnectorSide } from '../extension/session.js';
import { identifyAgent, loadCredential, saveCredential } from './agent.js';

const VERSION = '3.0.0';
const BASE_PORT = Number(process.env.CHROME_BRIDGE_PORT || 9333);
const PORT_SPAN = 20; // 必须与扩展 background.js 的 PORT_SPAN 一致
const EXT_WAIT_MS = 35000; // 扩展的 service worker 休眠时靠 30 秒一次的 alarm 唤醒, 留足余量
const HEARTBEAT_MS = 15000;
const RING = 2000;
const STARTED_AT = Date.now();

const err = (...a) => console.error('[connector]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 与扩展的连接 ----------------

let port = null;
let nextId = 1;
const pending = new Map();
const mySubs = new Set(); // 本会话订阅的 chrome.* 事件, 扩展重连后自动补订

const netByTab = new Map(); // tabId -> Map<'session:requestId', rec>
const logByTab = new Map(); // tabId -> rec[]
const sessionInfo = new Map(); // sessionId -> { type, url }
const chromeEvents = []; // chrome.* 订阅事件

function ringPush(arr, item) {
  arr.push(item);
  if (arr.length > RING) arr.shift();
}

function onCdpEvent(tabId, sessionId, method, p) {
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

  if (method.startsWith('Network.')) {
    if (!netByTab.has(tabId)) netByTab.set(tabId, new Map());
    const m = netByTab.get(tabId);
    if (!p.requestId) return;
    // 同一请求的事件可能分落在主会话和子会话上 (跨站 iframe 的文档请求就是这样:
    // 开始在父框架, 结束在子框架), 所以只按 requestId 合并, 不按会话拆开.
    const key = p.requestId;
    // 没见过开始事件的请求 (附加调试器之前就已发出) 不收录: 既不知道 URL, 也算不出耗时
    if (!m.has(key) && method !== 'Network.requestWillBeSent') return;
    const rec = m.get(key) || { requestId: p.requestId };
    if (from) rec.来自 = `${from.type || 'child'} ${String(from.url || '').slice(0, 70)}`;
    switch (method) {
      case 'Network.requestWillBeSent':
        rec.url = p.request?.url;
        rec.method = p.request?.method;
        rec.type = p.type;
        rec.startedAt = p.timestamp;
        break;
      case 'Network.responseReceived':
        rec.status = p.response?.status;
        rec.mimeType = p.response?.mimeType;
        rec.fromCache = p.response?.fromDiskCache || false;
        break;
      case 'Network.loadingFinished':
        rec.done = true;
        rec.bytes = p.encodedDataLength;
        if (rec.startedAt) rec.durationMs = Math.round((p.timestamp - rec.startedAt) * 1000);
        break;
      case 'Network.loadingFailed':
        rec.done = true;
        // 被阻断的请求 errorText 为空, 原因在 blockedReason 里
        rec.failed = p.errorText || (p.blockedReason ? 'blocked: ' + p.blockedReason : 'failed');
        if (p.canceled) rec.canceled = true;
        if (rec.startedAt) rec.durationMs = Math.round((p.timestamp - rec.startedAt) * 1000);
        break;
      default:
        return;
    }
    m.set(key, rec);
    if (m.size > RING) m.delete(m.keys().next().value);
    return;
  }

  if (!logByTab.has(tabId)) logByTab.set(tabId, []);
  const logs = logByTab.get(tabId);
  const tag = from ? { 来自: `${from.type || 'child'} ${String(from.url || '').slice(0, 70)}` } : {};

  if (method === 'Runtime.consoleAPICalled') {
    ringPush(logs, {
      kind: 'console',
      level: p.type,
      ...tag,
      text: (p.args || [])
        .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type))
        .join(' ')
        .slice(0, 800),
    });
  } else if (method === 'Log.entryAdded') {
    ringPush(logs, {
      kind: 'log',
      level: p.entry?.level,
      ...tag,
      text: String(p.entry?.text || '').slice(0, 800),
      url: p.entry?.url,
    });
  } else if (method === 'Runtime.exceptionThrown') {
    ringPush(logs, {
      kind: 'exception',
      level: 'error',
      ...tag,
      text: String(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || '未知异常').slice(0, 800),
    });
  }
}

// ---------------- 身份与配对 ----------------
// 身份按 agent 持久化 (见 agent.js): 同一个 agent 的所有会话共用一把签名密钥,
// 与扩展配对一次后, 之后的会话握手即就绪. 无法识别 agent 时用只在本进程有效的临时身份.

let agent = null; // { id, label, strength } | null
let cred = null; // { sk: pkcs8 b64, pub, trustedExt: [扩展公钥] }
let identity = null; // { sk: CryptoKey, pub }
let clientInfo = null; // MCP initialize 里 agent 自报的名字与版本, 只用于显示
let pairing = null; // { code, key, fails }
const identityReady = loadIdentity();

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
    pid: process.pid,
    cwd: process.cwd(),
    version: VERSION,
    startedAt: STARTED_AT,
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
      // 不加 CORS 头: 网页读不到响应, 也就探不出这里有什么.
      if (req.method === 'GET' && req.url === '/chrome-bridge') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ bridge: 'chrome-bridge', protocol: P.PROTOCOL }));
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
  for (;;) {
    for (let p = BASE_PORT; p < BASE_PORT + PORT_SPAN; p++) {
      const srv = await tryListen(p);
      if (srv) return serve(srv, p);
    }
    err(`端口 ${BASE_PORT}-${BASE_PORT + PORT_SPAN - 1} 全被占用, 2 秒后重试`);
    await sleep(2000);
  }
}

function serve(srv, p) {
  port = p;
  const wss = new WebSocketServer({
    server: srv,
    maxPayload: 256 * 1024 * 1024,
    // 第一道筛子: 网页也能连 127.0.0.1, 但带不了 chrome-extension:// 来源. 真正的鉴权在握手里
    verifyClient: ({ origin }) => typeof origin === 'string' && origin.startsWith('chrome-extension://'),
  });
  srv.on('error', (e) => err('监听出错:', e.message));
  wss.on('connection', onConnection);
  setInterval(heartbeat, HEARTBEAT_MS).unref();
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

function onExtMessage(msg) {
  if (msg.event === 'cdp') return onCdpEvent(msg.tabId, msg.sessionId, msg.method, msg.params || {});
  if (msg.event === 'chrome') return ringPush(chromeEvents, { path: msg.path, at: msg.at, args: msg.args });
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

const READY_RANK = { loading: 0, interactive: 1, complete: 2 };

async function waitReadyState(tabId, want, timeoutMs) {
  const t0 = Date.now();
  let last = 'unknown';
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await cdp(tabId, 'Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
      last = r?.result?.value || last;
      if ((READY_RANK[last] ?? -1) >= READY_RANK[want]) return { 达到: last, 用时ms: Date.now() - t0 };
    } catch {}
    await sleep(200);
  }
  return { 达到: last, 超时: true, 用时ms: Date.now() - t0 };
}

// ---------------- MCP 工具 ----------------

const tabIdProp = { type: 'number', description: '标签页 id, 由 chrome_tabs 获得' };

const TOOLS = [
  {
    name: 'chrome_tabs',
    description:
      '列出 Chrome 所有标签页 (tabId, windowId, 标题, URL, 是否无痕)。attached 表示本会话是否已附加调试器; ' +
      'otherSessions > 0 表示另有 agent 会话正在操作这个标签, 别去动它。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'chrome_status',
    description: '查看桥接状态: 本会话的 agent 身份、配对状态 (待配对时含配对码)、端口, 以及所有已接入的 agent 会话。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'chrome_new_tab',
    description:
      '新建标签页并返回 tabId。不传 windowId 时总是开在普通 (非无痕) 窗口; 传 windowId 可开在指定窗口 (例如用 chrome_api 建的无痕窗口)。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '缺省 about:blank' },
        active: { type: 'boolean', description: '是否切到前台, 默认 true' },
        windowId: { type: 'number' },
      },
    },
  },
  {
    name: 'chrome_close_tab',
    description: '关闭指定标签页。',
    inputSchema: { type: 'object', properties: { tabId: tabIdProp }, required: ['tabId'] },
  },
  {
    name: 'chrome_navigate',
    description:
      '让标签页跳转到 URL。会先附加调试器再导航, 因此网络与 console 记录从第一个字节开始完整覆盖 (含跨站 iframe)。' +
      '返回实际达到的 readyState, 不会假装成功。',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: tabIdProp,
        url: { type: 'string' },
        waitFor: {
          type: 'string',
          enum: ['none', 'interactive', 'complete'],
          description: '等到哪个 readyState, 默认 interactive',
        },
        timeoutMs: { type: 'number', description: '等 readyState 的上限, 默认 15000' },
        waitMs: { type: 'number', description: '之后再额外等待的毫秒数, 上限 300000' },
      },
      required: ['tabId', 'url'],
    },
  },
  {
    name: 'chrome_eval',
    description: '在标签页的页面上下文执行 JavaScript 并返回结果, 支持顶层 await。返回值需可 JSON 序列化。',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: tabIdProp,
        expression: { type: 'string', description: '最后一个表达式的值即返回值' },
      },
      required: ['tabId', 'expression'],
    },
  },
  {
    name: 'chrome_screenshot',
    description: '截取标签页, 返回 PNG。',
    inputSchema: {
      type: 'object',
      properties: { tabId: tabIdProp, fullPage: { type: 'boolean', description: '截整页, 默认只截可视区域' } },
      required: ['tabId'],
    },
  },
  {
    name: 'chrome_network',
    description:
      '读取该标签页记录的网络请求, 包括跨站 iframe 与 worker 的请求 (带「来自」字段)。' +
      '只在附加调试器之后记录 — 想看加载全过程请先 chrome_navigate。',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: tabIdProp,
        urlPattern: { type: 'string', description: '只返回 URL 含此子串的请求' },
        onlyPending: { type: 'boolean', description: '只返回尚未完成的请求' },
        sort: {
          type: 'string',
          enum: ['slowest', 'earliest', 'latest'],
          description: '默认 slowest (按耗时降序, 未完成的按已等待时长计)',
        },
        limit: { type: 'number', description: '默认 40' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'chrome_console',
    description: '读取该标签页记录的 console 输出、日志与未捕获异常 (含 iframe 与 worker)。',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: tabIdProp,
        pattern: { type: 'string', description: '只返回匹配此正则的条目' },
        limit: { type: 'number', description: '默认 50' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'chrome_detach',
    description:
      '解除本会话对标签页的调试器附加。若没有其他会话在用这个标签, 黄色提示条随之消失; ' +
      '若有, 只释放本会话的占用, 不影响对方 (返回的 stillUsedBy 是仍在用的会话数)。',
    inputSchema: { type: 'object', properties: { tabId: tabIdProp }, required: ['tabId'] },
  },
  {
    name: 'chrome_cdp',
    description:
      '通用出口: 向标签页或任意 target 发送任意 Chrome DevTools Protocol 方法并返回原始结果。' +
      '例: Network.setBlockedURLs, Emulation.setCPUThrottlingRate, Input.dispatchMouseEvent, ' +
      'Tracing.start, Page.addScriptToEvaluateOnNewDocument。传 sessionId 可发给子会话 (OOPIF)。',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: tabIdProp,
        targetId: { type: 'string', description: '不按标签页、而按 target 附加时使用 (见 chrome_targets)' },
        sessionId: { type: 'string', description: '发给子会话' },
        method: { type: 'string', description: 'CDP 方法名, 如 Network.setBlockedURLs' },
        params: { type: 'object', description: 'CDP 参数' },
      },
      required: ['method'],
    },
  },
  {
    name: 'chrome_targets',
    description: '列出所有可调试 target (页面、iframe、service worker、扩展后台等), 附带 targetId。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'chrome_api',
    description:
      '通用出口: 调用任意 chrome.* 扩展 API, path 为 chrome. 之后的部分。' +
      '例: windows.create [{"incognito":true}], cookies.getAll [{"domain":"bilibili.com"}], ' +
      'browsingData.remove, extension.isAllowedIncognitoAccess []。若 path 指向属性而非函数则返回属性值。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '如 windows.create' },
        args: { type: 'array', description: '参数数组, 默认 []' },
      },
      required: ['path'],
    },
  },
  {
    name: 'chrome_events',
    description:
      '通用出口: 订阅 / 退订 / 读取任意 chrome.* 事件, 如 tabs.onUpdated、webNavigation.onCompleted、' +
      'webRequest.onErrorOccurred。订阅属于本会话: 扩展重连后自动恢复, 会话结束自动退订。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['subscribe', 'unsubscribe', 'list', 'read', 'clear'] },
        path: { type: 'string', description: 'subscribe/unsubscribe 时必填; read 时可作过滤' },
        limit: { type: 'number', description: 'read 时返回最近多少条, 默认 50' },
      },
      required: ['action'],
    },
  },
  {
    name: 'chrome_wait',
    description: '等待指定毫秒数 (上限 300000), 用于等页面上的异步过程走完。',
    inputSchema: { type: 'object', properties: { ms: { type: 'number' } }, required: ['ms'] },
  },
];

const text = (v) => ({
  content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) }],
});

async function dispatch(name, a = {}) {
  switch (name) {
    case 'chrome_tabs':
      return text(await callExt('tabs.list'));

    case 'chrome_status': {
      await identityReady;
      const me = {
        版本: VERSION,
        pid: process.pid,
        端口: port,
        agent: agentInfo().agent,
        状态: side ? '已配对, 已接入' : pendingSide ? '已接入, 待配对' : '扩展未接入',
      };
      if (pendingSide) me.配对码 = P.formatCode(getPairing().code);
      if (!side) return text(me);
      return text({ ...me, ...(await callExt('bridge.status')) });
    }

    case 'chrome_new_tab':
      return text(await callExt('tabs.create', { url: a.url, active: a.active, windowId: a.windowId }));

    case 'chrome_close_tab':
      return text(await callExt('tabs.close', { tabId: a.tabId }));

    case 'chrome_navigate': {
      await callExt('cdp.attach', { tabId: a.tabId });
      netByTab.delete(a.tabId);
      logByTab.delete(a.tabId);
      await cdp(a.tabId, 'Page.navigate', { url: a.url });
      const want = a.waitFor || 'interactive';
      const state = want === 'none' ? { 达到: '未等待' } : await waitReadyState(a.tabId, want, a.timeoutMs || 15000);
      if (a.waitMs) await sleep(Math.min(a.waitMs, 300000));
      return text({ navigated: a.url, 等待目标: want, ...state });
    }

    case 'chrome_eval': {
      const r = await cdp(a.tabId, 'Runtime.evaluate', {
        expression: a.expression,
        returnByValue: true,
        awaitPromise: true,
        allowUnsafeEvalBlockedByCSP: true,
      });
      if (r?.exceptionDetails) {
        return text({ 错误: r.exceptionDetails.exception?.description || r.exceptionDetails.text });
      }
      return text(r?.result?.value ?? null);
    }

    case 'chrome_screenshot': {
      const r = await cdp(
        a.tabId,
        'Page.captureScreenshot',
        a.fullPage ? { format: 'png', captureBeyondViewport: true } : { format: 'png' }
      );
      if (!r?.data) return text({ 错误: '截图失败' });
      return { content: [{ type: 'image', data: r.data, mimeType: 'image/png' }] };
    }

    case 'chrome_network': {
      const m = netByTab.get(a.tabId);
      if (!m || m.size === 0) {
        return text({ 提示: '暂无记录。网络请求只在附加调试器之后才开始收集 — 先用 chrome_navigate 走一次导航。' });
      }
      const nowTs = Math.max(0, ...[...m.values()].map((r) => r.startedAt || 0));
      let list = [...m.values()].map((r) =>
        r.done ? r : { ...r, 未完成: true, 已等待ms: r.startedAt ? Math.round((nowTs - r.startedAt) * 1000) : null }
      );
      if (a.urlPattern) list = list.filter((r) => (r.url || '').includes(a.urlPattern));
      if (a.onlyPending) list = list.filter((r) => !r.done);
      const sort = a.sort || 'slowest';
      if (sort === 'slowest') list.sort((x, y) => (y.durationMs ?? y.已等待ms ?? 0) - (x.durationMs ?? x.已等待ms ?? 0));
      else if (sort === 'earliest') list.sort((x, y) => (x.startedAt || 0) - (y.startedAt || 0));
      else list.sort((x, y) => (y.startedAt || 0) - (x.startedAt || 0));
      return text({
        总数: m.size,
        未完成数: [...m.values()].filter((r) => !r.done).length,
        请求: list.slice(0, a.limit || 40),
      });
    }

    case 'chrome_console': {
      let list = logByTab.get(a.tabId) || [];
      if (a.pattern) {
        const re = new RegExp(a.pattern, 'i');
        list = list.filter((r) => re.test(r.text || ''));
      }
      return text({ 总数: list.length, 条目: list.slice(-(a.limit || 50)) });
    }

    case 'chrome_detach':
      return text(await callExt('cdp.detach', { tabId: a.tabId }));

    case 'chrome_cdp': {
      const params = { cdpMethod: a.method, cdpParams: a.params || {} };
      if (a.tabId !== undefined) params.tabId = a.tabId;
      else if (a.targetId !== undefined) params.targetId = a.targetId;
      else throw new Error('需要 tabId 或 targetId');
      if (a.sessionId) params.sessionId = a.sessionId;
      return text(await callExt('cdp.send', params));
    }

    case 'chrome_targets':
      return text(await callExt('cdp.targets'));

    case 'chrome_api':
      return text(await callExt('api.call', { path: a.path, args: a.args || [] }));

    case 'chrome_events': {
      switch (a.action) {
        case 'subscribe': {
          const r = await callExt('events.subscribe', { path: a.path });
          mySubs.add(a.path);
          return text(r);
        }
        case 'unsubscribe':
          mySubs.delete(a.path);
          return text(await callExt('events.unsubscribe', { path: a.path }));
        case 'list':
          return text(await callExt('events.list'));
        case 'clear':
          chromeEvents.length = 0;
          return text({ cleared: true });
        case 'read': {
          const list = a.path ? chromeEvents.filter((e) => e.path === a.path) : chromeEvents;
          return text({ 总数: list.length, 事件: list.slice(-(a.limit || 50)) });
        }
        default:
          throw new Error('未知 action: ' + a.action);
      }
    }

    case 'chrome_wait': {
      const ms = Math.min(Math.max(0, a.ms || 0), 300000);
      await sleep(ms);
      return text({ waited: ms });
    }

    default:
      throw new Error('未知工具: ' + name);
  }
}

const INSTRUCTIONS = `控制用户日常使用的 Chrome (默认 profile, 含其扩展与登录态), 经本机扩展 Chrome Bridge 的 chrome.debugger 实现。
这是用户正在用的真实浏览器: 不要关闭或刷新他已有的标签页, 需要页面时用 chrome_new_tab 自己开, 用完 chrome_close_tab 关掉。
需要他配合的操作 (保持某标签在前台、不动鼠标等) 先说清楚再做。

基本流程:
1. chrome_tabs 拿 tabId; 或 chrome_new_tab 开新标签 (active:false 可在后台开, 不打扰他)。
2. 想完整记录加载过程 (网络/console, 含跨站 iframe 与 worker), 用 chrome_navigate —— 它先附加调试器再导航。事后才附加的话, 之前的请求看不到。
3. chrome_eval 在页面里执行 JS; chrome_network / chrome_console 读记录; chrome_screenshot 截图。
4. 附加调试器时页面顶部会出现黄色提示条, 用完 chrome_detach 去掉。

进阶:
- 在文档最早期注入代码: chrome_cdp 调 Page.addScriptToEvaluateOnNewDocument, 再 chrome_navigate。
- 读跨站 iframe 内部: chrome_targets 找到它的 targetId, 再 chrome_cdp {targetId, method:"Runtime.evaluate"}。
- 阻断请求做对照: chrome_cdp Network.setBlockedURLs (只作用于页面内的子资源与 fetch/XHR, 不拦顶层导航)。
- 无痕窗口: chrome_api windows.create [{"incognito":true, "focused":false}] 得到 windowId, 再 chrome_new_tab {windowId}; 结束时 chrome_api windows.remove [windowId]。
- 任意 chrome.* API 与事件: chrome_api / chrome_events。
- 需要等待时用 chrome_wait, 不必借助 shell。

多会话:
- 同一个 Chrome 可能同时被几个 agent 会话使用, 各会话互不抢占。chrome_tabs 里 otherSessions > 0 的标签正被别的会话操作, 不要去碰。
- chrome_detach 只释放本会话的占用; 会话结束时, 它附加的调试器与事件订阅会自动释放。
- 报「扩展未接入」时, 用 chrome_status 看本会话端口与已接入的会话。

配对:
- 每个 agent 第一次使用时需要用户配对一次: 工具会返回一个 8 位配对码, 把它原样告诉用户, 请用户在 Chrome 工具栏点 Chrome Bridge 图标输入。用户说好了再重试。
- 不要自己尝试完成配对, 也不要反复调用工具刷新配对码。`;

const server = new Server(
  { name: 'chrome-bridge', version: VERSION },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
);

server.oninitialized = () => {
  clientInfo = server.getClientVersion() || null;
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    return await dispatch(req.params.name, req.params.arguments || {});
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: '失败: ' + String((e && e.message) || e) }] };
  }
});

await server.connect(new StdioServerTransport());
err('MCP 连接器已启动');

// 会话结束 (stdin 关闭, 或父进程消失被过继给 launchd) 就退出, 不留孤儿进程占着端口
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
setInterval(() => process.ppid === 1 && process.exit(0), 5000).unref();

listen().catch((e) => err('监听失败:', e));
