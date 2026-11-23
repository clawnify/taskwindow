/**
 * Extension pages are off limits to tools. TaskWindow's own pages (settings,
 * popover, the responsive harness) run with the extension's rights, so a tool
 * that opened one or ran on one would be acting as the extension: the
 * "all tabs" setting is the user's to change, not the agent's.
 *
 * Run in Node against the chrome.* mock, whose pages live at
 * chrome-extension://test/.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { makeChrome } from "./chrome-mock.js";
import { extensionPageRefusal, guardExtensionPages, REFUSES_EXTENSION_PAGES_SINCE } from "../src/tools.js";

const TOOLS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "extension", "tools");
const OWN = "chrome-extension://test/options/options.html";
const OFF_LIMITS = /extension pages are off limits/i;

/** One instance of each module, as in the extension; real state lives in chrome.storage, fresh per mock. */
async function load(mock) {
  globalThis.chrome = mock.chrome;
  mock.storage.set("separateWindow", false);
  mock.chrome.tabs.onUpdated.addListener = (fn) => queueMicrotask(() => fn(null, { status: "complete" }));
  const tabs = await import(pathToFileURL(join(TOOLS, "tabs.js")).href);
  const { javascriptExecute } = await import(pathToFileURL(join(TOOLS, "javascript.js")).href);
  const responsive = await import(pathToFileURL(join(TOOLS, "responsive.js")).href);
  responsive.TIMING.frameDeadlineMs = 60;
  return { ...tabs, javascriptExecute, setViewport: responsive.setViewport };
}

async function session(mock) {
  const tools = await load(mock);
  const { data } = await tools.tabsCreate({ url: "https://example.com", task: "Pages", longRunning: false });
  return { ...tools, tabId: data.id, own: { tabId: data.id, sessionToken: data.sessionToken }, token: data.sessionToken };
}

const SPELLINGS = [
  OWN,
  "CHROME-EXTENSION://test/options/options.html",
  "  " + OWN,
  "chrome-extension://someotherextension/page.html",
  "blob:chrome-extension://test/0b3c-uuid",
  "view-source:" + OWN,
];

test("no tool opens an extension page, however the address is spelled", async () => {
  const mock = makeChrome();
  const { tabsCreate, navigate, setViewport, own, token } = await session(mock);
  const before = mock.tabs.size;
  for (const url of SPELLINGS) {
    await assert.rejects(() => tabsCreate({ url, sessionToken: token }), OFF_LIMITS, `tabs_create ${url}`);
    await assert.rejects(() => navigate({ ...own, url }), OFF_LIMITS, `navigate ${url}`);
    await assert.rejects(() => setViewport({ viewports: [{ width: 390, height: 844 }], url, sessionToken: token }), OFF_LIMITS, `set_viewport ${url}`);
  }
  assert.equal(mock.tabs.size, before, "nothing was opened");
  assert.equal(mock.tabs.get(own.tabId).url, "https://example.com", "the tab stayed where it was");
});

test("an address that only mentions an extension page is still a web page", async () => {
  const mock = makeChrome();
  const { tabsCreate, token } = await session(mock);
  const made = await tabsCreate({ url: "https://example.com/?next=chrome-extension://test/options/options.html", sessionToken: token });
  assert.ok(made.data.id);
});

test("a tab that shows an extension page is out of reach of every tool, but can be left or closed", async () => {
  const mock = makeChrome();
  const { resolveTab, javascriptExecute, navigate, tabsClose, own } = await session(mock);
  mock.tabs.get(own.tabId).url = OWN; // got there some other way
  mock.cdp.length = 0;

  await assert.rejects(() => resolveTab(own.tabId, own.sessionToken), OFF_LIMITS, "the lookup every tool goes through");
  await assert.rejects(() => javascriptExecute({ ...own, code: "chrome.storage.local.get(null)" }), OFF_LIMITS);
  assert.equal(mock.cdp.filter((c) => c.method.startsWith("Runtime.")).length, 0, "no script reached the page");

  const left = await navigate({ ...own, url: "https://example.com/back" });
  assert.equal(left.data.url, "https://example.com/back");
  mock.tabs.get(own.tabId).url = OWN;
  await tabsClose(own);
  assert.equal(mock.tabs.has(own.tabId), false);
});

