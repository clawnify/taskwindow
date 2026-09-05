#!/usr/bin/env node
/**
 * MCP-client-side test suite for the TaskWindow daemon.
 * Usage: node mcp-client.mjs <port> <token>
 * Exits 0 on success, 1 on failure.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [port, token] = process.argv.slice(2);
const BASE = `http://127.0.0.1:${port}`;

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name}${extra ? `: ${extra}` : ""}`);
  }
}

async function expectToolError(client, tool, args, needle) {
  const res = await client.callTool({ name: tool, arguments: args });
  return res.isError === true && res.content?.[0]?.text?.includes(needle);
}

async function main() {
  // --- raw HTTP auth checks -------------------------------------------------
  console.log("auth:");
  const noAuth = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  check("POST /mcp without token -> 401", noAuth.status === 401);

  const badAuth = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer wrong" },
    body: "{}",
  });
  check("POST /mcp with wrong token -> 401", badAuth.status === 401);

  const health = await fetch(`${BASE}/health`);
  const healthBody = await health.json();
  check("GET /health without token is allowed (loopback only)", health.status === 200 && healthBody.ok === true);
  check("health reports extension connected", healthBody.extensionConnected === true);
  check("health carries the latest known version", healthBody.latestVersion === "9.9.9", JSON.stringify(healthBody));

  console.log("extension reload (taskwindow update):");
  const unauthReload = await fetch(`${BASE}/extension/reload`, { method: "POST" });
  check("reload requests require daemon authentication", unauthReload.status === 401);
  const reload = await fetch(`${BASE}/extension/reload`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  check("authenticated reload reaches the extension", reload.status === 200 && (await reload.json()).ok === true);

  console.log("pairing:");
  const unauthPairRequest = await fetch(`${BASE}/pair/request`, { method: "POST" });
  check("pairing-code requests require daemon authentication", unauthPairRequest.status === 401);
  const pairRequest = await fetch(`${BASE}/pair/request`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  const pairRequestBody = await pairRequest.json();
  check("authenticated clients can request a short-lived code", pairRequest.status === 200 && /^[A-Z2-9]{6}$/.test(pairRequestBody.code));
  const badPair = await fetch(`${BASE}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "WRONG2" }),
  });
  check("incorrect pairing codes are rejected", badPair.status === 403);
  const goodPair = await fetch(`${BASE}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: pairRequestBody.code }),
  });
  const goodPairBody = await goodPair.json();
  check("a valid pairing code exchanges for the daemon token", goodPair.status === 200 && goodPairBody.token === token);
  const reusedPair = await fetch(`${BASE}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: pairRequestBody.code }),
  });
  check("pairing codes are single-use", reusedPair.status === 403);

  // --- MCP client -----------------------------------------------------------
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "taskwindow-test", version: "0.0.1" });
  await client.connect(transport);

  console.log("tools/list:");
  const { tools } = await client.listTools();
  const expected = [
    "taskwindow_status",
    "tabs_list", "tabs_create", "tabs_close", "navigate", "reload", "computer", "read_page", "find",
    "get_page_text", "form_input", "file_upload", "upload_image", "javascript_execute",
    "read_console_messages", "read_network_requests", "browser_batch", "gif_record",
    "shortcuts_list", "shortcuts_execute",
  ];
  const got = tools.map((t) => t.name).sort();
  check(`all ${expected.length} tools exposed`, expected.length === 20 && expected.every((n) => got.includes(n)), `got: ${got.join(",")}`);
  const computer = tools.find((t) => t.name === "computer");
  check("computer schema has action enum", JSON.stringify(computer.inputSchema).includes("screenshot"));
  const tabsCreate = tools.find((t) => t.name === "tabs_create");
  check("tabs_create schema requires task", Array.isArray(tabsCreate.inputSchema.required) && tabsCreate.inputSchema.required.includes("task"));

  console.log("tools/call through the extension bridge:");
  const status = await client.callTool({ name: "taskwindow_status", arguments: {} });
  check("status reports daemon and extension readiness", !status.isError && status.content[0].text.includes('"extensionConnected": true'));
  check("status names the newer version and says to ask the user first",
    status.content[0].text.includes('"latestVersion": "9.9.9"') && /9\.9\.9 is available[\s\S]*Ask the user for permission[\s\S]*taskwindow update/.test(status.content[0].text));

  const tabs = await client.callTool({ name: "tabs_list", arguments: {} });
  check("tabs_list returns text", !tabs.isError && tabs.content[0].text.includes("example.com"));
  check("tabs_list returns data block", tabs.content.some((c) => c.type === "text" && c.text.includes("developer.mozilla.org")));

  const shot = await client.callTool({ name: "computer", arguments: { action: "screenshot" } });
  const img = shot.content.find((c) => c.type === "image");
  check("computer screenshot returns image content block", !!img && img.data === "aWNvbg==" && img.mimeType === "image/png");

  const saved = await client.callTool({ name: "computer", arguments: { action: "screenshot", save_to_disk: true } });
  const savedText = saved.content.find((c) => c.type === "text").text;
  const savedPath = savedText.match(/Saved to: (.+)/)?.[1];
  const { readFile } = await import("node:fs/promises");
  let savedOk = false;
  if (savedPath) {
    const buf = await readFile(savedPath);
    savedOk = buf.toString("base64") === "aWNvbg==";
  }
  check("computer screenshot save_to_disk writes file and returns path", savedOk, `text: ${savedText}`);

  const nav = await client.callTool({ name: "navigate", arguments: { url: "https://example.com/other" } });
  check("navigate returns final url/title", !nav.isError && nav.content.at(-1).text.includes("Other"));

  const created = await client.callTool({ name: "tabs_create", arguments: { url: "https://example.com/", task: "Update notice" } });
  check("tabs_create appends the update notice once, as its own text block",
    !created.isError && created.content.length === 2 && /9\.9\.9 is available/.test(created.content[1].text) && /Ask the user for permission/.test(created.content[1].text));
  check("other tools stay quiet about updates", !tabs.content.some((c) => /is available/.test(c.text || "")));

  const noTask = await client.callTool({ name: "tabs_create", arguments: { url: "https://example.com/" } });
  check("tabs_create without task is rejected", noTask.isError === true && /task/i.test(noTask.content?.[0]?.text || ""));

  console.log("browser_batch:");
  const batch = await client.callTool({
    name: "browser_batch",
    arguments: { steps: [{ tool: "tabs_list" }, { tool: "computer", params: { action: "left_click", x: 10, y: 10 } }] },
  });
  check("batch runs all steps", !batch.isError && batch.content.at(-1).text.includes("1. tabs_list") && batch.content.at(-1).text.includes("2. computer"));

  const batchBad = await client.callTool({
    name: "browser_batch",
    arguments: { steps: [{ tool: "tabs_list" }, { tool: "tabs_close", params: { tabId: 999 } }] },
  });
  check("batch aborts on failing step with step number", batchBad.isError === true && batchBad.content[0].text.includes("aborted at step 2"));

  const batchNested = await client.callTool({
    name: "browser_batch",
    arguments: { steps: [{ tool: "browser_batch", params: { steps: [] } }] },
  });
  check("batch rejects nested browser_batch", batchNested.isError === true && batchNested.content[0].text.includes("cannot be nested"));

  const batchUnknown = await client.callTool({
    name: "browser_batch",
    arguments: { steps: [{ tool: "not_a_tool" }] },
  });
  check("batch rejects unknown tool", batchUnknown.isError === true && batchUnknown.content[0].text.includes('unknown tool "not_a_tool"'));

  await client.close();

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("test harness error:", err);
  process.exit(1);
});
