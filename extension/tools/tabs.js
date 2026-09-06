/**
 * Tab access policy.
 *
 * Every tab the agent creates lands in a tab group named after the task it
 * belongs to (e.g. "Research competitors") — the task name is required and is
 * the human-readable label of the group. Groups are scoped per agent
 * SESSION: tabs_create mints (or takes) a secret sessionToken and namespaces
 * that session's groups under it, so concurrent agents never share tabs even
 * when they pick the same task name. The token is the capability: tools see
 * and act only on the session's own groups. The user can widen access to all
 * tabs from the options page (allowAllTabs); the agent cannot change it.
 */
const GROUPS_KEY = "agentGroups"; // { [sessionToken]: { [taskNameLower]: {groupId, lastUsed} } }
const GROUP_TTL_MS = 30 * 24 * 60 * 60 * 1000; // reap groups unused for 30 days
const REAP_ALARM = "taskwindow-reap-groups";
const CURRENT_TASK_KEY = "currentTask"; // { [sessionToken]: taskNameLower }
const LEGACY_GROUP_KEY = "agentTabGroupId";
const ALLOW_ALL_KEY = "allowAllTabs";
const SEPARATE_WINDOW_KEY = "separateWindow";
const DEFAULT_TASK = "TaskWindow"; // title of the pre-task-era fixed group (migration only)
/** Pinned anchor tab that keeps the shared agent window alive; outside every group, so no agent can close it. */
const workspaceUrl = () => chrome.runtime.getURL("workspace/workspace.html");

// chrome.storage has no transactions: serialize every read-modify-write so
// concurrent agent sessions can't clobber each other's registrations.
let storeQueue = Promise.resolve();
function serialized(fn) {
  const run = storeQueue.then(fn);
  storeQueue = run.then(
    () => {},
    () => {}
  );
  return run;
}

/**
 * Chrome's tab and tab-group calls can stall for tens of seconds right after
 * the machine wakes. Every tool passes through the serialized store queue, so
 * one stalled call there would hold every session's tools; bound them and say
 * what stalled instead. Timeouts are marked so callers never mistake one for
 * "the group is gone" and prune or recreate it.
 */
const CHROME_CALL_TIMEOUT_MS = 10_000;
function bounded(promise, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(
        `Chrome did not answer ${what} within ${CHROME_CALL_TIMEOUT_MS / 1000}s — it may still be waking up; retry in a moment`
      );
      err.chromeTimeout = true;
      reject(err);
    }, CHROME_CALL_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function policyAllowsAll() {
  const stored = await chrome.storage.local.get(ALLOW_ALL_KEY);
  return stored[ALLOW_ALL_KEY] === true;
}

/** Default on: agent tabs open in their own window, not the user's. */
async function policySeparateWindow() {
  const stored = await chrome.storage.local.get(SEPARATE_WINDOW_KEY);
  return stored[SEPARATE_WINDOW_KEY] !== false;
}

function normalizeToken(sessionToken) {
  return typeof sessionToken === "string" && sessionToken.trim()
    ? sessionToken.trim().slice(0, 100)
    : null;
}

