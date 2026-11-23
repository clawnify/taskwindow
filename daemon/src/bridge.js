import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";

const PROTOCOL_VERSION = 1;

/**
 * Bridges MCP tool calls to the TaskWindow Chrome extension over WebSocket.
 *
 * The extension dials in as a WS client (ws://127.0.0.1:<port>/ws?token=...);
 * tool calls go out as {type:"tool_call", id, tool, params} and come back as
 * {type:"tool_result", id, ok, ...}. Token is checked at handshake time.
 *
 * One browser at a time, and the connected one keeps its place. Every browser
 * profile with the extension dials the same daemon, and each one redials a
 * second after it loses the connection. When the newest connection always
 * won, two of them took it from each other about once a second, and a tool
 * call landed in whichever browser held it at that instant: an agent's own
 * tabs "did not exist" from one call to the next. So a second connection is
 * refused while the first still answers a ping, and takes over only once it
 * does not (a laptop sleep can leave a dead socket reading OPEN).
 */
const SLOW_ANSWER_MS = 5_000; // log tool calls the extension took longer than this
const EXPIRED_TTL_MS = 10 * 60_000; // how long a timed-out call is remembered, to name a late answer
const REFUSAL_LOG_MS = 5 * 60_000; // a refused browser retries every 30s or so: log it this often, not each time
// A refused browser's extension redials at least once a minute, so one that
// has not tried for this long is gone (closed, or TaskWindow removed from it).
const OTHER_BROWSER_TTL_MS = 3 * 60_000;

export class Bridge {
  /**
   * `pingIntervalMs` / `silenceMs`: the extension sends an application-level
   * ping every 20s, so 65s without any message from it means its end of the
   * socket is dead (a laptop sleep can leave it half-open, readyState still
   * OPEN) — tests shrink both.
   *
   * `probeMs`: how long the connected extension has to answer a ping when
   * another one asks for its place. A live one answers within milliseconds;
   * the wait only runs out on a dead socket.
   */
  constructor({ token, logger = console, pingIntervalMs = 25_000, silenceMs = 65_000, probeMs = 2_000 }) {
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
    this.probeMs = probeMs;
    this.probe = null; // {ws, promise}: a ping to the connected extension that is still out
    this.refused = null; // {count, lastAt, loggedAt}: another browser's attempts while this one answers
  }

  start(httpServer) {
    this.wss = new WebSocketServer({
      server: httpServer,
      path: "/ws",
      verifyClient: (info, done) => this.#admit(info, done),
    });

    this.wss.on("connection", (ws, req) => {
      const url = new URL(req.url, "http://localhost");
      const token = url.searchParams.get("token");
      if (token !== this.token) {
        ws.close(4401, "invalid or missing token");
        return;
      }

      // Only reached with another connection in place when that one did not
      // answer its ping (#admit), or when two dialled in at the same moment.
      if (this.ext && this.ext !== ws) {
        this.logger.log("[bridge] replacing an extension connection that stopped answering");
        // Calls sent to it will not be answered. Failed here, not when its
        // socket finally closes: by then the calls in flight belong to the
        // new connection.
        this.#failAllPending(new Error("TaskWindow extension disconnected"));
        try {
          this.ext.close(4000, "superseded by a new extension connection");
        } catch {}
      }
      this.ext = ws;
      this.lastExtMessage = Date.now();
      // The refusals on record were answered for the previous connection, and
      // the browser now connecting is most likely the one that was refused.
      // Another that is still out there is refused, and recorded, again.
      this.refused = null;

      ws.on("message", (raw) => this.#onMessage(ws, raw));
      ws.on("close", () => {
        if (this.ext !== ws) return; // replaced earlier, see above
        this.ext = null;
        this.lastHello = null;
        this.logger.log("[bridge] extension disconnected");
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
   * Another browser with the extension that keeps asking for the connection
   * and is being refused: {attempts, lastAt}, or null. For status and doctor,
   * so "my tabs opened in the wrong Chrome" has an answer.
   */
  get otherBrowser() {
    if (!this.refused || Date.now() - this.refused.lastAt > OTHER_BROWSER_TTL_MS) return null;
    return { attempts: this.refused.count, lastAt: new Date(this.refused.lastAt).toISOString() };
  }

  /**
   * Decide a new connection during the WebSocket handshake. Refusing here,
   * before the socket opens, matters: the extension resets its retry delay to
   * one second whenever a socket opens, so a connection accepted and then
   * closed would be retried every second for as long as the other browser runs.
   * Refused at the handshake, its delay grows to 30 seconds.
   */
  #admit(info, done) {
    const token = new URL(info.req.url, "http://localhost").searchParams.get("token");
    // A wrong token is let through to be closed with 4401, the code that tells
    // the extension to forget it and pair again.
    if (token !== this.token) return done(true);
    const current = this.ext;
    if (!current || current.readyState !== 1 /* OPEN */) return done(true);
    this.#answers(current).then((alive) => {
      if (!alive) return done(true);
      const now = Date.now();
      const refused = this.refused && now - this.refused.lastAt <= OTHER_BROWSER_TTL_MS ? this.refused : { count: 0, loggedAt: 0 };
      refused.count++;
      refused.lastAt = now;
      if (now - refused.loggedAt >= REFUSAL_LOG_MS) {
        refused.loggedAt = now;
        this.logger.log(
          "[bridge] refused another extension connection: the connected browser still answers, so it keeps its place. " +
            "A second Chrome profile (or a second Chrome) has TaskWindow installed and will keep trying."
        );
      }
      this.refused = refused;
      done(false, 409, "another browser is already connected");
    });
  }

  /** Whether the socket's other end still answers: one ping, a pong within probeMs. */
  #answers(ws) {
    if (this.probe?.ws === ws) return this.probe.promise;
    let settled = false;
    const promise = new Promise((resolve) => {
      const finish = (alive) => {
        settled = true;
        clearTimeout(timer);
        ws.off("pong", onPong);
        ws.off("close", onClose);
        if (this.probe?.ws === ws) this.probe = null;
        resolve(alive);
      };
      const onPong = () => finish(true);
      const onClose = () => finish(false);
      const timer = setTimeout(() => finish(false), this.probeMs);
      ws.on("pong", onPong);
      ws.on("close", onClose);
      try {
        ws.ping();
      } catch {
        finish(false); // closed between the check and the ping
      }
    });
    if (!settled) this.probe = { ws, promise }; // attempts that arrive together share one ping
    return promise;
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
