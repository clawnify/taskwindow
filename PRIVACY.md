# TaskWindow — Privacy Policy

**Last updated: September 2026**

TaskWindow is a browser automation bridge: it lets a coding agent running on
*your own machine* view and operate browser tabs, inside tab groups the agent
creates, with every action visible on screen.

## The short version

Everything stays on your machine. TaskWindow has no servers, no accounts of
its own, and no analytics. It never sends your data to us or to any third
party.

## What stays local

- **The daemon runs on your machine** (`127.0.0.1` only) and is installed by
  you via `npm install -g taskwindow`. The extension talks only to that local
  daemon over a WebSocket on localhost.
- **Pairing is local.** A short-lived, single-use code pairs the extension to
  your daemon; the long-lived bearer token is stored in your browser's local
  extension storage and in `~/.taskwindow/token` on your machine.
- **No telemetry.** No usage statistics, crash reports, or tracking of any
  kind are collected or transmitted.
- **No data leaves your machine.** Page content, screenshots, and recordings
  captured by the agent flow only between the page, the extension, your local
  daemon, and the agent you run. Nothing is uploaded anywhere by TaskWindow.

## What the extension can access, and why

- The extension can read and operate **tabs and tab groups it created for
  agent tasks** (by default, only those — not your other tabs).
- Agent actions use Chrome's DevTools debugger on those tabs. Chrome itself
  displays a visible *"started debugging this browser"* infobar whenever this
  is active, and a phantom cursor shows where the agent is acting.
- Broad host access (`<all_urls>`) exists because automation you request can
  target any site you're signed into — that is the product's purpose. Access
  is exercised only for pages the agent is directed to, by you or your agent.

## What you control

- Which coding agents get access (configured at install time, changeable via
  `taskwindow install`).
- Whether the agent can see tabs outside its groups (settings page, off by
  default).
- You can revoke everything at once by removing the extension and running
  `taskwindow uninstall`.

## Contact

This project is open source: https://github.com/clawnify/taskwindow — issues
are the fastest way to reach us.