function normalizeTask(name) {
  const trimmed = String(name || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  if (!trimmed) {
    throw new Error(
      'A task name is required: pass "task" describing what the tab group is about (e.g. "Research competitors").'
    );
  }
  return trimmed;
}

function isGroupEntry(v) {
  return v != null && typeof v === "object" && typeof v.groupId === "number";
}

/**
 * Read all session namespaces. Read-only: migrations are normalized in memory
 * and persisted by the next serialized write. v1 shapes (pre-sessions flat
 * group map, scalar current task) migrate into the "" legacy namespace,
 * which tools can't reach — the groups stay visible to the user until reaped.
 */
async function agentGroups() {
  const stored = await chrome.storage.local.get(GROUPS_KEY);
  const raw = stored[GROUPS_KEY] || {};
  const map = {};
  const values = Object.values(raw);
  if (values.length > 0 && values.every((v) => isGroupEntry(v) || typeof v === "number")) {
    map[""] = {};
    for (const [name, entry] of Object.entries(raw)) {
      map[""][name] =
        typeof entry === "number" ? { groupId: entry, lastUsed: Date.now() } : entry;
    }
  } else {
    for (const [token, tasks] of Object.entries(raw)) {
      if (tasks == null || typeof tasks !== "object") continue;
      const inner = {};
      for (const [name, entry] of Object.entries(tasks)) {
        if (typeof entry === "number") inner[name] = { groupId: entry, lastUsed: Date.now() };
        else if (isGroupEntry(entry)) inner[name] = entry;
      }
      if (Object.keys(inner).length) map[token] = inner;
    }
  }
  // Migrate the pre-task-era fixed group, if one still exists.
  if (Object.keys(map).length === 0) {
    const legacy = await chrome.storage.local.get(LEGACY_GROUP_KEY);
    const id = legacy[LEGACY_GROUP_KEY];
    if (id != null) {
      try {
        await chrome.tabGroups.get(id);
        map[""] = { [DEFAULT_TASK.toLowerCase()]: { groupId: id, lastUsed: Date.now() } };
      } catch {}
    }
  }
  return map;
}

async function saveAgentGroups(map) {
  await chrome.storage.local.set({ [GROUPS_KEY]: map });
}

async function currentTaskMap() {
  const stored = await chrome.storage.local.get(CURRENT_TASK_KEY);
  const raw = stored[CURRENT_TASK_KEY];
  if (raw == null) return {};
  if (typeof raw === "string") return { "": raw }; // v1 scalar → legacy "" session
  return raw && typeof raw === "object" ? raw : {};
}

async function currentTaskName(sessionToken) {
  const token = normalizeToken(sessionToken);
  if (token == null) return null;
  const map = await currentTaskMap();
  return map[token] || null;
}

/** Must run inside serialized() — reads, mutates, and writes the task map. */
async function writeCurrentTask(token, taskLower) {
  const map = await currentTaskMap();
  map[token] = taskLower;
  await chrome.storage.local.set({ [CURRENT_TASK_KEY]: map });
}

/** Record that a session's task group was just used (throttled write). */
async function touchGroup(token, nameLower) {
  if (token == null) return;
  await serialized(async () => {
    const all = await agentGroups();
    const entry = all[token]?.[nameLower];
    if (!entry) return;
    const now = Date.now();
    if (now - entry.lastUsed > 30_000) {
      entry.lastUsed = now;
      await saveAgentGroups(all);
    }
  });
}

/** Group ids this session may touch. Dead ids are pruned lazily. */
async function allowedGroupIds(sessionToken) {
  const token = normalizeToken(sessionToken);
  if (token == null) return { ids: [], map: {} };
  return serialized(async () => {
    const all = await agentGroups();
    const session = { ...(all[token] || {}) };
    const ids = [];
    for (const [name, entry] of Object.entries(session)) {
      try {
        await bounded(chrome.tabGroups.get(entry.groupId), "tabGroups.get");
        ids.push(entry.groupId);
      } catch (err) {
        if (err?.chromeTimeout) throw err;
        delete session[name];
      }
    }
    if (Object.keys(session).length !== Object.keys(all[token] || {}).length) {
      if (Object.keys(session).length) all[token] = session;
      else delete all[token];
      await saveAgentGroups(all);
    }
    return { ids, map: session };
  });
}

const NEED_SESSION =
  "Browser tools are scoped per agent session. Call tabs_create first — it returns a " +
  "sessionToken — and pass that sessionToken in every subsequent browser tool call to " +
  "act on your session's tabs.";

/**
 * Deliberately says nothing about *why* the tab is out of reach: it may belong
 * to another session, to the user, or not exist at all. Distinguishing those
 * would let an agent map the browser by probing tab ids, and the remedy is the
 * same in every case.
 */
function deniedError(tabId) {
  return new Error(
    `Access denied: tab ${tabId} is not in your session's tab groups. ` +
      `Use tabs_list to see your tabs, or tabs_create (with a task name and your sessionToken) ` +
      `to open one in your own session; the user can allow all tabs from the extension's options page.`
  );
}

async function assertAllowedTab(tab, sessionToken) {
  if (await policyAllowsAll()) return;
  const token = normalizeToken(sessionToken);
  if (token == null) throw new Error(NEED_SESSION);
  const { ids, map } = await allowedGroupIds(token);
  if (!ids.includes(tab.groupId)) throw deniedError(tab.id);
  const name = Object.entries(map).find(([, e]) => e.groupId === tab.groupId)?.[0];
  if (name) await touchGroup(token, name);
}

export async function resolveTab(tabId, sessionToken) {
  const token = normalizeToken(sessionToken);
  if (tabId != null) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (err) {
      // Under the default policy a missing tab and someone else's tab must look
      // identical, or the difference between the two errors reveals which ids
      // are live. With allowAllTabs there is nothing to hide, so say it plainly.
      if (!(await policyAllowsAll())) throw deniedError(tabId);
      throw err;
    }
    await assertAllowedTab(tab, token);
    return tab;
  }
  // Default target: the active tab of this session's current-task group, then
  // its other groups, then (if the user widened the policy) the active tab.
  if (token == null) {
    if (await policyAllowsAll()) {
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (active) return active;
    }
    throw new Error(NEED_SESSION);
  }
  const { ids, map } = await allowedGroupIds(token);
  const current = await currentTaskName(token);
  const candidates = [];
  if (current && map[current] != null) candidates.push({ name: current, groupId: map[current].groupId });
  for (const [name, entry] of Object.entries(map)) {
    if (!candidates.some((c) => c.groupId === entry.groupId)) candidates.push({ name, groupId: entry.groupId });
  }
  for (const { name, groupId } of candidates) {
    const groupTabs = await chrome.tabs.query({ groupId });
    const active = groupTabs.find((t) => t.active);
    if (active) {
      await touchGroup(token, name);
      return active;
    }
    if (groupTabs.length > 0) {
      await touchGroup(token, name);
      return groupTabs[groupTabs.length - 1];
    }
  }
  if (await policyAllowsAll()) {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (active) return active;
  }
  throw new Error("No tabs in this session's tab groups yet — use tabs_create (with a task name) to open one.");
}

