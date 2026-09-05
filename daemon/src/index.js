#!/usr/bin/env node
import http from "node:http";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { loadConfig } from "./config.js";
import { Bridge } from "./bridge.js";
import { createMcpRequestHandler } from "./mcp-http.js";
import {
  extensionInstallDir,
  installService,
  uninstallService,
  installExtension,
  downloadExtensionZip,
  refreshExtensionFiles,
  removeExtensionBootstrap,
} from "./service.js";
import { PairingManager } from "./pairing.js";
import {
  readHealth,
  requestPairCode,
  requestExtensionReload,
  waitForDaemon,
  waitForExtension,
  waitForExtensionVersion,
} from "./setup-client.js";
import { UpdateChecker, fetchLatestVersion, isNewer, readUpdateState, updateCheckDisabled } from "./updates.js";
import { createRequire } from "node:module";

const { version: VERSION } = createRequire(import.meta.url)("../package.json");
import { inspectAgents, registerClaude, registerCursor, registerOpenCode, unregisterAgents } from "./agents.js";
import { clearLine, cursorTo, emitKeypressEvents, moveCursor } from "node:readline";

// `taskwindow install` manages the login service and offers to register the
// MCP server with one or more coding agents. Component-only installs do not
// reopen the interactive picker.
const args = process.argv.slice(2);
const verb = args[0];
const flags = args.slice(1);

const AGENT_CHOICES = [
  ["claude", "Claude Code", registerClaude],
  ["cursor", "Cursor", registerCursor],
  ["opencode", "OpenCode", registerOpenCode],
];

function selectCodingAgents() {
  const agentState = new Map(inspectAgents().map((agent) => [agent.id, agent]));
  const choices = [
    ...AGENT_CHOICES.map(([id, label]) => ({ label, detected: agentState.get(id)?.detected === true })),
    { label: "None (set up later)", detected: false },
  ];
  const noneIndex = choices.length - 1;
  const detected = choices
    .map((choice, index) => (index !== noneIndex && choice.detected ? index : null))
    .filter((index) => index !== null);
  const selected = new Set(detected.length ? detected : [noneIndex]);
  let focused = 0;
  let rendered = false;

  emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  const wasPaused = process.stdin.isPaused();
  process.stdin.setRawMode(true);
  process.stdin.resume();

  const render = () => {
    if (rendered) moveCursor(process.stdout, 0, -choices.length);
    for (const [index, choice] of choices.entries()) {
      cursorTo(process.stdout, 0);
      clearLine(process.stdout, 0);
      const pointer = index === focused ? ">" : " ";
      const checkbox = selected.has(index) ? "[x]" : "[ ]";
      const suffix = choice.detected ? " (detected)" : "";
      process.stdout.write(`${pointer} ${checkbox} ${choice.label}${suffix}\n`);
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
    const [, label, register] = AGENT_CHOICES[index];
    try {
      await register(config);
      registered.push(label);
    } catch (err) {
      console.error(`[taskwindow] ${label} registration failed:`, err.message);
    }
  }
  console.log(
    registered.length
      ? `[taskwindow] registered: ${registered.join(", ")}`
      : "[taskwindow] no agents registered — run taskwindow install again to pick some"
  );
}

async function ensureDaemon(config, { forceInstall = false, allowInstall = true } = {}) {
  const current = await readHealth(config.port);
  if (!forceInstall && current?.version === VERSION) {
    console.log(`[taskwindow] daemon already running (v${current.version})`);
    return current;
  }
  if (!allowInstall) {
    if (current) return current;
    throw new Error("the daemon is not running; re-run without --no-service");
  }
  installService(fileURLToPath(new URL("./index.js", import.meta.url)));
  const health = await waitForDaemon(config.port);
  if (!health) throw new Error(`daemon did not become ready on port ${config.port}`);
  return health;
}

async function installAndConnectExtension(config, zipPath) {
  const pairing = await requestPairCode(config);
  installExtension(zipPath, { port: config.port, pairingCode: pairing.code });
  console.log("[taskwindow] waiting up to 5 minutes for the extension to connect…");
  const health = await waitForExtension(config.port);
  if (!health) {
    console.error("[taskwindow] extension not connected yet — finish the Chrome steps, then run: taskwindow doctor");
    return false;
  }
  removeExtensionBootstrap();
  console.log(`[taskwindow] ready ✓ — daemon v${health.version}, extension v${health.extensionVersion || "unknown"}`);
  return true;
}

function installedExtensionVersion() {
  try {
    return JSON.parse(readFileSync(join(extensionInstallDir(), "manifest.json"), "utf8")).version || null;
  } catch {
    return null;
  }
}

/**
 * The `taskwindow` that PATH resolves to, if it isn't this one. Global installs
 * under different Node versions (nvm, Homebrew, /usr/local) leave older copies
 * behind, and an older copy earlier on PATH silently runs instead of the one
 * `npm install -g taskwindow@latest` just put down — a pre-`doctor` version
 * even falls through to daemon mode and dies on the busy port.
 */
function shadowingInstall() {
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  };
  const self = real(process.argv[1]);
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    const bin = join(dir, "taskwindow");
    if (!existsSync(bin)) continue;
    const target = real(bin);
    if (!target || target === self) return null; // first hit is us: no shadow
    let version = "unknown";
    try {
      version = JSON.parse(readFileSync(join(dirname(target), "..", "package.json"), "utf8")).version || version;
    } catch {}
    return { bin, version };
  }
  return null;
}

