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

A blue tab group named after your task appears in a separate TaskWindow
window — the agents' workspace, shared by every task and every agent, and kept
open by a pinned tab no agent can close. Screenshot done. Now try:
*"Find the sign-up link and read the page's headings."*

### Repair and advanced commands

```bash
taskwindow update              # update daemon + extension to the latest release, no clicks
taskwindow doctor              # diagnose daemon, extension, versions, and agents
taskwindow pair                # create a manual one-time pairing code
taskwindow install             # re-run first-time setup; also repairs the extension
taskwindow install --claude    # add Claude Code without repeating setup
taskwindow install --cursor    # add Cursor without repeating setup
taskwindow install --opencode  # add OpenCode without repeating setup
```

When a newer release exists, agents are told once per session (in the
`tabs_create` result and in `taskwindow_status`) to ask you before running
`taskwindow update`. The daemon learns this by asking the npm registry for the
package's latest version at most once a day; create `~/.taskwindow/no-update-check`
to turn that off.

Use `taskwindow install --no-extension` to install only the daemon and selected
agents. For another MCP client, connect to `http://127.0.0.1:9377/mcp` with
`Authorization: Bearer <token>`; the token is stored in `~/.taskwindow/token`.

## What the agent gets

| Area | Tools |
|---|---|
| Status | `taskwindow_status` (daemon/extension readiness and recovery guidance) |
| Tabs | `tabs_list`, `tabs_create`, `tabs_close`, `navigate`, `reload` |
| See | `computer` (screenshot + click/type/key/scroll), `read_page`, `find`, `get_page_text` |
| Act | `form_input`, `file_upload`, `upload_image`, `javascript_execute` |
| Debug | `read_console_messages`, `read_network_requests` |
| Efficiency | `browser_batch` (multi-step in one call), `gif_record`, `set_viewport` (responsive view), `shortcuts_*` |

## How the isolation works

- **Task groups & sessions**: every tab the agent creates goes into a blue tab
  group named after its task (the first `tabs_create` names it — it says what
  the group is about; later tabs join the session's current group unless a new
  task name starts another). Sessions are isolated from each other:
  `tabs_create` returns a secret sessionToken and every browser tool call is
  scoped to that session's groups, so concurrent agents never share tabs —
  even when they pick the same task name. By default the agent can only see
  and act on tabs in its own groups — never yours. You can click a group in
  the toolbar popover to watch, and widen access in settings.
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
