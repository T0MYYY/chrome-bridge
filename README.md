# Chrome Bridge

**English** · [中文](README.zh-CN.md)

An MCP server that lets AI agents drive **the Chrome you already use**: your default profile, logins, cookies and extensions. There's no `--remote-debugging-port` and no separate automation browser. It works with any MCP client, including Claude Code, Codex, and others.

It has two parts:

- **Extension** (`extension/`): an MV3 extension that exposes the Chrome DevTools Protocol through `chrome.debugger` and gives access to every `chrome.*` API.
- **Connector** (`connector/`): a stdio MCP server that your agent launches. It talks to the extension over an authenticated, encrypted local WebSocket.

```
agent ──stdio/MCP──▶ connector (127.0.0.1:9333–9352) ◀══ encrypted WebSocket ══ extension ──chrome.debugger──▶ your tabs
```

## Features

- **Your real browser session.** Pages open already logged in, with your extensions active.
- **Pair once per agent.** The first time an agent connects, you type an 8-character code into the extension popup. After that, every future session of that agent connects silently. Other software on your machine can't simply connect and take over your browser (see [Security](#security)).
- **Full network and console capture**, including cross-origin iframes (OOPIF) and workers. `chrome_navigate` attaches before it navigates, so capture starts at the first byte.
- **Generic escape hatches**: arbitrary CDP methods (`chrome_cdp`), arbitrary `chrome.*` APIs (`chrome_api`), and arbitrary `chrome.*` events (`chrome_events`).
- **Many sessions at once.** Each agent session gets its own port and the extension connects to all of them. Debugger attachments and event subscriptions are reference-counted per session, so one session detaching or exiting never breaks another. New sessions are discovered in under a second.

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
| `chrome_status` | Agent identity, pairing state (with the code while pairing), port, and all connected sessions |
| `chrome_wait` | Sleep without a shell |

## Install

Requirements: Chrome 116+, Node.js 18+, and an MCP client.

```bash
git clone https://github.com/T0MYYY/chrome-bridge.git
cd chrome-bridge/connector && npm install
```

1. **Load the extension.** Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and select the `extension/` folder.
2. **Register the MCP server** with your agent:

   **Claude Code**

   ```bash
   claude mcp add -s user chrome-bridge -- node /absolute/path/to/chrome-bridge/connector/index.js
   ```

   **Codex** (`~/.codex/config.toml`)

   ```toml
   [mcp_servers.chrome-bridge]
   command = "node"
   args = ["/absolute/path/to/chrome-bridge/connector/index.js"]
   ```

   **Any other MCP client** (the usual JSON shape)

   ```json
   { "mcpServers": { "chrome-bridge": { "command": "node", "args": ["/absolute/path/to/chrome-bridge/connector/index.js"] } } }
   ```

3. **Pair.** Ask the agent to do anything in Chrome. Its first tool call returns a code like `K7Q2-M9XD`. Click the Chrome Bridge icon in the toolbar (a notification also pops up) and type the code. The popup pairs automatically once all 8 characters are in, and you're done for that agent.

To update later, `git pull`, reload the extension in `chrome://extensions`, and run your client's MCP reconnect (e.g. `/mcp` in Claude Code) in running sessions.

## Pairing and agent identity

