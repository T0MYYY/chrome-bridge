// Chrome Bridge for Claude Code — service worker
//
// 通过 WebSocket 连到本地 MCP 连接器. 提供三类通用出口, 新需求不必再改扩展:
//   cdp.*     任意 Chrome DevTools Protocol 方法 (经 chrome.debugger, 无需调试端口)
//   api.call  任意 chrome.* 扩展 API
//   events.*  订阅任意 chrome.* 事件并转发给连接器
// 另保留 tabs.* 几个便捷方法.
//
// 多会话: 每个 Claude Code 会话有自己的连接器, 各占 9333 起的一个端口.
// 这里扫描整个区间, 对每个连接器各维持一条连接 (conn). 命令从哪条连接来,
// 结果就回哪条; 调试器附加与事件订阅按 conn 记账 (引用计数), 一个会话
// detach 或退出, 只释放它自己的那份, 不会把别的会话正在用的标签断掉.
//
// 附加到标签页时会开启 Target.setAutoAttach (flatten), 跨站 iframe (OOPIF)
// 与 worker 的子会话会被自动附加并打开 Network/Runtime/Log, 它们的事件
// 带 sessionId 一并转发 — 否则这些请求对主会话是不可见的.

const BASE_PORT = 9333;
const PORT_SPAN = 20; // 必须与连接器 index.js 的 PORT_SPAN 一致
const PROTOCOL = 2;
const SCAN_MS = 1000;
const PROBE_TIMEOUT_MS = 800;
const FOREIGN_RETRY_MS = 30000; // 端口上是别的程序: 少去打扰它
const HANDSHAKE_MS = 3000;
const KEEPALIVE_MS = 20000; // 扩展 API 调用与 WebSocket 消息会重置 service worker 的 30 秒空闲计时
const PROTOCOL_VERSION = '1.3';
const TAB_DOMAINS = ['Page', 'Runtime', 'Network', 'Log'];
const CHILD_DOMAINS = ['Runtime', 'Network', 'Log'];

const conns = new Map(); // port -> conn { port, ws, ready, info }
const retryAt = new Map(); // port -> at  在此之前不再探测该端口
const probing = new Set(); // 正在探测的端口
const attached = new Map(); // key -> { d, owners: Set<conn> }
const attaching = new Map(); // key -> Promise  并发附加去重
const subscriptions = new Map(); // 'tabs.onUpdated' -> { ev, listener, conns: Set<conn> }

const log = (...a) => console.log('[bridge]', ...a);

// ---------- 序列化 ----------
// chrome.* 的返回值可能带函数或 ArrayBuffer, 统一转成可 JSON 的形式.

function toJSONSafe(v, depth = 0) {
  if (v === undefined) return null;
  if (typeof v === 'function') return '[function]';
  if (v === null || typeof v !== 'object') return v;
  if (depth > 10) return '[depth-limit]';
  if (v instanceof ArrayBuffer) return { __arrayBuffer: v.byteLength };
  if (Array.isArray(v)) return v.map((x) => toJSONSafe(x, depth + 1));
  const out = {};
  for (const k of Object.keys(v)) out[k] = toJSONSafe(v[k], depth + 1);
  return out;
}

// ---------- 连接管理 ----------

function send(conn, obj) {
  if (conn.ready && conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(obj));
}

// 发现: 先用普通 HTTP 探测, 确认端口上是连接器再建 WebSocket.
// 不直接对每个端口开 WebSocket, 是因为 Chrome 会对连续失败的 WebSocket 连接限流
// (实测一轮 20 个端口全失败后, 新连接被推迟 7-26 秒), 而 fetch 被拒不受此限,
// 本机端口被拒只需几毫秒.
function scan() {
  const now = Date.now();
  for (let port = BASE_PORT; port < BASE_PORT + PORT_SPAN; port++) {
    if (conns.has(port) || probing.has(port) || now < (retryAt.get(port) || 0)) continue;
    probe(port);
  }
}

