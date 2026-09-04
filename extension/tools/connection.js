/**
 * WebSocket connection to the local daemon (the extension dials in as a
 * client). Reconnects with backoff; a 1-minute alarm covers service-worker
 * restarts.
 */
import { ATTACHED, dropTabState } from "./cdp.js";

const DEFAULTS = { port: 9377, token: "" };

let ws = null;
let backoff = 1000;
let dispatchTool = null;
let version = "0.0.0";
let connected = false;

function broadcastStatus() {
  chrome.runtime.sendMessage({ type: "taskwindow:status", connected }).catch(() => {});
}

async function settings() {
  const stored = await chrome.storage.local.get(["port", "token"]);
  return {
    port: Number(stored.port) || DEFAULTS.port,
    token: stored.token || DEFAULTS.token,
  };
}

async function handleToolCall(msg) {
  let result = null;
  let ok = true;
  try {
    result = await dispatchTool(msg.tool, msg.params);
  } catch (err) {
    ok = false;
    result = { error: err?.message || String(err) };
  }
  const payload = { type: "tool_result", id: msg.id, ok };
  if (ok) {
    payload.result = result ?? {};
  } else {
    payload.error = result.error;
  }
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function scheduleReconnect() {
  setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, 30_000);
}

export function connectWs({ version: v, dispatchTool: dispatch } = {}) {
  dispatchTool = dispatch;
  version = v;

  chrome.alarms.create("taskwindow-reconnect", { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "taskwindow-reconnect" && (!ws || ws.readyState === WebSocket.CLOSED)) connect();
  });

  chrome.tabs.onRemoved.addListener((tabId) => dropTabState(tabId));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.token || changes.port)) {
      if (ws) try { ws.close(); } catch {}
    }
  });

  connect();
}

export function isConnected() {
  return connected;
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  const { port, token } = await settings();
  if (!token) {
    connected = false;
    broadcastStatus();
    scheduleReconnect(); // unconfigured: keep polling so we connect the moment settings are saved
    return;
  }

  let socket;
  try {
    socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
  } catch {
    scheduleReconnect();
    return;
  }
  ws = socket; // the active socket; handlers below close over their own `socket`

  socket.onopen = () => {
    backoff = 1000;
    connected = true;
    broadcastStatus();
    socket.send(
      JSON.stringify({
        type: "hello",
        protocol: 1,
        version,
        userAgent: navigator.userAgent,
        attachedTabs: [...ATTACHED],
      })
    );
  };

  socket.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === "tool_call") handleToolCall(msg);
  };

  socket.onclose = () => {
    if (ws === socket) ws = null;
    if (connected) {
      connected = false;
      broadcastStatus();
    }
    scheduleReconnect();
  };

  socket.onerror = () => {
    try {
      socket.close();
    } catch {}
  };
}
