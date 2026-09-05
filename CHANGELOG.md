# Changelog

The section matching a release tag becomes that release's notes on GitHub, so
write these for users. Add the version's section before tagging.

## 0.2.2

### Fixed

**A tab's existence no longer leaks across sessions.** Passing another session's
tab id returned *"belongs to a different agent session"* while an unused id
returned *"No tab with id"* — two distinguishable answers, so an agent could walk
tab ids and learn which were live (and how many tabs you had open) without ever
being allowed to touch them. Both now return the same message, and it no longer
claims the tab belongs to another agent: it may equally be one of your own.
`tabs_close` went through its own tab lookup and bypassed the check entirely; it
now shares the single guarded path.

### Changed

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
