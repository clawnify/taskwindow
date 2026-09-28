/**
 * Wonder tests for extension/tools/human.js and its wiring into computer.js
 * (run in Node with the chrome.* mock).
 *
 * The properties that matter are not "does it look human" — that is
 * unfalsifiable — but the two things a caller's correctness rests on:
 * a humanised action must land on exactly the coordinates and deltas that were
 * asked for, and it must reach the page as many events rather than one, since
 * that is the whole reason the mode exists.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { makeChrome } from "./chrome-mock.js";

const here = dirname(fileURLToPath(import.meta.url));
const TOOLS = join(here, "..", "..", "extension", "tools");

let loadCount = 0;
async function load(mock) {
  globalThis.chrome = mock.chrome;
  mock.storage.set("separateWindow", false);
  const bust = `?t=${++loadCount}`;
  const tabs = await import(pathToFileURL(join(TOOLS, "tabs.js")).href);
  const human = await import(pathToFileURL(join(TOOLS, "human.js")).href + bust);
  const computer = await import(pathToFileURL(join(TOOLS, "computer.js")).href + bust);
  return { ...tabs, human, computer: computer.computer };
}

async function session(mock) {
  const api = await load(mock);
  const created = await api.tabsCreate({ url: "https://example.com", task: "Wonder", longRunning: false });
  return { ...api, token: created.data.sessionToken, tabId: created.data.id };
}

const mouse = (mock, type) =>
  mock.cdp.filter((c) => c.method === "Input.dispatchMouseEvent" && c.params.type === type);

/* --------------------------------------------------------------- geometry */

test("movePath ends exactly on the target, however much it wandered on the way", async () => {
  const { human } = await load(makeChrome());
  for (let i = 0; i < 200; i++) {
    const from = { x: Math.random() * 1200, y: Math.random() * 800 };
    const to = { x: Math.round(Math.random() * 1200), y: Math.round(Math.random() * 800) };
    const path = human.movePath(from, to, { targetWidth: 1 + Math.random() * 200 });
    const last = path[path.length - 1];
    assert.equal(last.x, to.x, "the jitter belongs in the path, not the destination");
    assert.equal(last.y, to.y);
    assert.ok(path.length >= 4 && path.length <= 34, `bounded step count, got ${path.length}`);
    assert.ok(path.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.dt > 0));
  }
});

test("movePath leaves the straight line and does not repeat one fixed angle", async () => {
  const { human } = await load(makeChrome());
  const from = { x: 100, y: 100 };
  const to = { x: 900, y: 500 };
  let bowed = 0;
  const angles = new Set();
  for (let i = 0; i < 60; i++) {
    const path = human.movePath(from, to, { targetWidth: 20 });
    const mid = path[Math.floor(path.length / 2)];
    // Perpendicular distance of the midpoint from the straight line.
    const off = Math.abs((to.y - from.y) * mid.x - (to.x - from.x) * mid.y + to.x * from.y - to.y * from.x) /
      Math.hypot(to.x - from.x, to.y - from.y);
    if (off > 2) bowed++;
    angles.add(Math.round(Math.atan2(mid.y - from.y, mid.x - from.x) * 40));
  }
  assert.ok(bowed > 50, `paths should curve, only ${bowed}/60 did`);
  assert.ok(angles.size > 10, `directions should spread, saw ${angles.size} distinct`);
});

test("movePath decelerates into the target rather than arriving at full speed", async () => {
  const { human } = await load(makeChrome());
  const path = human.movePath({ x: 0, y: 0 }, { x: 800, y: 0 }, { targetWidth: 200 });
  const step = (i) => Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  const mid = step(Math.floor(path.length / 2));
  const end = step(path.length - 1);
  assert.ok(mid > end * 2, `minimum-jerk peaks in the middle: mid ${mid.toFixed(1)} vs end ${end.toFixed(1)}`);
});

/* ----------------------------------------------------------------- scroll */

