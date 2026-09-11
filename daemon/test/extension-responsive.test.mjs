/**
 * Lifecycle tests for extension/tools/responsive.js (run in Node with the
 * chrome.* mock): set_viewport must reuse the view it already opened and must
 * never report a close it did not perform.
 *
 * The bugs these cover all shipped in 0.2.8 and all showed up the same way —
 * an agent iterating on a responsive design ended a session with a tab strip
 * full of duplicates it believed it had closed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { makeChrome } from "./chrome-mock.js";

const here = dirname(fileURLToPath(import.meta.url));
const TOOLS = join(here, "..", "..", "extension", "tools");
const TABS_JS = join(TOOLS, "tabs.js");
const RESPONSIVE_JS = join(TOOLS, "responsive.js");

let loadCount = 0;
/**
 * tabs.js is imported unbusted so the test and responsive.js share one
 * instance (responsive.js imports "./tabs.js" by that same specifier); all its
 * real state lives in chrome.storage, which is fresh per mock.
 */
async function load(mock) {
  globalThis.chrome = mock.chrome;
  mock.storage.set("separateWindow", false);
  const tabs = await import(pathToFileURL(TABS_JS).href);
  const responsive = await import(pathToFileURL(RESPONSIVE_JS).href + `?t=${++loadCount}`);
  responsive.TIMING.frameDeadlineMs = 60; // a blocked frame is never coming
  return { ...tabs, ...responsive };
}

/** A session with a task group, which set_viewport requires before it will run. */
async function session(mock, url = "https://example.com") {
  const { tabsCreate, setViewport } = await load(mock);
  const created = await tabsCreate({ url, task: "Layout", longRunning: false });
  return { setViewport, token: created.data.sessionToken, tabId: created.data.id };
}

const harnessTabs = (mock) => [...mock.tabs.values()].filter((t) => String(t.url).includes("responsive.html"));

test("a second call reuses the harness instead of opening another window", async () => {
  const mock = makeChrome();
  const { setViewport, token } = await session(mock);

  await setViewport({ viewports: [{ width: 390, height: 844 }], sessionToken: token });
  const afterFirst = mock.windowsCreated.length;

  const second = await setViewport({ viewports: [{ width: 768, height: 1024 }], sessionToken: token });

  assert.equal(mock.windowsCreated.length, afterFirst, "no second harness window");
  assert.equal(harnessTabs(mock).length, 1, "exactly one harness tab exists");
  assert.equal(second.data.results[0].mode, "iframe", "the new viewport renders as a frame");
  assert.equal(second.data.results[0].pageWidth, 768);
});

test("a reused view follows the url it is given, and says so", async () => {
  const mock = makeChrome();
  const { setViewport, token } = await session(mock);

  await setViewport({ viewports: [{ width: 390, height: 844 }], url: "https://first.example", sessionToken: token });
  const second = await setViewport({
    viewports: [{ width: 390, height: 844 }],
    url: "https://second.example",
    sessionToken: token,
  });

  assert.match(second.text, /second\.example/, "reports the url it was asked for");
  assert.doesNotMatch(second.text, /first\.example/, "not the one stored when the view opened");
});

test("a viewport that cannot be framed gets one emulated tab, not one per call", async () => {
  const mock = makeChrome();
  mock.flags.framingBlocked = true;
  const { setViewport, token } = await session(mock);

  const first = await setViewport({ viewports: [{ width: 390, height: 844 }], sessionToken: token });
  assert.equal(first.data.results[0].mode, "emulated tab");
  const tabCount = () => mock.tabs.size;
  const afterFirst = tabCount();

  const second = await setViewport({ viewports: [{ width: 390, height: 844 }], sessionToken: token });
  const third = await setViewport({ viewports: [{ width: 390, height: 844 }], sessionToken: token });

  assert.equal(tabCount(), afterFirst, "no tab is added by repeating the call");
  assert.equal(second.data.results[0].tabId, first.data.results[0].tabId, "the same emulated tab is re-pointed");
  assert.equal(third.data.results[0].tabId, first.data.results[0].tabId);
});

test("a file:// target without file access skips the doomed frame and names the fix", async () => {
  const mock = makeChrome();
  const { setViewport, token } = await session(mock, "file:///tmp/table-test.html");

  const started = Date.now();
  const res = await setViewport({ viewports: [{ width: 390, height: 844 }], sessionToken: token });

  assert.equal(res.data.results[0].mode, "emulated tab", "goes straight to the route that works");
  assert.ok(Date.now() - started < 50, "does not wait out the frame deadline for a frame Chrome will never load");
  assert.match(res.text, /file URLs/i, "tells the user which toggle would make frames work");
});

test("closing without a session token fails loudly and closes nothing", async () => {
  const mock = makeChrome();
  const { setViewport, token } = await session(mock);
  await setViewport({ viewports: [{ width: 390, height: 844 }], sessionToken: token });
  const openWindows = mock.windowIds.size;

  await assert.rejects(() => setViewport({}), /sessionToken/i, "a tokenless close is an error, not a no-op");
  assert.equal(mock.windowIds.size, openWindows, "the view is still open");
  assert.equal(harnessTabs(mock).length, 1);
});

test("closing a view that is not there is not reported as having closed one", async () => {
  const mock = makeChrome();
  const { setViewport, token } = await session(mock);

  const res = await setViewport({ sessionToken: token });
  assert.doesNotMatch(res.text, /^closed the responsive view/, "nothing was closed, so do not say it was");
});

test("closing with the right token closes the harness and its emulated tabs", async () => {
  const mock = makeChrome();
  mock.flags.framingBlocked = true;
  const { setViewport, token } = await session(mock);
  await setViewport({ viewports: [{ width: 390, height: 844 }], sessionToken: token });

  const opened = await setViewport({ viewports: [{ width: 390, height: 844 }], sessionToken: token });
  const fallbackId = opened.data.results[0].tabId;

  const res = await setViewport({ sessionToken: token });

  assert.match(res.text, /closed the responsive view/);
  assert.equal(harnessTabs(mock).length, 0, "harness tab gone");
  assert.equal(mock.tabs.has(fallbackId), false, "emulated tab gone");
  assert.equal(mock.tabs.size, 1, "only the session's own tab is left");
});

test("two sessions each keep their own header-stripping rule", async () => {
  const mock = makeChrome();
  const a = await session(mock, "https://a.example");
  const b = await session(mock, "https://b.example");

  await a.setViewport({ viewports: [{ width: 390, height: 844 }], sessionToken: a.token });
  await b.setViewport({ viewports: [{ width: 390, height: 844 }], sessionToken: b.token });

  assert.equal(mock.dnrRules.size, 2, "one rule per session, not one rule shared and overwritten");
  const scoped = [...mock.dnrRules.values()].flatMap((r) => r.condition.tabIds);
  assert.equal(new Set(scoped).size, 2, "each rule is scoped to its own harness tab");
});

test("harness and emulated tabs land in the session's group, in its window", async () => {
  const mock = makeChrome();
  mock.flags.framingBlocked = true;
  const { setViewport, token, tabId } = await session(mock);
  const home = mock.tabs.get(tabId);

  await setViewport({ viewports: [{ width: 390, height: 844 }], sessionToken: token });

  for (const t of mock.tabs.values()) {
    assert.equal(t.groupId, home.groupId, `tab ${t.id} (${t.url}) is in the session's group`);
    assert.equal(t.windowId, home.windowId, `tab ${t.id} (${t.url}) is in the session's window`);
  }
});
