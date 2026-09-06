#!/usr/bin/env node
/**
 * Fake TaskWindow extension for daemon testing: connects over WS like the real
 * extension and answers tool calls with canned results. Printable + failure
 * injection for tests.
 *
 * Usage: node fake-extension.js <port> <token> [mode]
 *   mode "flaky"  — every tool call fails
 *   mode "normal" — (default) canned success results
 */
import WebSocket from "ws";

const [port, token, mode = "normal"] = process.argv.slice(2);

let ws;
function connect() {
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  ws.on("open", onOpen);
  ws.on("message", onMessage);
  ws.on("error", () => {
    // Daemon may not be listening yet — keep retrying.
    setTimeout(connect, 300);
  });
}

function onOpen() {
  ws.send(JSON.stringify({ type: "hello", protocol: 1, version: "test-fake", userAgent: "FakeChrome/1.0" }));
}

const canned = {
  tabs_list: {
    data: [
      { id: 1, title: "Example", url: "https://example.com/", active: true, windowId: 1 },
      { id: 2, title: "Docs", url: "https://developer.mozilla.org/", active: false, windowId: 1 },
    ],
    text: "1. Example — https://example.com/ (active)\n2. Docs — https://developer.mozilla.org/",
  },
  navigate: { data: { tabId: 1, url: "https://example.com/other", title: "Other", loadTimedOut: false } },
  computer: (params) =>
    params?.action === "screenshot"
      ? { image: { data: "aWNvbg==", mimeType: "image/png" }, text: "captured 1280x720 viewport" }
      : { text: `ok: ${params?.action}` },
  read_page: { text: '- heading "Example Domain" (e1)\n- link "More information" (e2)' },
  find: { text: '- link "More information" (e2)' },
  get_page_text: { text: "Example Domain\nThis domain is for use in illustrative examples." },
  form_input: (params) => ({ data: { filled: true, value: String(params?.value ?? "") } }),
  file_upload: { data: { attached: ["a.txt"] } },
  upload_image: { data: { pasted: true } },
  javascript_execute: { data: { result: 42 } },
  read_console_messages: { data: [{ level: "error", text: "Uncaught TypeError: x is not a function" }] },
  read_network_requests: { data: [{ method: "GET", url: "https://example.com/", status: 200 }] },
  shortcuts_list: { data: [{ name: "screenshot", description: "Take a screenshot" }] },
  shortcuts_execute: { text: "1. computer:\nok: screenshot" },
  reload_extension: { text: "extension test-fake reloading" },
  gif_record: { image: { data: "R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", mimeType: "image/gif" }, text: "recorded 5 frames" },
};

function onMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (msg.type !== "tool_call") return;
  const reply = (ok, payload) =>
    ws.send(JSON.stringify({ type: "tool_result", id: msg.id, ok, ...payload }));

  if (mode === "flaky") {
    reply(false, { error: `injected failure (${mode} mode)` });
    return;
  }
  if (msg.tool === "tabs_close") {
    if (msg.params?.tabId === 999) reply(false, { error: "No tab with id 999" });
    else reply(true, { text: "closed" });
    return;
  }
  if (msg.tool === "tabs_create") {
    reply(true, {
      result: {
        data: { id: 3, title: "New Tab", url: msg.params?.url || "about:blank", sessionToken: msg.params?.sessionToken || null },
        text: `opened tab 3 — sessionToken ${msg.params?.sessionToken || "(none)"}`,
      },
    });
    return;
  }
  const fn = canned[msg.tool];
  if (!fn) {
    reply(false, { error: `fake extension has no canned result for ${msg.tool}` });
    return;
  }
  const result = typeof fn === "function" ? fn(msg.params) : fn;
  reply(true, { result });
}

connect();
