# TaskWindow

A Chrome extension (MV3) + local daemon that lets **any MCP-speaking coding
agent** drive your real, logged-in browser tab — the same capability as
"Claude in Chrome", but not tied to one vendor's runtime.

```
[Agent, any vendor] --MCP (HTTP)--> [local daemon] --WebSocket--> [Chrome extension] --CDP--> [live tab]
```

The extension attaches Chrome's debugger to your actual tab (your cookies,
your session — not a spawned automation profile) and exposes 18 tools over
MCP Streamable HTTP: tab management, screenshot + mouse/keyboard
(`computer`), accessibility-tree snapshots (`read_page`/`find`), text
extraction, form filling, file upload, in-page JS, console/network capture,
`browser_batch`, GIF recording, and shortcuts.

## Quickstart

**1. Run the daemon** (Node 18+):

```bash
cd daemon
npm install
npm start
# [taskwindow] MCP endpoint: http://127.0.0.1:9377/mcp
# [taskwindow] token: <printed on first run, also saved to ~/.taskwindow/token>
```

**2. Load the extension**: `chrome://extensions` → Developer mode → Load
unpacked → select `extension/`. Then open the extension's **Options** page,
paste the daemon token, and save. The status dot turns green when the
extension connects to the daemon.

**3. Point your MCP client** at the endpoint, sending the token as a bearer
header:

```json
{
  "mcpServers": {
    "taskwindow": {
      "type": "http",
      "url": "http://127.0.0.1:9377/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Any MCP client works — Claude Code, Cursor, Windsurf, or a raw
`tools/call` over HTTP. Verify with: *"List my tabs, then take a
screenshot of the active one."*

## Tools

`tabs_list` · `tabs_create` · `tabs_close` · `navigate` · `computer`
(screenshot, click, type, key, scroll) · `read_page` · `find` ·
`get_page_text` · `form_input` · `file_upload` · `upload_image` ·
`javascript_execute` · `read_console_messages` · `read_network_requests` ·
`browser_batch` · `gif_record` · `shortcuts_list` · `shortcuts_execute`

Shortcuts are editable macros (named sequences of tool actions) in the
extension's options page.

## Security model

- The daemon binds **127.0.0.1 only**; every MCP request and the extension's
  WebSocket handshake require a shared token (generated at
  `~/.taskwindow/token`, `0600`).
- Anything your agent can reach through the browser, it can act on — treat
  MCP client access to this daemon as browser-level trust. `Authorization:
  Bearer <token>` on every request.
- While the `computer` tool is active Chrome shows an *"TaskWindow started
  debugging this browser"* infobar. That's a Chrome policy for CDP-based
  control; there is no way around it.

## Known limits

- Chrome/Chromium only (MV3 `chrome.*` APIs directly). Firefox needs
  different CDP access — deferred.
- Page-level tools (`read_page`, `form_input`, …) run in the top frame;
  automation inside iframes is out of scope for now.
- Native `alert()`/`confirm()` dialogs block the attached tab — avoid
  triggering them.
- Console/network capture covers the period the extension has been driving
  the tab (CDP domains are enabled on attach).

## Development

```bash
cd daemon && npm test        # boots a daemon + fake extension + real MCP client, 24 checks
```

The daemon is fully covered by an end-to-end harness (auth, tool dispatch,
batch semantics, error paths). The extension's GIF encoder has a round-trip
suite. The extension itself is syntax-checked and manifest-validated; load
it in Chrome and drive a real tab for a manual end-to-end pass.
