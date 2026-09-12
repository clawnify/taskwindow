/**
 * Optional per-agent MCP registration, always explicit:
 *   taskwindow install --claude   → Claude Code
 *   taskwindow install --codex    → Codex
 *   taskwindow install --cursor   → Cursor
 * Registered only when selected in the installer or explicitly requested.
 */
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";

function commandExists(command) {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

const CODEX_TASKWINDOW_SECTION = /^\[mcp_servers\.(?:taskwindow|"taskwindow")\][ \t]*(?:#[^\r\n]*)?\r?$/m;

export function codexConfigHasTaskWindow(contents) {
  return CODEX_TASKWINDOW_SECTION.test(contents);
}

export function addCodexAuthorization(contents, token) {
  const match = CODEX_TASKWINDOW_SECTION.exec(contents);
  if (!match) throw new Error("Codex did not create the taskwindow MCP server entry");
  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  const lineEnd = contents.indexOf("\n", match.index + match[0].length);
  const insertAt = lineEnd === -1 ? contents.length : lineEnd + 1;
  const prefix = lineEnd === -1 ? newline : "";
  const header = `http_headers = { Authorization = ${JSON.stringify(`Bearer ${token}`)} }${newline}`;
  return contents.slice(0, insertAt) + prefix + header + contents.slice(insertAt);
}

function codexConfigPath(homeDir, codexHome = process.env.CODEX_HOME) {
  return join(codexHome || join(homeDir, ".codex"), "config.toml");
}

export function inspectAgents({ homeDir = homedir(), codexHome, hasCommand = commandExists } = {}) {
  const claudePath = join(homeDir, ".claude.json");
  const codexPath = codexConfigPath(homeDir, codexHome);
  const cursorPath = join(homeDir, ".cursor", "mcp.json");
  const openCodePath = join(homeDir, ".config", "opencode", "opencode.json");
  const claude = readJson(claudePath);
  const cursor = readJson(cursorPath);
  const openCode = readJson(openCodePath);
  let codex = "";
  try {
    codex = readFileSync(codexPath, "utf8");
  } catch {}
  return [
    {
      id: "claude",
      label: "Claude Code",
      detected: hasCommand("claude") || existsSync(claudePath),
      configured: !!claude.mcpServers?.taskwindow,
    },
    {
      id: "codex",
      label: "Codex",
      detected: hasCommand("codex"),
      configured: codexConfigHasTaskWindow(codex),
    },
    {
      id: "cursor",
      label: "Cursor",
      detected: hasCommand("cursor") || existsSync(join(homeDir, ".cursor")),
      configured: !!cursor.mcpServers?.taskwindow,
    },
    {
      id: "opencode",
      label: "OpenCode",
      detected: hasCommand("opencode") || existsSync(join(homeDir, ".config", "opencode")),
      configured: !!openCode.mcp?.taskwindow,
    },
  ];
}

export function registerClaude({ port, token }) {
  try {
    // Replace an older registration, if any.
    execFileSync("claude", ["mcp", "remove", "taskwindow"], { stdio: "ignore" });
  } catch {}
  execFileSync(
    "claude",
    [
      "mcp", "add",
      "--transport", "http",
      "--scope", "user",
      "taskwindow",
      `http://127.0.0.1:${port}/mcp`,
      "--header", `Authorization: Bearer ${token}`,
    ],
    { stdio: "inherit" }
  );
  console.log("[taskwindow] registered in Claude Code (user scope: available in every repo)");
}

export function registerCodex(
  { port, token },
  { homeDir = homedir(), codexHome, execFile = execFileSync } = {}
) {
  const path = codexConfigPath(homeDir, codexHome);
  const existed = existsSync(path);
  const original = existed ? readFileSync(path, "utf8") : null;
  const originalMode = existed ? statSync(path).mode & 0o777 : null;
  const url = `http://127.0.0.1:${port}/mcp`;
  // Use the same config directory for the CLI and the header edit, even when
  // invoked from a project with its own MCP overrides.
  const options = { cwd: dirname(path), timeout: 15_000, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" };
  mkdirSync(dirname(path), { recursive: true });
  try {
    // Let Codex own its config-table creation/removal, then add the static
    // Authorization header its CLI does not currently expose as a flag.
    if (codexConfigHasTaskWindow(original || "")) {
      execFile("codex", ["mcp", "remove", "taskwindow"], options);
    }
    execFile(
      "codex",
      ["mcp", "add", "taskwindow", "--url", url],
      options
    );
    const configured = readFileSync(path, "utf8");
    // writeFile's mode applies only to newly created files.
    chmodSync(path, 0o600);
    writeFileSync(path, addCodexAuthorization(configured, token), { mode: 0o600 });
    const saved = JSON.parse(execFile("codex", ["mcp", "get", "taskwindow", "--json"], options));
    if (!saved.enabled || saved.transport?.type !== "streamable_http" ||
        saved.transport.url !== url || saved.transport.http_headers?.Authorization !== `Bearer ${token}`) {
      throw new Error("saved server does not match the requested connection");
    }
  } catch (err) {
    try {
      if (existed) {
        writeFileSync(path, original);
        chmodSync(path, originalMode);
      }
      else rmSync(path, { force: true });
    } catch (rollbackErr) {
      throw new Error(`Codex registration failed; restoring ${path} also failed: ${rollbackErr.code || "filesystem error"}`);
    }
    // CLI/config errors can include the complete config and its credentials.
    const reason = err.code === "ENOENT" ? "install the Codex CLI and ensure it is on PATH" : "check the Codex CLI and config.toml";
    throw new Error(`Codex registration failed (${reason}); original configuration restored`);
  }
  console.log(`[taskwindow] registered in Codex (${path}) — restart Codex to load the tools`);
}

export function registerCursor({ port, token }) {
  const path = join(homedir(), ".cursor", "mcp.json");
  let cfg = {};
  try {
    cfg = JSON.parse(readFileSync(path, "utf8"));
  } catch {}
  cfg.mcpServers = cfg.mcpServers || {};
  cfg.mcpServers.taskwindow = {
    url: `http://127.0.0.1:${port}/mcp`,
    headers: { Authorization: `Bearer ${token}` },
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
  console.log(`[taskwindow] registered in Cursor (${path})`);
}

export function registerOpenCode({ port, token }) {
  const path = join(homedir(), ".config", "opencode", "opencode.json");
  let cfg = {};
  try {
    cfg = JSON.parse(readFileSync(path, "utf8"));
  } catch {}
  cfg.mcp = cfg.mcp || {};
  cfg.mcp.taskwindow = {
    type: "remote",
    url: `http://127.0.0.1:${port}/mcp`,
    enabled: true,
    headers: { Authorization: `Bearer ${token}` },
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
  console.log(`[taskwindow] registered in OpenCode (${path})`);
}

export function unregisterAgents({ port }) {
  try {
    execFileSync("claude", ["mcp", "remove", "taskwindow"], { stdio: "ignore" });
    console.log("[taskwindow] removed from Claude Code");
  } catch {}
  try {
    execFileSync("codex", ["mcp", "remove", "taskwindow"], { stdio: "ignore" });
    console.log("[taskwindow] removed from Codex");
  } catch {}
  try {
    const path = join(homedir(), ".cursor", "mcp.json");
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    if (cfg.mcpServers?.taskwindow) {
      delete cfg.mcpServers.taskwindow;
      writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
      console.log("[taskwindow] removed from Cursor");
    }
  } catch {}
}