/**
 * Put a tab into the session's group for `task`, reusing an existing group
 * of the same name within the session (never a duplicate). Records the
 * session's current task.
 */
async function ensureTaskGroup(tabId, taskName, sessionToken) {
  const token = normalizeToken(sessionToken);
  if (token == null) throw new Error(NEED_SESSION);
  const task = normalizeTask(taskName);
  return serialized(async () => {
    const all = await agentGroups();
    const session = { ...(all[token] || {}) };
    const key = task.toLowerCase();
    let groupId = session[key]?.groupId;
    if (groupId != null) {
      try {
        await bounded(chrome.tabGroups.get(groupId), "tabGroups.get");
        await bounded(chrome.tabs.group({ tabIds: [tabId], groupId }), "tabs.group");
        await bounded(chrome.tabGroups.update(groupId, { color: "blue" }), "tabGroups.update");
        session[key] = { groupId, lastUsed: Date.now() };
        all[token] = session;
        await saveAgentGroups(all);
        await writeCurrentTask(token, key);
        return { groupId, task };
      } catch (err) {
        if (err?.chromeTimeout) throw err;
        groupId = null; // group was closed; recreate below
      }
    }
    groupId = await bounded(chrome.tabs.group({ tabIds: [tabId] }), "tabs.group");
    await bounded(chrome.tabGroups.update(groupId, { title: task, color: "blue" }), "tabGroups.update");
    session[key] = { groupId, lastUsed: Date.now() };
    all[token] = session;
    await saveAgentGroups(all);
    await writeCurrentTask(token, key);
    return { groupId, task };
  });
}

/** Surface a task group: focus its window and highlight its active tab. */
export async function focusGroup(name, sessionToken) {
  const key = String(name || "").toLowerCase();
  const token = normalizeToken(sessionToken);
  const all = await agentGroups();
  const ns =
    token != null && all[token]?.[key] != null
      ? token
      : Object.keys(all).find((t) => all[t][key] != null);
  if (ns == null) return false;
  const tabs = await chrome.tabs.query({ groupId: all[ns][key].groupId });
  if (tabs.length === 0) return false;
  const active = tabs.find((t) => t.active) ?? tabs[tabs.length - 1];
  await chrome.tabs.update(active.id, { active: true });
  await chrome.windows.update(tabs[0].windowId, { focused: true });
  return true;
}