async function probe(port) {
  probing.add(port);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/chrome-bridge`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const body = await r.text();
    let info = null;
    try {
      info = JSON.parse(body);
    } catch {}
    // 2.0 版连接器没有探测地址, 对任何 HTTP 请求回 426 加这句话; 协议相同, 照样接入
    const legacy = r.status === 426 && body.startsWith('chrome-bridge connector');
    if (legacy || (info?.bridge === 'chrome-bridge' && info.protocol === PROTOCOL)) {
      if (!conns.has(port)) open(port);
    } else {
      retryAt.set(port, Date.now() + FOREIGN_RETRY_MS);
    }
  } catch {
    // 没人监听: 下一轮再探
  } finally {
    probing.delete(port);
  }
}

function open(port) {
  let ws;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}`);
  } catch {
    return retryAt.set(port, Date.now() + 2000);
  }
  const conn = { port, ws, ready: false, info: null };
  conns.set(port, conn);
  // 端口上可能是别的程序或旧版连接器: 限时内没收到 welcome 就放弃
  const handshake = setTimeout(() => ws.close(), HANDSHAKE_MS);

  ws.onmessage = async (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!conn.ready) {
      if (msg?.event !== 'welcome' || msg.bridge !== 'chrome-bridge' || msg.protocol !== PROTOCOL) return ws.close();
      clearTimeout(handshake);
      conn.ready = true;
      conn.info = { pid: msg.pid, cwd: msg.cwd, version: msg.version, startedAt: msg.startedAt };
      retryAt.delete(port);
      log('已接入会话', port, msg.cwd);
      send(conn, { event: 'hello', version: chrome.runtime.getManifest().version });
      return publishStatus();
    }
    if (!msg || msg.id === undefined) return;
    try {
      const result = await handle(msg.method, msg.params || {}, conn);
      send(conn, { id: msg.id, ok: true, result });
    } catch (e) {
      send(conn, { id: msg.id, ok: false, error: String((e && e.message) || e) });
    }
  };

  ws.onclose = (ev) => {
    clearTimeout(handshake);
    if (conns.get(port) === conn) conns.delete(port);
    if (conn.ready) {
      log('会话断开', port);
      release(conn);
      retryAt.delete(port); // 端口很可能马上被新会话复用, 立即重扫
      publishStatus();
    } else {
      // 4001: 该连接器已服务另一个扩展实例 (另一个 Chrome profile)
      retryAt.set(port, Date.now() + (ev.code === 4001 ? FOREIGN_RETRY_MS : 2000));
    }
  };

  ws.onerror = () => {};
}

// 会话断开: 释放它占用的调试器附加与事件订阅
function release(conn) {
  for (const [k, e] of attached) {
    if (e.owners.delete(conn) && e.owners.size === 0) realDetach(k, e.d);
  }
  for (const path of [...subscriptions.keys()]) dropSubscriber(path, conn);
}

function readyConns() {
  return [...conns.values()].filter((c) => c.ready);
}

function status(conn) {
  return {
    扩展版本: chrome.runtime.getManifest().version,
    会话: readyConns().map((c) => ({
      本会话: c === conn,
      端口: c.port,
      pid: c.info.pid,
      目录: c.info.cwd,
      启动于: new Date(c.info.startedAt).toLocaleString(),
      附加的标签: [...attached].filter(([, e]) => e.owners.has(c)).map(([k]) => k),
      订阅: [...subscriptions].filter(([, s]) => s.conns.has(c)).map(([p]) => p),
    })),
  };
}

function publishStatus() {
  chrome.storage.session
    .set({ sessions: readyConns().map((c) => ({ port: c.port, pid: c.info.pid, cwd: c.info.cwd })) })
    .catch(() => {});
}

// ---------- chrome.* 路径解析 ----------

function resolve(path) {
  const parts = String(path).split('.');
  let owner = chrome;
  for (const seg of parts.slice(0, -1)) {
    owner = owner ? owner[seg] : undefined;
    if (owner == null) throw new Error('chrome.' + path + ' 不存在 (可能缺权限)');
  }
  return { owner, member: owner[parts[parts.length - 1]] };
}

// ---------- 命令分发 ----------