function warnIfShadowed() {
  const other = shadowingInstall();
  if (!other) return false;
  console.log(
    `✗ \`taskwindow\` on your PATH is v${other.version} at ${other.bin}, not this v${VERSION} — ` +
      `remove it (npm uninstall -g taskwindow with the npm that owns that prefix, or delete the link) so commands run the current version`
  );
  return true;
}

async function runDoctor(config) {
  const health = await readHealth(config.port);
  const installedVersion = installedExtensionVersion();
  const agents = inspectAgents();
  console.log(`TaskWindow doctor (CLI v${VERSION})`);
  warnIfShadowed();
  const known = updateCheckDisabled(config.dir) ? null : (health?.latestVersion || readUpdateState(config.dir).latest);
  if (known && isNewer(known, VERSION)) console.log(`↑ TaskWindow v${known} is available (CLI v${VERSION}) — run: taskwindow update`);
  if (health) {
    const versionNote = health.version === VERSION ? "" : ` — CLI is v${VERSION}; run taskwindow update`;
    console.log(`✓ Daemon running (v${health.version}, port ${health.port})${versionNote}`);
  } else {
    console.log("✗ Daemon not running — run: taskwindow install");
  }
  if (installedVersion) console.log(`✓ Extension files installed (v${installedVersion}, ${extensionInstallDir()})`);
  else console.log("✗ Extension files not installed — run: taskwindow install");
  if (health?.extensionConnected) {
    const versionNote = installedVersion && health.extensionVersion && installedVersion !== health.extensionVersion
      ? ` — installed files are v${installedVersion}; run taskwindow update (or reload the extension in Chrome)`
      : "";
    console.log(`✓ Chrome extension connected (v${health.extensionVersion || "unknown"})${versionNote}`);
  } else {
    console.log("✗ Chrome extension not connected — enable it in Chrome, then run: taskwindow pair");
  }
  for (const agent of agents) {
    console.log(`${agent.configured ? "✓" : "○"} ${agent.label}${agent.configured ? " configured" : " not configured"}`);
  }
  if (!agents.some((agent) => agent.configured)) {
    console.log("  Add an agent with: taskwindow install --claude|--cursor|--opencode");
  }
  return !!health && health.extensionConnected === true;
}

