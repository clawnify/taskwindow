/**
 * The daemon declares each tool's schema (zod) and the extension implements the
 * handler; they are separate artifacts with nothing binding them, so the two
 * can silently disagree. A param a handler reads but the schema never declares
 * is unreachable: the MCP SDK validates arguments with a plain z.object(shape),
 * so zod's default strip silently drops anything undeclared before the call ever
 * leaves the daemon. That is how v0.2.0 shipped an uncallable
 * read_network_requests.
 *
 * This pins the contract by static analysis. Static analysis has blind spots,
 * so anything it cannot parse is a FAILURE, never a skip: a silently skipped
 * tool is how the check would rot.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toolDefs } from "../src/tools.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const extToolsDir = join(root, "extension", "tools");

/** Tools whose handler lives in the daemon, so there is no extension function. */
const DAEMON_HANDLED = new Set(["browser_batch"]);
// Params the daemon consumes and strips before forwarding, so the extension
// handler never reads them (see registerTools).
const DAEMON_HANDLED_PARAMS = { computer: new Set(["save_to_disk"]) };

/** Split on commas at brace/bracket/paren depth 0 (defaults may contain commas). */
function splitTopLevel(src) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of src) {
    if ("{[(".includes(ch)) depth++;
    else if ("}])".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Text between the opening delimiter at `open` and its match. */
function matchedSpan(src, open) {
  const pairs = { "(": ")", "{": "}" };
  const close = pairs[src[open]];
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === src[open]) depth++;
    else if (src[i] === close && --depth === 0) return { body: src.slice(open + 1, i), end: i };
  }
  return null;
}

/** Every `export async function` in the extension's tool modules. */
function readHandlers() {
  const handlers = new Map();
  for (const file of readdirSync(extToolsDir).filter((f) => f.endsWith(".js"))) {
    const src = readFileSync(join(extToolsDir, file), "utf8");
    for (const m of src.matchAll(/export async function (\w+)\s*\(/g)) {
      const parenAt = src.indexOf("(", m.index + m[0].length - 1);
      const params = matchedSpan(src, parenAt);
      if (!params) continue;
      const braceAt = src.indexOf("{", params.end);
      const fnBody = matchedSpan(src, braceAt);
      handlers.set(m[1], { file, params: params.body.trim(), body: fnBody ? fnBody.body : "" });
    }
  }
  return handlers;
}

/** Param names a handler actually reads, or null if the shape is unparseable. */
function paramsRead({ params, body }) {
  if (params === "") return new Set(); // takes no arguments
  const first = splitTopLevel(params)[0];

  if (first.startsWith("{")) {
    const span = matchedSpan(first, 0);
    if (!span) return null;
    return new Set(
      splitTopLevel(span.body).map((p) => p.split(/[=:]/)[0].trim()).filter(Boolean)
    );
  }

  // Single object argument (e.g. `computer(params)`): collect both `params.<name>`
  // and anything destructured off it in the body (`const { action } = params`).
  const name = first.split("=")[0].trim();
  if (!/^\w+$/.test(name)) return null;
  const read = new Set();
  for (const m of body.matchAll(new RegExp(`\\b${name}\\.(\\w+)`, "g"))) read.add(m[1]);
  for (const m of body.matchAll(new RegExp(`(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*${name}\\b`, "g"))) {
    for (const p of splitTopLevel(m[1])) read.add(p.split(/[=:]/)[0].trim());
  }
  return read;
}

test("every tool schema matches its extension handler", () => {
  const bg = readFileSync(join(root, "extension", "background.js"), "utf8");
  const handlersBlock = matchedSpan(bg, bg.indexOf("{", bg.indexOf("const HANDLERS")));
  assert.ok(handlersBlock, "could not locate the HANDLERS table in background.js");

  const toolToFn = new Map();
  for (const entry of splitTopLevel(handlersBlock.body)) {
    const m = entry.match(/^(\w+)\s*:\s*(?:\([^)]*\)\s*=>\s*)?(\w+)/);
    if (m) toolToFn.set(m[1], m[2]);
  }

  const handlers = readHandlers();
  const problems = [];
  let checked = 0;

  for (const def of toolDefs) {
    if (def.local || DAEMON_HANDLED.has(def.name)) continue;

    const fnName = toolToFn.get(def.name);
    if (!fnName) {
      problems.push(`${def.name}: declared but absent from background.js HANDLERS`);
      continue;
    }
    const handler = handlers.get(fnName);
    if (!handler) {
      problems.push(`${def.name}: HANDLERS points at ${fnName}(), which no extension/tools/*.js exports`);
      continue;
    }
    const read = paramsRead(handler);
    if (read === null) {
      problems.push(
        `${def.name}: cannot statically read ${fnName}()'s params in ${handler.file} — ` +
          `rewrite the signature or teach this test the shape (never skip it)`
      );
      continue;
    }

    const daemonParams = DAEMON_HANDLED_PARAMS[def.name] || new Set();
    const declared = new Set(Object.keys(def.inputSchema || {}).filter((p) => !daemonParams.has(p)));
    const undeclared = [...read].filter((p) => !declared.has(p));
    const unused = [...declared].filter((p) => !read.has(p));

    if (undeclared.length) {
      problems.push(
        `${def.name}: ${fnName}() reads [${undeclared.join(", ")}] but the schema does not declare ` +
          `${undeclared.length > 1 ? "them" : "it"} — the daemon strips undeclared args, so the handler ` +
          `always sees ${undeclared.length > 1 ? "them" : "it"} as undefined`
      );
    }
    if (unused.length) {
      problems.push(`${def.name}: schema declares [${unused.join(", ")}] which ${fnName}() never reads`);
    }
    checked++;
  }

  assert.equal(problems.length, 0, `tool contract drift:\n  - ${problems.join("\n  - ")}`);
  assert.ok(checked >= 15, `only ${checked} tools were actually compared — the check is not covering the surface`);
});

test("every session-scoped tool declares sessionToken", () => {
  const missing = toolDefs
    .filter((def) => !def.local && !def.noSession)
    .filter((def) => !("sessionToken" in (def.inputSchema || {})))
    .map((def) => def.name);

  assert.deepEqual(missing, [], `tools missing sessionToken: ${missing.join(", ")}`);
});
