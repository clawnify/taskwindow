/**
 * Clicking an element by its ref (extension/tools/computer.js, with the page's
 * answer mocked). The page side, content/ax-tree.js `locate`, needs layout, so
 * it was checked in a real Chromium for the PR (in view, below the fold, an
 * icon button's child span, covered by a dialog, a stale ref).
 *
 * What a caller's correctness rests on: the click lands where the page says
 * the element is, a covered element is never clicked, and a click by x,y does
 * not ask the page anything.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { makeChrome } from "./chrome-mock.js";

const here = dirname(fileURLToPath(import.meta.url));
const TOOLS = join(here, "..", "..", "extension", "tools");

let loadCount = 0;
async function session(mock) {
  globalThis.chrome = mock.chrome;
  mock.storage.set("separateWindow", false);
  const bust = `?t=${++loadCount}`;
  const tabs = await import(pathToFileURL(join(TOOLS, "tabs.js")).href);
  const computer = (await import(pathToFileURL(join(TOOLS, "computer.js")).href + bust)).computer;
  const created = await tabs.tabsCreate({ url: "https://example.com", task: "Clicks", longRunning: false });
  return { computer, token: created.data.sessionToken, tabId: created.data.id };
}

const pressed = (mock) => mock.cdp.filter((c) => c.method === "Input.dispatchMouseEvent" && c.params.type === "mousePressed");
const locates = (mock) => mock.messages.filter((m) => m.msg?.op === "locate");

test("a click by ref lands on the centre the page reports, and says what it clicked", async () => {
  const mock = makeChrome();
  mock.hooks.message = (_tabId, msg) =>
    msg.op === "locate" ? { ok: true, x: 412, y: 236, width: 96, target: 'button "Save" (e12)' } : { ok: true };
  const { computer, token, tabId } = await session(mock);
  const res = await computer({ action: "left_click", ref: "e12", human: false, tabId, sessionToken: token });
  assert.deepEqual(locates(mock).map((m) => m.msg.params), [{ ref: "e12", selector: undefined }]);
  assert.deepEqual(pressed(mock).map((c) => [c.params.x, c.params.y]), [[412, 236]]);
  assert.match(res.text, /left_click at \(412, 236\).*, on button "Save" \(e12\)$/);
});

test("a covered element is never clicked: the page's refusal reaches the caller", async () => {
  const mock = makeChrome();
  mock.hooks.message = (_tabId, msg) =>
    msg.op === "locate" ? { ok: false, error: 'something else is on top of that element (dialog "Cookies" <div>): close it first, or take a screenshot' } : { ok: true };
  const { computer, token, tabId } = await session(mock);
  await assert.rejects(
    computer({ action: "left_click", ref: "e12", human: false, tabId, sessionToken: token }),
    /something else is on top of that element \(dialog "Cookies"/,
  );
  assert.equal(pressed(mock).length, 0);
});

test("a click by x,y asks the page nothing, as before", async () => {
  const mock = makeChrome();
  mock.hooks.message = () => assert.fail("a click by x,y must not message the page");
  const { computer, token, tabId } = await session(mock);
  await computer({ action: "left_click", x: 10, y: 20, human: false, tabId, sessionToken: token });
  assert.deepEqual(pressed(mock).map((c) => [c.params.x, c.params.y]), [[10, 20]]);
});

test("a ref on an action that takes no element is ignored, not located", async () => {
  const mock = makeChrome();
  mock.hooks.message = (_tabId, msg) => (msg.op === "locate" ? assert.fail("type takes no element") : { ok: true });
  const { computer, token, tabId } = await session(mock);
  await computer({ action: "type", text: "hi", ref: "e3", human: false, tabId, sessionToken: token });
  assert.equal(locates(mock).length, 0);
});
