import { resolveTab } from "./tabs.js";
import { indicator } from "./page.js";
import { withDebugger, send } from "./cdp.js";

const KEY_CODES = {
  enter: [13, "Enter"], tab: [9, "Tab"], escape: [27, "Escape"], esc: [27, "Escape"],
  backspace: [8, "Backspace"], delete: [46, "Delete"], del: [46, "Delete"],
  arrowleft: [37, "ArrowLeft"], left: [37, "ArrowLeft"],
  arrowup: [38, "ArrowUp"], up: [38, "ArrowUp"],
  arrowright: [39, "ArrowRight"], right: [39, "ArrowRight"],
  arrowdown: [40, "ArrowDown"], down: [40, "ArrowDown"],
  home: [36, "Home"], end: [35, "End"], pageup: [33, "PageUp"], pagedown: [34, "PageDown"],
  " ": [32, "Space"], space: [32, "Space"],
};

const BUTTONS = { left: ["left", 1], right: ["right", 2], middle: ["middle", 4] };

function keySpec(name) {
  const parts = String(name).split("+");
  let modifiers = 0;
  for (let i = 0; i < parts.length - 1; i++) {
    const m = parts[i].toLowerCase();
    if (m === "alt") modifiers |= 1;
    else if (m === "ctrl" || m === "control") modifiers |= 2;
    else if (m === "meta" || m === "cmd" || m === "command") modifiers |= 4;
    else if (m === "shift") modifiers |= 8;
    else throw new Error(`unknown key modifier "${parts[i]}" in "${name}"`);
  }
  const keyName = parts[parts.length - 1];
  let vk, code, key = keyName;
  const lower = keyName.toLowerCase();
  if (KEY_CODES[lower] !== undefined || KEY_CODES[keyName] !== undefined) {
    [vk, code] = KEY_CODES[lower] ?? KEY_CODES[keyName];
    if (code === "Space") key = " ";
  } else if (/^f([1-9]|1[0-2])$/.test(lower)) {
    const n = Number(lower.slice(1));
    vk = 111 + n;
    code = "F" + n;
    key = code;
  } else if (keyName.length === 1) {
    const upper = keyName.toUpperCase();
    vk = upper.charCodeAt(0);
    code = /[a-z]/i.test(keyName) ? "Key" + upper : /[0-9]/.test(keyName) ? "Digit" + keyName : keyName;
  } else {
    // Unknown named key: send it raw and let the page decide.
    vk = 0;
    code = keyName;
  }
  return { key, code, windowsVirtualKeyCode: vk, modifiers, text: keyName.length === 1 ? keyName : undefined };
}

function readPngDimensions(b64) {
  try {
    // PNG IHDR: width/height are big-endian uint32 at offsets 16 and 20.
    const bin = atob(b64.slice(0, 40));
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const dv = new DataView(u8.buffer);
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  } catch {
    return null;
  }
}

export async function computer(params) {
  const { action } = params;
  const tab = await resolveTab(params.tabId, params.sessionToken);

  if (action !== "screenshot" && action !== "wait") {
    // Visual "an agent is acting here" feedback, best-effort.
    indicator(tab.id, {
      op: action === "type" || action === "key" ? "focus" : "move",
      x: params.x,
      y: params.y,
    });
  }

  if (action === "screenshot") {
    return withDebugger(tab.id, async (tabId) => {
      const shot = await send(tabId, "Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: !!params.fullPage,
      });
      const dims = readPngDimensions(shot.data);
      return {
        image: { data: shot.data, mimeType: "image/png" },
        text: `screenshot of tab ${tabId}${dims ? ` (${dims.width}x${dims.height})` : ""}${params.fullPage ? " (full page)" : " (viewport)"}`,
      };
    });
  }

  if (action === "wait") {
    const ms = params.ms ?? 1000;
    await new Promise((r) => setTimeout(r, ms));
    return { text: `waited ${ms}ms` };
  }

  // CDP mouse input only reaches the tab that is active in its window: an
  // inactive tab's widget is hidden, so the event ack stalls for seconds and a
  // wheel event never returns. With several tasks (and agents) sharing one
  // window that is the normal case, so activate first. This changes which tab
  // the agent window shows — never which window has focus.
  if (!tab.active && action !== "type" && action !== "key") {
    await chrome.tabs.update(tab.id, { active: true });
  }

  return withDebugger(tab.id, async (tabId) => {
    switch (action) {
      case "left_click":
      case "right_click":
      case "middle_click":
      case "double_click":
      case "triple_click": {
        const x = params.x ?? 0;
        const y = params.y ?? 0;
        const [button, btnBits] = BUTTONS[action === "left_click" ? "left" : action === "right_click" ? "right" : "middle"];
        const clicks = action === "double_click" ? 2 : action === "triple_click" ? 3 : 1;
        await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        for (let i = 1; i <= clicks; i++) {
          await send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons: btnBits, clickCount: i });
          await send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount: i });
        }
        return { text: `${action} at (${x}, ${y}) in tab ${tabId}` };
      }
      case "type": {
        if (!params.text) throw new Error('computer "type" requires text');
        await send(tabId, "Input.insertText", { text: params.text });
        return { text: `typed ${params.text.length} chars into tab ${tabId}` };
      }
      case "key": {
        if (!params.key) throw new Error('computer "key" requires key (e.g. "Enter", "Control+a")');
        const spec = keySpec(params.key);
        const base = {
          key: spec.key, code: spec.code,
          windowsVirtualKeyCode: spec.windowsVirtualKeyCode, nativeVirtualKeyCode: spec.windowsVirtualKeyCode,
          modifiers: spec.modifiers,
        };
        await send(tabId, "Input.dispatchKeyEvent", { type: spec.text ? "keyDown" : "rawKeyDown", ...base, text: spec.text });
        await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
        return { text: `pressed ${params.key}` };
      }
      case "scroll": {
        const dx = params.dx ?? 0;
        const dy = params.dy ?? 0;
        let x = params.x, y = params.y;
        if (x == null || y == null) {
          const metrics = await send(tabId, "Page.getLayoutMetrics");
          const vp = metrics.cssLayoutViewport || metrics.layoutViewport || {};
          x = x ?? Math.floor((vp.clientWidth || 800) / 2);
          y = y ?? Math.floor((vp.clientHeight || 600) / 2);
        }
        await send(tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: dx, deltaY: dy });
        return { text: `scrolled (${dx}, ${dy}) at (${x}, ${y})` };
      }
      case "mouse_move": {
        const x = params.x ?? 0;
        const y = params.y ?? 0;
        await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        return { text: `mouse moved to (${x}, ${y})` };
      }
      default:
        throw new Error(`unknown computer action "${action}"`);
    }
  });
}
