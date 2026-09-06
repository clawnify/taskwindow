# Changelog

The section matching a release tag becomes that release's notes on GitHub, so
write these for users. Add the version's section before tagging.

## 0.2.7

Extension only. Coming from 0.2.6: `taskwindow update`.

### Fixed

**Nothing ever brings a tab forward.** 0.2.6 still made a tab visible before
mouse input, on the belief that a hidden tab never acknowledges the event, and
failed the call when that tab was behind yours — which agents then worked
around by closing tabs or clicking through page scripts. Checked in Chrome:
click, wheel scroll and typing over the DevTools protocol all land in a tab
that is not its window's active tab, and it stays that way. The activation and
the "behind another tab" error are gone.

## 0.2.6

Extension and daemon. Coming from 0.2.5: nothing to run — `taskwindow update`.

### Changed

**The task name is remembered per session.** Only the first `tabs_create`
needs a `task`; later calls with the sessionToken can omit it and the tab
joins the session's current task group — the same way the token is kept for
the agent instead of re-derived. A new task name still starts another group
and makes it current. A token whose session has no group yet gets an error
that says to pass the name.

### Fixed

**The agent never switches tabs on you.** `tabs_create` opened every tab as
the active one, and clicking or scrolling in a tab that was not the visible
one first made it visible — so when that window was the one you were working
in (agent groups adopted into it, or "own window" off), you were pulled off
your page mid-task. Now every tab opens in the background: the `active` option
is gone, and a background tab still renders, so screenshots and page reads
work as before. Input brings a tab forward only in a window you are not
looking at — the agent's own window, or any window while Chrome is in the
background; if the tab is behind yours in your focused window, the call fails
with the reason instead of switching. The focus hand-back after Chrome raises
a window on tab creation now runs only while Chrome is frontmost, so it can no
longer pull you out of another app.

## 0.2.5

Daemon and extension. Coming from 0.2.4: `taskwindow update` — it refreshes the
extension files, restarts the daemon and reloads the extension for you.

### Fixed

**A slow wake-up no longer turns one task into five groups and stray tabs.**
After a laptop sleep, Chrome can take tens of seconds to answer the extension.
The daemon gave up on `tabs_create` after 15s, the extension finished the call
anyway, and each retry — having no session token yet — minted a new session:
the popover filled with identical "linkedin batch 7 research" groups, some tabs
sat outside any group, and the agent could reach none of them. Now the daemon
mints the session token up front and names it in the timeout error, so the
retry (same token, task and url) receives the tab the first call opened — still
opening, or finished within the last minute — instead of a second one. A tab
the extension cannot put in its task group is closed again, never stranded.
Chrome calls that stall inside the tab-group bookkeeping fail that one call
after 10s instead of holding every session's tools; the error says which call.

**`taskwindow_status` and the popover agree about the connection.** Both ends
now use the extension's 20-second ping as a liveness check: a socket the other
side silently abandoned (typical after sleep) is dropped and redialled, so
tools fail fast with "not connected" instead of timing out one by one while
status still reported a connected extension.

**`javascript_execute` can reuse variable names.** Top-level `const`/`let`
declarations stayed in the page between calls, so the second script that
declared `ta` failed with "Identifier 'ta' has already been declared". It now
evaluates in the DevTools console's REPL mode, which also allows top-level
`await`.

**The daemon log names slow and late answers.** A tool call the extension
answered after more than 5s — or after its deadline had passed — is logged
with the elapsed time and, for `tabs_create`, how long the tab creation and
the grouping each took, so the next slow morning is diagnosable.

## 0.2.4

Extension-side. Coming from 0.2.3 or older: `npm install -g taskwindow@latest`,
then `taskwindow update` — it refreshes the extension files and reloads the
extension for you (older extensions get told the one click that remains).

### Added

**`taskwindow update`.** One non-interactive command brings the daemon and the
extension to the latest release: installs the npm package into the prefix the
current one lives in (not whichever npm is first on PATH), refreshes the
unpacked extension files, restarts the daemon, and has the extension reload
itself. Open tabs survive. Agents may run it, with your permission.

**Agents learn about new versions.** The daemon asks the npm registry for the
latest version at most once a day and, when there is one (or the extension
lags the daemon), says so once per agent session — in the `tabs_create` result
and in `taskwindow_status` — telling the agent to ask you before running
`taskwindow update`. `doctor` shows it too. Disable with
`~/.taskwindow/no-update-check`.

**`computer` screenshots can be saved to disk.** By default a screenshot comes
back inline, with no path — nothing else could use the actual image. Pass
`save_to_disk: true` and the daemon also writes the PNG to a temp directory
(OS-cleaned) and returns the absolute path in the result text, so the agent can
attach it to an issue, feed it to another tool, or just verify it with `file`.
The extension is untouched; this happens entirely daemon-side.

Extension-side: after `taskwindow install`, reload TaskWindow in
`chrome://extensions`.

### Fixed

**Screenshot coordinates now match click coordinates on Retina and zoomed
pages.** `computer` screenshots were rendered in device pixels while clicks,
scrolls and mouse moves are dispatched in CSS pixels, so on a 2x display every
coordinate read off a screenshot landed twice too far right and down — off the
button, or off the viewport entirely. Agents clicked "send" and nothing
happened, then pressed Enter into nothing. Screenshots are now captured at
1 image pixel per CSS pixel, so x,y read off them can be used as-is; the
result text says so. A newly created agent window also opens at 1280x900, so
that 1:1 screenshot stays within the resolution vision models see natively
instead of being downscaled on the way in (resize the window if you want more).

