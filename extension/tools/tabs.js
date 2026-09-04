import { withDebugger } from "./cdp.js";

/**
 * Tab access policy.
 *
 * Every tab the agent creates lands in a tab group named after the task it
 * belongs to (e.g. "Research competitors"). Same task name → same group, never
 * a duplicate. The agent may only see and act on tabs inside agent-created
 * groups — the groups are the capability boundary. The user can widen this to
 * all tabs from the options page (allowAllTabs); the agent cannot change it.
 */
const GROUPS_KEY = "agentGroups"; // { [taskNameLower]: {groupId, lastUsed} }
const GROUP_TTL_MS = 30 * 24 * 60 * 60 * 1000; // reap groups unused for 30 days
const REAP_ALARM = "taskwindow-reap-groups";
const CURRENT_TASK_KEY = "currentTask"; // lowercased task name
const LEGACY_GROUP_KEY = "agentTabGroupId";
const ALLOW_ALL_KEY = "allowAllTabs";
const SEPARATE_WINDOW_KEY = "separateWindow";
const DEFAULT_TASK = "TaskWindow";

async function policyAllowsAll() {
  const stored = await chrome.storage.local.get(ALLOW_ALL_KEY);
  return stored[ALLOW_ALL_KEY] === true;
}

/** Default on: agent tabs open in their own window, not the user's. */
async function policySeparateWindow() {
  const stored = await chrome.storage.local.get(SEPARATE_WINDOW_KEY);
  return stored[SEPARATE_WINDOW_KEY] !== false;
}

async function agentGroups() {
  const stored = await chrome.storage.local.get(GROUPS_KEY);
  const raw = stored[GROUPS_KEY] || {};
  const map = {};
  let changed = false;
  for (const [name, entry] of Object.entries(raw)) {
    if (typeof entry === "number") {
      map[name] = { groupId: entry, lastUsed: Date.now() }; // migrate pre-reaper shape
      changed = true;
    } else {
      map[name] = entry;
    }
  }
  // Migrate the pre-task fixed group, if it still exists.
  if (Object.keys(map).length === 0) {
    const legacy = await chrome.storage.local.get(LEGACY_GROUP_KEY);
    const id = legacy[LEGACY_GROUP_KEY];
    if (id != null) {
      try {
        await chrome.tabGroups.get(id);
        map[DEFAULT_TASK.toLowerCase()] = { groupId: id, lastUsed: Date.now() };
        changed = true;
      } catch {}
    }
  }
  if (changed) await saveAgentGroups(map);
  return map;
}

async function saveAgentGroups(map) {
  await chrome.storage.local.set({ [GROUPS_KEY]: map });
}

async function currentTaskName() {
  const stored = await chrome.storage.local.get(CURRENT_TASK_KEY);
  return stored[CURRENT_TASK_KEY] || null;
}

/** Group ids the agent may touch. Invalid ids are pruned lazily. */
async function allowedGroupIds() {
  const map = await agentGroups();
  const ids = [];
  for (const [name, entry] of Object.entries(map)) {
    try {
      await chrome.tabGroups.get(entry.groupId);
      ids.push(entry.groupId);
    } catch {
      delete map[name];
    }
  }
  if (Object.keys(map).length) await saveAgentGroups(map);
  return { ids, map };
}

/** Record that a task group was just used (throttled to avoid write churn). */
async function touchGroup(nameLower) {
  const map = await agentGroups();
  const entry = map[nameLower];
  if (!entry) return;
  const now = Date.now();
  if (now - entry.lastUsed > 30_000) {
    entry.lastUsed = now;
    await saveAgentGroups(map);
  }
}

/**
 * Reap task groups the agent hasn't used in GROUP_TTL_MS. Safety rails:
 * only group ids in our own registry are ever touched (never the user's or
 * another extension's groups), and a group is skipped while any of its tabs
 * is the active tab in its window — the user may be reading it.
 */
export async function reapIdleGroups() {
  const map = await agentGroups();
  const now = Date.now();
  let reaped = 0;
  for (const [name, entry] of Object.entries(map)) {
    let groupTabs = [];
    try {
      groupTabs = await chrome.tabs.query({ groupId: entry.groupId });
    } catch {
      delete map[name];
      continue;
    }
    if (groupTabs.length === 0) {
      delete map[name];
      continue;
    }
    const userReadingIt = groupTabs.some((t) => t.active);
    if (userReadingIt || now - entry.lastUsed < GROUP_TTL_MS) continue;
    try {
      await chrome.tabs.remove(groupTabs.map((t) => t.id));
      reaped++;
    } catch {}
    delete map[name];
  }
  await saveAgentGroups(map);
  return reaped;
}

export function initGroupReaper() {
  chrome.alarms.create(REAP_ALARM, { periodInMinutes: 5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === REAP_ALARM) reapIdleGroups().catch(() => {});
  });
}

function normalizeTask(name) {
  const trimmed = String(name || "").replace(/\s+/g, " ").trim().slice(0, 60);
  return trimmed || DEFAULT_TASK;
}

async function assertAllowedTab(tab) {
  if (await policyAllowsAll()) return;
  const { ids, map } = await allowedGroupIds();
  if (!ids.includes(tab.groupId)) {
    throw new Error(
      `Access denied: tab ${tab.id} is outside the agent's tab groups (default policy: group-only). ` +
        `Use tabs_create to open a tab the agent can use; the user can allow all tabs from the extension's options page.`
    );
  }
  const name = Object.entries(map).find(([, e]) => e.groupId === tab.groupId)?.[0];
  if (name) await touchGroup(name);
}