async function handle(method, p, conn) {
  await staleCleanup;
  switch (method) {
    case 'ping':
      return { pong: Date.now(), ...status(conn) };
    case 'bridge.status':
      return status(conn);

    // 便捷方法
    case 'tabs.list': {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => {
        const owners = attached.get('tab:' + t.id)?.owners;
        const mine = !!owners?.has(conn);
        return {
          tabId: t.id,
          windowId: t.windowId,
          title: t.title,
          url: t.url,
          active: t.active,
          incognito: t.incognito,
          attached: mine,
          otherSessions: owners ? owners.size - (mine ? 1 : 0) : 0,
        };
      });
    }
    case 'tabs.create': {
      const opts = { url: p.url || 'about:blank', active: p.active !== false };
      const windowId = p.windowId !== undefined ? p.windowId : await defaultWindowId();
      if (windowId !== undefined) opts.windowId = windowId;
      const tab = await chrome.tabs.create(opts);
      return { tabId: tab.id, windowId: tab.windowId, incognito: tab.incognito };
    }
    case 'tabs.close':
      await chrome.tabs.remove(p.tabId);
      attached.delete('tab:' + p.tabId);
      return { closed: p.tabId };

    // 通用 CDP
    case 'cdp.targets':
      return toJSONSafe(await chrome.debugger.getTargets());
    case 'cdp.attach': {
      const d = debuggeeOf(p);
      await ensureAttached(d, p.enableDomains !== false, conn);
      return { attached: keyOf(d), otherSessions: attached.get(keyOf(d)).owners.size - 1 };
    }
    case 'cdp.detach':
      return detach(debuggeeOf(p), conn);
    case 'cdp.send': {
      const d = debuggeeOf(p);
      await ensureAttached(stripSession(d), p.enableDomains !== false, conn);
      return (await chrome.debugger.sendCommand(d, p.cdpMethod, p.cdpParams || {})) ?? null;
    }

    // 通用 chrome.* API
    case 'api.call': {
      const { owner, member } = resolve(p.path);
      if (typeof member !== 'function') return toJSONSafe(member);
      return toJSONSafe(await member.apply(owner, p.args || []));
    }

    // 通用 chrome.* 事件
    case 'events.subscribe':
      return subscribe(p.path, conn);
    case 'events.unsubscribe':
      return unsubscribe(p.path, conn);
    case 'events.list':
      return [...subscriptions].filter(([, s]) => s.conns.has(conn)).map(([path]) => path);

    default:
      throw new Error('未知方法: ' + method);
  }
}

// 没指定窗口时开在普通窗口里: 用户此刻若在用无痕窗口, 不往他的无痕窗口里塞标签.
async function defaultWindowId() {
  const last = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  if (last && !last.incognito) return last.id;
  const normal = (await chrome.windows.getAll({ windowTypes: ['normal'] })).find((w) => !w.incognito);
  return normal ? normal.id : undefined;
}

// ---------- chrome.debugger 封装 ----------

function debuggeeOf(p) {
  let d;
  if (p.tabId !== undefined) d = { tabId: p.tabId };
  else if (p.targetId !== undefined) d = { targetId: p.targetId };
  else if (p.extensionId !== undefined) d = { extensionId: p.extensionId };
  else throw new Error('需要 tabId / targetId / extensionId 之一');
  if (p.sessionId) d.sessionId = p.sessionId;
  return d;
}

const stripSession = ({ sessionId, ...rest }) => rest;

const keyOf = (d) =>
  d.tabId !== undefined ? 'tab:' + d.tabId : d.targetId !== undefined ? 'target:' + d.targetId : 'ext:' + d.extensionId;

const keyOfSource = (s) => (s.tabId !== undefined ? 'tab:' + s.tabId : s.targetId !== undefined ? 'target:' + s.targetId : 'ext:' + s.extensionId);

// 多个会话共用同一个附加: 第一个来的真正 attach, 后来的只登记为 owner
// 附加进行中 (还在开 domain) 时后来的会话也要等它做完, 否则命令会早于 Network.enable 发出
async function ensureAttached(d, enableDomains, conn) {
  const k = keyOf(d);
  if (attaching.has(k)) await attaching.get(k);
  else if (!attached.has(k)) {
    attaching.set(k, doAttach(d, enableDomains).finally(() => attaching.delete(k)));
    await attaching.get(k);
  }
  const e = attached.get(k);
  if (!e) throw new Error(k + ' 刚附加就被解除了 (标签关闭或用户点了取消), 请重试');
  e.owners.add(conn);
}

