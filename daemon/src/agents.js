/**
 * Optional per-agent MCP registration, always explicit:
 *   taskwindow install --claude   → Claude Code
 *   taskwindow install --cursor   → Cursor
 * Nothing is registered unless the matching flag is given.
 */
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

export function registerClaude({ port, token }) {
  try {
    // Replace an older registration, if any.
    execFileSync("claude", ["mcp", "remove", "taskwindow"], { stdio: "ignore" });
  } catch {}
  execFileSync(
    "claude",
    [
      "mcp", "add", "taskwindow",
      "--transport", "http",
      `http://127.0.0.1:${port}/mcp`,
      "--header", `Authorization: Bearer ${token}`,
    ],
    { stdio: "inherit" }
  );
  console.log("[taskwindow] registered in Claude Code — verify with: claude mcp list");
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
