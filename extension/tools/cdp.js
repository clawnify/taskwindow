/**
 * Shared low-level chrome.debugger (CDP) helpers plus per-tab console/network
 * capture buffers.
 *
 * Ordinary attachments are released when tool calls go quiet. Tabs that need
 * ongoing rendering or viewport emulation retain theirs until closed.
 */

export const ATTACHED = new Set();
/** Tabs kept painting by keepRendering; the screencast ends with the attachment. */
const RENDERING = new Set();
const RETAINED = new Set();
const attaching = new Map();
const detaching = new Map();
// Runtime/Log.enable replay cached entries when a tab reconnects. Suppress only
// copies of entries already captured, while those domains are being enabled.
const replaying = new Map();

const BUFFER_CAP = 500;
/** tabId -> { console: [], network: Map(requestId -> entry), networkOrder: [] } */
const buffers = new Map();

function buf(tabId) {
  let b = buffers.get(tabId);
  if (!b) {
    b = { console: [], network: new Map(), networkOrder: [] };
    buffers.set(tabId, b);
  }
  return b;
}

export function getBuffers(tabId) {
  return buf(tabId);
}

export function dropTabState(tabId) {
  ATTACHED.delete(tabId);
  RENDERING.delete(tabId);
  RETAINED.delete(tabId);
  buffers.delete(tabId);
}

/** Keep CDP state (rendering or viewport emulation) alive between tool calls. */
export function retainDebugger(tabId) {
  RETAINED.add(tabId);
}

function clearAttachment(tabId) {
  ATTACHED.delete(tabId);
  RENDERING.delete(tabId);
  RETAINED.delete(tabId);
  chrome.tabs.sendMessage(tabId, { type: "taskwindow:indicator", op: "hide" }).catch(() => {});
}

/** Called only with no tools running. Returns true if a failed detach needs retrying. */
export async function detachIdleDebuggers() {
  const results = await Promise.allSettled([...ATTACHED].filter((id) => !RETAINED.has(id)).map(async (tabId) => {
    if (detaching.has(tabId)) return detaching.get(tabId);
    const pending = chrome.debugger.detach({ tabId }).then(() => clearAttachment(tabId));
    detaching.set(tabId, pending);
    try {
      await pending;
    } finally {
      detaching.delete(tabId);
    }
  }));
  return results.some((r) => r.status === "rejected");
}

function levelOf(consoleType) {
  switch (consoleType) {
    case "error": return "error";
    case "warning": return "warning";
    case "info": case "log": case "debug": case "dir": case "table": case "trace":
      return consoleType === "debug" || consoleType === "trace" ? "log" : "info";
    default: return "log";
  }
}

function argPreview(arg) {
  if (!arg || typeof arg !== "object") return String(arg);
  switch (arg.type) {
    case "string": return arg.value ?? "";
    case "number": case "boolean": case "undefined": case "symbol": case "bigint":
      return String(arg.value);
    case "function": return "ƒ ()";
    case "object": {
      if (arg.subtype === "null") return "null";
      if (arg.subtype === "regexp") return arg.value?.description || "/.../";
      const preview = arg.preview;
      if (preview) {
        const props = preview.properties
          .slice(0, 12)
          .map((p) => `${p.name}: ${p.value ?? ""}`)
          .join(", ");
        return preview.overflow ? `{${props}, …}` : `{${props}}`;
      }
      return "{…}";
    }
    default: return String(arg.value ?? "");
  }
}