async function doAttach(d, enableDomains) {
  try {
    await chrome.debugger.attach(d, PROTOCOL_VERSION);
  } catch (e) {
    const m = String((e && e.message) || e);
    if (/already attached/i.test(m)) throw new Error('该页面已被其他调试器占用 (DevTools 或别的扩展), 无法附加: ' + m);
    throw e;
  }
  attached.set(keyOf(d), { d, owners: new Set() });
  if (!enableDomains || d.tabId === undefined) return;
  for (const dom of TAB_DOMAINS) {
    await chrome.debugger.sendCommand(d, dom + '.enable', {}).catch((e) => log('enable 失败', dom, e));
  }
  await chrome.debugger
    .sendCommand(d, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
    .catch((e) => log('setAutoAttach 失败', e));
}

// 子会话启动时是暂停的: 先打开它的 domain 并让它继续自动附加更深层的子目标,
// 然后放行. 否则子框架最早的请求 (常常走缓存, 0ms) 会在开记录之前就发完.
// 放行放在 finally 里, 任何一步失败都不能让子框架一直挂着.
async function prepareChild(child) {
  try {
    for (const dom of CHILD_DOMAINS) await chrome.debugger.sendCommand(child, dom + '.enable', {}).catch(() => {});
    await chrome.debugger
      .sendCommand(child, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
      .catch(() => {});
  } finally {
    chrome.debugger.sendCommand(child, 'Runtime.runIfWaitingForDebugger', {}).catch(() => {});
  }
}

async function detach(d, conn) {
  const k = keyOf(stripSession(d));
  const e = attached.get(k);
  if (!e || !e.owners.has(conn)) return { detached: k, wasAttached: false };
  e.owners.delete(conn);
  if (e.owners.size > 0) return { detached: k, stillUsedBy: e.owners.size, 说明: '其他会话仍在使用, 黄条保留' };
  await realDetach(k, e.d);
  return { detached: k };
}

async function realDetach(k, d) {
  attached.delete(k);
  try {
    await chrome.debugger.detach(d);
  } catch {}
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  // 子会话 (OOPIF / worker) 一出现就准备好, 否则收不到它的网络事件
  if (method === 'Target.attachedToTarget' && params && params.sessionId && source.tabId !== undefined) {
    prepareChild({ tabId: source.tabId, sessionId: params.sessionId });
  }
  const e = attached.get(keyOfSource(source));
  if (!e) return;
  const msg = { event: 'cdp', tabId: source.tabId, targetId: source.targetId, sessionId: source.sessionId, method, params };
  for (const c of e.owners) send(c, msg);
});

// 用户点了黄条上的「取消」、标签关闭或页面崩溃: 通知所有在用的会话
chrome.debugger.onDetach.addListener((source, reason) => {
  const k = keyOfSource(source);
  const e = attached.get(k);
  if (!e) return;
  attached.delete(k);
  for (const c of e.owners) send(c, { event: 'detached', key: k, reason });
});

chrome.tabs.onRemoved.addListener((tabId) => attached.delete('tab:' + tabId));

// service worker 重启后, 上一代留下的附加已无人记账: 启动时统一解除.
// detach 只能解除本扩展自己的附加, 不会误伤 DevTools 或别的扩展.
const staleCleanup = chrome.debugger
  .getTargets()
  .then((targets) =>
    Promise.all(
      targets
        .filter((t) => t.attached)
        .map((t) => chrome.debugger.detach(t.tabId !== undefined ? { tabId: t.tabId } : { targetId: t.id }).catch(() => {}))
    )
  )
  .catch(() => {});

// ---------- chrome.* 事件订阅 ----------
// 每个事件只挂一个 listener, 转发给订阅了它的会话.

function subscribe(path, conn) {
  let s = subscriptions.get(path);
  if (!s) {
    const { member: ev } = resolve(path);
    if (!ev || typeof ev.addListener !== 'function') throw new Error('chrome.' + path + ' 不是事件');
    s = { ev, conns: new Set(), listener: null };
    s.listener = (...args) => {
      const msg = { event: 'chrome', path, at: Date.now(), args: toJSONSafe(args) };
      for (const c of s.conns) send(c, msg);
    };
    ev.addListener(s.listener);
    subscriptions.set(path, s);
  }
  const already = s.conns.has(conn);
  s.conns.add(conn);
  return already ? { subscribed: path, already: true } : { subscribed: path };
}

function unsubscribe(path, conn) {
  const wasSubscribed = !!subscriptions.get(path)?.conns.has(conn);
  dropSubscriber(path, conn);
  return { unsubscribed: path, wasSubscribed };
}

function dropSubscriber(path, conn) {
  const s = subscriptions.get(path);
  if (!s || !s.conns.delete(conn) || s.conns.size > 0) return;
  s.ev.removeListener(s.listener);
  subscriptions.delete(path);
}

// ---------- 生命周期 ----------
// MV3 的 service worker 空闲 30 秒会被回收, 回收后只能靠 alarm (最短 30 秒) 唤醒,
// 新会话就得等那么久. 所以让它常驻: 每 20 秒调一次扩展 API 重置空闲计时.
// alarm 仍保留, 万一被回收 (例如 Chrome 更新) 也能自己恢复.

chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(scan);
chrome.runtime.onStartup.addListener(scan);
chrome.runtime.onInstalled.addListener(scan);

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== 'status') return;
  scan();
  reply({ version: chrome.runtime.getManifest().version, basePort: BASE_PORT, span: PORT_SPAN, ...status(null) });
});

setInterval(scan, SCAN_MS);
setInterval(() => {
  chrome.runtime.getPlatformInfo();
  for (const c of readyConns()) send(c, { event: 'ping' });
}, KEEPALIVE_MS);

scan();
