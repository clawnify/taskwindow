# TaskWindow

Let any coding agent drive your real, logged-in Chrome — the tabs you're
already signed into — without touching the windows you're working in.

```
[coding agent] --MCP--> [TaskWindow daemon] --WebSocket--> [Chrome extension] --CDP--> [your tab]
```

Works with Claude Code, Cursor, Windsurf, Codex, or any client that speaks
MCP over HTTP.

## Setup (5 minutes)

Requires Node 18+ and Chrome/Chromium 116+.

```bash
npm install -g taskwindow
taskwindow install
```

The guided installer:

- shows a checkbox list of detected coding agents (choose any combination, or **None**);
- installs the background daemon as a login service;
- downloads the extension to the visible `TaskWindow Extension` folder in your home directory;
- opens `chrome://extensions` and waits for a verified connection.

In Chrome, turn on **Developer mode**, click **Load unpacked**, and choose the
`TaskWindow Extension` folder. Chrome requires these two manual clicks for
unpacked extensions. TaskWindow then pairs automatically with a short-lived,
single-use setup code and the installer prints `ready ✓` only after Chrome is
connected.

### Try it

Ask your agent: *"Open example.com in a new tab and take a screenshot."*

A green tab group named after your task appears in its own window — that's
the agent's workspace. Screenshot done. Now try:
*"Find the sign-up link and read the page's headings."*

### Repair and advanced commands

```bash
taskwindow doctor              # diagnose daemon, extension, versions, and agents
taskwindow pair                # create a manual one-time pairing code
taskwindow install --extension # repair or update only the extension
taskwindow install --claude    # add Claude Code without repeating setup
taskwindow install --cursor    # add Cursor without repeating setup
taskwindow install --opencode  # add OpenCode without repeating setup
```

Use `taskwindow install --no-extension` to install only the daemon and selected
agents. For another MCP client, connect to `http://127.0.0.1:9377/mcp` with
`Authorization: Bearer <token>`; the token is stored in `~/.taskwindow/token`.

## What the agent gets

| Area | Tools |
|---|---|
| Status | `taskwindow_status` (daemon/extension readiness and recovery guidance) |
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
- **Pairing**: the daemon listens on 127.0.0.1 only. During setup, the CLI gives
  the extension a short-lived, single-use code; the long-lived bearer token is
  returned only after the code is claimed. Manual codes are available with
  `taskwindow pair`.
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