- **What counts as "one agent".** On macOS, the connector walks up its parent processes (skipping shells and `npx`-style launchers) to the agent and verifies that **running process's code signature** with `codesign`. The identity is *team ID + identifier*, e.g. Claude Code is `Q6L2SF6YDW:com.anthropic.claude-code` (Anthropic PBC), and Codex is `2DC432GLL2:codex`. The identity survives agent upgrades. Unsigned agents (e.g. Node CLIs) fall back to their script or executable path. If the agent can't be identified at all, the connector uses an in-memory identity that's valid only for that session.
- **Credentials.** Each agent gets a P-256 signing key. On macOS it's stored in the **Keychain**: written through `security -i` on stdin, so it never appears in a process list. On other systems it's stored in `~/.config/chrome-bridge/agents/*.json` with mode `0600`. The extension has its own non-extractable key in IndexedDB.
- **Handshake** (SIGMA-style, standard WebCrypto only): both sides sign a transcript of both static keys and fresh ECDH keys, then derive per-direction AES-GCM keys. Every frame is encrypted and sequence-numbered.
- **Pairing proof.** The code has 40 bits of entropy and goes through PBKDF2 (300k iterations), salted with the agent key and bound to the channel transcript. Each side must prove it knows the code. Three wrong guesses invalidate the code.
- **Managing agents.** The popup lists paired agents (with signature strength and last use) and lets you **revoke** one. Revoking disconnects its sessions; that agent then rotates its key and has to pair again.

## Security

What this protects against:

- **A local program posing as a connector** (listening on a port in range). It has no paired key, so all it can do is raise a pairing request you'll never have a code for. Ignore it.
- **A program launching the connector itself** to borrow an agent's pairing. Its parent process's signature doesn't match, so it's treated as a new, unpaired agent.
- **A program posing as the extension** to feed fake results to the agent. It fails the handshake: it has no trusted key and can't pass pairing without the code.
- **Relaying, injecting, tampering or replaying traffic.** The channel is end-to-end encrypted and sequence-numbered.
- **Web pages.** WebSocket upgrades are accepted only from `chrome-extension://` origins, and the discovery endpoint sends no CORS headers.

What it can't protect against: malware **running as your user that specifically targets this tool**. Examples: reading the agent's Keychain item (`security` can read it once you know the item's name), injecting into the agent or Chrome process, or clicking the popup through Accessibility permissions. Desktop OSes don't strongly isolate programs run by the same user, and Chrome's own cookie store has the same limit. The goal is that other software **can't simply access** your browser; access requires a targeted attack.

The extension requests broad permissions (`debugger`, `<all_urls>`, and more) so that `chrome_api` can reach any API. A paired agent effectively has full control of your browser, so only pair agents you trust.

## How multi-session works

- Each connector binds the first free port in `127.0.0.1:9333–9352`. If all 20 are busy, it retries every 2 s.
- The extension probes that range every second with plain HTTP (`GET /chrome-bridge`), then opens a WebSocket to every connector it finds. It uses HTTP for discovery because Chrome throttles repeated *failed WebSocket* connections: probing 20 ports with WebSockets delayed new connections by 7–26 s in testing.
- Replies and CDP events are routed per connection. A tab's debugger stays attached until the **last** session using it detaches or disconnects.
- When an agent session ends, its connector exits (stdin closed or parent gone), and the extension releases everything that session held.
- The service worker stays resident through a 20 s heartbeat, about ten-odd MB of memory, so discovery stays fast even after Chrome has been idle.
- Sessions share CDP state on a tab they both use. `chrome_tabs` flags tabs other sessions are using.

## Troubleshooting

- **"Not paired"**: the tool result contains the code. Click the Chrome Bridge toolbar icon and type it. `chrome_status` shows the code too.
- **"Extension not connected"**: `chrome_status` shows this session's port. Open the extension popup (opening it also triggers a rescan). Make sure the extension is enabled and is version 3.x.
- **A tab keeps the yellow "debugging" bar**: another session may still be using it (`chrome_tabs` → `otherSessions`), or call `chrome_detach`. Clicking **Cancel** on the bar detaches every session from that tab; the next command re-attaches.
- Logs: the connector logs to stderr. Extension logs are in `chrome://extensions` → Chrome Bridge → *service worker*.

## Development

```bash
node test/protocol.test.mjs      # handshake, pairing, attack cases (in-memory)
node test/integration.test.mjs   # real connector processes + simulated extension
```

`CHROME_BRIDGE_PORT` changes the connector's base port (default `9333`). If you change it, also change `BASE_PORT` in `extension/background.js`. `PORT_SPAN` (20) must match on both sides.

## License

[MIT](LICENSE)
