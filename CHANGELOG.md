# Changelog

The section matching a release tag becomes that release's notes on GitHub, so
write these for users. Add the version's section before tagging.

## Unreleased

### Fixed

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
