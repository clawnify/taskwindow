import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocket } from "ws";
import { Bridge } from "../src/bridge.js";

const STORE_ID = "adbfpkbjndcpjihceobeegkokblgifpe";

test("a store build whose token the daemon rejects forgets it and pairs again by origin", async () => {
  // A daemon whose token was rotated: it no longer accepts the one Chrome kept.
  const bridge = new Bridge({ token: "rotated-token" });
  const pairs = [];
  const server = createServer((req, res) => {
    if (req.url === "/pair" && req.method === "POST") {
      pairs.push(req.headers.origin);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ token: "rotated-token" }));
      return;
    }
    res.writeHead(404).end();
  });
  bridge.start(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const storage = new Map([["token", "old-token"], ["port", port]]);
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
  // The store origin is what Chrome stamps on the extension's own requests.
  globalThis.fetch = ((realFetch) => async (url, options = {}) => {
    if (String(url).startsWith("chrome-extension://")) return new Response("", { status: 404 });
    return realFetch(url, { ...options, headers: { ...options.headers, origin: `chrome-extension://${STORE_ID}` } });
  })(globalThis.fetch);

  try {
    const { connectWs, isConnected } = await import("../../extension/tools/connection.js");
    connectWs({ version: "test", dispatchTool: async () => ({}) });
    const deadline = Date.now() + 8000;
    while (!(isConnected() && bridge.connected) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.equal(isConnected(), true, "reconnected after the rejection");
    assert.equal(storage.get("token"), "rotated-token");
    assert.equal(pairs.length, 1);
  } finally {
    bridge.stop();
    server.close();
  }
});
