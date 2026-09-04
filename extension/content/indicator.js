/**
 * Visual "an agent is acting here" feedback: a phantom cursor that glides to
 * each interaction point and a pulsing inset glow, mirroring the reference
 * extension's layer. Both elements are pointer-events:none at max z-index;
 * the pulse respects prefers-reduced-motion. Injected on demand, top frame.
 */
(() => {
  if (globalThis.__agentTabIndicator) return;
  globalThis.__agentTabIndicator = true;

  const CURSOR_SVG = `<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path d="M5 3l14 8.5-6.2 1.4L16 19.5 13 21l-3.2-6.6L5 18.6z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/>
  </svg>`;

  let cursor = null;
  let glow = null;
  let style = null;
  let hideTimer = null;

  function ensure() {
    if (cursor) return;
    style = document.createElement("style");
    style.id = "taskwindow-indicator-styles";
    style.textContent = `
      @keyframes taskwindow-pulse { 0%,100% { opacity:.5 } 50% { opacity:1 } }
      #taskwindow-glow-inner { animation: taskwindow-pulse 2s ease-in-out infinite; }
      @media (prefers-reduced-motion: reduce) { #taskwindow-glow-inner { animation: none; } }
    `;
    document.documentElement.appendChild(style);

    glow = document.createElement("div");
    glow.id = "taskwindow-glow";
    glow.setAttribute("aria-hidden", "true");
    glow.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483646;opacity:0;transition:opacity 300ms;";
    glow.innerHTML = `<div id="taskwindow-glow-inner" style="position:absolute;inset:0;box-shadow: inset 0 0 25px rgba(37,99,235,.5), inset 0 0 60px rgba(37,99,235,.25);"></div>`;
    document.documentElement.appendChild(glow);

    cursor = document.createElement("div");
    cursor.id = "taskwindow-cursor";
    cursor.setAttribute("aria-hidden", "true");
    cursor.style.cssText =
      "position:fixed;top:0;left:0;pointer-events:none;z-index:2147483646;opacity:0;" +
      "transform:translate3d(-100px,-100px,0);transition:transform 180ms cubic-bezier(.2,0,0,1),opacity 200ms;";
    cursor.innerHTML = CURSOR_SVG;
    document.documentElement.appendChild(cursor);
  }

  function showGlow(ms = 1600) {
    glow.style.opacity = "1";
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      glow.style.opacity = "0";
      cursor.style.opacity = "0";
    }, ms);
  }

  function moveTo(x, y) {
    ensure();
    cursor.style.opacity = "1";
    cursor.style.transform = `translate3d(${x - 2}px, ${y - 2}px, 0)`;
    showGlow();
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== "taskwindow:indicator") return;
    try {
      if (msg.op === "move" && typeof msg.x === "number" && typeof msg.y === "number") {
        moveTo(msg.x, msg.y);
      } else if (msg.op === "focus") {
        ensure();
        showGlow(1200);
      } else if (msg.op === "hide") {
        if (glow) glow.style.opacity = "0";
        if (cursor) cursor.style.opacity = "0";
      }
    } catch {}
    // no async response; let the ax-tree listener own the response channel
  });
})();