/**
 * Make `windowId` the agent's home window: move every session's task groups
 * into it (several groups can share one window). Future tabs follow their
 * group, so they land here too.
 */
export async function adoptWindow(windowId) {
  const all = await agentGroups();
  let moved = 0;
  for (const [token, session] of Object.entries(all)) {
    for (const [name, entry] of Object.entries(session)) {
      const gid = entry.groupId;
      let tabs = [];
      try {
        tabs = await chrome.tabs.query({ groupId: gid });
      } catch {
        continue;
      }
      if (tabs.length === 0) continue;
      const tabIds = tabs.map((t) => t.id);
      // index: -1 = append at the end of the destination window (Chrome requires
      // an explicit index when moving an array of tabs).
      await chrome.tabs.move(tabIds, { windowId, index: -1 });
      try {
        // Moving between windows can dissolve the group — re-form it here.
        await chrome.tabs.group({ tabIds, groupId: gid });
      } catch {
        const fresh = await chrome.tabs.group({ tabIds });
        await chrome.tabGroups.update(fresh, { title: name, color: "blue" });
        session[name].groupId = fresh;
      }
      await touchGroup(token, name);
      moved++;
    }
  }
  if (moved > 0) await saveAgentGroups(all);
  return moved;
}

/** Summary for the toolbar popover: agent task groups that still have tabs. */
export async function groupsSummary() {
  const all = await agentGroups();
  const currentMap = await currentTaskMap();
  let recentToken = null;
  let recentTs = -1;
  for (const [token, session] of Object.entries(all)) {
    for (const entry of Object.values(session)) {
      if (entry.lastUsed > recentTs) {
        recentTs = entry.lastUsed;
        recentToken = token;
      }
    }
  }
  const currentTask = recentToken != null ? currentMap[recentToken] : null;
  const groups = [];
  for (const [token, session] of Object.entries(all)) {
    for (const [name, entry] of Object.entries(session)) {
      try {
        const tabs = await chrome.tabs.query({ groupId: entry.groupId });
        if (tabs.length > 0) {
          groups.push({
            name,
            token,
            tabCount: tabs.length,
            windowId: tabs[0].windowId,
            current: token === recentToken && name === currentTask,
          });
        }
      } catch {}
    }
  }
  return groups;
}

/**
 * Reap task groups no session has used in GROUP_TTL_MS. Safety rails: only
 * group ids in our own registry are ever touched (never the user's or
 * another extension's groups), and a group is skipped while any of its tabs
 * is the active tab in its window — the user may be reading it.
 */
export async function reapIdleGroups() {
  return serialized(async () => {
    const all = await agentGroups();
    const now = Date.now();
    let reaped = 0;
    for (const session of Object.values(all)) {
      for (const [name, entry] of Object.entries(session)) {
        let groupTabs = [];
        try {
          groupTabs = await chrome.tabs.query({ groupId: entry.groupId });
        } catch {
          delete session[name];
          continue;
        }
        if (groupTabs.length === 0) {
          delete session[name];
          continue;
        }
        const userReadingIt = groupTabs.some((t) => t.active);
        if (userReadingIt || now - entry.lastUsed < GROUP_TTL_MS) continue;
        try {
          await chrome.tabs.remove(groupTabs.map((t) => t.id));
          reaped++;
        } catch {}
        delete session[name];
      }
    }
    for (const token of Object.keys(all)) {
      if (Object.keys(all[token]).length === 0) delete all[token];
    }
    await saveAgentGroups(all);
    return reaped;
  });
}

export function initGroupReaper() {
  chrome.alarms.create(REAP_ALARM, { periodInMinutes: 5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === REAP_ALARM) reapIdleGroups().catch(() => {});
  });
}

export { ensureTaskGroup, currentTaskName, normalizeToken };

