#!/usr/bin/env node
// Chrome Bridge MCP 连接器
//
// 一头是 MCP (stdio, 接 Claude Code), 另一头是 WebSocket 服务 (接 Chrome 扩展).
// 扩展用 chrome.debugger 提供 CDP 能力, 所以不需要 --remote-debugging-port,
// 可以直接操作日常使用的默认 profile.
//
// 除便捷工具外, chrome_cdp / chrome_api / chrome_events 三个通用出口覆盖任意
// CDP 方法、任意 chrome.* API 与事件, 新需求不必再改代码.
//
// 注意: stdout 专属于 MCP 协议, 所有日志必须走 stderr.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.CHROME_BRIDGE_PORT || 9333);
const RING = 2000;

const err = (...a) => console.error('[connector]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 与扩展的连接 ----------------

let sock = null;
let nextId = 1;
const pending = new Map();

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

const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });
wss.on('listening', () => err(`WebSocket 服务已就绪 127.0.0.1:${PORT}, 等待扩展接入`));
wss.on('error', (e) => err('WebSocket 服务出错:', e.message));

wss.on('connection', (s) => {
  err('扩展已接入');
  sock = s;
  s.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.event === 'cdp') return onCdpEvent(msg.tabId, msg.sessionId, msg.method, msg.params || {});
    if (msg.event === 'chrome') return ringPush(chromeEvents, { path: msg.path, at: msg.at, args: msg.args });
    if (msg.event) return;
    const p = pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error || '扩展返回错误'));
  });
  s.on('close', () => {
    if (sock === s) sock = null;
    err('扩展已断开');
  });
});

function callExt(method, params = {}, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    if (!sock || sock.readyState !== 1) {
      return reject(new Error('扩展未接入。请确认 Chrome 中已加载 Chrome Bridge 扩展, 且它的弹窗显示「已连接」。'));
    }
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('扩展响应超时: ' + method));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    sock.send(JSON.stringify({ id, method, params }));
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
    description: '列出 Chrome 所有标签页 (tabId, windowId, 标题, URL, 是否无痕, 是否已附加调试器)。',
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
    description: '解除对标签页的调试器附加, 页面顶部的黄色提示条随之消失。',
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
      'webRequest.onErrorOccurred。订阅跨 service worker 重启保留。',
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
        case 'subscribe':
          return text(await callExt('events.subscribe', { path: a.path }));
        case 'unsubscribe':
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
- 需要等待时用 chrome_wait, 不必借助 shell。`;

const server = new Server(
  { name: 'chrome-bridge', version: '1.0.0' },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
);

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
