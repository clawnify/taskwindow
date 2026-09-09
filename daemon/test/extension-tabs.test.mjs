/**
 * Session-isolation tests for extension/tools/tabs.js (run in Node with a
 * chrome.* mock): concurrent agents must never share tab groups even when
 * they pick the same task name, a task name is required once and then fixed
 * (one session, one group), and the legacy pre-session storage shape stays
 * visible to the user but unreachable by tools.
 *
 * Each test gets a fresh chrome mock plus a fresh module instance (ESM
 * query-string cache buster), since tabs.js closes over the global `chrome`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const TABS_JS = join(here, "..", "..", "extension", "tools", "tabs.js");

function makeChrome() {
  const storage = new Map();
  const groups = new Map(); // groupId -> { id, title, color }
  const tabs = new Map(); // tabId -> { id, windowId: 1, groupId: -1, url, title: "", active: true }
  let nextTabId = 1;
  let nextGroupId = 100;
  let nextWindowId = 2; // window 1 is the user's
  const windowFocus = []; // window ids handed {focused:true}
  const windowsCreated = []; // opts passed to windows.create
  const userFocus = { id: 1, focused: true }; // what windows.getLastFocused answers: the user is in window 1, Chrome frontmost
  const gates = {}; // gates.group: awaited (may stall or throw) before tabs.group does its work
  const flags = { raiseOnCreate: false }; // Chrome marks a newly created window as last-focused

  function createTab({ url, active = true, windowId = 1 }) {
    const id = nextTabId++;
    const tab = { id, windowId, groupId: -1, url, title: "", active, pinned: false };
    tabs.set(id, tab);
    return tab;
  }

  return {
    storage,
    groups,
    tabs,
    windowFocus,
    windowsCreated,
    userFocus,
    gates,
    flags,
    chrome: {
      runtime: { getURL: (path) => `chrome-extension://test/${path}` },
      storage: {
        local: {
          async get(keys) {
            const out = {};
            for (const k of Array.isArray(keys) ? keys : [keys]) {
              if (storage.has(k)) out[k] = storage.get(k);
            }
            return out;
          },
          async set(obj) {
            for (const [k, v] of Object.entries(obj)) storage.set(k, v);
          },
          async remove(keys) {
            for (const k of Array.isArray(keys) ? keys : [keys]) storage.delete(k);
          },
        },
      },
      tabGroups: {
        async get(id) {
          const g = groups.get(id);
          if (!g) throw new Error(`No group with id ${id}`);
          return g;
        },
        async update(id, props) {
          const g = groups.get(id);
          if (!g) throw new Error(`No group with id ${id}`);
          Object.assign(g, props);
          return g;
        },
      },
      tabs: {
        async create(opts) {
          return createTab(opts);
        },
        async get(id) {
          const t = tabs.get(id);
          if (!t) throw new Error(`No tab with id ${id}`);
          return t;
        },
        async remove(ids) {
          for (const id of Array.isArray(ids) ? ids : [ids]) tabs.delete(id);
        },
        async query(q) {
          const all = [...tabs.values()];
          if (q == null || Object.keys(q).length === 0) return all;
          return all.filter(
            (t) =>
              (q.groupId === undefined || t.groupId === q.groupId) &&
              (q.active === undefined || t.active === q.active) &&
              (q.url === undefined || t.url === q.url) &&
              (q.pinned === undefined || t.pinned === q.pinned) &&
              (q.windowId === undefined || t.windowId === q.windowId)
          );
        },
        // Faithful to Chrome: a group lives in one window, and grouping MOVES
        // every tab that isn't already there. A new group is created in
        // createProperties.windowId, or — for a service worker, which has no
        // window of its own — in the last-focused window, i.e. the user's.
        async group({ tabIds, groupId, createProperties }) {
          if (gates.group) await gates.group();
          let gid = groupId;
          let windowId;
          if (gid == null) {
            windowId = createProperties?.windowId ?? userFocus.id;
            gid = nextGroupId++;
            groups.set(gid, { id: gid, title: "", color: "", windowId });
          } else {
            windowId = groups.get(gid)?.windowId ?? userFocus.id;
          }
          for (const id of tabIds) Object.assign(tabs.get(id), { groupId: gid, windowId });
          return gid;
        },
        async update(id, props) {
          Object.assign(tabs.get(id), props);
        },
        onUpdated: { addListener() {}, removeListener() {} },
      },
      windows: {
        async getLastFocused() {
          return { ...userFocus };
        },
        async update(id, props) {
          if (props?.focused) windowFocus.push(id);
        },
        async create(opts) {
          windowsCreated.push(opts);
          const id = nextWindowId++;
          if (flags.raiseOnCreate) userFocus.id = id;
          const created = opts?.url ? [createTab({ url: opts.url, active: true, windowId: id })] : [];
          return { id, tabs: created };
        },
      },
    },
  };
}

let loadCount = 0;
async function loadTabs(mock) {
  globalThis.chrome = mock.chrome;
  mock.storage.set("separateWindow", false); // keep the window dance out of the tests
  const url = pathToFileURL(TABS_JS).href + `?t=${++loadCount}`;
  return import(url);
}

test("tabs_create requires a task name until the session has a group", async () => {
  const { tabsCreate } = await loadTabs(makeChrome());
  await assert.rejects(() => tabsCreate({ url: "https://example.com" }), /"task" is required/);
  await assert.rejects(() => tabsCreate({ url: "https://example.com", task: "   " , longRunning: true}), /"task" is required/);
  // A token the daemon minted for a call that never got as far as a group.
  await assert.rejects(() => tabsCreate({ url: "https://example.com", sessionToken: "fresh" }), /no task group yet, so "task" is required/);
});

test("one session, one group: every later tab joins it, named or not", async () => {
  const mock = makeChrome();
  const { tabsCreate } = await loadTabs(mock);
  const first = await tabsCreate({ url: "https://a.example", task: "Research Competitors", longRunning: true });
  const token = first.data.sessionToken;

  const joined = await tabsCreate({ url: "https://a.example/2", sessionToken: token });
  assert.equal(joined.data.groupId, first.data.groupId, "no task given: joins the session's group");
  assert.equal(joined.data.task, "Research Competitors", "the group's own title, not a lowercased key");

  // The sub-task the agent is on ("Fix bug") is not a second job: same group,
  // same name, and the result says the name was not used.
  const named = await tabsCreate({ url: "https://b.example", task: "Fix bug", sessionToken: token });
  assert.equal(named.data.groupId, first.data.groupId, "a name on a later call does not start another group");
  assert.equal(named.data.task, "Research Competitors", "the group keeps the name it was given");
  assert.equal(named.data.ignoredTask, "Fix bug");
  assert.match(named.text, /"Fix bug" was not used as a name/);

  // Even a name the word-count rule would reject: it is never applied, so it
  // is never judged — the tab still lands in the group.
  const long = await tabsCreate({ url: "https://c.example", task: "Popover transition check", sessionToken: token });
  assert.equal(long.data.groupId, first.data.groupId, "an over-long later name is ignored, not rejected");
  assert.equal(mock.groups.size, 1, "the session made exactly one group");
});

test("an ignored task name takes its longRunning answer with it", async () => {
  const { tabsCreate } = await loadTabs(makeChrome());
  const first = await tabsCreate({ url: "https://a.example", task: "Research competitors", longRunning: true });
  const token = first.data.sessionToken;
  assert.equal(first.data.longRunning, true);

  // The agent thinks it is starting a short sub-task. The name is ignored, so
  // its answer must be too: honouring it would cut the whole job's group down
  // to the one-hour lifetime.
  const stray = await tabsCreate({ url: "https://b.example", task: "Fix bug", longRunning: false, sessionToken: token });
  assert.equal(stray.data.groupId, first.data.groupId);
  assert.equal(stray.data.longRunning, true, "the group keeps its own answer");
  assert.match(stray.text, /"longRunning" was not applied either/);

  // Passed on its own it is unambiguous, and revises the group.
  const revised = await tabsCreate({ url: "https://c.example", longRunning: false, sessionToken: token });
  assert.equal(revised.data.groupId, first.data.groupId);
  assert.equal(revised.data.longRunning, false, "passed alone, it revises the group");
});

test("two agents with the same task name get separate groups and tokens", async () => {
  const { tabsCreate } = await loadTabs(makeChrome());
  const a = await tabsCreate({ url: "https://a.example", task: "Research competitors" , longRunning: true});
  const b = await tabsCreate({ url: "https://b.example", task: "Research competitors" , longRunning: true});
  assert.ok(a.data.sessionToken, "agent A got a sessionToken");
  assert.ok(b.data.sessionToken, "agent B got a sessionToken");
  assert.notEqual(a.data.sessionToken, b.data.sessionToken);
  assert.notEqual(a.data.groupId, b.data.groupId, "same task name, different groups");
});

test("same sessionToken reuses the group whatever task is named", async () => {
  const { tabsCreate } = await loadTabs(makeChrome());
  const r1 = await tabsCreate({ url: "https://a.example", task: "Research competitors" , longRunning: true});
  const r2 = await tabsCreate({ url: "https://a.example/2", task: "Research competitors", sessionToken: r1.data.sessionToken , longRunning: true});
  assert.equal(r2.data.groupId, r1.data.groupId, "same session + task reuses the group");
  const r3 = await tabsCreate({ url: "https://b.example", task: "Fix bug", sessionToken: r1.data.sessionToken });
  assert.equal(r3.data.groupId, r1.data.groupId, "a different task in the same session joins it too");
});

test("a session cannot act on another session's tabs", async () => {
  const { tabsCreate, tabsClose } = await loadTabs(makeChrome());
  const a = await tabsCreate({ url: "https://a.example", task: "Research competitors" , longRunning: true});
  const b = await tabsCreate({ url: "https://b.example", task: "Research competitors" , longRunning: true});
  await assert.rejects(
    () => tabsClose({ tabId: a.data.id, sessionToken: b.data.sessionToken }),
    /not in your session's tab groups/
  );
  await tabsClose({ tabId: a.data.id, sessionToken: a.data.sessionToken }); // own tab: fine
});

test("a foreign tab and a missing tab are indistinguishable", async () => {
  const { tabsCreate, tabsClose } = await loadTabs(makeChrome());
  const a = await tabsCreate({ url: "https://a.example", task: "Research competitors" , longRunning: true});
  const b = await tabsCreate({ url: "https://b.example", task: "Fix bug" , longRunning: true});

  const foreign = await tabsClose({ tabId: a.data.id, sessionToken: b.data.sessionToken }).catch((e) => e.message);
  const missing = await tabsClose({ tabId: 987654, sessionToken: b.data.sessionToken }).catch((e) => e.message);

  // Differing errors would let an agent probe tab ids to map the browser.
  assert.equal(foreign.replace(String(a.data.id), "N"), missing.replace("987654", "N"));
});

test("tasks from any session share one agent window; only the first opens it", async () => {
  const mock = makeChrome();
  const { tabsCreate } = await loadTabs(mock);
  mock.storage.set("separateWindow", true);
  const a = await tabsCreate({ url: "https://a.example", task: "Research competitors", longRunning: true });
  const b = await tabsCreate({ url: "https://b.example", task: "Fix bug", longRunning: true }); // another agent
  const c = await tabsCreate({ url: "https://c.example", sessionToken: a.data.sessionToken }); // a second tab of session A

  assert.equal(a.data.newWindow, true, "the very first task opens the window");
  assert.equal(b.data.newWindow, false);
  assert.equal(c.data.newWindow, false);
  const wid = mock.tabs.get(a.data.id).windowId;
  assert.notEqual(wid, 1, "never the user's window");
  assert.equal(mock.tabs.get(b.data.id).windowId, wid);
  assert.equal(mock.tabs.get(c.data.id).windowId, wid);
});

test("the agent window outlives its last task: a pinned anchor stays, and no agent can close it", async () => {
  const mock = makeChrome();
  const { tabsCreate, tabsClose } = await loadTabs(mock);
  mock.storage.set("separateWindow", true);
  const a = await tabsCreate({ url: "https://a.example", task: "Research competitors" , longRunning: true});
  const wid = mock.tabs.get(a.data.id).windowId;

  await tabsClose({ tabId: a.data.id, sessionToken: a.data.sessionToken });
  const left = [...mock.tabs.values()].filter((t) => t.windowId === wid);
  assert.equal(left.length, 1, "only the anchor remains, so Chrome keeps the window");
  assert.equal(left[0].pinned, true);
  assert.equal(left[0].groupId, -1, "the anchor is outside every group");
  await assert.rejects(
    () => tabsClose({ tabId: left[0].id, sessionToken: a.data.sessionToken }),
    /not in your session's tab groups/
  );

  // The next task rejoins that window instead of opening another.
  const b = await tabsCreate({ url: "https://b.example", task: "Fix bug" , longRunning: true});
  assert.equal(b.data.newWindow, false);
  assert.equal(mock.tabs.get(b.data.id).windowId, wid);
});

test("opening a URL the group already has is allowed but called out", async () => {
  const { tabsCreate } = await loadTabs(makeChrome());
  const a = await tabsCreate({ url: "https://app.example/deals", task: "CRM" , longRunning: true});
  const b = await tabsCreate({ url: "https://app.example/deals#top", task: "CRM", sessionToken: a.data.sessionToken , longRunning: true});
  assert.notEqual(b.data.id, a.data.id, "not deduped: the second tab really opens");
  assert.deepEqual(b.data.alreadyOpenIn, [a.data.id], "fragment ignored when matching");
  assert.match(b.text, /already had tab \d+ at this URL/);
  assert.match(b.text, /reload or navigate/);
  const c = await tabsCreate({ url: "https://app.example/contacts", task: "CRM", sessionToken: a.data.sessionToken , longRunning: true});
  assert.deepEqual(c.data.alreadyOpenIn, []);
  assert.doesNotMatch(c.text, /already had/);
});

// The daemon mints the session token on a first tabs_create and hands it back
// with a timeout error, so a retry carries the token even when the first
// result never arrived. The retry must then get the first call's tab.
test("an identical retry while the first tabs_create is still grouping gets that tab, not a second one", async () => {
  const mock = makeChrome();
  const { tabsCreate } = await loadTabs(mock);
  let release;
  mock.gates.group = () => new Promise((r) => (release = r));
  const call = { url: "https://a.example", task: "Research competitors", sessionToken: "tok-1" , longRunning: true};

  const first = tabsCreate(call);
  await new Promise((r) => setTimeout(r, 20)); // first is now stalled inside tabs.group
  const retry = tabsCreate(call);
  await new Promise((r) => setTimeout(r, 20));
  release();
  const [r1, r2] = await Promise.all([first, retry]);

  assert.equal(r2.data.id, r1.data.id);
  assert.equal(r2.data.groupId, r1.data.groupId);
  assert.equal(r2.data.replayed, true);
  assert.match(r2.text, /no second tab was opened/);
  assert.equal(mock.tabs.size, 1, "exactly one tab exists");
  assert.equal(mock.groups.size, 1, "exactly one group exists");
});

test("an identical retry within a minute of a finished tabs_create gets that tab; other callers and other URLs do not", async () => {
  const mock = makeChrome();
  const { tabsCreate, tabsClose } = await loadTabs(mock);
  const call = { url: "https://a.example", task: "Research competitors", sessionToken: "tok-1" , longRunning: true};
  const r1 = await tabsCreate(call);
  const r2 = await tabsCreate(call);
  assert.equal(r2.data.id, r1.data.id, "same token, task and url within the window: the same tab");
  assert.equal(r2.data.replayed, true);

  const other = await tabsCreate({ ...call, sessionToken: "tok-2" }); // another agent, same task and url
  assert.notEqual(other.data.id, r1.data.id, "a different token is a different caller: its own tab and group");
  assert.notEqual(other.data.groupId, r1.data.groupId);
  const page2 = await tabsCreate({ ...call, url: "https://a.example/2" });
  assert.notEqual(page2.data.id, r1.data.id, "a different url is a different request");
  assert.equal(page2.data.replayed, undefined);

  await tabsClose({ tabId: r1.data.id, sessionToken: "tok-1" });
  const again = await tabsCreate(call);
  assert.notEqual(again.data.id, r1.data.id, "once the tab is gone the same call opens a new one");
  assert.equal(again.data.replayed, undefined);
});

test("a tab that cannot be grouped is closed again, never left outside a task group", async () => {
  const mock = makeChrome();
  const { tabsCreate } = await loadTabs(mock);
  mock.gates.group = () => {
    throw new Error("boom");
  };
  await assert.rejects(
    () => tabsCreate({ url: "https://a.example", task: "Research competitors" , longRunning: true}),
    /could not put the new tab in the "Research competitors" group \(boom\); closed it again/
  );
  assert.equal(mock.tabs.size, 0, "no ungrouped tab is left behind");

  delete mock.gates.group;
  const ok = await tabsCreate({ url: "https://a.example", task: "Research competitors" , longRunning: true});
  assert.equal(mock.tabs.get(ok.data.id).groupId, ok.data.groupId, "the retry works and is grouped");
});

test("a Chrome call that stalls fails the tool (and closes the tab) instead of holding every session's tools", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const mock = makeChrome();
  const { tabsCreate, tabsList } = await loadTabs(mock);
  const other = await tabsCreate({ url: "https://b.example", task: "Fix bug" , longRunning: true}); // another agent, before the stall
  mock.gates.group = () => new Promise(() => {}); // never resolves

  const stalled = tabsCreate({ url: "https://a.example", task: "Research competitors" , longRunning: true});
  stalled.catch(() => {}); // rejection is asserted below; don't let it look unhandled meanwhile
  await new Promise((r) => setImmediate(r)); // let it reach tabs.group
  t.mock.timers.tick(10_001);
  await assert.rejects(stalled, /Chrome did not answer tabs\.group within 10s/);
  assert.equal(mock.tabs.size, 1, "only the other agent's tab remains");

  // The store queue moved on: the other session's tools still work.
  const list = await tabsList({ sessionToken: other.data.sessionToken });
  assert.deepEqual(list.data.map((x) => x.id), [other.data.id]);
});

test("opening a tab never takes focus from the user's window", async () => {
  const mock = makeChrome();
  const { tabsCreate } = await loadTabs(mock);
  mock.storage.set("separateWindow", true);
  const a = await tabsCreate({ url: "https://a.example", task: "Research competitors", longRunning: true }); // opens the window
  const b = await tabsCreate({ url: "https://b.example", sessionToken: a.data.sessionToken }); // joins it

  assert.equal(mock.windowsCreated.length, 1);
  assert.equal(mock.windowsCreated[0].focused, false, "the agent window is created unfocused");
  // Focus may only ever be handed *back* to the user's window (id 1), never given to an agent window.
  assert.ok(mock.windowFocus.every((id) => id === 1), `focused agent window(s): ${mock.windowFocus}`);
  assert.equal(mock.tabs.get(a.data.id).active, false, "opened in the background, even in the agent's own window");
  assert.equal(mock.tabs.get(b.data.id).active, false);
});

test("a tab is never opened as the active tab, whatever window it lands in", async () => {
  // Shared-window mode: the tab lands in the user's window (1), which is focused.
  let mock = makeChrome();
  let { tabsCreate } = await loadTabs(mock);
  let a = await tabsCreate({ url: "https://a.example", task: "Research competitors" , longRunning: true});
  assert.equal(mock.tabs.get(a.data.id).active, false, "behind the user's tab");

  // Chrome in the background: still a background tab — the user comes back to what they left.
  mock.userFocus.focused = false;
  const b = await tabsCreate({ url: "https://b.example", sessionToken: a.data.sessionToken });
  assert.equal(mock.tabs.get(b.data.id).active, false);

  // The agent's own window, adopted by the user and focused: same.
  mock = makeChrome();
  ({ tabsCreate } = await loadTabs(mock));
  mock.storage.set("separateWindow", true);
  a = await tabsCreate({ url: "https://a.example", task: "Research competitors" , longRunning: true}); // agent window 2
  mock.userFocus.id = 2;
  const c = await tabsCreate({ url: "https://c.example", sessionToken: a.data.sessionToken });
  assert.equal(mock.tabs.get(c.data.id).active, false);
  assert.equal(mock.windowFocus.length, 0, "and no window was focused");
});

test("focus stolen by Chrome is handed back only while Chrome is frontmost", async () => {
  // Chrome raised the new window over the user's Chrome window: hand focus back to theirs.
  let mock = makeChrome();
  let { tabsCreate } = await loadTabs(mock);
  mock.storage.set("separateWindow", true);
  mock.flags.raiseOnCreate = true;
  await tabsCreate({ url: "https://a.example", task: "Research competitors" , longRunning: true});
  assert.deepEqual(mock.windowFocus, [1]);

  // The user is in another app (no Chrome window focused): Chrome only re-marked its
  // last-focused window. Focusing anything now would pull the user out of that app.
  mock = makeChrome();
  ({ tabsCreate } = await loadTabs(mock));
  mock.storage.set("separateWindow", true);
  mock.flags.raiseOnCreate = true;
  mock.userFocus.focused = false;
  await tabsCreate({ url: "https://a.example", task: "Research competitors" , longRunning: true});
  assert.deepEqual(mock.windowFocus, []);
});

test("tabs_list without a sessionToken gives an instructive error; with one, only own tabs", async () => {
  const { tabsCreate, tabsList } = await loadTabs(makeChrome());
  const a = await tabsCreate({ url: "https://a.example", task: "Research competitors" , longRunning: true});
  const b = await tabsCreate({ url: "https://b.example", task: "Fix bug" , longRunning: true});
  await assert.rejects(() => tabsList({}), /sessionToken/);
  const listA = await tabsList({ sessionToken: a.data.sessionToken });
  const ids = listA.data.map((t) => t.id);
  assert.ok(ids.includes(a.data.id), "own tab listed");
  assert.ok(!ids.includes(b.data.id), "other session's tab not listed");
});

test("default tab resolution is scoped to the session's own groups", async () => {
  const { tabsCreate, resolveTab } = await loadTabs(makeChrome());
  const a = await tabsCreate({ url: "https://a.example", task: "Research competitors" , longRunning: true});
  const b = await tabsCreate({ url: "https://b.example", task: "Fix bug" , longRunning: true});
  assert.equal((await resolveTab(null, a.data.sessionToken)).id, a.data.id);
  assert.equal((await resolveTab(null, b.data.sessionToken)).id, b.data.id);
  await assert.rejects(() => resolveTab(null, null), /sessionToken/);
});

// tabs_create can no longer give a session a second group, but sessions from
// before that rule have several and their tabs must stay reachable.
test("a session holding several groups resolves to its current task's group by default", async () => {
  const mock = makeChrome();
  const t = "tok-fixed";
  mock.groups.set(60, { id: 60, title: "Research competitors", color: "blue" });
  mock.groups.set(61, { id: 61, title: "Fix bug", color: "blue" });
  mock.tabs.set(9, { id: 9, windowId: 1, groupId: 60, url: "https://a.example", title: "", active: false });
  mock.tabs.set(10, { id: 10, windowId: 1, groupId: 61, url: "https://b.example", title: "", active: true });
  mock.storage.set("agentGroups", {
    [t]: { "research competitors": { groupId: 60, lastUsed: 1 }, "fix bug": { groupId: 61, lastUsed: 2 } },
  });
  mock.storage.set("currentTask", { [t]: "fix bug" });

  const { resolveTab } = await loadTabs(mock);
  const tab = await resolveTab(null, t);
  assert.equal(tab.id, 10, "the current task's group answers the default target");
  const explicit = await resolveTab(9, t);
  assert.equal(explicit.id, 9, "a tab of the session's other group is still reachable");
});

test("v1 (pre-session) storage migrates: visible to the user, unreachable by tools", async () => {
  const mock = makeChrome();
  // A pre-upgrade agent group "research competitors" holding one tab.
  mock.groups.set(55, { id: 55, title: "Research competitors", color: "green" });
  mock.tabs.set(9, { id: 9, windowId: 1, groupId: 55, url: "https://old.example", title: "", active: true });
  mock.storage.set("agentGroups", { "research competitors": { groupId: 55, lastUsed: Date.now() } });
  mock.storage.set("currentTask", "research competitors");

  const { tabsList, tabsClose, groupsSummary } = await loadTabs(mock);
  const summary = await groupsSummary();
  assert.equal(summary.length, 1, "legacy group still shows in the popup summary");
  assert.equal(summary[0].name, "research competitors");
  await assert.rejects(() => tabsList({}), /sessionToken/);
  await assert.rejects(
    () => tabsClose({ tabId: 9, sessionToken: "some-new-token" }),
    /not in your session's tab groups/,
    "legacy groups are not reachable through a fresh session"
  );
});

test("allowAllTabs policy widens access without a sessionToken", async () => {
  const mock = makeChrome();
  mock.storage.set("allowAllTabs", true);
  mock.tabs.set(9, { id: 9, windowId: 1, groupId: -1, url: "https://user.example", title: "", active: true });
  const { tabsList, resolveTab } = await loadTabs(mock);
  const res = await tabsList({});
  assert.equal(res.data.length, 1);
  assert.equal((await resolveTab(null, null)).id, 9);
});

test("reaper removes only idle groups, across sessions", async () => {
  const mock = makeChrome();
  const { tabsCreate, reapIdleGroups } = await loadTabs(mock);
  const a = await tabsCreate({ url: "https://a.example", task: "Research competitors" , longRunning: true});
  await tabsCreate({ url: "https://b.example", task: "Fix bug" , longRunning: true});
  // Backdate every group to beyond the 30-day TTL.
  const stored = mock.storage.get("agentGroups");
  for (const session of Object.values(stored)) {
    for (const entry of Object.values(session)) entry.lastUsed = Date.now() - 31 * 24 * 60 * 60 * 1000;
  }
  // Mark A's tab as the active one being read — its group must be skipped.
  for (const t of mock.tabs.values()) t.active = t.id === a.data.id;
  const reaped = await reapIdleGroups();
  assert.equal(reaped, 1, "only the idle group was reaped");
  const remaining = [...mock.tabs.values()];
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, a.data.id);
});

test("naming a task requires longRunning; joining the current group does not", async () => {
  const mock = makeChrome();
  const { tabsCreate } = await loadTabs(mock);
  await assert.rejects(
    () => tabsCreate({ url: "https://a.example", task: "Research" }),
    /"longRunning" is required when you pass "task"/
  );
  await assert.rejects(
    () => tabsCreate({ url: "https://a.example", task: "Research", longRunning: "yes" }),
    /"longRunning" is required/
  );
  assert.equal([...mock.tabs.values()].length, 0, "a rejected call opens no tab");

  const first = await tabsCreate({ url: "https://a.example", task: "Research", longRunning: false });
  assert.equal(first.data.longRunning, false);
  assert.match(first.text, /closes itself after an hour idle/);
  const joined = await tabsCreate({ url: "https://a.example/2", sessionToken: first.data.sessionToken });
  assert.equal(joined.data.groupId, first.data.groupId);
  assert.equal(joined.data.longRunning, false, "joining keeps the group's answer");

  // The agent can revise the estimate for the current group without renaming it.
  const extended = await tabsCreate({ url: "https://a.example/3", sessionToken: first.data.sessionToken, longRunning: true });
  assert.equal(extended.data.groupId, first.data.groupId);
  assert.equal(extended.data.longRunning, true);
  assert.doesNotMatch(extended.text, /closes itself/);
});

test("reaper closes a short task's group after an hour idle, a long-running one only after 30 days", async () => {
  const mock = makeChrome();
  const { tabsCreate, reapIdleGroups } = await loadTabs(mock);
  const short = await tabsCreate({ url: "https://a.example", task: "Quick check", longRunning: false });
  const long = await tabsCreate({ url: "https://b.example", task: "Migration", longRunning: true });
  for (const t of mock.tabs.values()) t.active = false; // nobody is reading either group

  // 59 minutes idle: nothing happens.
  let stored = mock.storage.get("agentGroups");
  for (const session of Object.values(stored)) for (const e of Object.values(session)) e.lastUsed = Date.now() - 59 * 60 * 1000;
  assert.equal(await reapIdleGroups(), 0);
  assert.equal([...mock.tabs.values()].length, 2);

  // 61 minutes idle: only the short task's group closes, tabs and registry entry.
  stored = mock.storage.get("agentGroups");
  for (const session of Object.values(stored)) for (const e of Object.values(session)) e.lastUsed = Date.now() - 61 * 60 * 1000;
  assert.equal(await reapIdleGroups(), 1);
  const remaining = [...mock.tabs.values()];
  assert.deepEqual(remaining.map((t) => t.id), [long.data.id]);
  assert.ok(!mock.tabs.has(short.data.id));
  assert.equal(mock.storage.get("agentGroups")[short.data.sessionToken], undefined, "the short task's session has no groups left");
  assert.ok(mock.storage.get("agentGroups")[long.data.sessionToken]?.migration, "the long-running group is still registered");
});

test("groups stored before the longRunning flag keep the 30-day lifetime", async () => {
  const mock = makeChrome();
  const { tabsCreate, reapIdleGroups } = await loadTabs(mock);
  const a = await tabsCreate({ url: "https://a.example", task: "Legacy", longRunning: true });
  for (const t of mock.tabs.values()) t.active = false;
  const stored = mock.storage.get("agentGroups");
  for (const session of Object.values(stored)) {
    for (const e of Object.values(session)) {
      delete e.longRunning; // as written by a pre-flag extension
      e.lastUsed = Date.now() - 2 * 60 * 60 * 1000;
    }
  }
  assert.equal(await reapIdleGroups(), 0, "no flag means no short TTL");
  assert.ok(mock.tabs.has(a.data.id));
});
