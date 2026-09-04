/**
 * Responsive view: the verify-responsive harness, native.
 *
 * set_viewport opens a dedicated window with one fixed-size iframe per
 * requested viewport (an iframe's viewport is its own box — media queries and
 * vw/vh resolve exactly, several breakpoints side by side). Header-stripping
 * DNR rules scoped to the harness tab let most sites frame; viewports whose
 * frame still fails (frame-busters, cookie-partitioned logins) fall back to a
 * dedicated top-level emulation window. Every frame's real innerWidth is
 * asserted from inside the page — a screenshot alone proves nothing.
 *
 * Clearing closes the harness window, fallback windows and the DNR rules.
 */
import { resolveTab, ensureTaskGroup, currentTaskName, DEFAULT_TASK } from "./tabs.js";
import { ensureAttached, send } from "./cdp.js";

const SESSION_KEY = "responsiveSession";
const DNR_RULE_ID = 1;
const HARNESS_MARKER = "responsive.html";

function dnrRule(tabId) {
  return {
    id: DNR_RULE_ID,
    priority: 1,
    condition: { tabIds: [tabId], resourceTypes: ["sub_frame"] },
    action: {
      type: "modifyHeaders",
      responseHeaders: [
        { header: "X-Frame-Options", operation: "remove" },
        { header: "Content-Security-Policy", operation: "remove" },
      ],
    },
  };
}

async function removeDnrRule() {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [DNR_RULE_ID] });
  } catch {}
}

async function loadSession() {
  const stored = await chrome.storage.local.get(SESSION_KEY);
  const s = stored[SESSION_KEY];
  if (!s) return null;
  try {
    await chrome.windows.get(s.windowId);
    await chrome.tabs.get(s.tabId);
    return s;
  } catch {
    return null; // the user closed the harness window
  }
}

async function probeFrames(tabId) {
  const inj = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => ({ href: location.href, w: innerWidth, h: innerHeight, touch: navigator.maxTouchPoints }),
  });
  return inj
    .filter((r) => r.result && !String(r.result.href).includes(HARNESS_MARKER))
    .map((r) => ({ frameId: r.frameId, ...r.result }));
}

async function assertFrames(tabId, viewports) {
  const deadline = Date.now() + 8000;
  for (;;) {
    let frames = [];
    try {
      frames = await probeFrames(tabId);
    } catch {}
    const found = viewports.map((v) => {
      const f = frames.find((fr) => fr.w === v.width && fr.h === v.height);
      return f ? { ...v, mode: "iframe", pageWidth: f.w, pageHeight: f.h, touch: f.touch, frameId: f.frameId } : null;
    });
    if (found.every(Boolean)) return found;
    if (Date.now() > deadline) {
      return viewports.map((v, i) => found[i] || { ...v, mode: "failed" });
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function openFallbackWindow(url, v, taskName) {
  // Top-level navigation: framing rules don't apply. The Emulation override
  // pins the page viewport to exactly width×height even though Chrome clamps
  // the window to its own minimum size.
  const win = await chrome.windows.create({ url, width: v.width, height: v.height + 130, focused: false });
  const ftab = win.tabs?.[0];
  if (!ftab) throw new Error("window was created but Chrome returned no tab");
  await ensureTaskGroup(ftab.id, taskName);
  await ensureAttached(ftab.id);
  await send(ftab.id, "Emulation.setDeviceMetricsOverride", {
    width: v.width,
    height: v.height,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await send(ftab.id, "Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  return { windowId: win.id, tabId: ftab.id };
}

export async function setViewport({ viewports, url, tabId } = {}) {
  if (!viewports?.length) {
    const s = await loadSession();
    await removeDnrRule();
    if (!s) return { text: "no responsive view is open (it may have been closed already)" };
    for (const f of s.fallbacks || []) {
      try {
        await chrome.windows.remove(f.windowId);
      } catch {}
    }
    try {
      await chrome.windows.remove(s.windowId);
    } catch {}
    await chrome.storage.local.remove(SESSION_KEY);
    return { text: "closed the responsive view" };
  }

  const vps = viewports.map((v) => ({ width: v.width, height: v.height }));
  const src = await resolveTab(tabId);
  const targetUrl = url || src.url || src.pendingUrl || "about:blank";
  const taskName = (await currentTaskName()) || DEFAULT_TASK;

  let s = await loadSession();
  if (!s) {
    const totalW = vps.reduce((a, v) => a + v.width, 0) + 48 * (vps.length + 1);
    const maxH = Math.max(...vps.map((v) => v.height)) + 90;
    const harnessUrl =
      chrome.runtime.getURL("responsive/responsive.html") +
      `?url=${encodeURIComponent(targetUrl)}&widths=${encodeURIComponent(JSON.stringify(vps))}`;
    const win = await chrome.windows.create({
      url: harnessUrl,
      width: Math.max(totalW, 520),
      height: Math.max(maxH, 420),
      focused: false,
    });
    const htab = win.tabs?.[0];
    if (!htab) throw new Error("window was created but Chrome returned no tab");
    await ensureTaskGroup(htab.id, taskName);
    s = { windowId: win.id, tabId: htab.id, url: targetUrl, viewports: vps, fallbacks: [] };
    await chrome.storage.local.set({ [SESSION_KEY]: s });
  }

  // Frames may be blocked by the site's framing headers; strip them for this
  // tab only (session rule). Also re-scoped on every call in case of reuse.
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [DNR_RULE_ID],
    addRules: [dnrRule(s.tabId)],
  });

  const results = await assertFrames(s.tabId, vps);

  // Fallback: any viewport whose frame didn't render gets its own emulated
  // top-level window — framing rules can't block a top-level navigation.
  for (const r of results) {
    if (r.mode !== "failed") continue;
    const fb = await openFallbackWindow(s.url, r, taskName);
    s.fallbacks = s.fallbacks || [];
    s.fallbacks.push({ windowId: fb.windowId, tabId: fb.tabId, width: r.width, height: r.height });
    r.mode = "emulated window";
    r.tabId = fb.tabId;
    r.pageWidth = r.width;
    r.pageHeight = r.height;
    r.touch = 5;
  }
  await chrome.storage.local.set({ [SESSION_KEY]: s });

  const lines = results.map(
    (r) => `${r.width}×${r.height} via ${r.mode} — page sees ${r.pageWidth}×${r.pageHeight}, maxTouchPoints=${r.touch}${r.tabId ? ` (tab ${r.tabId})` : ""}`
  );
  return {
    data: { harnessTabId: s.tabId, windowId: s.windowId, results },
    text:
      `responsive view open (${s.url}):\n` +
      lines.join("\n") +
      `\nscreenshot the listed tabIds; pass no viewports to close`,
  };
}
