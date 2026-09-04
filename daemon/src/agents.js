/**
 * Optional per-agent MCP registration, always explicit:
 *   taskwindow install --claude   → Claude Code
 *   taskwindow install --cursor   → Cursor
 * Nothing is registered unless the matching flag is given.
 */
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
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

export function inspectAgents() {
  const claudePath = join(homedir(), ".claude.json");
  const cursorPath = join(homedir(), ".cursor", "mcp.json");
  const openCodePath = join(homedir(), ".config", "opencode", "opencode.json");
  const claude = readJson(claudePath);
  const cursor = readJson(cursorPath);
  const openCode = readJson(openCodePath);
  return [
    {
      id: "claude",
      label: "Claude Code",
      detected: commandExists("claude") || existsSync(claudePath),
      configured: !!claude.mcpServers?.taskwindow,
    },
    {
      id: "cursor",
      label: "Cursor",
      detected: commandExists("cursor") || existsSync(join(homedir(), ".cursor")),
      configured: !!cursor.mcpServers?.taskwindow,
    },
    {
      id: "opencode",
      label: "OpenCode",
      detected: commandExists("opencode") || existsSync(join(homedir(), ".config", "opencode")),
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
    const path = join(homedir(), ".cursor", "mcp.json");
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    if (cfg.mcpServers?.taskwindow) {
      delete cfg.mcpServers.taskwindow;
      writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
      console.log("[taskwindow] removed from Cursor");
    }
  } catch {}
}
