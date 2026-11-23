/**
 * The daemon↔extension bridge under a slow or dead extension — what the
 * morning after a laptop sleep looks like. A tool call the extension answers
 * late is logged (the work happened), a silent extension is dropped so tools
 * fail fast instead of waiting out their timeouts, and a tabs_create that times
 * out hands the agent the session token it minted so the retry can claim the
 * tab the first call opened.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import WebSocket from "ws";
import { Bridge } from "../src/bridge.js";
import { registerTools } from "../src/tools.js";

const TOKEN = "t";

function logger() {
  const lines = [];
  return { lines, log: (...a) => lines.push(a.join(" ")), error: (...a) => lines.push(a.join(" ")) };
}

/** Daemon side of the bridge on an ephemeral port plus a raw WS "extension". */
async function bridgeWithExtension(t, opts = {}) {
  const log = logger();
  const bridge = new Bridge({ token: TOKEN, logger: log, ...opts });
  const server = http.createServer();
  bridge.start(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const ext = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
  const calls = [];
  ext.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "tool_call") calls.push(msg);
  });
  await new Promise((r) => ext.on("open", r));
  ext.send(JSON.stringify({ type: "hello", protocol: 1, version: "test" }));
  t.after(() => {
    ext.close();
    bridge.stop();
    server.close();
  });
  return { bridge, ext, calls, log, port };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("a late answer to a timed-out call is logged, not lost in silence", async (t) => {
  const { bridge, ext, calls, log } = await bridgeWithExtension(t);
  const err = await bridge.sendTool("tabs_create", { url: "https://a.example" }, 50).catch((e) => e);
  assert.equal(err.code, "TIMEOUT");
  assert.match(err.message, /did not answer "tabs_create" within 0s/);
  assert.equal(calls.length, 1);

  ext.send(
    JSON.stringify({
      type: "tool_result",
      id: calls[0].id,
      ok: true,
      result: { data: { id: 7, timing: { createMs: 100, groupMs: 22_900 } } },
    })
  );
  await wait(50);
  const line = log.lines.find((l) => l.includes("tabs_create answered"));
  assert.ok(line, `expected a late-answer line, got:\n${log.lines.join("\n")}`);
  assert.match(line, /past its 0s timeout/);
  assert.match(line, /create 0\.1s, group 22\.9s/);
});

test("a silent extension is dropped so calls fail fast and status stops claiming it is connected", async (t) => {
  const { bridge, ext, log } = await bridgeWithExtension(t, { pingIntervalMs: 30, silenceMs: 80 });
  assert.equal(bridge.connected, true);
  // The extension keeps the transport open but its worker sends nothing.
  await wait(200);
  assert.equal(bridge.connected, false);
  assert.ok(log.lines.some((l) => /extension silent for \d+s — dropping/.test(l)), log.lines.join("\n"));
  await assert.rejects(() => bridge.sendTool("tabs_list", {}, 50), /not connected/);
  assert.equal(ext.readyState, WebSocket.CLOSED);
});

test("an extension that keeps pinging is kept", async (t) => {
  const { bridge, ext } = await bridgeWithExtension(t, { pingIntervalMs: 30, silenceMs: 80 });
  const pinger = setInterval(() => ext.send(JSON.stringify({ type: "ping" })), 20);
  t.after(() => clearInterval(pinger));
  await wait(200);
  assert.equal(bridge.connected, true);
});

/** registerTools against a stand-in MCP server: collect each tool's handler. */
function handlersFor(bridge) {
  const handlers = new Map();
  registerTools({ registerTool: (name, _meta, fn) => handlers.set(name, fn) }, { bridge, version: "0.0.0", logger: logger() });
  return handlers;
}

