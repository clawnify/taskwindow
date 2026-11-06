import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

const STORE_ID = "adbfpkbjndcpjihceobeegkokblgifpe";

test("idle cleanup waits for all calls, restarts its quiet period, and runs after failures", async (t) => {
  // A daemon that hands the extension one tool call and holds it open.
  let daemonSide;
  const connected = new Promise((resolve) => (daemonSide = resolve));
  const answers = [];
  const waiting = new Map();
  const server = createServer((_req, res) => res.writeHead(404).end());
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      const msg = JSON.parse(data);
      if (msg.type === "tool_result") {
        answers.push(msg);
        waiting.get(msg.id)?.(msg);
      }
    });
    daemonSide(ws);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const storage = new Map([["token", "token"], ["port", server.address().port]]);

  let extensionSocket;
  globalThis.WebSocket = class extends WebSocket {
    constructor(...args) { super(...args); extensionSocket = this; }
  };
  if (!globalThis.navigator) globalThis.navigator = { userAgent: "test" };
  // The extension keeps redialling forever, as it should in Chrome; here that
  // must not hold the test process open once the daemon is gone.
  let now = Date.now();
  const timers = new Map();
  const realTimeout = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => {
    if (ms !== 10_000) return realTimeout(fn, ms, ...args).unref();
    const handle = {};
    timers.set(handle, { fn, at: now + ms });
    return handle;
  });
  t.mock.method(globalThis, "clearTimeout", (handle) => {
    timers.delete(handle);
    realClear(handle);
  });
  const realInterval = globalThis.setInterval;
  t.mock.method(globalThis, "setInterval", (...args) => realInterval(...args).unref());
  async function advance(ms) {
    now += ms;
    for (const [handle, timer] of [...timers]) {
      if (timer.at > now || !timers.has(handle)) continue;
      timers.delete(handle);
      await timer.fn();
    }
  }
  const attached = new Set();
  globalThis.chrome = {
    runtime: { id: STORE_ID, getURL: (p) => `chrome-extension://${STORE_ID}/${p}`, sendMessage: async () => {} },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    tabs: { onRemoved: { addListener() {} }, async sendMessage() {} },
    debugger: {
      async attach({ tabId }) { attached.add(tabId); },
      async detach({ tabId }) { attached.delete(tabId); },
      async sendCommand() { return {}; },
      onEvent: { addListener() {} }, onDetach: { addListener() {} },
    },
    storage: {
      onChanged: { addListener() {} },
      local: {
        async get(keys) {
          const out = {};
          for (const k of keys) if (storage.has(k)) out[k] = storage.get(k);
          return out;
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) storage.set(k, v);
        },
        async remove(k) {
          storage.delete(k);
        },
      },
    },
  };

  let finishCall;
  const callRunning = new Promise((resolve) => (finishCall = resolve));
  let started;
  const callStarted = new Promise((resolve) => (started = resolve));
  try {
    const { connectWs, isIdle } = await import("../../extension/tools/connection.js");
    const { ensureAttached } = await import("../../extension/tools/cdp.js");
    assert.equal(isIdle(10_000), true, "nothing has run yet");
    connectWs({
      version: "test",
      dispatchTool: async (_tool, params) => {
        await ensureAttached(1);
        if (params?.fail) throw new Error("failed tool");
        if (params?.quick) return {};
        started();
        await callRunning;
        return {};
      },
    });
    const ws = await connected;
    const answerFor = (id) => new Promise((resolve) => {
      const existing = answers.find((a) => a.id === id);
      if (existing) resolve(existing);
      else waiting.set(id, resolve);
    });
    ws.send(JSON.stringify({ type: "tool_call", id: 1, tool: "gif_record", params: {} }));
    await callStarted;
    assert.equal(isIdle(0), false, "a call is running");
    await advance(20_000);
    assert.ok(attached.has(1), "a long-running call is never detached");
    ws.send(JSON.stringify({ type: "tool_call", id: 2, tool: "computer", params: { quick: true } }));
    await answerFor(2);
    await advance(20_000);
    assert.ok(attached.has(1), "finishing an overlapping call does not detach the running one");
    finishCall();
    await answerFor(1);
    assert.equal(isIdle(0), true, "the call is done");
    assert.equal(isIdle(10_000), false, "but it ran under ten seconds ago");
    await advance(9_999);
    assert.ok(attached.has(1));
    // A later call resets the quiet period.
    ws.send(JSON.stringify({ type: "tool_call", id: 3, tool: "computer", params: { quick: true } }));
    await answerFor(3);
    await advance(9_999);
    assert.ok(attached.has(1), "the timer was reset by the later call");
    await advance(1);
    assert.equal(attached.size, 0, "ten quiet seconds release the debugger");
    ws.send(JSON.stringify({ type: "tool_call", id: 4, tool: "computer", params: { fail: true } }));
    assert.equal((await answerFor(4)).ok, false);
    assert.ok(attached.has(1), "the next call reattaches");
    await advance(10_000);
    assert.equal(attached.size, 0, "a failed call still schedules cleanup");
  } finally {
    extensionSocket.onclose = null;
    extensionSocket.terminate();
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }
});
