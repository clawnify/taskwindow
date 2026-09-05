#!/usr/bin/env node
/**
 * Test runner: boots a daemon on an ephemeral port with a throwaway token/dir,
 * connects the fake extension, runs the MCP client suite, then runs the
 * extension-disconnect and auth-negative cases.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const PORT = 19377;
const TOKEN = "test-token-0123456789abcdef";
const env = {
  ...process.env,
  TASKWINDOW_PORT: String(PORT),
  TASKWINDOW_TOKEN: TOKEN,
  TASKWINDOW_DIR: mkdtempSync(join(tmpdir(), "taskwindow-test-")),
};

function run(cmd, args, { wait = false } = {}) {
  const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  if (wait) {
    return new Promise((resolve, reject) => {
      child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}\n${out}`))));
      child.on("error", reject);
    });
  }
  return { child, getOut: () => out };
}

async function waitFor(url, probe, ms = 15_000) {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(url);
      if (await probe(res)) return;
    } catch {}
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

// A stand-in npm registry that always knows a newer version, so the update
// notice path runs end to end without the network.
const registry = createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ latest: "9.9.9" }));
});
await new Promise((resolve) => registry.listen(0, "127.0.0.1", resolve));
env.TASKWINDOW_UPDATE_CHECK_URL = `http://127.0.0.1:${registry.address().port}/dist-tags`;

const daemon = run(process.execPath, [join(root, "src", "index.js")]);
let fakeExt = null;
let flaky = null;

let exitCode = 0;
try {
  await waitFor(`http://127.0.0.1:${PORT}/health`, (r) => r.status === 200);
  fakeExt = run(process.execPath, [join(here, "fake-extension.js"), String(PORT), TOKEN]);
  await waitFor(
    `http://127.0.0.1:${PORT}/health`,
    async (r) => (await r.json()).extensionConnected === true
  );

  console.log("=== mcp-client suite (extension connected) ===");
  const clientRun = run(process.execPath, [join(here, "mcp-client.mjs"), String(PORT), TOKEN], { wait: true });
  console.log(await clientRun);

  console.log("=== negative suite (extension killed) ===");
  fakeExt.child.kill();
  await waitFor(
    `http://127.0.0.1:${PORT}/health`,
    async (r) => (await r.json()).extensionConnected === false
  );
  {
    const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "tabs_list", arguments: {} },
      }),
    });
    const body = await res.json();
    const text = body?.result?.content?.[0]?.text || "";
    if (body?.result?.isError === true && text.includes("not connected")) {
      console.log("  ok - tool call with no extension -> clean error");
    } else {
      console.error("  FAIL - expected clean not-connected error, got:", JSON.stringify(body).slice(0, 400));
      exitCode = 1;
    }

    const statusRes = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "taskwindow_status", arguments: {} },
      }),
    });
    const statusBody = await statusRes.json();
    const statusText = statusBody?.result?.content?.[0]?.text || "";
    if (statusBody?.result?.isError !== true && statusText.includes('"extensionConnected": false') && statusText.includes("taskwindow doctor")) {
      console.log("  ok - status remains available with actionable recovery guidance");
    } else {
      console.error("  FAIL - expected disconnected status guidance, got:", JSON.stringify(statusBody).slice(0, 400));
      exitCode = 1;
    }
  }

  console.log("=== negative suite (flaky extension) ===");
  // Start an extension that fails every call: errors must surface as isError.
  flaky = run(process.execPath, [join(here, "fake-extension.js"), String(PORT), TOKEN, "flaky"]);
  await waitFor(
    `http://127.0.0.1:${PORT}/health`,
    async (r) => (await r.json()).extensionConnected === true
  );
  const bad = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "tabs_list", arguments: {} },
    }),
  });
  const badBody = await bad.json();
  const errText = badBody?.result?.content?.[0]?.text || "";
  if (badBody?.result?.isError === true && errText.includes("injected failure")) {
    console.log("  ok - extension tool failure surfaces as isError with message");
  } else {
    console.error("  FAIL - expected isError with injected failure, got:", JSON.stringify(badBody).slice(0, 400));
    exitCode = 1;
  }
  flaky.child.kill();
} catch (err) {
  console.error("SUITE ERROR:", err.message);
  console.error("daemon output:\n" + daemon.getOut());
  if (fakeExt) console.error("fake-ext output:\n" + fakeExt.getOut());
  exitCode = 1;
} finally {
  registry.close();
  daemon.child.kill();
  if (fakeExt) fakeExt.child.kill();
  if (flaky) flaky.child.kill();
}
process.exit(exitCode);
