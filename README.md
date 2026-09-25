# TaskWindow

[![Add to Chrome](https://img.shields.io/badge/Chrome_Web_Store-Add_to_Chrome-4285F4?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/adbfpkbjndcpjihceobeegkokblgifpe)

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
- opens the [TaskWindow listing on the Chrome Web Store](https://chromewebstore.google.com/detail/adbfpkbjndcpjihceobeegkokblgifpe)
  and waits for a verified connection.

In Chrome, click **Add to Chrome**. That is the only click: the extension
pairs with the daemon on its own, and the installer prints `ready ✓` once
Chrome is connected. Chrome keeps the extension up to date from the store.

Installed the extension first? A setup guide opens with the two commands
above and turns green by itself as soon as the daemon is running. Coming from
the installer, nothing opens.

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
taskwindow install             # re-run first-time setup; reopens the store listing if the extension is missing
taskwindow install --claude    # add Claude Code without repeating setup
taskwindow install --codex     # add Codex without repeating setup
taskwindow install --cursor    # add Cursor without repeating setup
taskwindow install --opencode  # add OpenCode without repeating setup
```

The Codex option requires the `codex` CLI on PATH. It configures the shared
user-level MCP connection; restart Codex after registration to load the tools.
If you use `CODEX_HOME`, that directory is respected.

When a newer release exists, agents are told once per session (in the
`tabs_create` result and in `taskwindow_status`) to ask you before running
`taskwindow update`. The daemon learns this by asking the npm registry for the
package's latest version at most once a day; create `~/.taskwindow/no-update-check`
to turn that off.

Use `taskwindow install --no-extension` to install only the daemon and selected
agents. Developing the extension? `taskwindow install --extension <zip>` unpacks
a build into the `TaskWindow Extension` folder in your home directory for
`chrome://extensions` → **Load unpacked**, pairing through a one-time code the
installer leaves in that folder; `taskwindow update` then refreshes those files
too. Loaded unpacked before the store listing existed? Remove that copy in
`chrome://extensions` before adding the store one — two copies would keep
taking the daemon connection from each other. For another MCP client, connect to `http://127.0.0.1:9377/mcp` with
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
  group named after its task — one group per agent session, holding every tab
  of that job however many sub-tasks it spans. The first `tabs_create` names
  it; every later tab joins it. Naming the task also says whether the job
  might take more than an hour (`longRunning`): a group for a shorter job
  closes itself, tabs and all, once it has been idle for an hour, so finished
  work does not pile up in the window; long-running groups stay until unused
  for 30 days. Sessions are isolated from each other:
  `tabs_create` returns a secret sessionToken and every browser tool call is
  scoped to that session's groups, so concurrent agents never share tabs —
  even when they pick the same task name. By default the agent can only see
  and act on tabs in its own groups — never yours. You can click a group in
  the toolbar popover to watch, and widen access in settings.
- **Your focus is never taken**: nothing the agent does brings a tab or window
  forward on you. Chrome's `tabs.create` makes a new tab active by default and
  `windows.create` focuses the new window by default; TaskWindow always opens
  tabs in the background (a background tab still renders, so screenshots and
  page reads work), creates the agent window unfocused, and hands focus back if
  Chrome raises a window anyway. A background tab also takes mouse, wheel and
  keyboard input over the DevTools protocol (checked in Chrome: click, scroll
  and type all land in a tab that is not its window's active tab, and it stays
  that way), so nothing ever brings a tab forward. Clicking a group in the
  popover is the only thing that focuses the agent's window — and that is you
  asking for it.
- **Pairing**: the daemon listens on 127.0.0.1 only. Chrome stamps every
  request the store extension makes with its fixed extension id as the origin,
  which no other extension or web page can forge, so the daemon hands the
  bearer token to that origin and nothing else. An unpacked development build
  pairs with a short-lived, single-use code the installer leaves in its
  folder; manual codes are available with `taskwindow pair`.
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
