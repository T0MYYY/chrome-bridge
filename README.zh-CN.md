# Chrome Bridge

[English](README.md) · **中文**

一个 MCP server，让 AI agent 直接操作**你日常在用的 Chrome**：默认 profile、登录状态、cookie 和扩展都是现成的。不需要 `--remote-debugging-port`，也不用另开一个自动化浏览器。任何 MCP 客户端都能用，包括 Claude Code、Codex 等。

分两部分：

- **扩展**（`extension/`）：MV3 扩展，通过 `chrome.debugger` 提供 Chrome DevTools Protocol 能力，并开放全部 `chrome.*` API。
- **连接器**（`connector/`）：由 agent 启动的 stdio MCP server，与扩展之间走一条经过鉴权、加密的本机 WebSocket。

```
agent ──stdio/MCP──▶ 连接器 (127.0.0.1:9333–9352) ◀══ 加密 WebSocket ══ 扩展 ──chrome.debugger──▶ 你的标签页
```

## 特性

- **真实的浏览器会话**：打开的页面已经是登录状态，你装的扩展也照常生效。
- **每个 agent 只配对一次**：agent 第一次连上时，你在扩展弹窗里输入一个 8 位码；之后它的所有会话都静默接入。本机其他软件没法简单连上来接管你的浏览器（见[安全](#安全)）。
- **完整的网络与 console 记录**，包括跨站 iframe（OOPIF）和 worker。`chrome_navigate` 先附加调试器再导航，从第一个字节开始记录。
- **通用出口**：任意 CDP 方法（`chrome_cdp`）、任意 `chrome.*` API（`chrome_api`）、任意 `chrome.*` 事件（`chrome_events`）。
- **多个会话可以同时使用**：每个 agent 会话有自己的端口，扩展会跟所有会话都连上。调试器附加和事件订阅按会话做引用计数，一个会话 detach 或退出，绝不会影响其他会话。新会话不到 1 秒就能被发现。

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
| `chrome_status` | agent 身份、配对状态（待配对时附配对码）、端口，以及所有已接入的会话 |
| `chrome_wait` | 等待一段时间，不用借助 shell |

## 安装

需要 Chrome 116+、Node.js 18+，以及一个 MCP 客户端。

```bash
git clone https://github.com/T0MYYY/chrome-bridge.git
cd chrome-bridge/connector && npm install
```

1. **加载扩展**：打开 `chrome://extensions`，开启「开发者模式」，点「加载已解压的扩展程序」，选择 `extension/` 目录。
2. **在 agent 中注册 MCP server**：

   **Claude Code**

   ```bash
   claude mcp add -s user chrome-bridge -- node /绝对路径/chrome-bridge/connector/index.js
   ```

   **Codex**（`~/.codex/config.toml`）

   ```toml
   [mcp_servers.chrome-bridge]
   command = "node"
   args = ["/绝对路径/chrome-bridge/connector/index.js"]
   ```

   **其他 MCP 客户端**（常见的 JSON 写法）

   ```json
   { "mcpServers": { "chrome-bridge": { "command": "node", "args": ["/绝对路径/chrome-bridge/connector/index.js"] } } }
   ```

3. **配对**：让 agent 在 Chrome 里做任意一件事，它的第一次工具调用会返回一个类似 `K7Q2-M9XD` 的码。点 Chrome 工具栏上的 Chrome Bridge 图标（同时会弹出系统通知），输入这个码，输满 8 位就自动配对。这个 agent 以后都不用再配对。

以后更新：`git pull`，在 `chrome://extensions` 重新加载扩展，然后在正在运行的会话里执行一次客户端的 MCP 重连（例如 Claude Code 的 `/mcp`）。

## 配对与 agent 身份

- **什么算「同一个 agent」**：在 macOS 上，连接器沿父进程链往上找（跳过 shell 和 `npx` 这类启动器）到 agent 进程，用 `codesign` 校验这个**运行中进程的代码签名**，身份记为「团队 ID + 标识符」。例如 Claude Code 是 `Q6L2SF6YDW:com.anthropic.claude-code`（Anthropic PBC），Codex 是 `2DC432GLL2:codex`。agent 升级后身份不变。没有签名的 agent（例如 Node 写的 CLI）退化为按脚本或可执行文件路径识别。完全无法识别时，使用只在当前会话有效的内存身份。
- **凭据**：每个 agent 有一把 P-256 签名密钥。macOS 上存在**钥匙串**里，经 `security -i` 从 stdin 写入，不会出现在进程列表中；其他系统存在 `~/.config/chrome-bridge/agents/*.json`，权限 `0600`。扩展也有一把自己的、不可导出的密钥，存在 IndexedDB 里。
- **握手**（SIGMA 结构，只用标准 WebCrypto）：双方对「双方静态公钥 + 本次新生成的 ECDH 公钥」的握手记录签名，再派生出两个方向各一把 AES-GCM 密钥。之后每一帧都加密并带序号。
- **配对证明**：配对码有 40 bit 熵，经 PBKDF2（30 万次迭代）处理，以 agent 公钥为盐，并绑定到这条通道的握手记录。双方都必须证明自己知道这个码；连续猜错 3 次，码就作废。
- **管理**：弹窗里列出已配对的 agent（含签名强度、最近使用时间），可以**撤销**。撤销后它的会话立即断开，该 agent 会换一把新密钥，需要重新配对。

## 安全

能防住的：

- **本机程序冒充连接器**（在端口区间里监听）：它没有已配对的密钥，最多只能发起一个配对请求，而你手里不会有它的码，忽略即可。
- **程序自己启动连接器**，想蹭某个 agent 的配对：它作为父进程，签名对不上，会被当作一个新的、未配对的 agent。
- **程序冒充扩展**，想给 agent 喂假结果：没有受信任的密钥，没有码也过不了配对，握手直接失败。
- **在中间转发、注入、篡改或重放流量**：通道端到端加密，每帧带序号。
- **网页**：只接受来自 `chrome-extension://` 的 WebSocket 连接；探测地址不返回 CORS 头。

防不住的：**以你的用户身份运行、专门针对这个工具的恶意程序**。比如读取 agent 的钥匙串项（知道条目名的话，`security` 就能读出来）、注入 agent 或 Chrome 进程、借辅助功能权限替你点弹窗。桌面系统对同一用户下的程序本来就隔离不彻底，Chrome 自己的 cookie 也是这个级别的保护。我们的目标是：其他软件**没法简单访问**你的浏览器，要访问就必须专门针对这个工具来攻击。

为了让 `chrome_api` 能调用任意 API，扩展申请了很宽的权限（`debugger`、`<all_urls>` 等）。已配对的 agent 实际上拥有浏览器的完全控制权，只配对你信任的 agent。

## 多会话的原理

- 每个连接器占用 `127.0.0.1:9333–9352` 中第一个空闲端口。20 个都被占时，每 2 秒重试一次。
- 扩展每秒用普通 HTTP（`GET /chrome-bridge`）探测这段端口，探到连接器再建 WebSocket。之所以用 HTTP 来发现，是因为 Chrome 会对反复**失败的 WebSocket 连接**限流：实测直接用 WebSocket 扫 20 个端口，新连接会被推迟 7–26 秒。
- 回复和 CDP 事件按连接分别投递。一个标签页的调试器，要等**最后一个**在用它的会话 detach 或断开后才真正解除。
- agent 会话结束时，它的连接器会退出（stdin 关闭或父进程消失），扩展随即释放这个会话占用的一切。
- service worker 靠每 20 秒一次的心跳保持常驻，占约十几 MB 内存，所以 Chrome 闲置很久之后，发现新会话也一样快。
- 两个会话同时用同一个标签页时，CDP 状态是共享的。`chrome_tabs` 会标出其他会话正在用的标签页。

## 排障

- **提示「未配对」**：工具结果里有配对码，点 Chrome 工具栏的 Chrome Bridge 图标输入即可。`chrome_status` 也会显示这个码。
- **提示「扩展未接入」**：先用 `chrome_status` 看本会话的端口，再打开扩展弹窗（打开弹窗时也会立即重扫一次端口）。确认扩展已启用，且版本是 3.x。
- **标签页上一直有黄色「正在调试」提示条**：可能有其他会话还在用它（看 `chrome_tabs` 的 `otherSessions`），也可以调用 `chrome_detach`。在黄条上点「取消」会让所有会话都从这个标签页断开，下次命令会自动重新附加。
- 日志：连接器的日志写到 stderr；扩展的日志在 `chrome://extensions` → Chrome Bridge →「Service Worker」。

## 开发

```bash
node test/protocol.test.mjs      # 握手、配对与各类攻击场景 (内存中)
node test/integration.test.mjs   # 真实连接器进程 + 模拟扩展
```

`CHROME_BRIDGE_PORT` 用来改连接器的起始端口（默认 `9333`）。改了它，也要同步改 `extension/background.js` 里的 `BASE_PORT`。两边的 `PORT_SPAN`（20）必须一致。

## 许可证

[MIT](LICENSE)