export async function tabsList({ sessionToken } = {}) {
  const token = normalizeToken(sessionToken);
  const allowAll = await policyAllowsAll();
  if (!allowAll && token == null) throw new Error(NEED_SESSION);

  const { ids, map } = await allowedGroupIds(token);
  const tabs = allowAll
    ? await chrome.tabs.query({})
    : ids.length
      ? (await Promise.all(ids.map((gid) => chrome.tabs.query({ groupId: gid })))).flat()
      : [];

  const titleFor = (t) => {
    if (allowAll && t.groupId == null) return "";
    const entry = Object.entries(map).find(([, e]) => e.groupId === t.groupId);
    return entry ? entry[0] : "";
  };

  return {
    data: tabs.map((t) => ({
      id: t.id,
      title: t.title,
      url: t.url || t.pendingUrl || "",
      active: t.active,
      windowId: t.windowId,
      task: titleFor(t) || undefined,
    })),
    text:
      tabs.length > 0
        ? tabs
            .map((t) => {
              const task = titleFor(t);
              return `${t.id}. ${t.title || "(untitled)"} — ${t.url || t.pendingUrl || "about:blank"}${t.active ? "  [active]" : ""}${task ? `  [task: ${task}]` : ""}`;
            })
            .join("\n")
        : "no tabs in this session's groups yet — use tabs_create (with a task name) to open one",
  };
}

/**
 * Chrome sometimes raises a window as a side effect of tab creation, even for
 * background tabs. If focus moved and we didn't ask for it, hand it back.
 * Best effort: works between Chrome windows; can't restore focus to a
 * non-Chrome app the user was working in. Only when Chrome is frontmost
 * (`focused`): if the user is in another app, nothing visible moved, and
 * focusing a Chrome window then would pull them out of that app.
 */
async function restoreFocusIfStolen(previousWindowId) {
  if (previousWindowId == null) return;
  try {
    const { id, focused } = await chrome.windows.getLastFocused();
    if (focused && id !== previousWindowId) await chrome.windows.update(previousWindowId, { focused: true });
  } catch {}
}


/**
 * The window already hosting the agent's work, or null if there is none.
 *
 * A Chrome window holds many tab groups, so every task joins one shared agent
 * window rather than opening its own — concurrent agents included. Only groups
 * in our own registry are considered, so this never returns the user's window
 * unless they put an agent group there themselves (which is what adoptWindow
 * is for). Most-recently-used first, so a new task lands beside live work
 * rather than in the window of some long-idle group.
 */
async function agentWindowId() {
  const all = await agentGroups();
  const entries = Object.values(all)
    .flatMap((session) => Object.values(session))
    .sort((a, b) => b.lastUsed - a.lastUsed);
  for (const { groupId } of entries) {
    try {
      const tabs = await chrome.tabs.query({ groupId });
      if (tabs.length > 0) return tabs[0].windowId;
    } catch {}
  }
  // Every task may have finished, but the anchored window is still open. Not
  // query({url}): match patterns only cover http(s)/file, so a chrome-extension
  // URL there matches nothing. `pinned` is a plain filter; compare URLs ourselves.
  try {
    const pinned = await chrome.tabs.query({ pinned: true });
    const anchor = pinned.find((t) => t.url === workspaceUrl());
    if (anchor) return anchor.windowId;
  } catch {}
  return null;
}

/**
 * A tabs_create whose result never made it back (the daemon gave up waiting
 * while Chrome was slow to wake) still opened its tab — and the agent, having
 * no result, calls again. Without a token a retry and a second agent look the
 * same, so the daemon mints the session token on the first call and names it
 * in the timeout error: the retry with the same token, task and url is then
 * provably the same caller and gets the tab the first call opened — whether
 * that call is still in flight or finished within the last minute — instead
 * of a second tab in a second group. The token is the capability: without one
 * the key is unique per call and nothing is coalesced.
 */
const createsInFlight = new Map(); // key -> Promise<result>
const createsDone = new Map(); // key -> { result, at }
const RETRY_WINDOW_MS = 60_000;

