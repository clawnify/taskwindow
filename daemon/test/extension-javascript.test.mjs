/**
 * javascript_execute's result (issue #38). A Promise the script returned came
 * back as {}: in REPL mode Chrome waits for a top-level `await` only, and a
 * Promise read by value is an empty object.
 *
 * That is V8's behaviour, which a hand-written mock would only restate, so the
 * Runtime commands here go to this process's own V8 inspector: the code that
 * answers them in Chrome.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { Session } from "node:inspector";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeChrome } from "./chrome-mock.js";
import { registerTools, unawaitedPromiseNote, AWAITS_RETURNED_PROMISE_SINCE } from "../src/tools.js";

const EXT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "extension", "tools");

const inspector = new Session();
inspector.connect();
after(() => inspector.disconnect());
// A protocol error rejects, as chrome.debugger.sendCommand does.
const v8 = (method, params) =>
  new Promise((resolve, reject) => {
    inspector.post(method, params, (err, result) => (err ? reject(err) : resolve(result)));
  });

const mock = makeChrome();
const log = mock.chrome.debugger.sendCommand; // records the command in mock.cdp
mock.chrome.debugger.sendCommand = async (target, method, params) => {
  await log(target, method, params);
  return method.startsWith("Runtime.") ? v8(method, params) : {};
};
globalThis.chrome = mock.chrome;
mock.storage.set("separateWindow", false);
const tabs = await import(pathToFileURL(join(EXT, "tabs.js")).href);
const { javascriptExecute } = await import(pathToFileURL(join(EXT, "javascript.js")).href);
const { data } = await tabs.tabsCreate({ url: "https://example.com/orders", task: "Scripts", longRunning: false });
const run = (code, extra = {}) => javascriptExecute({ tabId: data.id, sessionToken: data.sessionToken, code, ...extra });

test("a Promise the script returns is waited for, like a top-level await", async () => {
  // The four rows of the issue's table.
  assert.deepEqual((await run("({a: 1})")).data.result, { a: 1 });
  assert.equal((await run("new Promise(r => setTimeout(() => r(JSON.stringify({ok: true})), 20))")).text, '{"ok":true}');
  assert.equal((await run("(async () => { await new Promise(r => setTimeout(r, 20)); return 'done'; })()")).text, "done");
  assert.equal((await run("await new Promise(r => setTimeout(() => r('awaited'), 20))")).text, "awaited");

  assert.deepEqual((await run("Promise.resolve({rows: [1, 2]})")).data.result, { rows: [1, 2] });
  assert.equal((await run("Promise.resolve()")).data.result, null);
  // A thenable that is not a native Promise (jQuery's jqXHR, a query builder).
  assert.equal((await run("({then(resolve) { resolve('thenable'); }})")).text, "thenable");
});

test("a Promise that rejects is an error naming the reason", async () => {
  await assert.rejects(() => run("Promise.reject(new Error('nope'))"), /^Error: page script threw: Error: nope/);
  await assert.rejects(() => run("new Promise((_, reject) => setTimeout(() => reject('timed out'), 20))"), /page script threw: timed out/);
  await assert.rejects(() => run("throw new TypeError('sync')"), /page script threw: TypeError: sync/);
});

test("awaitPromise: false returns at once and names the Promise instead of {}", async () => {
  const result = await run("new Promise(() => {})", { awaitPromise: false });
  assert.equal(result.data.result, "Promise");
  assert.equal(result.text, "Promise");
});

test("results that are not Promises are unchanged", async () => {
  assert.equal((await run("42")).data.result, 42);
  assert.equal((await run("'text'")).text, "text");
  assert.equal((await run("undefined")).data.result, null);
  assert.equal((await run("null")).data.result, null);
  assert.equal((await run("NaN")).data.result, "NaN");
  assert.deepEqual((await run("[1, {b: 2}]")).data.result, [1, { b: 2 }]);
  assert.equal((await run("Symbol('s')")).data.result, "Symbol(s)");
  // Why REPL mode stays: the second declaration of `ta` is not an error.
  assert.equal((await run("const ta = 1; ta")).data.result, 1);
  assert.equal((await run("const ta = 2; ta")).data.result, 2);
});

test("no handle outlives its call, whether it returned, threw or was left pending", async () => {
  mock.cdp.length = 0;
  await run("({a: 1})");
  await run("Promise.resolve(1)");
  await run("new Promise(() => {})", { awaitPromise: false });
  await assert.rejects(() => run("Promise.reject(new Error('nope'))"));
  await assert.rejects(() => run("throw new Error('sync')"));
  const groups = mock.cdp.filter((c) => c.method === "Runtime.evaluate").map((c) => c.params.objectGroup);
  const released = mock.cdp.filter((c) => c.method === "Runtime.releaseObjectGroup").map((c) => c.params.objectGroup);
  assert.equal(new Set(groups).size, 5, "one group per call, so a release cannot reach another call's result");
  assert.deepEqual(released, groups);

  // And released for real: V8 no longer knows the object the handle named.
  const handle = mock.cdp.find((c) => c.method === "Runtime.callFunctionOn").params.objectId;
  await assert.rejects(
    () => v8("Runtime.callFunctionOn", { objectId: handle, functionDeclaration: "function () {}" }),
    /Could not find object with given id/
  );
});

// Chrome updates the extension from the Web Store on its own schedule, so a
// daemon with the fix still meets extensions without it.
test("a daemon ahead of the extension says what a {} may be", async () => {
  const empty = { data: { result: {} }, text: "{}" };
  const note = (args, result, version) => unawaitedPromiseNote("javascript_execute", args, result, version);
  assert.match(note({}, empty, "0.2.18"), /this \{\} is the Promise, not its value.*\(v0\.2\.18\) does not wait.*top-level await/s);
  assert.match(note({}, empty, null), /\(version unknown\) does not wait/);
  assert.equal(note({}, empty, AWAITS_RETURNED_PROMISE_SINCE), null);
  assert.equal(note({}, empty, "0.3.0"), null);
  assert.equal(note({ awaitPromise: false }, empty, "0.2.18"), null, "the caller asked not to wait");
  for (const value of [{ a: 1 }, [], null, "{}", 0]) assert.equal(note({}, { data: { result: value } }, "0.2.18"), null);
  assert.equal(unawaitedPromiseNote("read_page", {}, empty, "0.2.18"), null);

  // On the answer itself, called directly or as a batch step.
  const bridge = { connected: true, lastHello: { version: "0.2.18" }, sendTool: async () => ({ data: { result: {} }, text: "{}" }) };
  const handlers = new Map();
  registerTools({ registerTool: (name, _meta, fn) => handlers.set(name, fn) }, { bridge, version: "0.0.0", logger: { error() {} } });
  const direct = await handlers.get("javascript_execute")({ code: "fetch('/')", sessionToken: "s" });
  assert.match(direct.content[0].text, /^\{\}\nNote: if the script returned a Promise/);
  const batch = await handlers.get("browser_batch")({ steps: [{ tool: "javascript_execute", params: { code: "fetch('/')" } }], sessionToken: "s" });
  assert.match(batch.content[0].text, /^1\. javascript_execute:\n\{\}\nNote: if the script returned a Promise/);

  bridge.lastHello.version = AWAITS_RETURNED_PROMISE_SINCE;
  const current = await handlers.get("javascript_execute")({ code: "({})", sessionToken: "s" });
  assert.equal(current.content[0].text, "{}");
});
