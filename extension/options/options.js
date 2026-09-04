const $ = (id) => document.getElementById(id);

function renderStatus(connected) {
  $("dot").className = `dot ${connected ? "on" : "off"}`;
  $("status").textContent = connected
    ? "Connected to the daemon — MCP clients can drive this browser."
    : "Not connected. Is the daemon running, and does the token below match it?";
}

async function loadShortcuts() {
  const store = await chrome.storage.local.get("shortcuts");
  if (!store.shortcuts) {
    // Seed defaults (same as tools/shortcuts.js does on first use).
    const defaults = {
      screenshot: {
        description: "Screenshot the active tab",
        actions: [{ tool: "computer", params: { action: "screenshot" } }],
      },
      page_text: {
        description: "Extract the active tab's visible text",
        actions: [{ tool: "get_page_text", params: {} }],
      },
    };
    await chrome.storage.local.set({ shortcuts: defaults });
    return defaults;
  }
  return store.shortcuts;
}

async function init() {
  const { token = "", port = 9377, allowAllTabs = false, separateWindow = true } = await chrome.storage.local.get([
    "token", "port", "allowAllTabs", "separateWindow",
  ]);
  $("token").value = token;
  $("port").value = port;
  $("allowAllTabs").checked = allowAllTabs === true;
  $("separateWindow").checked = separateWindow !== false;

  try {
    const res = await chrome.runtime.sendMessage({ type: "taskwindow:getStatus" });
    renderStatus(res?.connected === true);
  } catch {
    renderStatus(false);
  }

  const registry = await loadShortcuts();
  $("shortcuts").value = JSON.stringify(registry, null, 2);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "taskwindow:status") renderStatus(msg.connected === true);
});

$("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    token: $("token").value.trim(),
    port: Number($("port").value) || 9377,
    allowAllTabs: $("allowAllTabs").checked,
    separateWindow: $("separateWindow").checked,
  });
  $("saved").textContent = "saved ✓";
  setTimeout(() => ($("saved").textContent = ""), 2000);
});

$("save-shortcuts").addEventListener("click", async () => {
  try {
    const parsed = JSON.parse($("shortcuts").value);
    if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("must be a JSON object");
    for (const [name, sc] of Object.entries(parsed)) {
      if (!sc || !Array.isArray(sc.actions)) throw new Error(`"${name}" needs an actions array`);
      for (const a of sc.actions) {
        if (!a || typeof a.tool !== "string") throw new Error(`"${name}" has an action without a tool`);
      }
    }
    await chrome.storage.local.set({ shortcuts: parsed });
    $("saved-shortcuts").textContent = "saved ✓";
  } catch (err) {
    $("saved-shortcuts").textContent = `✗ ${err.message}`;
  }
  setTimeout(() => ($("saved-shortcuts").textContent = ""), 4000);
});

init();