function replayed(result) {
  return {
    ...result,
    data: { ...result.data, replayed: true },
    text:
      `${result.text}\nnote: an identical tabs_create from this session already opened this tab within the last minute ` +
      "(its result may not have reached you) — no second tab was opened",
  };
}

/**
 * The task group a session is working in, by display title. The current-task
 * map stores the lowercased key, so the title comes from the group itself.
 */
async function rememberedTask(token) {
  const current = await currentTaskName(token);
  const entry = current ? (await agentGroups())[token]?.[current] : null;
  if (!entry) {
    throw new Error(
      'This session has no task group yet, so "task" is required: pass a name describing what the tab group is about (e.g. "Research competitors"). ' +
        "Later tabs_create calls can omit it to join that group."
    );
  }
  const title = await chrome.tabGroups.get(entry.groupId).then((g) => g?.title, () => null);
  return normalizeTask(title || current);
}

export async function tabsCreate({ url, task, sessionToken } = {}) {
  const token = normalizeToken(sessionToken) || crypto.randomUUID();
  // The task is remembered per session like the token, so the agent names it
  // once: a later call without one joins the session's current task group.
  const taskUsed = String(task ?? "").trim() ? normalizeTask(task) : await rememberedTask(token);
  const key = [token, taskUsed.toLowerCase(), String(url || "")].join("\n");

  const inFlight = createsInFlight.get(key);
  if (inFlight) return replayed(await inFlight);
  const done = createsDone.get(key);
  if (done && Date.now() - done.at < RETRY_WINDOW_MS && (await chrome.tabs.get(done.result.data.id).then(() => true, () => false))) {
    return replayed(done.result);
  }
  createsDone.delete(key);

  const run = openInTaskGroup({ url, taskUsed, token });
  createsInFlight.set(key, run);
  try {
    const result = await run;
    for (const [k, v] of createsDone) if (Date.now() - v.at >= RETRY_WINDOW_MS) createsDone.delete(k);
    createsDone.set(key, { result, at: Date.now() });
    return result;
  } finally {
    createsInFlight.delete(key);
  }
}