test("scrollPlan splits unevenly but its deltas sum to exactly what was asked", async () => {
  const { human } = await load(makeChrome());
  let multi = 0;
  for (let i = 0; i < 300; i++) {
    const dy = Math.round((Math.random() - 0.5) * 4000);
    const dx = Math.round((Math.random() - 0.5) * 400);
    const plan = human.scrollPlan(dx, dy);
    const sy = plan.reduce((a, b) => a + b.dy, 0);
    const sx = plan.reduce((a, b) => a + b.dx, 0);
    assert.ok(Math.abs(sy - dy) < 1e-9, `dy must be exact: asked ${dy}, planned ${sy}`);
    assert.ok(Math.abs(sx - dx) < 1e-9, `dx must be exact: asked ${dx}, planned ${sx}`);
    assert.ok(plan.every((b) => b.speed >= 650 && b.speed <= 1150 && b.pauseMs > 0));
    if (plan.length > 1) {
      multi++;
      const sizes = plan.map((b) => Math.abs(b.dy));
      assert.ok(Math.max(...sizes) - Math.min(...sizes) > 0, "bursts must not be equal slices");
    }
  }
  assert.ok(multi > 200, `long scrolls should break up, only ${multi}/300 did`);
});

test("a human scroll reaches the page as several gestures, with Chrome's inverted sign", async () => {
  const mock = makeChrome();
  const { computer, token, tabId } = await session(mock);
  mock.cdp.length = 0;

  const res = await computer({ action: "scroll", human: true, dy: 1600, x: 400, y: 300, tabId, sessionToken: token });

  const gestures = mock.cdp.filter((c) => c.method === "Input.synthesizeScrollGesture");
  assert.ok(gestures.length >= 2, `expected several bursts, got ${gestures.length}`);
  assert.equal(mouse(mock, "mouseWheel").length, 0, "the jumbo single wheel event is what we are replacing");
  const travelled = gestures.reduce((a, g) => a + g.params.yDistance, 0);
  assert.ok(
    Math.abs(travelled + 1600) < 1e-6,
    `yDistance is positive-is-up, so scrolling down 1600 must total -1600, got ${travelled}`
  );
  assert.ok(gestures.every((g) => g.params.preventFling === true), "fling would make the landing offset unpredictable");
  assert.match(res.text, /human burst/);
});

test("a scroll below the floor stays a single plain event", async () => {
  const mock = makeChrome();
  const { computer, token, tabId } = await session(mock);
  mock.cdp.length = 0;
  await computer({ action: "scroll", human: true, dy: 40, x: 400, y: 300, tabId, sessionToken: token });
  assert.equal(mock.cdp.filter((c) => c.method === "Input.synthesizeScrollGesture").length, 0);
  assert.equal(mouse(mock, "mouseWheel").length, 1, "a 40px nudge is a nudge for a hand too");
});

/* ------------------------------------------------------------------ click */

test("a human click approaches over many moves and presses on the exact pixel", async () => {
  const mock = makeChrome();
  const { computer, token, tabId } = await session(mock);
  mock.cdp.length = 0;

  await computer({ action: "left_click", human: true, x: 640, y: 420, targetWidth: 90, tabId, sessionToken: token });

  const moves = mouse(mock, "mouseMoved");
  assert.ok(moves.length >= 5, `the pointer must travel, got ${moves.length} moves`);
  const last = moves[moves.length - 1].params;
  assert.deepEqual([last.x, last.y], [640, 420], "it settles on the requested pixel before pressing");
  const down = mouse(mock, "mousePressed");
  const up = mouse(mock, "mouseReleased");
  assert.equal(down.length, 1);
  assert.equal(up.length, 1);
  assert.deepEqual([down[0].params.x, down[0].params.y], [640, 420]);
  // Ordering: every move precedes the press.
  assert.ok(
    mock.cdp.findIndex((c) => c.params?.type === "mousePressed") >
      mock.cdp.findLastIndex((c) => c.params?.type === "mouseMoved" && c.params.x === 640 && c.params.y === 420) - 1
  );
});

test("the next click starts from where the last one left the pointer", async () => {
  const mock = makeChrome();
  const { computer, human, token, tabId } = await session(mock);
  await computer({ action: "left_click", x: 100, y: 100, tabId, sessionToken: token });
  mock.cdp.length = 0;
  await computer({ action: "left_click", human: true, x: 900, y: 600, tabId, sessionToken: token });
  const first = mouse(mock, "mouseMoved")[0].params;
  assert.ok(
    Math.hypot(first.x - 100, first.y - 100) < 200,
    `a humanised move should continue from (100,100), started at (${first.x}, ${first.y})`
  );
  void human;
});