/**
 * The global npm install this CLI runs from: its prefix and the npm that owns
 * it. `npm install -g` with the npm on PATH can belong to another Node (nvm,
 * Homebrew, /usr/local) and would plant a second copy — the shadowing problem
 * — so updates target the prefix these files live under.
 */
function owningInstall() {
  const self = realpathSync(process.argv[1]); // <prefix>/lib/node_modules/taskwindow/src/index.js
  const pkgRoot = dirname(dirname(self));
  const nodeModules = dirname(pkgRoot);
  if (basename(nodeModules) !== "node_modules" || basename(pkgRoot) !== "taskwindow") {
    throw new Error(`this taskwindow (${self}) is not a global npm install — update it the way you installed it`);
  }
  let prefix = dirname(nodeModules);
  if (basename(prefix) === "lib") prefix = dirname(prefix);
  const npm = [join(prefix, "bin", "npm"), join(dirname(process.execPath), "npm")].find((p) => existsSync(p)) || "npm";
  return { prefix, npm };
}

function printManualReload() {
  console.log("[taskwindow] the extension could not reload itself — in Chrome open chrome://extensions and click reload on TaskWindow");
}

/**
 * `taskwindow update`: non-interactive, safe to run mid-session (agents run it
 * with the user's OK). Stage 1 (old CLI): install the newer npm package into
 * the owning prefix, then re-exec the NEW CLI for stage 2 so the rest runs on
 * current code. Stage 2: refresh the extension files, restart the daemon on
 * the new code, then have the extension reload itself — daemon first, because
 * only the new daemon knows how to ask.
 */
async function runUpdate(config, flags) {
  const force = flags.includes("--force");
  const staged = flags.includes("--stage2");
  const extFlag = flags.indexOf("--extension");
  const zipArg = extFlag !== -1 && flags[extFlag + 1] && !flags[extFlag + 1].startsWith("--") ? flags[extFlag + 1] : null;

  if (!staged) {
    warnIfShadowed();
    let latest = null;
    try {
      latest = await fetchLatestVersion();
    } catch (err) {
      console.log(`[taskwindow] couldn't reach the npm registry (${err.message}) — refreshing the local install only`);
    }
    if (latest && isNewer(latest, VERSION)) {
      const { prefix, npm } = owningInstall();
      console.log(`[taskwindow] updating v${VERSION} → v${latest} (${prefix})`);
      execFileSync(npm, ["install", "-g", "--prefix", prefix, `taskwindow@${latest}`], { stdio: "inherit" });
      const rest = ["update", "--stage2", ...flags.filter((f) => f !== "--force" || force)];
      const child = spawnSync(process.execPath, [realpathSync(process.argv[1]), ...rest], { stdio: "inherit" });
      return child.status === 0;
    }
    const health = await readHealth(config.port);
    const filesVersion = installedExtensionVersion();
    const current =
      health?.version === VERSION &&
      filesVersion === VERSION &&
      (!health?.extensionConnected || health.extensionVersion === VERSION);
    if (current && !force) {
      console.log(`[taskwindow] already up to date (v${VERSION})${latest ? "" : " as far as the local install goes"}`);
      return true;
    }
  }

  // Stage 2 (or nothing newer on npm, but the local pieces disagree).
  refreshExtensionFiles(zipArg || downloadExtensionZip(VERSION));
  console.log(`[taskwindow] extension files refreshed (v${installedExtensionVersion() || "?"}, ${extensionInstallDir()})`);
  await ensureDaemon(config, { forceInstall: true });
  const health = await waitForExtension(config.port, 90_000);
  if (!health) {
    console.log("[taskwindow] the extension did not reconnect — enable TaskWindow in Chrome, then run: taskwindow doctor");
    return false;
  }
  if (health.extensionVersion !== VERSION) {
    const reload = await requestExtensionReload(config);
    if (!reload.ok) {
      printManualReload();
    } else if (!(await waitForExtensionVersion(config.port, VERSION))) {
      console.log("[taskwindow] the extension reloaded but has not reconnected on the new version yet");
      printManualReload();
    }
  }
  return runDoctor(config);
}

