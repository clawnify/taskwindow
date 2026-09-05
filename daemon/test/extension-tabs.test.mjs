/**
 * Session-isolation tests for extension/tools/tabs.js (run in Node with a
 * chrome.* mock): concurrent agents must never share tab groups even when
 * they pick the same task name, task names are required, and the legacy
 * pre-session storage shape stays visible to the user but unreachable by
 * tools.
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
        async group({ tabIds, groupId }) {
          let gid = groupId;
          if (gid == null) {
            gid = nextGroupId++;
            groups.set(gid, { id: gid, title: "", color: "" });
          }
          for (const id of tabIds) tabs.get(id).groupId = gid;
          return gid;
        },
        async update(id, props) {
          Object.assign(tabs.get(id), props);
        },
        onUpdated: { addListener() {}, removeListener() {} },
      },
      windows: {
        async getLastFocused() {
          return { id: 1 };
        },
        async update(id, props) {
          if (props?.focused) windowFocus.push(id);
        },
        async create(opts) {
          windowsCreated.push(opts);
          const id = nextWindowId++;
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

test("tabs_create requires a task name", async () => {
  const { tabsCreate } = await loadTabs(makeChrome());
  await assert.rejects(() => tabsCreate({ url: "https://example.com" }), /task/i);
  await assert.rejects(() => tabsCreate({ url: "https://example.com", task: "   " }), /task/i);
});

test("two agents with the same task name get separate groups and tokens", async () => {
  const { tabsCreate } = await loadTabs(makeChrome());
  const a = await tabsCreate({ url: "https://a.example", task: "Research competitors" });
  const b = await tabsCreate({ url: "https://b.example", task: "Research competitors" });
  assert.ok(a.data.sessionToken, "agent A got a sessionToken");
  assert.ok(b.data.sessionToken, "agent B got a sessionToken");
  assert.notEqual(a.data.sessionToken, b.data.sessionToken);
  assert.notEqual(a.data.groupId, b.data.groupId, "same task name, different groups");
});

test("same sessionToken + same task reuses the group; a new task gets its own", async () => {
  const { tabsCreate } = await loadTabs(makeChrome());
  const r1 = await tabsCreate({ url: "https://a.example", task: "Research competitors" });
  const r2 = await tabsCreate({ url: "https://a.example/2", task: "Research competitors", sessionToken: r1.data.sessionToken });
  assert.equal(r2.data.groupId, r1.data.groupId, "same session + task reuses the group");
  const r3 = await tabsCreate({ url: "https://b.example", task: "Fix bug", sessionToken: r1.data.sessionToken });
  assert.notEqual(r3.data.groupId, r1.data.groupId, "different task in the same session gets its own group");
});

test("a session cannot act on another session's tabs", async () => {
  const { tabsCreate, tabsClose } = await loadTabs(makeChrome());
  const a = await tabsCreate({ url: "https://a.example", task: "Research competitors" });
  const b = await tabsCreate({ url: "https://b.example", task: "Research competitors" });
  await assert.rejects(
    () => tabsClose({ tabId: a.data.id, sessionToken: b.data.sessionToken }),
    /not in your session's tab groups/
  );
  await tabsClose({ tabId: a.data.id, sessionToken: a.data.sessionToken }); // own tab: fine
});

test("a foreign tab and a missing tab are indistinguishable", async () => {
  const { tabsCreate, tabsClose } = await loadTabs(makeChrome());
  const a = await tabsCreate({ url: "https://a.example", task: "Research competitors" });
  const b = await tabsCreate({ url: "https://b.example", task: "Fix bug" });

  const foreign = await tabsClose({ tabId: a.data.id, sessionToken: b.data.sessionToken }).catch((e) => e.message);
  const missing = await tabsClose({ tabId: 987654, sessionToken: b.data.sessionToken }).catch((e) => e.message);

  // Differing errors would let an agent probe tab ids to map the browser.
  assert.equal(foreign.replace(String(a.data.id), "N"), missing.replace("987654", "N"));
});

test("tasks from any session share one agent window; only the first opens it", async () => {
  const mock = makeChrome();
  const { tabsCreate } = await loadTabs(mock);
  mock.storage.set("separateWindow", true);
  const a = await tabsCreate({ url: "https://a.example", task: "Research competitors" });
  const b = await tabsCreate({ url: "https://b.example", task: "Fix bug" }); // another agent
  const c = await tabsCreate({ url: "https://c.example", task: "Third thing", sessionToken: a.data.sessionToken });

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
  const a = await tabsCreate({ url: "https://a.example", task: "Research competitors" });
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
  const b = await tabsCreate({ url: "https://b.example", task: "Fix bug" });
  assert.equal(b.data.newWindow, false);
  assert.equal(mock.tabs.get(b.data.id).windowId, wid);
});

test("opening a URL the group already has is allowed but called out", async () => {
  const { tabsCreate } = await loadTabs(makeChrome());
  const a = await tabsCreate({ url: "https://app.example/deals", task: "CRM" });
  const b = await tabsCreate({ url: "https://app.example/deals#top", task: "CRM", sessionToken: a.data.sessionToken });
  assert.notEqual(b.data.id, a.data.id, "not deduped: the second tab really opens");
  assert.deepEqual(b.data.alreadyOpenIn, [a.data.id], "fragment ignored when matching");
  assert.match(b.text, /already had tab \d+ at this URL/);
  assert.match(b.text, /reload or navigate/);
  const c = await tabsCreate({ url: "https://app.example/contacts", task: "CRM", sessionToken: a.data.sessionToken });
  assert.deepEqual(c.data.alreadyOpenIn, []);
  assert.doesNotMatch(c.text, /already had/);
});

test("opening a tab never takes focus from the user's window", async () => {
  const mock = makeChrome();
  const { tabsCreate } = await loadTabs(mock);
  mock.storage.set("separateWindow", true);
  const a = await tabsCreate({ url: "https://a.example", task: "Research competitors", active: true }); // opens the window
  await tabsCreate({ url: "https://b.example", task: "Fix bug", sessionToken: a.data.sessionToken, active: true }); // joins it

  assert.equal(mock.windowsCreated.length, 1);
  assert.equal(mock.windowsCreated[0].focused, false, "the agent window is created unfocused");
  // Focus may only ever be handed *back* to the user's window (id 1), never given to an agent window.
  assert.ok(mock.windowFocus.every((id) => id === 1), `focused agent window(s): ${mock.windowFocus}`);
  assert.equal(mock.tabs.get(a.data.id).active, true, "active still means active within the agent window");
});

test("tabs_list without a sessionToken gives an instructive error; with one, only own tabs", async () => {
  const { tabsCreate, tabsList } = await loadTabs(makeChrome());
  const a = await tabsCreate({ url: "https://a.example", task: "Research competitors" });
  const b = await tabsCreate({ url: "https://b.example", task: "Fix bug" });
  await assert.rejects(() => tabsList({}), /sessionToken/);
  const listA = await tabsList({ sessionToken: a.data.sessionToken });
  const ids = listA.data.map((t) => t.id);
  assert.ok(ids.includes(a.data.id), "own tab listed");
  assert.ok(!ids.includes(b.data.id), "other session's tab not listed");
});

test("default tab resolution is scoped to the session's own groups", async () => {
  const { tabsCreate, resolveTab } = await loadTabs(makeChrome());
  const a = await tabsCreate({ url: "https://a.example", task: "Research competitors" });
  const b = await tabsCreate({ url: "https://b.example", task: "Fix bug" });
  assert.equal((await resolveTab(null, a.data.sessionToken)).id, a.data.id);
  assert.equal((await resolveTab(null, b.data.sessionToken)).id, b.data.id);
  await assert.rejects(() => resolveTab(null, null), /sessionToken/);
});

test("session with two tasks resolves to the current task's group by default", async () => {
  const { tabsCreate, resolveTab } = await loadTabs(makeChrome());
  const t = "tok-fixed";
  const r1 = await tabsCreate({ url: "https://a.example", task: "Research competitors", sessionToken: t });
  const r2 = await tabsCreate({ url: "https://b.example", task: "Fix bug", sessionToken: t });
  const tab = await resolveTab(null, t);
  assert.equal(tab.id, r2.data.id, "last-created task is the session's current task");
  const tab2 = await resolveTab(r1.data.id, t);
  assert.equal(tab2.id, r1.data.id, "explicit tab of an older task in the same session is reachable");
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
  const a = await tabsCreate({ url: "https://a.example", task: "Research competitors" });
  await tabsCreate({ url: "https://b.example", task: "Fix bug" });
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
