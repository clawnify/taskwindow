# TaskWindow

Let any coding agent drive your real, logged-in Chrome — the tabs you're
already signed into — without touching the windows you're working in.

```
[coding agent] --MCP--> [TaskWindow daemon] --WebSocket--> [Chrome extension] --CDP--> [your tab]
```

Works with Claude Code, Cursor, Windsurf, Codex, or any client that speaks
MCP over HTTP.

## Setup (5 minutes)

### 1. Install and start the daemon

Requires Node 18+.

```bash
npm install -g taskwindow
taskwindow install
```

That installs a login service (the daemon starts now and after every laptop
restart — no terminal needed) and prints:

```
[taskwindow] login service installed (~/Library/LaunchAgents/com.clawnify.taskwindow.plist)
[taskwindow] pairing code: A6LU5X — enter it in the TaskWindow extension options
```

Keep the pairing code for step 3. (Prefer running it by hand? `npx taskwindow`
in a terminal works too — it just won't survive a restart.)

### 2. Install the Chrome extension

You already have the CLI — add the extension:

```bash
taskwindow install --extension
```

That downloads the latest release, unpacks it, opens Chrome at
`chrome://extensions`, and prints the last 3 clicks (Developer mode →
Load unpacked → select the printed folder). Chrome's own policy requires
those clicks — no tool can do them for you. A Web Store listing (one-click
install + auto-updates) is planned.

### 3. Pair the extension with the daemon

1. Click the TaskWindow toolbar icon → **Settings**
2. Type the 6-character pairing code from step 1 → **Pair**
3. The dot turns green: connected ✓

(Manual token paste also works — `~/.taskwindow/token`.)

### 4. Connect your coding agent (one agent at a time, only when you ask)

```bash
taskwindow install --claude   # Claude Code (user scope: every repo)
taskwindow install --cursor   # Cursor
```

**OpenCode** — add to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "taskwindow": {
      "type": "remote",
      "url": "http://127.0.0.1:9377/mcp",
      "enabled": true,
      "headers": { "Authorization": "Bearer <token from ~/.taskwindow/token>" }
    }
  }
}
```

Nothing is registered for agents you don't name. For anything else, the
config is an HTTP MCP server at `http://127.0.0.1:9377/mcp` with header
`Authorization: Bearer <token>` (the token is in `~/.taskwindow/token`).

### 5. Try it

Ask your agent: *"Open example.com in a new tab and take a screenshot."*

A green tab group named after your task appears in its own window — that's
the agent's workspace. Screenshot done. Now try:
*"Find the sign-up link and read the page's headings."*

## What the agent gets

| Area | Tools |
|---|---|
| Tabs | `tabs_list`, `tabs_create`, `tabs_close`, `navigate` |
| See | `computer` (screenshot + click/type/key/scroll), `read_page`, `find`, `get_page_text` |
| Act | `form_input`, `file_upload`, `upload_image`, `javascript_execute` |
| Debug | `read_console_messages`, `read_network_requests` |
| Efficiency | `browser_batch` (multi-step in one call), `gif_record`, `set_viewport` (responsive view), `shortcuts_*` |

## How the isolation works

- **Task groups**: every tab the agent creates goes into a green tab group
  named after the task, in the agent's own window. By default the agent can
  only see and act on tabs in its own groups — never yours. You can click a
  group in the toolbar popover to watch, and the user can widen access in
  settings.
- **Pairing**: the daemon listens on 127.0.0.1 only; the extension pairs with
  a 6-character code printed at daemon start. MCP requests require a bearer
  token.
- **Agent actions are visible**: a phantom cursor and glow show where the
  agent is acting; while it does, Chrome shows a
  *"started debugging this browser"* infobar — an unavoidable Chrome policy
  for this capability, same as Claude's own extension.

## Requirements & limits

- Chrome/Chromium 116+ (Chrome, Edge, Brave, Arc…)
- Node 18+ for the daemon
- Page tools run in the top frame; native `alert()`/`confirm()` dialogs block
  the attached tab

## Development

```bash
git clone https://github.com/clawnify/taskwindow
cd taskwindow/daemon && npm install && npm test
```

The test suite boots the daemon with a fake extension and runs a real MCP
client against it (auth, dispatch, batching, error paths).
