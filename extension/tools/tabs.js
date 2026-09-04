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
        await chrome.tabGroups.get(entry.groupId);
        ids.push(entry.groupId);
      } catch {
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

function deniedError(tabId) {
  return new Error(
    `Access denied: tab ${tabId} belongs to a different agent session's tab groups. ` +
      `Use tabs_create (with a task name and your sessionToken) to open a tab in your own session; ` +
      `the user can allow all tabs from the extension's options page.`
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
    const tab = await chrome.tabs.get(tabId); // throws a clear error if missing
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
        await chrome.tabGroups.get(groupId);
        await chrome.tabs.group({ tabIds: [tabId], groupId });
        await chrome.tabGroups.update(groupId, { color: "green" });
        session[key] = { groupId, lastUsed: Date.now() };
        all[token] = session;
        await saveAgentGroups(all);
        await writeCurrentTask(token, key);
        return { groupId, task };
      } catch {
        groupId = null; // group was closed; recreate below
      }
    }
    groupId = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(groupId, { title: task, color: "green" });
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
        await chrome.tabGroups.update(fresh, { title: name, color: "green" });
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
 * non-Chrome app the user was working in.
 */
async function restoreFocusIfStolen(previousWindowId) {
  if (previousWindowId == null) return;
  try {
    const { id } = await chrome.windows.getLastFocused();
    if (id !== previousWindowId) await chrome.windows.update(previousWindowId, { focused: true });
  } catch {}
}

export async function tabsCreate({ url, active = true, task, sessionToken } = {}) {
  const token = normalizeToken(sessionToken) || crypto.randomUUID();
  const taskUsed = normalizeTask(task); // required, non-empty
  const separateWindow = await policySeparateWindow();
  const all = await agentGroups();
  const existingGroupId = all[token]?.[taskUsed.toLowerCase()]?.groupId;

  let tab;
  let createdNewWindow = false;
  const previouslyFocused = (await chrome.windows.getLastFocused().catch(() => null))?.id ?? null;

  if (separateWindow) {
    // Work in the task group's own window: create there, or spin up a new
    // window on first use so the user's window is never touched.
    let windowId = null;
    if (existingGroupId != null) {
      try {
        const groupTabs = await chrome.tabs.query({ groupId: existingGroupId });
        if (groupTabs.length > 0) windowId = groupTabs[0].windowId;
      } catch {}
    }
    if (windowId != null) {
      tab = await chrome.tabs.create({ url, active, windowId });
      if (active) await chrome.windows.update(windowId, { focused: true });
      else await restoreFocusIfStolen(previouslyFocused);
    } else {
      const win = await chrome.windows.create({ url, focused: !!active });
      tab = win.tabs?.[0];
      if (!tab) throw new Error("window was created but Chrome returned no tab");
      createdNewWindow = true;
      if (!active) await restoreFocusIfStolen(previouslyFocused);
    }
  } else {
    tab = await chrome.tabs.create({ url, active });
  }

  const { groupId, task: taskName } = await ensureTaskGroup(tab.id, taskUsed, token);
  return {
    data: {
      id: tab.id,
      title: tab.title,
      url: tab.url || url,
      active: !!active,
      groupId,
      task: taskName,
      sessionToken: token,
      newWindow: createdNewWindow,
    },
    text:
      `opened tab ${tab.id} in the "${taskName}" group${createdNewWindow ? " in a new window" : ""}: ${tab.url || url}` +
      ` — sessionToken ${token}: pass it as "sessionToken" in every subsequent browser tool call`,
  };
}

export async function tabsClose({ tabId, sessionToken } = {}) {
  const tab = await chrome.tabs.get(tabId);
  await assertAllowedTab(tab, sessionToken);
  await chrome.tabs.remove(tabId);
  return { text: `closed tab ${tabId}` };
}

export async function navigate({ url, tabId, sessionToken } = {}) {
  const tab = await resolveTab(tabId, sessionToken);
  const updated = await chrome.tabs.update(tab.id, { url });

  // Wait (up to 10s) for the load event so agents don't race page loads.
  let settled = await new Promise((resolve) => {
    const timeout = setTimeout(() => cleanup(false), 10_000);
    function listener(id, info) {
      if (id === tab.id && info.status === "complete") cleanup(true);
    }
    function cleanup(didLoad) {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(didLoad);
    }
    chrome.tabs.onUpdated.addListener(listener);
  });

  let fresh;
  try {
    fresh = await chrome.tabs.get(tab.id);
  } catch {
    return { text: `tab ${tab.id} closed during navigation to ${url}` };
  }
  return {
    data: { tabId: tab.id, url: fresh.url, title: fresh.title, loadTimedOut: !settled },
    text: `tab ${tab.id} now at ${fresh.url}${fresh.title ? ` — "${fresh.title}"` : ""}${!settled ? " (load event did not fire within 10s; the page may still be loading)" : ""}`,
  };
}
