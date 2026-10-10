import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

const STORE_ID = "adbfpkbjndcpjihceobeegkokblgifpe";

test("the extension is idle only with no tool call running and none for the quiet period", async () => {
  // A daemon that hands the extension one tool call and holds it open.
  let daemonSide;
  const connected = new Promise((resolve) => (daemonSide = resolve));
  let answered;
  const resultSent = new Promise((resolve) => (answered = resolve));
  const server = createServer((_req, res) => res.writeHead(404).end());
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      if (JSON.parse(data).type === "tool_result") answered();
    });
    daemonSide(ws);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const storage = new Map([["token", "token"], ["port", server.address().port]]);

  globalThis.WebSocket = WebSocket;
  if (!globalThis.navigator) globalThis.navigator = { userAgent: "test" };
  // The extension keeps redialling forever, as it should in Chrome; here that
  // must not hold the test process open once the daemon is gone.
  for (const name of ["setTimeout", "setInterval"]) {
    const real = globalThis[name];
    globalThis[name] = (...args) => real(...args).unref();
  }
  globalThis.chrome = {
    runtime: { id: STORE_ID, getURL: (p) => `chrome-extension://${STORE_ID}/${p}`, sendMessage: async () => {} },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    tabs: { onRemoved: { addListener() {} } },
    debugger: { onEvent: { addListener() {} }, onDetach: { addListener() {} } },
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
    assert.equal(isIdle(10_000), true, "nothing has run yet");
    connectWs({
      version: "test",
      dispatchTool: async () => {
        started();
        await callRunning;
        return {};
      },
    });
    const ws = await connected;
    ws.send(JSON.stringify({ type: "tool_call", id: 1, tool: "gif_record", params: {} }));
    await callStarted;
    assert.equal(isIdle(0), false, "a call is running");
    finishCall();
    await resultSent;
    assert.equal(isIdle(0), true, "the call is done");
    assert.equal(isIdle(10_000), false, "but it ran under ten seconds ago");
  } finally {
    for (const client of wss.clients) client.terminate();
    wss.close();
    server.close();
  }
});