function recordConsole(tabId, b, entry) {
  const replay = replaying.get(tabId);
  if (replay) {
    const key = JSON.stringify(entry);
    const count = replay.get(key) || 0;
    if (count) {
      replay.set(key, count - 1);
      return;
    }
  }
  b.console.push(entry);
  if (b.console.length > BUFFER_CAP) b.console.splice(0, b.console.length - BUFFER_CAP);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source?.tabId;
  if (tabId == null) return;
  const b = buf(tabId);

  switch (method) {
    case "Runtime.consoleAPICalled": {
      recordConsole(tabId, b, {
        ts: params.timestamp || Date.now(),
        level: levelOf(params.type),
        text: (params.args || []).map(argPreview).join(" "),
        url: params.stackTrace?.[0]?.url || "",
      });
      break;
    }
    case "Log.entryAdded": {
      const e = params.entry || {};
      recordConsole(tabId, b, {
        ts: e.timestamp || Date.now(),
        level: e.level === "warning" ? "warning" : e.level === "error" ? "error" : "log",
        text: e.text || "",
        url: e.url || "",
      });
      break;
    }
    case "Runtime.exceptionThrown": {
      const details = params.exceptionDetails || {};
      recordConsole(tabId, b, {
        ts: params.timestamp || Date.now(),
        level: "error",
        text: details.exception?.description || details.text || "Uncaught exception",
        url: details.url || "",
      });
      break;
    }
    case "Network.requestWillBeSent": {
      const entry = {
        requestId: params.requestId,
        method: params.request.method,
        url: params.request.url,
        type: params.type || "",
        ts: params.timestamp || Date.now(),
      };
      b.network.set(params.requestId, entry);
      b.networkOrder.push(params.requestId);
      if (b.networkOrder.length > BUFFER_CAP) {
        const dropped = b.networkOrder.splice(0, b.networkOrder.length - BUFFER_CAP);
        for (const id of dropped) b.network.delete(id);
      }
      break;
    }
    case "Network.responseReceived": {
      const entry = b.network.get(params.requestId);
      if (entry) {
        entry.status = params.response.status;
        entry.mimeType = params.response.mimeType;
      }
      break;
    }
    case "Network.loadingFailed": {
      const entry = b.network.get(params.requestId);
      if (entry) entry.error = params.errorText;
      break;
    }
    default:
      break;
  }
});

chrome.debugger.onDetach.addListener((source) => {
  const tabId = source?.tabId;
  if (tabId == null) return;
  // The tab is no longer being driven: take the cursor/glow indicator down
  // (it otherwise stays up so screenshots can show where the mouse is).
  clearAttachment(tabId);
});

export async function ensureAttached(tabId) {
  // A tool can arrive while idle cleanup is detaching this tab. Only this tab
  // waits; other sessions can continue while Chrome answers the detach.
  if (detaching.has(tabId)) await detaching.get(tabId).catch(() => {});
  if (attaching.has(tabId)) return attaching.get(tabId);
  if (ATTACHED.has(tabId)) return;
  const pending = attachAndEnable(tabId);
  attaching.set(tabId, pending);
  try {
    await pending;
  } finally {
    attaching.delete(tabId);
  }
}

async function attachAndEnable(tabId) {
  await chrome.debugger.attach({ tabId }, "1.3");
  ATTACHED.add(tabId);
  const replay = new Map();
  for (const entry of buf(tabId).console) {
    const key = JSON.stringify(entry);
    replay.set(key, (replay.get(key) || 0) + 1);
  }
  replaying.set(tabId, replay);
  // Best-effort domain enables: some pages (e.g. Chrome Web Store) restrict
  // parts of this, but input dispatch and screenshots still work.
  for (const [method, params] of [
    ["Runtime.enable"], ["Log.enable"], ["Page.enable"],
    ["Network.enable", { maxResourceBufferSize: 10_000_000, maxTotalBufferSize: 50_000_000 }],
    // The agent window is deliberately never focused (the user is elsewhere);
    // make the page behave as if it were, as headless-style drivers do.
    ["Emulation.setFocusEmulationEnabled", { enabled: true }],
  ]) {
    try {
      await send(tabId, method, params);
    } catch {}
  }
  replaying.delete(tabId);
}

/**
 * Keep a background tab painting at full rate, as if someone were watching it.
 * Opt-in (the agent asks for it): it costs what a visible tab costs.
 *
 * Focus emulation does not make a background tab render: a page in it paints
 * ~2 frames a second, and nothing before the debugger first attaches, so a
 * page that fetches or draws only once seen shows a skeleton, a blank chart or
 * a stalled animation, and Page.captureScreenshot can hang waiting for a
 * frame. A running screencast counts as a capture, and Chrome keeps a captured
 * tab visible and painting across navigations — without activating the tab or
 * focusing its window (checked in Chrome on openrouter.ai/rankings: 2 fps → 60
 * fps). The frames are never acked, so Chrome sends one tiny frame and stops.
 */
export async function keepRendering(tabId) {
  await ensureAttached(tabId);
  if (RENDERING.has(tabId)) return;
  await send(tabId, "Page.startScreencast", { format: "jpeg", quality: 1, maxWidth: 16, maxHeight: 16 });
  RENDERING.add(tabId);
  retainDebugger(tabId);
}

export async function send(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

export async function withDebugger(tabId, fn) {
  await ensureAttached(tabId);
  return fn(tabId);
}
