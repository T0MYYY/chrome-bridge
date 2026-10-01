# Chrome Bridge for Claude Code

[English](README.md) · **中文**

一个 MCP server，让 Claude Code 直接操作**你日常在用的 Chrome**：默认 profile、登录状态、cookie 和扩展都是现成的。不需要 `--remote-debugging-port`，也不用另开一个自动化浏览器。

分两部分：

- **扩展**（`extension/`）：MV3 扩展，通过 `chrome.debugger` 提供 Chrome DevTools Protocol 能力，并开放全部 `chrome.*` API。
- **连接器**（`connector/`）：由 Claude Code 启动的 stdio MCP server，通过本机 WebSocket 与扩展通信。

```
Claude Code ──stdio/MCP──▶ 连接器 (127.0.0.1:9333–9352) ◀──WebSocket── Chrome 扩展 ──chrome.debugger──▶ 你的标签页
```

## 特性

- **真实的浏览器会话**：打开的页面已经是登录状态，你装的扩展也照常生效。
- **完整的网络与 console 记录**，包括跨站 iframe（OOPIF）和 worker。`chrome_navigate` 先附加调试器再导航，从第一个字节开始记录。
- **通用出口**：任意 CDP 方法（`chrome_cdp`）、任意 `chrome.*` API（`chrome_api`）、任意 `chrome.*` 事件（`chrome_events`）。有新需求时很少需要改代码。
- **多个 Claude Code 会话可以同时使用**：每个会话有自己的端口，扩展会跟所有会话都连上。调试器附加和事件订阅按会话做引用计数，一个会话 detach 或退出，绝不会影响其他会话。新会话大约 1 秒内就能被发现，永远不需要用 `/mcp` 手动重连。

## 工具

| 工具 | 作用 |
|---|---|
| `chrome_tabs` | 列出标签页。`attached` 表示本会话已附加；`otherSessions` 大于 0 表示有其他会话在用 |
| `chrome_new_tab` / `chrome_close_tab` | 开、关标签页（`active:false` 在后台打开） |
| `chrome_navigate` | 先附加再导航，然后等页面到达指定的 `readyState` |
| `chrome_eval` | 在页面里执行 JS，支持顶层 `await` |
| `chrome_screenshot` | 截可视区域或整页，返回 PNG |
| `chrome_network` / `chrome_console` | 读取记录下来的网络请求，以及 console、日志和异常，含 iframe 与 worker |
| `chrome_detach` | 释放本会话的调试器附加 |
| `chrome_cdp` / `chrome_targets` | 对标签页、target 或子会话发送任意 CDP 方法 |
| `chrome_api` | 任意 `chrome.*` API，如 `windows.create`、`cookies.getAll` |
| `chrome_events` | 订阅、读取、退订任意 `chrome.*` 事件 |
| `chrome_status` | 桥接状态：本会话的端口，以及所有已接入的会话 |
| `chrome_wait` | 等待一段时间，不用借助 shell |

## 安装

需要 Chrome 116+、Node.js 18+ 和 Claude Code。

```bash
git clone https://github.com/T0MYYY/chrome-bridge.git
cd chrome-bridge/connector && npm install
```

1. **加载扩展**：打开 `chrome://extensions`，开启「开发者模式」，点「加载已解压的扩展程序」，选择 `extension/` 目录。
2. **在 Claude Code 中注册 MCP server**。用 user 作用域，所有项目都能用：

   ```bash
   claude mcp add -s user chrome-bridge -- node /绝对路径/chrome-bridge/connector/index.js
   ```

3. 启动 Claude Code，让它调用 `chrome_status` 确认连通。扩展弹窗会列出所有已接入的会话。

以后更新：`git pull`，在 `chrome://extensions` 重新加载扩展，然后在正在运行的会话里执行一次 `/mcp`。

## 多会话的原理

- 每个连接器占用 `127.0.0.1:9333–9352` 中第一个空闲端口。20 个都被占时，每 2 秒重试一次。
- 扩展每秒用普通 HTTP（`GET /chrome-bridge`）探测这段端口，探到连接器后再建 WebSocket。之所以用 HTTP 来发现，是因为 Chrome 会对反复**失败的 WebSocket 连接**限流：实测直接用 WebSocket 扫 20 个端口，新连接会被推迟 7–26 秒。而对本机发 `fetch` 被拒绝，只要几毫秒。
- 回复和 CDP 事件按连接分别投递。一个标签页的调试器，要等**最后一个**在用它的会话 detach 或断开后才真正解除。
- Claude Code 会话结束时，它的连接器会退出（stdin 关闭或父进程消失），WebSocket 断开，扩展随即释放这个会话占用的一切。
- service worker 靠每 20 秒一次的心跳保持常驻，所以 Chrome 闲置很久之后，发现新会话也一样快。代价是 service worker 常驻内存，约十几 MB。
- 两个会话同时用同一个标签页时，CDP 状态是共享的（比如 `Network.setBlockedURLs`）。`chrome_tabs` 会标出其他会话正在用的标签页，Claude 会避开它们。

## 安全

这个桥按设计就权限很大：任何能连上连接器的程序，都能读取并操作你已登录的浏览器。

- 连接器**只监听 127.0.0.1**。
- **只接受来自 `chrome-extension://` 的 WebSocket 连接**，网页无法连到本机端口冒充扩展。
- 探测地址不返回 CORS 头，网页读不到它的响应。
- 为了让 `chrome_api` 能调用任意 API，扩展申请了很宽的权限（`debugger`、`<all_urls>` 等）。如果想要更窄的桥，可以审阅并精简 `extension/manifest.json`。
- 本机以你的用户身份运行的任何进程都能访问 `127.0.0.1`，信任边界就是这台机器上的用户账号。

## 排障

- **报「扩展未接入」**：先用 `chrome_status` 看本会话的端口，再打开扩展弹窗（打开弹窗时也会立即重扫一次端口）。确认扩展已启用，且版本是 2.x。
- **用完后标签页上还有黄色「正在调试」提示条**：可能有其他会话还在用它（看 `chrome_tabs` 的 `otherSessions`），也可以调用 `chrome_detach`。
- **在黄条上点「取消」**：所有会话都会从这个标签页断开，下次命令会自动重新附加。
- 日志：连接器的日志写到 stderr；扩展的日志在 `chrome://extensions` → Chrome Bridge →「Service Worker」。

## 配置

`CHROME_BRIDGE_PORT` 用来改连接器的起始端口（默认 `9333`）。改了它，也要同步改 `extension/background.js` 里的 `BASE_PORT`。两边的 `PORT_SPAN`（20）必须一致。