test("a first tabs_create carries a daemon-minted sessionToken, and a timeout names it for the retry", async () => {
  const sent = [];
  const bridge = {
    connected: true,
    lastHello: null,
    sendTool(tool, params) {
      sent.push({ tool, params });
      const err = new Error(`TaskWindow extension did not answer "${tool}" within 15s`);
      err.code = "TIMEOUT";
      return Promise.reject(err);
    },
  };
  const create = handlersFor(bridge).get("tabs_create");
  const res = await create({ url: "https://a.example", task: "Research competitors" });

  assert.equal(sent[0].tool, "tabs_create");
  const token = sent[0].params.sessionToken;
  assert.match(token, /^[0-9a-f-]{36}$/, "a UUID token was minted and forwarded");
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /did not answer "tabs_create" within 15s/);
  assert.ok(res.content[0].text.includes(`sessionToken "${token}"`), res.content[0].text);
  assert.match(res.content[0].text, /returns the tab the first call opened/);

  // An agent that already has a token keeps it.
  await create({ url: "https://a.example", task: "Research competitors", sessionToken: "mine" });
  assert.equal(sent[1].params.sessionToken, "mine");
});

test("other tools' timeouts warn against blind repeats; non-timeout errors pass through untouched", async () => {
  let fail;
  const bridge = { connected: true, lastHello: null, sendTool: () => Promise.reject(fail) };
  const handlers = handlersFor(bridge);

  fail = Object.assign(new Error('TaskWindow extension did not answer "computer" within 30s'), { code: "TIMEOUT" });
  const timedOut = await handlers.get("computer")({ action: "left_click", x: 1, y: 1, sessionToken: "s" });
  assert.match(timedOut.content[0].text, /within 30s\. Chrome may still complete the action; check the page/);

  fail = new Error("Access denied: tab 5 is not in your session's tab groups.");
  const denied = await handlers.get("computer")({ action: "left_click", x: 1, y: 1, sessionToken: "s" });
  assert.equal(denied.content[0].text, "Error: Access denied: tab 5 is not in your session's tab groups.");
});

/**
 * Two browsers with the extension, one daemon. Each real extension redials a
 * second after it loses the connection, so when the newest connection always
 * won, two of them took it from each other about once a second and a tool
 * call landed in whichever browser held it at that instant.
 */
