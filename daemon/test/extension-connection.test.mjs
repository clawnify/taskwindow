import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

const STORE_ID = "adbfpkbjndcpjihceobeegkokblgifpe";
const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;
const sleep = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));
const within = (promise, what) => Promise.race([promise, new Promise((_, reject) => {
  realSetTimeout(() => reject(new Error(`timed out waiting for ${what}`)), 5000).unref();
})]);
let instance = 0;

/**
 * Runs the extension's real connection code against a real WebSocket server
 * standing in for the daemon, with a store build's chrome.* mocked around it.
 * The daemon answers /pair with the token "new".
 */
async function withExtension({ token, onSocket, dispatchTool = async () => ({}) }, body) {
  const server = createServer((_req, res) => res.writeHead(404).end());
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws, req) => onSocket(ws, new URL(req.url, "http://127.0.0.1").searchParams.get("token")));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const store = { port, token };
  const removals = [];
  const changeListeners = [];
  const notify = (keys) => {
    for (const listener of changeListeners) listener(Object.fromEntries(keys.map((key) => [key, {}])), "local");
  };
  globalThis.WebSocket = WebSocket;
  const hadNavigator = "navigator" in globalThis; // Node 21+ has one; the hello reads its userAgent
  if (!hadNavigator) globalThis.navigator = { userAgent: "test" };
  globalThis.chrome = {
    runtime: { id: STORE_ID, getURL: (path) => `chrome-extension://${STORE_ID}/${path}`, sendMessage: async () => {} },
    storage: {
      local: {
        get: async (keys) => Object.fromEntries(keys.filter((key) => key in store).map((key) => [key, store[key]])),
        set: async (values) => {
          Object.assign(store, values);
          notify(Object.keys(values));
        },
        remove: async (key) => {
          delete store[key];
          removals.push(key);
          notify([key]);
        },
      },
      onChanged: { addListener: (listener) => changeListeners.push(listener) },
    },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    tabs: { onRemoved: { addListener() {} } },
    debugger: { onEvent: { addListener() {} }, onDetach: { addListener() {} } },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url) === `http://127.0.0.1:${port}/pair` && options?.method === "POST") {
      return new Response(JSON.stringify({ token: "new" }), { status: 200 });
    }
    return new Response("", { status: 404 }); // no installer bootstrap file in a store build
  };
  // The extension keeps reconnecting forever; unref'd timers let the test
  // process exit once it is done.
  globalThis.setTimeout = (...args) => realSetTimeout(...args).unref();
  globalThis.setInterval = (...args) => realSetInterval(...args).unref();

  try {
    // A fresh module per test: its connection state is module-level.
    const connection = await import(`../../extension/tools/connection.js?instance=${++instance}`);
    connection.connectWs({ version: "test", dispatchTool });
    await body({ connection, store, removals });
  } finally {
    // Close the sockets while the mocks still stand: the extension's close
    // handler runs after them.
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(() => server.close(resolve)));
    await sleep(50);
    globalThis.setTimeout = realSetTimeout;
    globalThis.setInterval = realSetInterval;
    globalThis.fetch = realFetch;
    delete globalThis.chrome;
    delete globalThis.WebSocket;
    if (!hadNavigator) delete globalThis.navigator;
  }
}

test("a store extension holding an old token pairs again when the daemon rejects it", async () => {
  // A daemon whose token changed under the extension (reinstalled, rotated,
  // or a Chrome profile restored from a backup).
  const sockets = [];
  let accepted;
  const acceptedNew = new Promise((resolve) => (accepted = resolve));
  await withExtension({
    token: "old",
    onSocket: (ws, token) => {
      sockets.push(token);
      if (token !== "new") ws.close(4401, "invalid or missing token");
      else accepted();
    },
  }, async ({ store, removals }) => {
    await within(acceptedNew, "a connection with the new token");
    assert.deepEqual(removals, ["token"]);
    assert.deepEqual(sockets, ["old", "new"]);
    assert.equal(store.token, "new");
  });
});

test("the extension is idle only with no tool call running and none for the quiet period", async () => {
  let socket;
  const connected = new Promise((resolve) => {
    socket = resolve;
  });
  let finishCall;
  const callRunning = new Promise((resolve) => {
    finishCall = resolve;
  });
  let started;
  const callStarted = new Promise((resolve) => (started = resolve));
  let answered;
  const resultSent = new Promise((resolve) => (answered = resolve));
  await withExtension({
    token: "new",
    onSocket: (ws) => {
      ws.on("message", (data) => {
        if (JSON.parse(data).type === "tool_result") answered();
      });
      socket(ws);
    },
    dispatchTool: async () => {
      started();
      await callRunning;
      return {};
    },
  }, async ({ connection }) => {
    assert.equal(connection.isIdle(10_000), true, "nothing has run yet");
    const ws = await within(connected, "the extension to connect");
    ws.send(JSON.stringify({ type: "tool_call", id: 1, tool: "gif_record", params: {} }));
    await within(callStarted, "the tool call to start");
    assert.equal(connection.isIdle(0), false, "a call is running");
    finishCall();
    await within(resultSent, "the tool result");
    assert.equal(connection.isIdle(0), true, "the call is done");
    assert.equal(connection.isIdle(10_000), false, "but it ran under ten seconds ago");
  });
});
