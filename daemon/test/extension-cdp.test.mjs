import test from "node:test";
import assert from "node:assert/strict";

let run = 0;
async function setup() {
  const attached = new Set();
  const calls = [];
  const messages = [];
  const gates = {};
  let event, detached;
  globalThis.chrome = {
    debugger: {
      async attach({ tabId }) {
        calls.push([tabId, "attach"]);
        await gates.attach;
        assert.equal(attached.has(tabId), false, "Chrome rejects a duplicate attachment");
        attached.add(tabId);
      },
      async detach({ tabId }) {
        calls.push([tabId, "detach"]);
        await gates.detach;
        if (gates.failDetach) throw new Error("detach failed");
        attached.delete(tabId);
        // Chrome does not emit onDetach for the extension's own detach().
      },
      async sendCommand({ tabId }, method) {
        assert.ok(attached.has(tabId), "commands require a live attachment");
        calls.push([tabId, method]);
        gates.onCommand?.(tabId, method);
        await gates.command;
        return {};
      },
      onEvent: { addListener(fn) { event = fn; } },
      onDetach: { addListener(fn) { detached = fn; } },
    },
    tabs: { async sendMessage(tabId, msg) { messages.push({ tabId, msg }); } },
  };
  const cdp = await import(`../../extension/tools/cdp.js?test=${++run}`);
  return { ...cdp, attached, calls, messages, gates, event, detached };
}

test("idle detach preserves captured logs and tabs, hides the indicator, and reattaches on demand", async () => {
  const c = await setup();
  await c.withDebugger(1, () => {});
  c.event({ tabId: 1 }, "Runtime.consoleAPICalled", { type: "log", timestamp: 123, args: [{ type: "string", value: "hello" }] });
  c.event({ tabId: 1 }, "Network.requestWillBeSent", { requestId: "a", request: { method: "GET", url: "https://example.com" } });
  await c.detachIdleDebuggers();
  assert.equal(c.ATTACHED.size, 0);
  assert.equal(c.attached.size, 0);
  assert.equal(c.getBuffers(1).console[0].text, "hello");
  assert.equal(c.getBuffers(1).network.size, 1);
  assert.deepEqual(c.messages, [{ tabId: 1, msg: { type: "taskwindow:indicator", op: "hide" } }]);
  await c.withDebugger(1, (id) => c.send(id, "Page.captureScreenshot"));
  assert.equal(c.calls.filter(([, m]) => m === "attach").length, 2);
  assert.equal(c.calls.filter(([, m]) => m === "Network.enable").length, 2);
  assert.equal(c.getBuffers(1).console.length, 1);
});

test("idle detach exempts rendering and retained viewport tabs; removing a tab clears its retention", async () => {
  const c = await setup();
  await c.ensureAttached(1);
  await c.keepRendering(2);
  await c.ensureAttached(3);
  c.retainDebugger(3);
  await c.detachIdleDebuggers();
  assert.deepEqual([...c.attached], [2, 3]);
  assert.deepEqual(c.calls.filter(([, m]) => m === "detach"), [[1, "detach"]]);
  c.dropTabState(2);
  c.attached.delete(2);
  await c.ensureAttached(2);
  await c.detachIdleDebuggers();
  assert.equal(c.attached.has(2), false, "a new tab cannot inherit a removed tab's rendering retention");
});

test("concurrent calls share attachment and wait until capture domains finish enabling", async () => {
  const c = await setup();
  let release;
  c.gates.command = new Promise((r) => { release = r; });
  const a = c.ensureAttached(1);
  await new Promise(setImmediate);
  let ran = false;
  const b = c.withDebugger(1, () => { ran = true; });
  await new Promise(setImmediate);
  assert.equal(ran, false);
  release();
  await Promise.all([a, b]);
  assert.equal(c.calls.filter(([, m]) => m === "attach").length, 1);
});

test("a call arriving during idle detach waits for it before reattaching the same tab", async () => {
  const c = await setup();
  await c.ensureAttached(1);
  let release;
  c.gates.detach = new Promise((r) => { release = r; });
  const cleanup = c.detachIdleDebuggers();
  let ran = false;
  const next = c.withDebugger(1, (id) => { ran = true; return c.send(id, "Page.captureScreenshot"); });
  await new Promise(setImmediate);
  assert.equal(ran, false);
  await c.withDebugger(2, () => {}); // another tab need not wait
  release();
  await Promise.all([cleanup, next]);
  assert.equal(c.attached.has(1), true);
});

test("a failed detach keeps attachment state so cleanup can retry", async () => {
  const c = await setup();
  await c.ensureAttached(1);
  c.gates.failDetach = true;
  assert.equal(await c.detachIdleDebuggers(), true, "request a retry");
  assert.ok(c.ATTACHED.has(1));
  c.gates.failDetach = false;
  assert.equal(await c.detachIdleDebuggers(), false);
  assert.equal(c.ATTACHED.has(1), false);
});

test("reconnection suppresses cached console replay without suppressing repeated new messages", async () => {
  const c = await setup();
  await c.ensureAttached(1);
  const entry = { type: "log", timestamp: 123, args: [{ type: "string", value: "hello" }] };
  c.event({ tabId: 1 }, "Runtime.consoleAPICalled", entry);
  c.event({ tabId: 1 }, "Runtime.consoleAPICalled", entry);
  await c.detachIdleDebuggers();
  c.gates.onCommand = (tabId, method) => {
    if (method !== "Runtime.enable") return;
    c.event({ tabId }, "Runtime.consoleAPICalled", entry);
    c.event({ tabId }, "Runtime.consoleAPICalled", entry);
  };
  await c.ensureAttached(1);
  assert.equal(c.getBuffers(1).console.length, 2, "cached copies were not added again");
  c.event({ tabId: 1 }, "Runtime.consoleAPICalled", { ...entry, timestamp: 124 });
  c.event({ tabId: 1 }, "Runtime.consoleAPICalled", entry);
  assert.equal(c.getBuffers(1).console.length, 4, "ordinary repeated messages are still captured");
});