**The on-page cursor and glow no longer fade out mid-task.** They used to
disappear about 1.6s after each action, so an agent that moved the mouse and
then took a screenshot to check the spot before clicking often found nothing to
check. Both now stay up for as long as the tab is being driven and go away when
TaskWindow detaches from the tab.

**`javascript_execute` works on sites with a strict Content Security Policy.**
It ran the code through `eval` inside the page, which x.com, reddit.com, GitHub
and any other site without `'unsafe-eval'` reject. It now evaluates over the
DevTools protocol like the DevTools console, which the page's CSP cannot block.


**`doctor` and `install` warn when an older `taskwindow` shadows this one.**
Global installs under different Node versions leave older copies behind, and if
one sits earlier on PATH it silently runs instead of the version you just
installed — a pre-`doctor` copy even falls through to daemon mode and dies with
`EADDRINUSE`. Both commands now name the shadowing binary and its version, and
say how to remove it.

## 0.2.3

Extension-side again: after `taskwindow install`, reload TaskWindow in
`chrome://extensions`.

### Changed

New icon, and task groups are now blue — the same blue as the glow that marks
where an agent is acting on a page — instead of green.

## 0.2.2

This one changes the extension, so updating the daemon alone is not enough:
after `taskwindow install`, reload TaskWindow in `chrome://extensions`.
`taskwindow doctor` flags the mismatch until you do.

### Added

**`reload`.** Reloads a tab in place (optionally bypassing the cache) and waits
for the load event. There was no way to refresh a page: `tabs_create` is the
first tool every agent learns and needs no tab id, so "check the page again"
turned into a second tab at the same URL, every iteration. `tabs_create` now
says so and points at `reload`/`navigate` for a page you already have open.

### Fixed

**Opening a tab no longer steals focus.** `tabs_create` focused the agent
window on every call — the default `active: true` ran
`windows.update({ focused: true })`, which also brings Chrome to the front — so
each tab an agent opened pulled you out of your own window, or out of your
terminal. `active` now means active *within* the agent window, so the page
renders and screenshots work; whatever you were in keeps focus. Click the agent
window when you want to watch.

**Mouse input no longer stalls when the agent window isn't in front.** Chrome
stops producing frames for a tab that is inactive or whose window is covered,
and DevTools holds a wheel event until the next frame — so `scroll` hung for
30 s and `mouse_move`/clicks took 5 s whenever you were looking at something
else, which the focus fix above makes the normal case. The page is now kept
rendering with CDP focus emulation (what Playwright does by default; the
equivalent launch flags aren't available to an extension), and a mouse action
first makes its tab the active one in the agent window. Keys and screenshots
were never affected.

**A tab's existence no longer leaks across sessions.** Passing another session's
tab id returned *"belongs to a different agent session"* while an unused id
returned *"No tab with id"* — two distinguishable answers, so an agent could walk
tab ids and learn which were live (and how many tabs you had open) without ever
being allowed to touch them. Both now return the same message, and it no longer
claims the tab belongs to another agent: it may equally be one of your own.
`tabs_close` went through its own tab lookup and bypassed the check entirely; it
now shares the single guarded path.

### Changed

**Agents share one window.** Every new task used to open another Chrome window,
even within one session. A window holds many tab groups, so a task now joins
the window the agent is already working in — concurrent agents included — and
only the very first creates one. A pinned *TaskWindow workspace* tab anchors
that window: Chrome closes a window with its last tab, and one task finishing
must not take the shared window, and wherever you put it, away from everyone
else. No agent can close the anchor, since it sits outside every group. Close it
yourself if you want the window gone; the next task simply opens a fresh one.

`taskwindow install` is documented as the one command that installs, repairs and
updates the extension. `taskwindow doctor` used to point at `taskwindow install
--extension` when extension files were missing; it now points at `taskwindow
install`. The `--extension` flag still works and remains the way to install from
a local zip when the download fails.

## 0.2.1

### Fixed

**`read_network_requests` was uncallable (regression in v0.2.0).** The
per-session isolation added in v0.2.0 gave sixteen tool schemas a `sessionToken`
parameter and missed this one, while its handler still scoped by session. Because
arguments are validated against the declared schema, the token was stripped
before dispatch — so every direct call failed with *"Call tabs_create first — it
returns a sessionToken"*, naming a parameter clients had no way to send. It only
worked inside `browser_batch`, which injects the token per step.

`sessionToken` is now added to every browser tool automatically rather than
listed by hand, so a tool can no longer ship missing it, and a contract test
checks every schema against its extension handler on each CI run.

### Changed

**`javascript_execute` no longer accepts `world`.** It was never in the tool
schema, so `ISOLATED` was already unreachable — and it could not have worked:
execution is `eval()`, which in an isolated world runs under the extension's own
CSP, and Manifest V3 forbids `unsafe-eval`. It failed on every page, not just
strict ones. Scripts run in the page's main world, as they always did in
practice.

## 0.2.0

Per-agent session isolation for tab groups. `tabs_create` mints a `sessionToken`
and namespaces that session's groups under it, so concurrent agents never share
tabs even when they pick the same task name. The task name is now required.
