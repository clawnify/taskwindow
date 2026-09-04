# TaskWindow

Let any coding agent drive your real, logged-in Chrome — the tabs you're
already signed into — without touching the windows you're working in.

```
[coding agent] --MCP--> [TaskWindow daemon] --WebSocket--> [Chrome extension] --CDP--> [your tab]
```

Works with Claude Code, Cursor, Windsurf, Codex, or any client that speaks
MCP over HTTP.

## Setup (5 minutes)

### 1. Start the daemon

Requires Node 18+.

```bash
npx taskwindow
```

You'll see:

```
[taskwindow] daemon listening on http://127.0.0.1:9377
[taskwindow] pairing code: A6LU5X — enter it in the TaskWindow extension options
[taskwindow] claude code: claude mcp add taskwindow --transport http http://127.0.0.1:9377/mcp --header "Authorization: Bearer …"
```

The daemon is what your agent talks to, so it needs to stay running.
To make it survive laptop restarts (installs a login service):

```bash
npm install -g taskwindow
taskwindow install
```

Or just keep `npx taskwindow` running in a terminal — both work.

### 2. Install the Chrome extension

1. Download `TaskWindow-extension-*.zip` from the
   [latest release](https://github.com/clawnify/taskwindow/releases) and unzip it
2. Open `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the unzipped folder
5. Click the TaskWindow icon in the toolbar

### 3. Pair the extension with the daemon

1. Click the TaskWindow toolbar icon → **Settings**
2. Type the 6-character pairing code from step 1 → **Pair**
3. The dot turns green: connected ✓

(Manual token paste also works — `~/.taskwindow/token`.)

### 4. Connect your coding agent (one agent at a time, only when you ask)

```bash
taskwindow install --claude   # Claude Code
taskwindow install --cursor   # Cursor
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
