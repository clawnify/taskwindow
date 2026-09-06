import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";

const PROTOCOL_VERSION = 1;

/**
 * Bridges MCP tool calls to the TaskWindow Chrome extension over WebSocket.
 *
 * The extension dials in as a WS client (ws://127.0.0.1:<port>/ws?token=...);
 * tool calls go out as {type:"tool_call", id, tool, params} and come back as
 * {type:"tool_result", id, ok, ...}. Token is checked at handshake time.
 */
const SLOW_ANSWER_MS = 5_000; // log tool calls the extension took longer than this
const EXPIRED_TTL_MS = 10 * 60_000; // how long a timed-out call is remembered, to name a late answer

export class Bridge {
  /**
   * `pingIntervalMs` / `silenceMs`: the extension sends an application-level
   * ping every 20s, so 65s without any message from it means its end of the
   * socket is dead (a laptop sleep can leave it half-open, readyState still
   * OPEN) — tests shrink both.
   */
  constructor({ token, logger = console, pingIntervalMs = 25_000, silenceMs = 65_000 }) {
    this.token = token;
    this.logger = logger;
    this.ext = null; // active extension WebSocket
    this.pending = new Map(); // tool_call id -> {resolve, reject, timer, tool, sentAt}
    this.expired = new Map(); // tool_call id -> {tool, sentAt, timeoutMs}: timed out, answer may still come
    this.lastHello = null;
    this.lastExtMessage = 0;
    this.wss = null;
    this.pingIntervalMs = pingIntervalMs;
    this.silenceMs = silenceMs;
  }

  start(httpServer) {
    this.wss = new WebSocketServer({ server: httpServer, path: "/ws" });

    this.wss.on("connection", (ws, req) => {
      const url = new URL(req.url, "http://localhost");
      const token = url.searchParams.get("token");
      if (token !== this.token) {
        ws.close(4401, "invalid or missing token");
        return;
      }

      // Single active extension connection: newest wins.
      if (this.ext && this.ext !== ws) {
        this.logger.log("[bridge] replacing existing extension connection");
        try {
          this.ext.close(4000, "superseded by a new extension connection");
        } catch {}
      }
      this.ext = ws;
      this.lastExtMessage = Date.now();

      ws.on("message", (raw) => this.#onMessage(ws, raw));
      ws.on("close", () => {
        if (this.ext === ws) {
          this.ext = null;
          this.lastHello = null;
          this.logger.log("[bridge] extension disconnected");
        }
        this.#failAllPending(new Error("TaskWindow extension disconnected"));
      });
      ws.on("error", () => {});
    });

    // Ping to keep the MV3 service worker alive, and drop a socket whose
    // extension has gone silent: otherwise `connected` stays true, every tool
    // call waits out its full timeout, and status reports a healthy extension
    // while the popover says "not connected".
    this.pingTimer = setInterval(() => {
      if (this.ext && this.ext.readyState === 0 /* CONNECTING */) return;
      if (this.ext && this.ext.readyState === 1 && Date.now() - this.lastExtMessage > this.silenceMs) {
        this.logger.log(
          `[bridge] extension silent for ${Math.round((Date.now() - this.lastExtMessage) / 1000)}s — dropping the stale connection`
        );
        try {
          this.ext.terminate();
        } catch {}
        return;
      }
      for (const client of this.wss.clients) {
        if (client.readyState === 1 /* OPEN */) client.ping();
      }
    }, this.pingIntervalMs);
  }

  stop() {
    clearInterval(this.pingTimer);
    this.#failAllPending(new Error("daemon shutting down"));
    if (this.ext) try { this.ext.close(); } catch {}
    if (this.wss) try { this.wss.close(); } catch {}
  }

  get connected() {
    return !!this.ext && this.ext.readyState === 1 /* OPEN */;
  }

  /**
   * Send a tool call to the extension and await its result.
   * Returns the extension's result object ({text?, image?, data?}).
   */
  sendTool(tool, params, timeoutMs = 30_000) {
    if (!this.connected) {
      return Promise.reject(
        new Error(
          "TaskWindow extension is not connected. Open Chrome with the extension enabled (check its options page shows Connected)."
        )
      );
    }
    const id = randomUUID();
    const sentAt = Date.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        for (const [k, v] of this.expired) if (Date.now() - v.sentAt > EXPIRED_TTL_MS) this.expired.delete(k);
        this.expired.set(id, { tool, sentAt, timeoutMs });
        const err = new Error(`TaskWindow extension did not answer "${tool}" within ${Math.round(timeoutMs / 1000)}s`);
        err.code = "TIMEOUT";
        reject(err);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, tool, sentAt });
      this.ext.send(JSON.stringify({ type: "tool_call", id, tool, params }));
    });
  }

  #onMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (ws === this.ext) this.lastExtMessage = Date.now();
    switch (msg.type) {
      case "hello":
        this.lastHello = msg;
        this.logger.log(`[bridge] extension connected (protocol ${msg.protocol}, ${msg.version || "?"}, ${msg.userAgent || "unknown chrome"})`);
        break;
      case "ping":
        ws.send(JSON.stringify({ type: "pong" }));
        break;
      case "pong":
        break;
      case "tool_result": {
        const entry = this.pending.get(msg.id);
        if (!entry) {
          // The extension did the work; nobody is waiting any more. Say so —
          // "did not answer" alone reads as a dead extension, and the tab or
          // click this answer describes really happened.
          const late = this.expired.get(msg.id);
          if (late) {
            this.expired.delete(msg.id);
            this.logger.log(
              `[bridge] ${late.tool} answered ${((Date.now() - late.sentAt) / 1000).toFixed(1)}s after it was sent — ` +
                `past its ${Math.round(late.timeoutMs / 1000)}s timeout, so the caller already got an error${this.#timing(msg)}`
            );
          }
          return;
        }
        clearTimeout(entry.timer);
        this.pending.delete(msg.id);
        const elapsed = Date.now() - entry.sentAt;
        if (elapsed > SLOW_ANSWER_MS) {
          this.logger.log(`[bridge] ${entry.tool} answered after ${(elapsed / 1000).toFixed(1)}s${this.#timing(msg)}`);
        }
        if (msg.ok) entry.resolve(msg.result ?? {});
        else entry.reject(new Error(msg.error || `extension tool "${entry.tool}" failed`));
        break;
      }
      default:
        break;
    }
  }

  /** Per-phase timing a handler reported (tabs_create does), for the slow/late log lines. */
  #timing(msg) {
    const timing = msg.result?.data?.timing;
    if (!timing || typeof timing !== "object") return "";
    const parts = Object.entries(timing).map(([k, v]) => `${k.replace(/Ms$/, "")} ${(v / 1000).toFixed(1)}s`);
    return parts.length ? ` (${parts.join(", ")})` : "";
  }

  #failAllPending(err) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }
}

export { PROTOCOL_VERSION };