test("a page still loading towards an extension page counts as one", async () => {
  const mock = makeChrome();
  const { resolveTab, own } = await session(mock);
  mock.tabs.get(own.tabId).pendingUrl = OWN;
  await assert.rejects(() => resolveTab(own.tabId, own.sessionToken), OFF_LIMITS);
});

test("with allowAllTabs the user's own settings tab stays out of reach", async () => {
  const mock = makeChrome();
  mock.storage.set("allowAllTabs", true);
  mock.tabs.set(9, { id: 9, windowId: 1, groupId: -1, url: OWN, title: "", active: true });
  const { resolveTab, javascriptExecute } = await load(mock);
  await assert.rejects(() => resolveTab(9, null), OFF_LIMITS);
  await assert.rejects(() => javascriptExecute({ tabId: 9, code: "1" }), OFF_LIMITS);
});

test("the responsive view stays usable, but no script runs on its harness page", async () => {
  const mock = makeChrome();
  const { setViewport, resolveTab, javascriptExecute, token } = await session(mock);
  const view = await setViewport({ viewports: [{ width: 390, height: 844 }], sessionToken: token });
  const harness = { tabId: view.data.harnessTabId, sessionToken: token };
  assert.match(mock.tabs.get(harness.tabId).url, /^chrome-extension:\/\/test\/responsive\/responsive\.html\?/);

  assert.equal((await resolveTab(harness.tabId, token)).id, harness.tabId, "screenshots and clicks still resolve it");
  mock.cdp.length = 0;
  await assert.rejects(() => javascriptExecute({ ...harness, code: "chrome.storage.local.get(null)" }), OFF_LIMITS);
  assert.equal(mock.cdp.filter((c) => c.method.startsWith("Runtime.")).length, 0, "no script reached the harness");
});

test("the daemon refuses the same addresses before they reach an older extension", () => {
  for (const url of SPELLINGS) {
    for (const tool of ["tabs_create", "navigate", "set_viewport"]) {
      assert.match(extensionPageRefusal(tool, { url }), OFF_LIMITS, `${tool} ${url}`);
    }
  }
  assert.equal(extensionPageRefusal("tabs_create", { url: "https://example.com/?next=chrome-extension://x/y" }), null);
  assert.equal(extensionPageRefusal("set_viewport", {}), null, "closing the view passes no url");
  assert.equal(extensionPageRefusal("javascript_execute", { code: "'chrome-extension://x'" }), null);
});

test("for an extension that predates the rule, the script refuses to run on an extension page itself", () => {
  const args = { code: "document.title", sessionToken: "s" };
  for (const old of ["0.2.19", null, undefined, "dev-build", "0.2.20.1"]) {
    const sent = guardExtensionPages("javascript_execute", args, old);
    assert.notEqual(sent.code, args.code);
    assert.ok(sent.code.endsWith(args.code), "the caller's script is untouched, after the check");
    assert.equal(sent.code.includes("\n"), false, "on one line, so error line numbers still match the caller's script");
    assert.equal(sent.sessionToken, "s");
    // What the check does in a page, for each origin a tab can have.
    const run = (origin) => new Function("location", `${sent.code.slice(0, -args.code.length)} return "ran";`)({ origin });
    assert.equal(run("https://example.com"), "ran");
    assert.equal(run("null"), "ran", "a data: or sandboxed page");
    assert.throws(() => run("chrome-extension://abcdefghijklmnop"), OFF_LIMITS);
  }
  assert.equal(guardExtensionPages("javascript_execute", args, REFUSES_EXTENSION_PAGES_SINCE), args, "a current extension checks for itself");
  assert.equal(guardExtensionPages("javascript_execute", args, "0.3.0"), args);
  assert.equal(guardExtensionPages("form_input", args, "0.2.19"), args, "only scripts are wrapped");
});
