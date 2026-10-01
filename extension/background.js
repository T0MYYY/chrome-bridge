// Chrome Bridge for Claude Code — service worker
//
// 通过 WebSocket 连到本地 MCP 连接器. 提供三类通用出口, 新需求不必再改扩展:
//   cdp.*     任意 Chrome DevTools Protocol 方法 (经 chrome.debugger, 无需调试端口)
//   api.call  任意 chrome.* 扩展 API
//   events.*  订阅任意 chrome.* 事件并转发给连接器
// 另保留 tabs.* 几个便捷方法.
//
// 附加到标签页时会开启 Target.setAutoAttach (flatten), 跨站 iframe (OOPIF)
// 与 worker 的子会话会被自动附加并打开 Network/Runtime/Log, 它们的事件
// 带 sessionId 一并转发 — 否则这些请求对主会话是不可见的.

const WS_URL = 'ws://127.0.0.1:9333';
const PROTOCOL_VERSION = '1.3';
const RECONNECT_MS = 3000;
const TAB_DOMAINS = ['Page', 'Runtime', 'Network', 'Log'];
const CHILD_DOMAINS = ['Runtime', 'Network', 'Log'];

let ws = null;
let reconnectTimer = null;
const attached = new Map(); // key -> debuggee
const subscriptions = new Map(); // 'tabs.onUpdated' -> listener

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

// ---------- WebSocket ----------

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_MS);
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try {
    ws = new WebSocket(WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    log('已连接到 MCP 连接器');
    chrome.storage.local.set({ connected: true, lastConnect: Date.now() });
    send({ event: 'hello', version: chrome.runtime.getManifest().version });
  };

  ws.onmessage = async (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!msg || msg.id === undefined) return;
    try {
      const result = await handle(msg.method, msg.params || {});
      send({ id: msg.id, ok: true, result });
    } catch (e) {
      send({ id: msg.id, ok: false, error: String((e && e.message) || e) });
    }
  };

  ws.onclose = () => {
    ws = null;
    chrome.storage.local.set({ connected: false });
    scheduleReconnect();
  };

  ws.onerror = () => {
    try {
      ws.close();
    } catch {}
  };
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

async function handle(method, p) {
  switch (method) {
    case 'ping':
      return { pong: Date.now(), attached: [...attached.keys()], subscriptions: [...subscriptions.keys()] };

    // 便捷方法
    case 'tabs.list': {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => ({
        tabId: t.id,
        windowId: t.windowId,
        title: t.title,
        url: t.url,
        active: t.active,
        incognito: t.incognito,
        attached: attached.has('tab:' + t.id),
      }));
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
      await ensureAttached(d, p.enableDomains !== false);
      return { attached: keyOf(d) };
    }
    case 'cdp.detach': {
      const d = debuggeeOf(p);
      await detach(d);
      return { detached: keyOf(d) };
    }
    case 'cdp.send': {
      const d = debuggeeOf(p);
      await ensureAttached(stripSession(d), p.enableDomains !== false);
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
      return subscribe(p.path);
    case 'events.unsubscribe':
      return unsubscribe(p.path);
    case 'events.list':
      return [...subscriptions.keys()];

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

async function ensureAttached(d, enableDomains) {
  const k = keyOf(d);
  if (attached.has(k)) return;
  await chrome.debugger.attach(d, PROTOCOL_VERSION);
  attached.set(k, d);
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

async function detach(d) {
  const k = keyOf(d);
  if (!attached.has(k)) return;
  try {
    await chrome.debugger.detach(d);
  } catch {}
  attached.delete(k);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  // 子会话 (OOPIF / worker) 一出现就准备好, 否则收不到它的网络事件
  if (method === 'Target.attachedToTarget' && params && params.sessionId && source.tabId !== undefined) {
    prepareChild({ tabId: source.tabId, sessionId: params.sessionId });
  }
  send({
    event: 'cdp',
    tabId: source.tabId,
    targetId: source.targetId,
    sessionId: source.sessionId,
    method,
    params,
  });
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) attached.delete('tab:' + source.tabId);
  if (source.targetId !== undefined) attached.delete('target:' + source.targetId);
});

chrome.tabs.onRemoved.addListener((tabId) => attached.delete('tab:' + tabId));

// ---------- chrome.* 事件订阅 ----------

async function subscribe(path) {
  if (subscriptions.has(path)) return { subscribed: path, already: true };
  const { member: ev } = resolve(path);
  if (!ev || typeof ev.addListener !== 'function') throw new Error('chrome.' + path + ' 不是事件');
  const listener = (...args) => send({ event: 'chrome', path, at: Date.now(), args: toJSONSafe(args) });
  ev.addListener(listener);
  subscriptions.set(path, listener);
  await chrome.storage.local.set({ subscriptions: [...subscriptions.keys()] });
  return { subscribed: path };
}

async function unsubscribe(path) {
  const listener = subscriptions.get(path);
  if (!listener) return { unsubscribed: path, wasSubscribed: false };
  const { member: ev } = resolve(path);
  ev.removeListener(listener);
  subscriptions.delete(path);
  await chrome.storage.local.set({ subscriptions: [...subscriptions.keys()] });
  return { unsubscribed: path };
}

// ---------- 生命周期 ----------
// MV3 的 service worker 会被回收: 用 alarm 定期唤醒重连, 并在启动时恢复事件订阅.

chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {
  connect();
  send({ event: 'ping' });
});

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

chrome.storage.local.get('subscriptions').then(({ subscriptions: saved }) => {
  for (const path of saved || []) subscribe(path).catch((e) => log('恢复订阅失败', path, e));
});

connect();
