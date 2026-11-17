/**
 * Page dialogs (issue #55): Chrome draws alert/confirm/prompt and the
 * "Leave site?" confirmation outside the page, so screenshots never show them,
 * and the page answers nothing until one is closed. These pin what the agent
 * is told, and that nothing is discarded unless it asked.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeChrome } from "./chrome-mock.js";

const EXT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "extension", "tools");
let emit; // cdp.js registers its CDP event listener once, on first import
let loadCount = 0;

async function setup() {
  const mock = makeChrome();
  mock.chrome.debugger.onEvent.addListener = (fn) => { emit = fn; };
  globalThis.chrome = mock.chrome;
  mock.storage.set("separateWindow", false);
  const q = `?d=${++loadCount}`;
  const tabs = await import(pathToFileURL(join(EXT, "tabs.js")).href + q);
  const page = await import(pathToFileURL(join(EXT, "page.js")).href + q);
  const js = await import(pathToFileURL(join(EXT, "javascript.js")).href + q);
  const computer = await import(pathToFileURL(join(EXT, "computer.js")).href + q);
  const cdp = await import(pathToFileURL(join(EXT, "cdp.js")).href);
  const { data } = await tabs.tabsCreate({ url: "https://example.com/form", task: "Dialogs", longRunning: false });
  const args = { tabId: data.id, sessionToken: data.sessionToken };
  const open = (type, message = "") => emit({ tabId: data.id }, "Page.javascriptDialogOpening", { type, message, url: "https://example.com/form" });
  const loads = () => { mock.chrome.tabs.onUpdated.addListener = (fn) => queueMicrotask(() => fn(data.id, { status: "complete" })); };
  const answers = () => mock.cdp.filter((c) => c.method === "Page.handleJavaScriptDialog").map((c) => c.params);
  return { mock, tabs, page, js, computer, cdp, data, args, open, loads, answers };
}

test("reload on a page with unsaved changes reports Blocked and keeps them", async () => {
  const t = await setup();
  // Chrome holds the reload behind the dialog: no load event ever comes.
  t.mock.chrome.tabs.reload = async () => { queueMicrotask(() => t.open("beforeunload")); };
  const result = await t.tabs.reload(t.args);
  assert.match(result.text, /^Blocked: .*unsaved changes.*onUnsaved: "discard"/s);
  assert.deepEqual(t.answers(), [{ accept: false }], "answered Stay, so nothing is lost");
  assert.equal(t.cdp.openDialog(t.data.id), null, "the tab is not left blocked");
});

test("onUnsaved: discard leaves the page and waits for the load", async () => {
  const t = await setup();
  t.mock.chrome.tabs.update = async () => { queueMicrotask(() => t.open("beforeunload")); };
  t.mock.cdp.length = 0;
  const realSend = t.mock.chrome.debugger.sendCommand;
  t.mock.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === "Page.handleJavaScriptDialog" && params.accept) {
      t.mock.tabs.get(t.data.id).url = "https://example.com/next";
      t.loads();
    }
    return realSend(target, method, params);
  };
  const result = await t.tabs.navigate({ ...t.args, url: "https://example.com/next", onUnsaved: "discard" });
  assert.deepEqual(t.answers(), [{ accept: true }]);
  assert.match(result.text, /now at https:\/\/example\.com\/next/);
  assert.match(result.text, /discarded/);
  assert.equal(result.data.loadTimedOut, false);
});

test("a dialog opened by a call is reported at once, blocks the tab's tools fast, and the dialog tool answers it", async () => {
  const t = await setup();
  const realSend = t.mock.chrome.debugger.sendCommand;
  // confirm() blocks the renderer: Runtime.evaluate never answers while it is open.
  t.mock.chrome.debugger.sendCommand = (target, method, params) => {
    if (method === "Runtime.evaluate") {
      queueMicrotask(() => t.open("confirm", "Delete this record?"));
      return new Promise(() => {});
    }
    return realSend(target, method, params);
  };
  await assert.rejects(
    () => t.js.javascriptExecute({ ...t.args, code: "confirm('Delete this record?')" }),
    /open a confirm dialog: "Delete this record\?".*dialog tool/s
  );
  t.mock.chrome.debugger.sendCommand = realSend;

  // Every later call names the dialog instead of hanging — including a default
  // (human) click, which injects its cursor script before any CDP command, and
  // script injection into a page behind a dialog never returns.
  const realInject = t.mock.chrome.scripting.executeScript;
  t.mock.chrome.scripting.executeScript = () => new Promise(() => {});
  await assert.rejects(() => t.computer.computer({ ...t.args, action: "left_click", x: 5, y: 5, human: true }), /is showing a confirm dialog/);
  t.mock.chrome.scripting.executeScript = realInject;
  await assert.rejects(() => t.js.javascriptExecute({ ...t.args, code: "1" }), /is showing a confirm dialog/);
  await assert.rejects(() => t.page.readPage(t.args), /is showing a confirm dialog/);
  await assert.rejects(() => t.tabs.reload(t.args), /is showing a confirm dialog/);
  const listed = await t.tabs.tabsList(t.args);
  assert.match(listed.text, /blocked by a confirm dialog: "Delete this record\?"/);

  // Idle cleanup keeps the attachment, or the close event could never arrive.
  await t.cdp.detachIdleDebuggers();
  assert.ok(t.cdp.ATTACHED.has(t.data.id));

  const answered = await t.tabs.dialog({ ...t.args, action: "dismiss" });
  assert.deepEqual(t.answers(), [{ accept: false }]);
  assert.match(answered.text, /dismissed a confirm dialog/);
  const after = await t.js.javascriptExecute({ ...t.args, code: "1" });
  assert.ok(after, "the tab works again");
});

test("a prompt is answered with promptText; a dialog the user closes stops blocking", async () => {
  const t = await setup();
  await t.cdp.ensureAttached(t.data.id);
  t.open("prompt", "Your name?");
  const answered = await t.tabs.dialog({ ...t.args, action: "accept", promptText: "Ada" });
  assert.deepEqual(t.answers(), [{ accept: true, promptText: "Ada" }]);
  assert.match(answered.text, /accepted a prompt: "Your name\?" .*with the answer "Ada"/);

  t.open("alert", "Saved");
  emit({ tabId: t.data.id }, "Page.javascriptDialogClosed", { result: true });
  assert.equal(t.cdp.openDialog(t.data.id), null);
  const none = await t.tabs.dialog({ ...t.args, action: "dismiss" });
  assert.match(none.text, /no dialog/);
});
