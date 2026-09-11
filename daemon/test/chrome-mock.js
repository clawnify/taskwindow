/**
 * The chrome.* mock the extension-side tests run against (tabs.js,
 * responsive.js): enough of Chrome's real semantics that a test failing here
 * means the extension would fail in Chrome.
 *
 * Faithful where it matters: a group lives in exactly one window and grouping
 * MOVES tabs into it, Chrome keeps no empty groups, and a new group without
 * createProperties is born in the last-focused (i.e. the user's) window.
 */
export function makeChrome() {
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
  const windowIds = new Set([1]); // window 1 is the user's
  const dnrRules = new Map(); // session rule id -> rule
  const cdp = []; // { tabId, method, params } sent through chrome.debugger
  const attached = new Set();
  // fileAccess: the per-extension "Allow access to file URLs" toggle, which
  // <all_urls> alone does not grant. framingBlocked: the target answers with
  // X-Frame-Options/CSP that the DNR rules failed to strip.
  const flags = { raiseOnCreate: false, fileAccess: false, framingBlocked: false };

  // Chrome keeps no empty groups: the last tab leaving destroys the group.
  function reapEmptyGroups() {
    for (const gid of [...groups.keys()]) {
      if (![...tabs.values()].some((t) => t.groupId === gid)) groups.delete(gid);
    }
  }

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
    windowIds,
    dnrRules,
    cdp,
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
          reapEmptyGroups();
        },
        // Chrome dissolves a tab's group membership when it moves to another
        // window, and destroys a group once its last tab is gone.
        async move(ids, { windowId }) {
          for (const id of Array.isArray(ids) ? ids : [ids]) {
            Object.assign(tabs.get(id), { windowId, groupId: -1 });
          }
          reapEmptyGroups();
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
            if (!groups.has(gid)) throw new Error(`No group with id ${gid}`);
            windowId = groups.get(gid).windowId;
          }
          for (const id of tabIds) Object.assign(tabs.get(id), { groupId: gid, windowId });
          return gid;
        },
        async update(id, props) {
          Object.assign(tabs.get(id), props);
        },
        onUpdated: { addListener() {}, removeListener() {} },
        async sendMessage() {},
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
          windowIds.add(id);
          if (flags.raiseOnCreate) userFocus.id = id;
          const created = opts?.url ? [createTab({ url: opts.url, active: true, windowId: id })] : [];
          return { id, tabs: created };
        },
        async get(id) {
          if (!windowIds.has(id)) throw new Error(`No window with id ${id}`);
          return { id };
        },
        async remove(id) {
          if (!windowIds.has(id)) throw new Error(`No window with id ${id}`);
          windowIds.delete(id);
          for (const t of [...tabs.values()]) if (t.windowId === id) tabs.delete(t.id);
          reapEmptyGroups();
        },
      },
      // What the harness tab actually renders: one iframe per entry in its own
      // ?widths= parameter, pointed at its own ?url=. A frame that Chrome would
      // refuse to load simply isn't there — which is how the caller finds out.
      scripting: {
        async executeScript({ target: { tabId, allFrames }, func }) {
          const tab = tabs.get(tabId);
          if (!tab) throw new Error(`No tab with id ${tabId}`);
          const self = { frameId: 0, result: { href: tab.url, w: 1280, h: 900, touch: 0 } };
          if (!allFrames || !String(tab.url).includes("responsive.html")) return [self];
          const params = new URLSearchParams(String(tab.url).split("?")[1] || "");
          const target = params.get("url") || "about:blank";
          let widths = [];
          try {
            widths = JSON.parse(params.get("widths") || "[]");
          } catch {}
          if (flags.framingBlocked) return [self];
          // <all_urls> does not carry file://; without the toggle the frame
          // never loads, so the harness renders empty boxes forever.
          if (target.startsWith("file:") && !flags.fileAccess) return [self];
          return [
            self,
            ...widths.map((v, i) => ({
              frameId: i + 1,
              result: { href: target, w: v.width, h: v.height, touch: 0 },
            })),
          ];
        },
      },
      declarativeNetRequest: {
        async updateSessionRules({ removeRuleIds = [], addRules = [] } = {}) {
          for (const id of removeRuleIds) dnrRules.delete(id);
          for (const r of addRules) {
            // Chrome rejects the whole call if an id is already taken.
            if (dnrRules.has(r.id)) throw new Error(`Rule with id ${r.id} does not have a unique ID.`);
            dnrRules.set(r.id, r);
          }
        },
        async getSessionRules() {
          return [...dnrRules.values()];
        },
      },
      debugger: {
        async attach({ tabId }) {
          attached.add(tabId);
        },
        async detach({ tabId }) {
          attached.delete(tabId);
        },
        async sendCommand({ tabId }, method, params) {
          cdp.push({ tabId, method, params });
          return {};
        },
        onEvent: { addListener() {}, removeListener() {} },
        onDetach: { addListener() {}, removeListener() {} },
      },
      extension: {
        async isAllowedFileSchemeAccess() {
          return flags.fileAccess;
        },
      },
    },
  };
}