function dial(port, { token = TOKEN, ...options } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`, options);
  const calls = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "tool_call") calls.push(msg);
  });
  /** "open", or the refusal: {status} at the handshake, {code} after it. */
  const outcome = new Promise((resolve) => {
    ws.on("open", () => resolve("open"));
    ws.on("unexpected-response", (req, res) => {
      req.destroy();
      resolve({ status: res.statusCode });
    });
    ws.on("error", () => {});
  });
  return { ws, calls, outcome };
}

test("a second browser is refused while the first one answers, and tool calls stay in the first", async (t) => {
  const { bridge, ext, calls, log, port } = await bridgeWithExtension(t);
  const second = dial(port);
  t.after(() => second.ws.terminate());

  assert.deepEqual(await second.outcome, { status: 409 });
  assert.equal(ext.readyState, WebSocket.OPEN, "the first browser kept its connection");
  assert.equal(bridge.connected, true);

  const pending = bridge.sendTool("tabs_list", {}, 500);
  await wait(30);
  assert.equal(calls.length, 1, "the call reached the first browser");
  assert.equal(second.calls.length, 0);
  ext.send(JSON.stringify({ type: "tool_result", id: calls[0].id, ok: true, result: { text: "ok" } }));
  assert.deepEqual(await pending, { text: "ok" });

  assert.ok(log.lines.some((l) => l.includes("refused another extension connection")), log.lines.join("\n"));
  assert.equal(bridge.otherBrowser.attempts, 1);

  // The first browser goes away: the second gets in on its next try, and
  // status stops reporting a refused browser, since it is now the connected one.
  ext.close();
  await new Promise((r) => ext.on("close", r));
  const retry = dial(port);
  t.after(() => retry.ws.terminate());
  assert.equal(await retry.outcome, "open");
  await wait(30);
  assert.equal(bridge.connected, true);
  assert.equal(bridge.otherBrowser, null);
});

test("two browsers that both keep redialling do not take the connection from each other", async (t) => {
  const { bridge, ext, log, port } = await bridgeWithExtension(t);
  let firstLost = 0;
  ext.on("close", () => firstLost++);

  // The second browser, redialling the way the extension does, only faster.
  let stop = false;
  let opened = 0;
  let refused = 0;
  const sockets = [];
  const outcomes = [];
  const redial = () => {
    if (stop) return;
    const { ws, outcome } = dial(port);
    sockets.push(ws);
    outcomes.push(
      outcome.then((o) => {
        if (o === "open") {
          opened++;
          ws.on("close", () => setTimeout(redial, 10));
        } else {
          refused++;
          setTimeout(redial, 10);
        }
      })
    );
  };
  redial();
  t.after(() => {
    stop = true;
    for (const ws of sockets) ws.terminate();
  });

  await wait(400);
  stop = true;
  await Promise.all(outcomes); // let the attempt in flight get its answer
  assert.ok(refused > 5, `the second browser kept trying (${refused} refusals)`);
  assert.equal(opened, 0, "it never got a connection");
  assert.equal(firstLost, 0, "the first browser was never disconnected");
  assert.equal(bridge.connected, true);
  assert.equal(log.lines.filter((l) => l.includes("replacing")).length, 0, log.lines.join("\n"));
  // A browser that retries for hours must not fill the log.
  assert.equal(log.lines.filter((l) => l.includes("refused another extension connection")).length, 1);
  assert.equal(bridge.otherBrowser.attempts, refused);
});

test("a connection that stopped answering gives way to a new one", async (t) => {
  const log = logger();
  const bridge = new Bridge({ token: TOKEN, logger: log, probeMs: 60 });
  const server = http.createServer();
  bridge.start(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  // What a laptop sleep leaves behind: the socket reads OPEN, nothing answers.
  const dead = dial(port, { autoPong: false });
  assert.equal(await dead.outcome, "open");
  const fresh = dial(port);
  t.after(() => {
    dead.ws.terminate();
    fresh.ws.terminate();
    bridge.stop();
    server.close();
  });

  assert.equal(await fresh.outcome, "open");
  assert.equal(bridge.otherBrowser, null, "taking over from a dead connection is not a refusal");
  assert.ok(log.lines.some((l) => l.includes("replacing an extension connection that stopped answering")), log.lines.join("\n"));

  const pending = bridge.sendTool("tabs_list", {}, 500);
  await wait(30);
  assert.equal(fresh.calls.length, 1, "calls now reach the new connection");
  fresh.ws.send(JSON.stringify({ type: "tool_result", id: fresh.calls[0].id, ok: true, result: {} }));
  await pending;
});

test("an extension that closes its socket and redials at once gets back in", async (t) => {
  const { bridge, ext, port } = await bridgeWithExtension(t);
  // The extension's own keepalive does this: close the old socket, dial a new
  // one in the same breath. The daemon may see the new one first.
  ext.close();
  const again = dial(port);
  t.after(() => again.ws.terminate());
  assert.equal(await again.outcome, "open");
  await wait(30);
  assert.equal(bridge.connected, true);
  assert.equal(bridge.otherBrowser, null);
});

test("a wrong token is still answered with 4401 while a browser is connected", async (t) => {
  const { ext, port } = await bridgeWithExtension(t);
  // 4401 is how the extension learns its token is dead and pairs again, so it
  // must not turn into the handshake refusal a second browser gets.
  const stale = dial(port, { token: "stale" });
  t.after(() => stale.ws.terminate());
  assert.equal(await stale.outcome, "open");
  const [code] = await new Promise((resolve) => stale.ws.on("close", (...args) => resolve(args)));
  assert.equal(code, 4401);
  assert.equal(ext.readyState, WebSocket.OPEN);
});
