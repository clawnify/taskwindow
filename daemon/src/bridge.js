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
export class Bridge {
  constructor({ token, logger = console }) {
    this.token = token;
    this.logger = logger;
    this.ext = null; // active extension WebSocket
    this.pending = new Map(); // tool_call id -> {resolve, reject, timer}
    this.lastHello = null;
    this.wss = null;
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

    // Ping to keep the MV3 service worker alive and detect dead peers.
    this.pingTimer = setInterval(() => {
      if (this.ext && this.ext.readyState === 0 /* CONNECTING */) return;
      for (const client of this.wss.clients) {
        if (client.readyState === 1 /* OPEN */) client.ping();
      }
    }, 25_000);
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
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`TaskWindow extension did not answer "${tool}" within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, tool });
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
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(msg.id);
        if (msg.ok) entry.resolve(msg.result ?? {});
        else entry.reject(new Error(msg.error || `extension tool "${entry.tool}" failed`));
        break;
      }
      default:
        break;
    }
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