async function openInTaskGroup({ url, taskUsed, token }) {
  const startedAt = Date.now();
  const separateWindow = await policySeparateWindow();
  const all = await agentGroups();
  const existingGroupId = all[token]?.[taskUsed.toLowerCase()]?.groupId;

  // Always a background tab: `tabs.create` defaults to active, which would
  // switch what the window shows. A background tab still renders and takes
  // input, so nothing ever needs to bring it forward.
  let tab;
  let createdNewWindow = false;
  const previouslyFocused = (await chrome.windows.getLastFocused().catch(() => null))?.id ?? null;

  if (separateWindow) {
    // Work in the agent's window, never the user's: this task's own group if it
    // already has one, else whatever window the agent is already using, else a
    // new window on first use.
    let windowId = null;
    if (existingGroupId != null) {
      try {
        const groupTabs = await chrome.tabs.query({ groupId: existingGroupId });
        if (groupTabs.length > 0) windowId = groupTabs[0].windowId;
      } catch {}
    }
    if (windowId == null) windowId = await agentWindowId();
    if (windowId != null) {
      tab = await chrome.tabs.create({ url, active: false, windowId });
    } else {
      // First use: a fresh agent window, anchored by a pinned tab outside any
      // group. Chrome drops a window with its last tab, and one task finishing
      // must not take the shared window (and wherever the user put it) away
      // from every other agent — and no agent can close a tab it can't reach.
      // Sized so a 1:1 CSS-pixel screenshot stays under the vision models'
      // native resolution (~1568px long edge): a wider viewport is downscaled
      // by the model API, and the coordinates it reads off the image drift.
      // Chrome clamps to the screen; the user may resize the window later.
      const win = await chrome.windows.create({ url: workspaceUrl(), focused: false, width: 1280, height: 900 });
      const anchor = win.tabs?.[0];
      if (!anchor) throw new Error("window was created but Chrome returned no tab");
      await chrome.tabs.update(anchor.id, { pinned: true });
      tab = await chrome.tabs.create({ url, active: false, windowId: win.id });
      createdNewWindow = true;
    }
    // The agent window never takes focus. The user is in their own window or
    // another app entirely; Chrome sometimes raises a window on tab creation
    // regardless, so hand focus straight back.
    await restoreFocusIfStolen(previouslyFocused);
  } else {
    tab = await chrome.tabs.create({ url, active: false });
  }
  const createdAt = Date.now();

  // A tab is only ever the agent's inside a task group: outside one it is
  // reachable by no session and shows in no popover list. If grouping fails
  // (or stalls, see bounded), close the tab again rather than strand it.
  let groupId, taskName;
  try {
    ({ groupId, task: taskName } = await ensureTaskGroup(tab.id, taskUsed, token));
  } catch (err) {
    await chrome.tabs.remove(tab.id).catch(() => {});
    throw new Error(`could not put the new tab in the "${taskUsed}" group (${err.message}); closed it again — retry`);
  }
  const timing = { createMs: createdAt - startedAt, groupMs: Date.now() - createdAt };

  // Agents open the same page again when they've lost track of the tab they
  // already have, and nothing told them. Don't dedupe silently (two tabs of one
  // URL is sometimes deliberate) — point at the existing tab instead.
  const sameUrl = (u) => String(u || "").split("#")[0];
  const duplicates = (await chrome.tabs.query({ groupId }))
    .filter((t) => t.id !== tab.id && sameUrl(t.url || t.pendingUrl) === sameUrl(url))
    .map((t) => t.id);

  return {
    data: {
      id: tab.id,
      title: tab.title,
      url: tab.url || url,
      groupId,
      task: taskName,
      sessionToken: token,
      newWindow: createdNewWindow,
      alreadyOpenIn: duplicates,
      timing,
    },
    text:
      `opened tab ${tab.id} in the "${taskName}" group${createdNewWindow ? " in a new window" : ""}: ${tab.url || url}` +
      ` — sessionToken ${token}: pass it as "sessionToken" in every subsequent browser tool call` +
      (duplicates.length
        ? `\nnote: this group already had ${duplicates.length === 1 ? "tab" : "tabs"} ${duplicates.join(", ")} at this URL — next time use reload or navigate on that tab instead of opening another`
        : ""),
  };
}

export async function tabsClose({ tabId, sessionToken } = {}) {
  // Via resolveTab, not a bare tabs.get: it is the one place that looks a tab
  // up and checks it, so closing cannot leak which ids exist.
  const tab = await resolveTab(tabId, sessionToken);
  await chrome.tabs.remove(tab.id);
  return { text: `closed tab ${tab.id}` };
}

/** Resolve true once the tab fires its load event, false after `ms` — so agents don't race page loads. */
function waitForLoad(tabId, ms = 10_000) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => cleanup(false), ms);
    function listener(id, info) {
      if (id === tabId && info.status === "complete") cleanup(true);
    }
    function cleanup(didLoad) {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(didLoad);
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/** Shared tail of navigate/reload: the tab's state once the load settled (or the tab vanished). */
async function loadOutcome(tabId, settled, verb) {
  let fresh;
  try {
    fresh = await chrome.tabs.get(tabId);
  } catch {
    return { text: `tab ${tabId} closed during ${verb}` };
  }
  return {
    data: { tabId, url: fresh.url, title: fresh.title, loadTimedOut: !settled },
    text: `tab ${tabId} now at ${fresh.url}${fresh.title ? ` — "${fresh.title}"` : ""}${!settled ? " (load event did not fire within 10s; the page may still be loading)" : ""}`,
  };
}

export async function navigate({ url, tabId, sessionToken } = {}) {
  const tab = await resolveTab(tabId, sessionToken);
  await chrome.tabs.update(tab.id, { url });
  const settled = await waitForLoad(tab.id);
  return loadOutcome(tab.id, settled, `navigation to ${url}`);
}

export async function reload({ tabId, sessionToken, bypassCache = false } = {}) {
  const tab = await resolveTab(tabId, sessionToken);
  await chrome.tabs.reload(tab.id, { bypassCache: !!bypassCache });
  const settled = await waitForLoad(tab.id);
  return loadOutcome(tab.id, settled, "reload");
}
