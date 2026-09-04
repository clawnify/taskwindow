#!/usr/bin/env node
import http from "node:http";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { Bridge } from "./bridge.js";
import { createMcpRequestHandler } from "./mcp-http.js";
import { installService, uninstallService } from "./service.js";

// `taskwindow install|uninstall` manage the login service, then exit.
if (process.argv[2] === "install") {
  installService(fileURLToPath(new URL("./index.js", import.meta.url)));
  process.exit(0);
}
if (process.argv[2] === "uninstall") {
  uninstallService();
  process.exit(0);
}

const config = loadConfig();
const bridge = new Bridge({ token: config.token });
const handleMcp = createMcpRequestHandler({ bridge });

// One-time pairing: the daemon prints a short code at startup; the extension
// exchanges it for the real token via POST /pair (loopback-only). This defends
// the pairing endpoint against other local user accounts; a same-user process
// could read the token file directly, so the code adds no obstacle there.
const PAIR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const pairCode = Array.from(randomBytes(6))
  .map((b) => PAIR_ALPHABET[b % PAIR_ALPHABET.length])
  .join("");
const pairFailures = []; // timestamps of failed attempts, rolling window
const PAIR_WINDOW_MS = 60_000;
const PAIR_MAX_FAILURES = 5;

function pairRateLimited() {
  const cutoff = Date.now() - PAIR_WINDOW_MS;
  while (pairFailures.length > 0 && pairFailures[0] < cutoff) pairFailures.shift();
  return pairFailures.length >= PAIR_MAX_FAILURES;
}

const BODY_LIMIT = 50 * 1024 * 1024; // file_upload transfers bytes through the daemon

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${config.port}`);

  if (url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      version: "0.1.0",
      extensionConnected: bridge.connected,
      port: config.port,
    });
    return;
  }

  if (url.pathname === "/pair") {
    if (pairRateLimited()) {
      sendJson(res, 429, { error: "too many failed pairing attempts; wait a minute" });
      return;
    }
    let body;
    try {
      body = JSON.parse((await readBody(req)).toString("utf8"));
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }
    const code = String(body?.code || "").trim().toUpperCase();
    if (code !== pairCode) {
      pairFailures.push(Date.now());
      sendJson(res, 403, { error: "invalid pairing code" });
      return;
    }
    sendJson(res, 200, { token: config.token });
    return;
  }

  if (url.pathname === "/mcp") {
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${config.token}`) {
      sendJson(res, 401, { error: "invalid or missing bearer token" });
      return;
    }

    if (req.method !== "POST") {
      // Stateless mode: no SSE streams, no sessions to terminate.
      res.setHeader("allow", "POST");
      sendJson(res, 405, { error: "method not allowed; POST JSON-RPC to /mcp" });
      return;
    }

    try {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        sendJson(res, 400, { error: "invalid JSON body" });
        return;
      }
      await handleMcp(req, res, body);
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
      else res.end();
    }
    return;
  }

  sendJson(res, 404, { error: "not found" });
});

bridge.start(server);

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[taskwindow] port ${config.port} is already in use — is another daemon running? (TASKWINDOW_PORT to change)`);
    process.exit(1);
  }
  console.error(`[taskwindow] server error:`, err);
});

server.listen(config.port, "127.0.0.1", () => {
  console.log(`[taskwindow] daemon listening on http://127.0.0.1:${config.port}`);
  console.log(`[taskwindow] MCP endpoint: http://127.0.0.1:${config.port}/mcp`);
  console.log(`[taskwindow] pairing code: ${pairCode} — enter it in the TaskWindow extension options to connect (valid while this daemon runs)`);
  console.log(`[taskwindow] your MCP client config: endpoint http://127.0.0.1:${config.port}/mcp, header "Authorization: Bearer ${config.token}"`);
  console.log(`[taskwindow] claude code: claude mcp add taskwindow --transport http http://127.0.0.1:${config.port}/mcp --header "Authorization: Bearer ${config.token}"`);
  console.log(`[taskwindow] waiting for the TaskWindow extension to connect on ws://127.0.0.1:${config.port}/ws`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`\n[taskwindow] ${sig} received, shutting down`);
    bridge.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