test("a double click keeps both presses inside the OS double-click window", async () => {
  const mock = makeChrome();
  const { computer, token, tabId } = await session(mock);
  mock.cdp.length = 0;
  const started = Date.now();
  await computer({ action: "double_click", human: true, x: 300, y: 200, tabId, sessionToken: token });
  const presses = mouse(mock, "mousePressed");
  assert.equal(presses.length, 2);
  assert.deepEqual(presses.map((p) => p.params.clickCount), [1, 2]);
  assert.ok(Date.now() - started < 3000, "a humanised double click is still a double click, not a pause");
});

/* ------------------------------------------------------------------- type */

test("human typing sends real per-character key events, not a bulk insert", async () => {
  const mock = makeChrome();
  const { computer, token, tabId } = await session(mock);
  mock.cdp.length = 0;

  const res = await computer({ action: "type", human: true, text: "ab c", tabId, sessionToken: token });

  assert.equal(mock.cdp.filter((c) => c.method === "Input.insertText").length, 0, "insertText fires no key events at all");
  const keys = mock.cdp.filter((c) => c.method === "Input.dispatchKeyEvent");
  assert.equal(keys.length, 8, "four characters, keyDown + keyUp each");
  assert.deepEqual(
    keys.filter((k) => k.params.type === "keyDown").map((k) => k.params.text),
    ["a", "b", " ", "c"]
  );
  assert.deepEqual(
    keys.filter((k) => k.params.type === "keyDown").map((k) => k.params.code),
    ["KeyA", "KeyB", "Space", "KeyC"]
  );
  assert.match(res.text, /real key events/);
});

test("typing more than a human would type becomes a paste, and says so", async () => {
  const mock = makeChrome();
  const { computer, human, token, tabId } = await session(mock);
  mock.cdp.length = 0;
  const long = "x".repeat(human.PASTE_THRESHOLD + 1);

  const res = await computer({ action: "type", human: true, text: long, tabId, sessionToken: token });

  assert.equal(mock.cdp.filter((c) => c.method === "Input.dispatchKeyEvent").length, 0);
  assert.equal(mock.cdp.filter((c) => c.method === "Input.insertText").length, 1);
  assert.match(res.text, /as a paste/);
});

test("typePlan keeps a long string inside the time budget", async () => {
  const { human } = await load(makeChrome());
  const plan = human.typePlan("y".repeat(human.PASTE_THRESHOLD), { budgetMs: 4000 });
  assert.equal(plan.mode, "keys");
  const total = plan.keys.reduce((a, k) => a + k.delayMs + k.hold, 0);
  assert.ok(total <= 4001, `budget respected, planned ${Math.round(total)}ms`);
  assert.ok(new Set(plan.keys.map((k) => k.delayMs)).size > 50, "intervals must vary, not tick");
});

/* ------------------------------------------------------------------- idle */

test("idle drifts the cursor and leaves the scroll offset exactly where it was", async () => {
  const mock = makeChrome();
  const { computer, token, tabId } = await session(mock);
  mock.cdp.length = 0;

  const res = await computer({ action: "idle", human: true, dy: 45, tabId, sessionToken: token });

  assert.ok(mouse(mock, "mouseMoved").length >= 2, "the cursor should wander");
  assert.equal(mouse(mock, "mousePressed").length, 0, "idle never clicks anything");
  const gestures = mock.cdp.filter((c) => c.method === "Input.synthesizeScrollGesture");
  const net = gestures.reduce((a, g) => a + g.params.yDistance, 0);
  assert.ok(Math.abs(net) < 1e-6, `the jiggle must net to zero, ended ${net} off`);
  assert.match(res.text, /returned to the same offset/);
});