try {
  if (verb === "update") {
    const ok = await runUpdate(loadConfig(), flags);
    process.exit(ok ? 0 : 1);
  }
  if (verb === "install") {
    const config = loadConfig();
    const extFlag = flags.indexOf("--extension");
    const hasAgentFlags = flags.includes("--claude") || flags.includes("--cursor") || flags.includes("--opencode");
    const fullInstall = extFlag === -1 && !hasAgentFlags;
    const wantsExtension = extFlag !== -1 || (fullInstall && !flags.includes("--no-extension"));

    if (fullInstall) {
      await pickAndRegisterAgents(config);
    } else if (hasAgentFlags) {
      if (flags.includes("--claude")) registerClaude(config);
      if (flags.includes("--cursor")) registerCursor(config);
      if (flags.includes("--opencode")) registerOpenCode(config);
    }

    if (fullInstall || wantsExtension) {
      await ensureDaemon(config, {
        forceInstall: fullInstall,
        allowInstall: !flags.includes("--no-service"),
      });
    }

    let ready = true;
    if (wantsExtension) {
      const zipPath = extFlag !== -1 && flags[extFlag + 1] && !flags[extFlag + 1].startsWith("--")
        ? flags[extFlag + 1]
        : null;
      ready = await installAndConnectExtension(config, zipPath);
    } else if (fullInstall) {
      console.log("[taskwindow] daemon and coding-agent setup complete (--no-extension selected)");
    }
    warnIfShadowed();
    process.exit(ready ? 0 : 1);
  }
  if (verb === "pair") {
    const config = loadConfig();
    const health = await readHealth(config.port);
    if (!health) throw new Error("the daemon is not running; run taskwindow install first");
    const pairing = await requestPairCode(config);
    console.log(`[taskwindow] pairing code: ${pairing.code}`);
    console.log(`[taskwindow] valid for ${Math.round(pairing.expiresInSeconds / 60)} minutes and one use`);
    console.log("[taskwindow] open the TaskWindow extension → Settings, enter the code, then click Pair");
    process.exit(0);
  }
  if (verb === "doctor" || verb === "status") {
    const healthy = await runDoctor(loadConfig());
    process.exit(healthy ? 0 : 1);
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
const pairing = new PairingManager();

const updates = new UpdateChecker({ version: VERSION, dir: config.dir });
updates.start();

const handleMcp = createMcpRequestHandler({ bridge, version: VERSION, updates });

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
      latestVersion: updates.latest,
      extensionConnected: bridge.connected,
      extensionVersion: bridge.lastHello?.version || null,
      port: config.port,
    });
    return;
  }

  // `taskwindow update` asks the extension to reload itself (re-reading the
  // unpacked files). Same bearer token as pairing requests; it rides the
  // ordinary tool-call channel but is not an MCP tool, so agents can't call it.
  if (url.pathname === "/extension/reload") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed; POST to reload the extension" });
      return;
    }
    if (req.headers.authorization !== `Bearer ${config.token}`) {
      sendJson(res, 401, { error: "invalid or missing bearer token" });
      return;
    }
    try {
      await bridge.sendTool("reload_extension", {}, 5000);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 503, { error: err.message });
    }
    return;
  }

  if (url.pathname === "/pair/request") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed; POST to request a pairing code" });
      return;
    }
    if (req.headers.authorization !== `Bearer ${config.token}`) {
      sendJson(res, 401, { error: "invalid or missing bearer token" });
      return;
    }
    sendJson(res, 200, pairing.issue());
    return;
  }

  if (url.pathname === "/pair") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed; POST a pairing code" });
      return;
    }
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
    if (!pairing.claim(code)) {
      pairFailures.push(Date.now());
      sendJson(res, 403, { error: "invalid or expired pairing code" });
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
  console.log("[taskwindow] run taskwindow doctor for connection status or taskwindow pair for manual pairing");
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
