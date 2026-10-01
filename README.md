# Chrome Bridge for Claude Code

**English** · [中文](README.zh-CN.md)

An MCP server that lets Claude Code drive **the Chrome you already use**: your default profile, logins, cookies and extensions. There's no `--remote-debugging-port` and no separate automation browser.

It has two parts:

- **Extension** (`extension/`): an MV3 extension that exposes the Chrome DevTools Protocol through `chrome.debugger` and gives access to every `chrome.*` API.
- **Connector** (`connector/`): a stdio MCP server that Claude Code launches. It talks to the extension over a local WebSocket.

```
Claude Code ──stdio/MCP──▶ connector (127.0.0.1:9333–9352) ◀──WebSocket── Chrome extension ──chrome.debugger──▶ your tabs
```

## Features

- **Your real browser session.** Pages open already logged in, with your extensions active.
- **Full network and console capture**, including cross-origin iframes (OOPIF) and workers. `chrome_navigate` attaches before it navigates, so capture starts at the first byte.
- **Generic escape hatches**: arbitrary CDP methods (`chrome_cdp`), arbitrary `chrome.*` APIs (`chrome_api`), and arbitrary `chrome.*` events (`chrome_events`). New needs rarely require code changes.
- **Multiple Claude Code sessions at once.** Each session gets its own port and the extension connects to all of them. Debugger attachments and event subscriptions are reference-counted per session, so one session detaching or exiting never breaks another. New sessions are discovered within about a second. You never have to run `/mcp` to reconnect.

## Tools

| Tool | What it does |
|---|---|
| `chrome_tabs` | List tabs. `attached` = attached by this session; `otherSessions` > 0 = another session is using it |
| `chrome_new_tab` / `chrome_close_tab` | Open and close tabs (`active:false` opens in the background) |
| `chrome_navigate` | Attach, then navigate, then wait for a `readyState` |
| `chrome_eval` | Run JS in the page (top-level `await` supported) |
| `chrome_screenshot` | PNG of the viewport or the full page |
| `chrome_network` / `chrome_console` | Captured requests and console/log/exception entries, including iframes and workers |
| `chrome_detach` | Release this session's debugger attachment |
| `chrome_cdp` / `chrome_targets` | Any CDP method on a tab, a target or a child session |
| `chrome_api` | Any `chrome.*` API, e.g. `windows.create`, `cookies.getAll` |
| `chrome_events` | Subscribe to, read and unsubscribe from any `chrome.*` event |
| `chrome_status` | Bridge status: this session's port and every connected session |
| `chrome_wait` | Sleep without a shell |

## Install

Requirements: Chrome 116+, Node.js 18+, Claude Code.

```bash
git clone https://github.com/T0MYYY/chrome-bridge.git
cd chrome-bridge/connector && npm install
```

1. **Load the extension.** Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and select the `extension/` folder.
2. **Register the MCP server** with Claude Code (user scope, so it's available in every project):

   ```bash
   claude mcp add -s user chrome-bridge -- node /absolute/path/to/chrome-bridge/connector/index.js
   ```

3. Start Claude Code and ask it to call `chrome_status`. The extension popup lists every connected session.

To update later, `git pull`, reload the extension in `chrome://extensions`, and run `/mcp` in any running sessions.

## How multi-session works

- Each connector binds the first free port in `127.0.0.1:9333–9352`. If all 20 are busy, it retries every 2 s.
- The extension probes that range every second with plain HTTP (`GET /chrome-bridge`), then opens a WebSocket to every connector it finds. It uses HTTP for discovery because Chrome throttles repeated *failed WebSocket* connections: probing 20 ports with WebSockets delayed new connections by 7–26 s in testing. A refused `fetch` to localhost takes milliseconds.
- Replies and CDP events are routed per connection. A tab's debugger stays attached until the **last** session using it detaches or disconnects.
- When a Claude Code session ends, its connector exits (stdin closed or parent gone), the WebSocket drops, and the extension releases everything that session held.
- The service worker is kept alive with a 20 s heartbeat, so discovery stays fast even after Chrome has been idle. The cost is a resident service worker, about ten-odd MB.
- Sessions share CDP state on a tab they both use (e.g. `Network.setBlockedURLs`). `chrome_tabs` flags tabs other sessions are using so Claude can leave them alone.

## Security

This bridge is powerful by design: anything that can talk to the connector can read and act in your logged-in browser.

- The connector listens on **127.0.0.1 only**.
- WebSocket upgrades are accepted **only from `chrome-extension://` origins**, so a web page can't connect to localhost and pose as the extension.
- The discovery endpoint sends no CORS headers, so web pages can't read its response.
- The extension requests broad permissions (`debugger`, `<all_urls>`, and more) so that `chrome_api` can reach any API. Review `extension/manifest.json` and trim it if you want a narrower bridge.
- Any local process running as your user can reach `127.0.0.1`. Treat the machine's user account as the trust boundary.

## Troubleshooting

- **"Extension not connected"**: call `chrome_status` to see this session's port. Open the extension popup; opening it also triggers an immediate rescan. Make sure the extension is enabled and is version 2.x.
- **A tab shows the yellow "debugging" bar after you're done**: another session may still be using it (`chrome_tabs` → `otherSessions`), or call `chrome_detach`.
- **Clicking "Cancel" on the yellow bar** detaches every session from that tab. The next command re-attaches automatically.
- Logs: the connector logs to stderr. Extension logs are in `chrome://extensions` → Chrome Bridge → *service worker*.

## Configuration

`CHROME_BRIDGE_PORT` changes the connector's base port (default `9333`). If you change it, also change `BASE_PORT` in `extension/background.js`. `PORT_SPAN` (20) must match on both sides.

## License

[MIT](LICENSE)