export async function resolveTab(tabId) {
  if (tabId != null) {
    const tab = await chrome.tabs.get(tabId); // throws a clear error if missing
    await assertAllowedTab(tab);
    return tab;
  }
  // Default target: the active tab of the current task's group, then any
  // agent-group active tab, then the most recent agent-group tab.
  const { ids, map } = await allowedGroupIds();
  const current = await currentTaskName();
  const candidates = [];
  if (current && map[current] != null) candidates.push({ name: current, groupId: map[current].groupId });
  for (const [name, entry] of Object.entries(map)) {
    if (!candidates.some((c) => c.groupId === entry.groupId)) candidates.push({ name, groupId: entry.groupId });
  }
  for (const { name, groupId } of candidates) {
    const groupTabs = await chrome.tabs.query({ groupId });
    const active = groupTabs.find((t) => t.active);
    if (active) {
      await touchGroup(name);
      return active;
    }
    if (groupTabs.length > 0) {
      await touchGroup(name);
      return groupTabs[groupTabs.length - 1];
    }
  }
  if (await policyAllowsAll()) {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (active) return active;
  }
  throw new Error("No agent tab groups yet — use tabs_create to open a tab the agent can use.");
}

/**
 * Put a tab into the group for `task`, reusing an existing group with the
 * same name (never creating a duplicate). Records the task as current.
 */
async function ensureTaskGroup(tabId, taskName) {
  const task = normalizeTask(taskName);
  const map = await agentGroups();
  let groupId = map[task.toLowerCase()]?.groupId;

  if (groupId != null) {
    try {
      await chrome.tabGroups.get(groupId);
      await chrome.tabs.group({ tabIds: [tabId], groupId });
      await chrome.tabGroups.update(groupId, { color: "green" });
      await touchGroup(task.toLowerCase());
      await chrome.storage.local.set({ [CURRENT_TASK_KEY]: task.toLowerCase() });
      return { groupId, task };
    } catch {
      groupId = null; // group was closed; recreate below
    }
  }

  // Adopt an agent-created group of the same name if one is still open.
  for (const [name, entry] of Object.entries(map)) {
    if (name !== task.toLowerCase()) continue;
    try {
      await chrome.tabGroups.get(entry.groupId);
      groupId = entry.groupId;
      break;
    } catch {}
  }

  if (groupId == null) {
    groupId = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(groupId, { title: task, color: "green" });
  }
  map[task.toLowerCase()] = { groupId, lastUsed: Date.now() };
  await saveAgentGroups(map);
  await chrome.storage.local.set({ [CURRENT_TASK_KEY]: task.toLowerCase() });
  return { groupId, task };
}

/** Surface a task group: focus its window and highlight its active tab. */
export async function focusGroup(name) {
  const map = await agentGroups();
  const groupId = map[String(name || "").toLowerCase()]?.groupId;
  if (groupId == null) return false;
  const tabs = await chrome.tabs.query({ groupId });
  if (tabs.length === 0) return false;
  const active = tabs.find((t) => t.active) ?? tabs[tabs.length - 1];
  await chrome.tabs.update(active.id, { active: true });
  await chrome.windows.update(tabs[0].windowId, { focused: true });
  return true;
}

/**
 * Make `windowId` the agent's home window: move every agent task group into
 * it (several groups can share one window). Future tabs for those tasks follow
 * their group, so they land here too.
 */
export async function adoptWindow(windowId) {
  const { map } = await allowedGroupIds();
  let moved = 0;
  for (const [name, entry] of Object.entries(map)) {
    const gid = entry.groupId;
    const tabs = await chrome.tabs.query({ groupId: gid });
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
      map[name].groupId = fresh;
    }
    await touchGroup(name);
    moved++;
  }
  if (moved > 0) await saveAgentGroups(map);
  return moved;
}

/** Summary for the toolbar popover: agent task groups that still have tabs. */
export async function groupsSummary() {
  const map = await agentGroups();
  const current = await currentTaskName();
  const groups = [];
  for (const [name, entry] of Object.entries(map)) {
    try {
      const tabs = await chrome.tabs.query({ groupId: entry.groupId });
      if (tabs.length > 0) {
        groups.push({ name, tabCount: tabs.length, windowId: tabs[0].windowId, current: name === current });
      }
    } catch {}
  }
  return groups;
}

export { ensureTaskGroup, currentTaskName, DEFAULT_TASK };

export async function tabsList() {
  const allowAll = await policyAllowsAll();
  const { ids, map } = await allowedGroupIds();
  const current = await currentTaskName();

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
        : "no agent tab groups yet — use tabs_create (optionally with task) to open a tab the agent can use",
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

export async function tabsCreate({ url, active = true, task }) {
  const taskUsed = normalizeTask(task || (await currentTaskName()) || DEFAULT_TASK);
  const separateWindow = await policySeparateWindow();
  const map = await agentGroups();
  const existingGroupId = map[taskUsed.toLowerCase()]?.groupId;

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

  const { groupId, task: taskName } = await ensureTaskGroup(tab.id, taskUsed);
  return {
    data: { id: tab.id, title: tab.title, url: tab.url || url, active: !!active, groupId, task: taskName, newWindow: createdNewWindow },
    text: `opened tab ${tab.id} in the "${taskName}" group${createdNewWindow ? " in a new window" : ""}: ${tab.url || url}`,
  };
}

export async function tabsClose({ tabId }) {
  const tab = await chrome.tabs.get(tabId);
  await assertAllowedTab(tab);
  await chrome.tabs.remove(tabId);
  return { text: `closed tab ${tabId}` };
}

export async function navigate({ url, tabId }) {
  const tab = await resolveTab(tabId);
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
