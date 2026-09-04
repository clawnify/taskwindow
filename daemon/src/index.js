#!/usr/bin/env node
import http from "node:http";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { Bridge } from "./bridge.js";
import { createMcpRequestHandler } from "./mcp-http.js";
import { installService, uninstallService, installExtension } from "./service.js";
import { createRequire } from "node:module";

const { version: VERSION } = createRequire(import.meta.url)("../package.json");
import { registerClaude, registerCursor, registerOpenCode, unregisterAgents } from "./agents.js";
import { clearLine, cursorTo, emitKeypressEvents, moveCursor } from "node:readline";

// One-time pairing: the daemon prints a short code at startup; the extension
// exchanges it for the real token via POST /pair (loopback-only). This defends
// the pairing endpoint against other local user accounts; a same-user process
// could read the token file directly, so the code adds no obstacle there.
const PAIR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const pairCode = Array.from(randomBytes(6))
  .map((b) => PAIR_ALPHABET[b % PAIR_ALPHABET.length])
  .join("");

// `taskwindow install` manages the login service and offers to register the
// MCP server with one or more coding agents. Component-only installs do not
// reopen the interactive picker.
const args = process.argv.slice(2);
const verb = args[0];
const flags = args.slice(1);

const AGENT_CHOICES = [
  ["Claude Code", registerClaude],
  ["Cursor", registerCursor],
  ["OpenCode", registerOpenCode],
];

function selectCodingAgents() {
  const choices = [...AGENT_CHOICES.map(([label]) => label), "None (set up later)"];
  const noneIndex = choices.length - 1;
  const selected = new Set([noneIndex]);
  let focused = 0;
  let rendered = false;

  emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  const wasPaused = process.stdin.isPaused();
  process.stdin.setRawMode(true);
  process.stdin.resume();

  const render = () => {
    if (rendered) moveCursor(process.stdout, 0, -choices.length);
    for (const [index, label] of choices.entries()) {
      cursorTo(process.stdout, 0);
      clearLine(process.stdout, 0);
      const pointer = index === focused ? ">" : " ";
      const checkbox = selected.has(index) ? "[x]" : "[ ]";
      process.stdout.write(`${pointer} ${checkbox} ${label}\n`);
    }
    rendered = true;
  };

  return new Promise((resolve) => {
    const finish = () => {
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode(wasRaw);
      if (wasPaused) process.stdin.pause();
      resolve([...selected].filter((index) => index !== noneIndex));
    };

    const onKeypress = (_character, key) => {
      if (key?.ctrl && key.name === "c") {
        process.stdin.setRawMode(wasRaw);
        process.stdout.write("\n");
        process.exit(130);
      }
      if (key?.name === "up") focused = (focused - 1 + choices.length) % choices.length;
      else if (key?.name === "down") focused = (focused + 1) % choices.length;
      else if (key?.name === "space") {
        if (focused === noneIndex) {
          selected.clear();
          selected.add(noneIndex);
        } else {
          selected.delete(noneIndex);
          if (selected.has(focused)) selected.delete(focused);
          else selected.add(focused);
          if (selected.size === 0) selected.add(noneIndex);
        }
      } else if (key?.name === "return" || key?.name === "enter") {
        finish();
        return;
      } else {
        return;
      }
      render();
    };

    process.stdin.on("keypress", onKeypress);
    render();
  });
}

async function pickAndRegisterAgents(config) {
  if (!process.stdin.isTTY) {
    console.log("[taskwindow] non-interactive session — register agents with: taskwindow install --claude|--cursor|--opencode");
    return;
  }
  console.log("Which coding agents should use TaskWindow?");
  console.log("Use ↑/↓ to move, space to select, and enter to confirm.");
  const picks = await selectCodingAgents();
  if (picks.length === 0) {
    console.log("[taskwindow] skipped coding-agent setup — add one later with taskwindow install --claude|--cursor|--opencode");
    return;
  }
  const registered = [];
  for (const index of picks) {
    const [label, register] = AGENT_CHOICES[index];
    try {
      await register(config);
      registered.push(label);
    } catch (err) {
      console.error(`[taskwindow] ${label} registration failed:`, err.message);
    }
  }
  console.log(
    registered.length
      ? `[taskwindow] registered: ${registered.join(", ")} — pair the extension with code ${pairCode} if it hasn't asked`
      : "[taskwindow] no agents registered — run taskwindow install again to pick some"
  );
}

try {
  if (verb === "install") {
    const config = loadConfig();
    if (!flags.includes("--no-service")) {
      installService(fileURLToPath(new URL("./index.js", import.meta.url)));
    }
    const extFlag = flags.indexOf("--extension");
    if (extFlag !== -1) {
      installExtension(flags[extFlag + 1] && !flags[extFlag + 1].startsWith("--") ? flags[extFlag + 1] : null);
    }
    if (flags.includes("--claude") || flags.includes("--cursor") || flags.includes("--opencode")) {
      if (flags.includes("--claude")) registerClaude(config);
      if (flags.includes("--cursor")) registerCursor(config);
      if (flags.includes("--opencode")) registerOpenCode(config);
    } else if (extFlag === -1) {
      await pickAndRegisterAgents(config);
    }
    process.exit(0);
  }
  if (verb === "uninstall") {
    if (!flags.includes("--keep-agents")) unregisterAgents({ port: 9377 });
    if (!flags.includes("--no-service")) uninstallService();
    process.exit(0);
  }
} catch (err) {
  console.error(`[taskwindow] ${verb || "install"} failed: ${err.message}`);
  console.error(`[taskwindow] if the problem persists: taskwindow uninstall, then taskwindow install`);
  process.exit(1);
}

const config = loadConfig();
const bridge = new Bridge({ token: config.token });

const handleMcp = createMcpRequestHandler({ bridge, version: VERSION });

// One-time pairing: the daemon prints a short code at startup; the extension
// exchanges it for the real token via POST /pair (loopback-only). This defends
// the pairing endpoint against other local user accounts; a same-user process
// could read the token file directly, so the code adds no obstacle there.
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
      version: VERSION,
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
  console.log(`[taskwindow] register an agent with: taskwindow install --claude (or --cursor)`);
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