test("without human:true nothing changes", async () => {
  const mock = makeChrome();
  const { computer, token, tabId } = await session(mock);
  mock.cdp.length = 0;
  await computer({ action: "left_click", x: 50, y: 60, tabId, sessionToken: token });
  await computer({ action: "scroll", dy: 2000, x: 10, y: 10, tabId, sessionToken: token });
  await computer({ action: "type", text: "hello", tabId, sessionToken: token });
  assert.equal(mouse(mock, "mouseMoved").length, 1);
  assert.equal(mouse(mock, "mouseWheel").length, 1);
  assert.equal(mock.cdp.filter((c) => c.method === "Input.insertText").length, 1);
  assert.equal(mock.cdp.filter((c) => c.method === "Input.synthesizeScrollGesture").length, 0);
});

test("a Chromium without the experimental gesture command still scrolls, in ticks", async () => {
  const mock = makeChrome();
  const { computer, token, tabId } = await session(mock);
  const real = mock.chrome.debugger.sendCommand;
  mock.chrome.debugger.sendCommand = async (src, method, params) => {
    if (method === "Input.synthesizeScrollGesture") throw new Error("'Input.synthesizeScrollGesture' wasn't found");
    return real(src, method, params);
  };
  mock.cdp.length = 0;

  await computer({ action: "scroll", human: true, dy: 900, x: 400, y: 300, tabId, sessionToken: token });

  const wheels = mouse(mock, "mouseWheel");
  assert.ok(wheels.length >= 5, `expected a tick loop, got ${wheels.length} wheel events`);
  const total = wheels.reduce((a, w) => a + w.params.deltaY, 0);
  assert.ok(Math.abs(total - 900) < 1, `ticks must still sum to the requested delta, got ${total}`);
});

/* ---------------------------------------------------------- drawn cursor */

const shown = (mock, op) =>
  mock.messages.filter((m) => m.msg?.type === "taskwindow:indicator" && m.msg.op === op).map((m) => m.msg);

test("the drawn cursor retraces the real pointer's path and rings on the real press", async () => {
  const mock = makeChrome();
  const { computer, token, tabId } = await session(mock);
  mock.cdp.length = 0;
  mock.messages.length = 0;

  await computer({ action: "left_click", human: true, x: 640, y: 420, targetWidth: 90, tabId, sessionToken: token });

  const real = mouse(mock, "mouseMoved").map((c) => [c.params.x, c.params.y]);
  const drawn = shown(mock, "move").map((m) => [m.x, m.y]);
  assert.deepEqual(drawn, real, "one drawn step per real move, in order, and no jump to the target ahead of them");
  assert.ok(shown(mock, "move").every((m) => Number.isFinite(m.ms)), "each step says how long to follow it");
  const presses = shown(mock, "press");
  assert.equal(presses.length, 1);
  assert.deepEqual([presses[0].x, presses[0].y], [640, 420]);
  const kinds = mock.messages.map((m) => m.msg.op);
  assert.ok(kinds.indexOf("press") > kinds.lastIndexOf("move"), "the ring comes after the cursor arrives");
  assert.equal(kinds[0], "focus", "the indicator is injected before the first step");
});

test("idle drift moves the drawn cursor along with the real one", async () => {
  const mock = makeChrome();
  const { computer, token, tabId } = await session(mock);
  mock.cdp.length = 0;
  mock.messages.length = 0;

  await computer({ action: "idle", tabId, sessionToken: token });

  const real = mouse(mock, "mouseMoved").map((c) => [c.params.x, c.params.y]);
  assert.ok(real.length >= 2);
  assert.deepEqual(shown(mock, "move").map((m) => [m.x, m.y]), real);
  assert.equal(shown(mock, "press").length, 0);
});

test("a plain click still sends one glide with a ring and no per-step moves", async () => {
  const mock = makeChrome();
  const { computer, token, tabId } = await session(mock);
  mock.messages.length = 0;

  await computer({ action: "left_click", x: 50, y: 60, tabId, sessionToken: token });
  await new Promise((r) => setTimeout(r, 0)); // the plain indicator call is fire-and-forget

  const moves = shown(mock, "move");
  assert.equal(moves.length, 1);
  assert.deepEqual([moves[0].x, moves[0].y, moves[0].click, moves[0].ms], [50, 60, true, undefined]);
  assert.equal(shown(mock, "press").length, 0);
});
