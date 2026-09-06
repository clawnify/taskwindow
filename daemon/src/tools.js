import { z } from "zod";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tabId = z.number().int().describe("Tab ID from tabs_list. Defaults to the active tab in your session's task groups.");

// Injected into every browser tool below (see toolDefs) rather than spread by
// hand into each schema: one missed spread made read_network_requests
// uncallable in v0.2.0.
const sessionToken = z
  .string()
  .optional()
  .describe(
    "Session token returned by tabs_create — pass it in every browser tool call so the call acts only on your session's tabs (sessions are isolated from each other)."
  );

// Result contract with the extension: {text?, image?: {data, mimeType}, data?}.
// The MCP layer turns `image` into an image content block and everything else
// into text blocks.

const rawDefs = [
  {
    name: "taskwindow_status",
    description:
      "Check whether the local TaskWindow daemon and Chrome extension are ready. Call this when browser tools report a connection problem; it returns the exact recovery action without requiring the extension.",
    inputSchema: {},
    local: true,
  },
  {
    name: "tabs_list",
    description:
      "List the tabs in your session (id, title, URL, active state) — by default only the tabs it created, grouped by task. Pass the sessionToken returned by tabs_create.",
    inputSchema: {},
    timeoutMs: 10_000,
  },
  {
    name: "tabs_create",
    description:
      "Open a new tab in a task-named tab group (in the agent's own window). Your first call needs a \"task\" name saying what " +
      "the group is about and returns a sessionToken — pass it as \"sessionToken\" in every subsequent browser tool call; concurrent " +
      "agents' sessions never share tabs. Later calls with the token need no task: the tab joins your session's current task group. " +
      "Pass a new task name to start another group. Don't open a second tab for a page you already have: " +
      "use reload or navigate on the existing tab (see tabs_list).",
    inputSchema: {
      url: z.string().url().describe("URL to open (include the scheme, e.g. https://...)"),
      task: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Task name for the tab group, e.g. "Research competitors". Required on your first call; afterwards omit it to add the tab to your current task group, or pass a new name to start another.'
        ),
      active: z.boolean().optional().describe("Make it the active tab of the agent window (default true). Never focuses that window: the user's window and app keep focus."),
      sessionToken: z
        .string()
        .optional()
        .describe("Your existing session token from an earlier tabs_create, to keep using that session's groups. Omit on your first call — a fresh token is minted and returned."),
    },
    timeoutMs: 15_000,
  },
  {
    name: "tabs_close",
    description: "Close a tab.",
    inputSchema: { tabId },
    timeoutMs: 10_000,
  },
  {
    name: "navigate",
    description:
      "Navigate a tab to a URL. Waits (up to 10s) for the load event, then returns the tab's URL and title.",
    inputSchema: { url: z.string().url(), tabId: tabId.optional() },
    timeoutMs: 30_000,
  },
  {
    name: "reload",
    description:
      "Reload a tab in place, like the browser's reload button, and wait (up to 10s) for the load event. " +
      "Use this — not tabs_create — to refresh a page you already have open.",
    inputSchema: {
      tabId: tabId.optional(),
      bypassCache: z.boolean().optional().describe("Skip the HTTP cache, like a hard reload (default false)"),
    },
    timeoutMs: 30_000,
  },
  {
    name: "computer",
    description:
      "Screenshot and low-level mouse/keyboard control of a tab via the Chrome DevTools Protocol. " +
      "Actions: screenshot (PNG of the viewport, or full page with fullPage), left_click / right_click / " +
      "middle_click / double_click / triple_click (at x,y), type (text into the focused element), " +
      "key (named key press, e.g. Enter, Tab, Escape, ArrowLeft, Backspace), scroll (by dx/dy pixels), " +
      "mouse_move, wait. Screenshots are in CSS pixels (1 image pixel = 1 coordinate unit, on any display density), so " +
      "read x,y straight off the last screenshot. NOTE: while attached, Chrome shows a " +
      '"TaskWindow started debugging this browser" infobar — this is unavoidable with CDP-based control.',
    inputSchema: {
      action: z.enum([
        "screenshot", "left_click", "right_click", "middle_click", "double_click", "triple_click",
        "type", "key", "scroll", "mouse_move", "wait",
      ]),
      tabId: tabId.optional(),
      x: z.number().int().optional().describe("X coordinate in viewport pixels (clicks, scroll origin, mouse_move)"),
      y: z.number().int().optional().describe("Y coordinate in viewport pixels"),
      text: z.string().optional().describe('Text for the "type" action'),
      key: z.string().optional().describe('Key name for the "key" action, e.g. "Enter", "a", "ArrowDown"'),
      dx: z.number().int().optional().describe("Horizontal scroll delta in pixels"),
      dy: z.number().int().optional().describe("Vertical scroll delta in pixels (positive scrolls down)"),
      ms: z.number().int().min(0).max(10_000).optional().describe('Milliseconds for the "wait" action (max 10000)'),
      fullPage: z.boolean().optional().describe('For "screenshot": capture the whole scrollable page instead of the viewport'),
      save_to_disk: z
        .boolean()
        .optional()
        .describe(
          'For "screenshot": also write the PNG to a local file and return its path in the result, so it can be read, attached or handed to other tools. Default false.'
        ),
    },
    timeoutMs: 30_000,
  },
  {
    name: "set_viewport",
    description:
      "Open a responsive view: a dedicated harness window in the current task's tab group rendering the current page in one fixed-size iframe per viewport (media queries, vw/vh and touch resolve exactly per frame; several breakpoints side by side). " +
      "Sites that refuse framing automatically fall back to a dedicated emulated window per viewport. Only these windows are affected — other windows and tab groups are untouched. " +
      "Each result reports the page's own innerWidth (trust it over screenshots). Typical flow: set_viewport, computer screenshot / read_page on the returned tabIds, then set_viewport with no arguments to close. " +
      "Note: frames may render logged out on cookie-partitioned sites — the emulated-window fallback has full cookies.",
    inputSchema: {
      viewports: z.array(z.object({
        width: z.number().int().min(200).max(4000),
        height: z.number().int().min(200).max(4000),
      })).min(1).max(4).optional().describe("Sizes to render side by side, e.g. [{\"width\":390,\"height\":844},{\"width\":1280,\"height\":800}]. Omit to close the responsive view."),
      url: z.string().url().optional().describe("Page to render (defaults to the current tab's URL)"),
      tabId: tabId.optional(),
    },
    timeoutMs: 30_000,
  },
  {
    name: "read_page",
    description:
      "Structured accessibility-style snapshot of the page: a text tree of interactive elements and content, " +
      "each labelled with a ref (e.g. e42) you can pass to form_input / file_upload. Cheaper and more reliable " +
      "than a screenshot for forms and navigation.",
    inputSchema: { tabId: tabId.optional() },
    timeoutMs: 20_000,
  },
  {
    name: "find",
    description:
      "Find elements on the page matching a query (matches role, accessible name and visible text, case-insensitive). " +
      "Returns matching refs plus enough context to pick between them.",
    inputSchema: { query: z.string().min(1), tabId: tabId.optional() },
    timeoutMs: 20_000,
  },
  {
    name: "get_page_text",
    description: "Extract the page's visible text content (like copy-pasting the page body).",
    inputSchema: {
      tabId: tabId.optional(),
      maxLength: z.number().int().min(100).max(500_000).optional().describe("Truncate output to this many characters (default 50000)"),
    },
    timeoutMs: 20_000,
  },
  {
    name: "form_input",
    description:
      "Fill a form field: text inputs, textareas, checkboxes, radios, <select>s and contenteditable elements. " +
      "Targets the element by ref (from read_page/find) or a CSS selector.",
    inputSchema: {
      value: z.union([z.string(), z.number(), z.boolean()]).describe("Value to set. For checkboxes/radios use true/false; for selects use the option value or visible text."),
      ref: z.string().optional().describe("Element ref from read_page/find (e.g. e42)"),
      selector: z.string().optional().describe("CSS selector as fallback when no ref is available"),
      clear: z.boolean().optional().describe("Clear the field before typing (default true for text fields)"),
      tabId: tabId.optional(),
    },
    timeoutMs: 20_000,
  },
  {
    name: "file_upload",
    description:
      "Attach local file content to a file input (<input type=file>). The file bytes are transferred through the " +
      "daemon; target the input by ref or CSS selector.",
    inputSchema: {
      files: z.array(z.object({
        name: z.string().describe("File name (shown to the site)"),
        mimeType: z.string().optional().describe("MIME type, e.g. application/pdf"),
        data: z.string().describe("File content, base64-encoded"),
      })).min(1).max(10),
      ref: z.string().optional(),
      selector: z.string().optional(),
      tabId: tabId.optional(),
    },
    timeoutMs: 60_000,
  },
  {
    name: "upload_image",
    description:
      "Push an image into the page: sets it on a file input if the target is one, otherwise dispatches a paste " +
      "(and drop) event with the image on the target element or the currently focused element — works with most " +
      "rich-text/chat editors.",
    inputSchema: {
      data: z.string().describe("Image content, base64-encoded"),
      mimeType: z.string().optional().describe("Image MIME type (default image/png)"),
      name: z.string().optional().describe("File name to present (default image.png)"),
      ref: z.string().optional(),
      selector: z.string().optional(),
      tabId: tabId.optional(),
    },
    timeoutMs: 30_000,
  },
  {
    name: "javascript_execute",
    description:
      "Run JavaScript in the page's main world (same context as the site's own scripts) and return the result. " +
      "Evaluated over the DevTools protocol, so the page's Content Security Policy does not block it. " +
      "The final expression's value is returned if JSON-serializable. Use sparingly — prefer read_page/find/form_input.",
    inputSchema: {
      code: z.string().describe("JavaScript source to evaluate, e.g. \"document.title\""),
      awaitPromise: z.boolean().optional().describe("Wait for a returned Promise to settle (default true)"),
      tabId: tabId.optional(),
    },
    timeoutMs: 30_000,
  },
  {
    name: "read_console_messages",
    description:
      "Read console output (console.*, errors, warnings) captured from the tab. Capture is CDP-based, so it covers " +
      "messages emitted while TaskWindow has been driving the tab.",
    inputSchema: {
      tabId: tabId.optional(),
      pattern: z.string().optional().describe("Only messages matching this regular expression"),
      level: z.enum(["log", "info", "warning", "error"]).optional().describe("Minimum severity to include"),
      limit: z.number().int().min(1).max(1000).optional().describe("Max messages to return (default 200, newest last)"),
    },
    timeoutMs: 20_000,
  },
  {
    name: "read_network_requests",
    description:
      "Read network requests observed in the tab while TaskWindow was attached: method, URL, status, type and size.",
    inputSchema: {
      tabId: tabId.optional(),
      pattern: z.string().optional().describe("Only requests whose URL matches this regular expression"),
      limit: z.number().int().min(1).max(1000).optional().describe("Max requests to return (default 200, newest last)"),
    },
    timeoutMs: 20_000,
  },
  {
    name: "browser_batch",
    description:
      "Run several browser tool calls in one round trip, in order, on the same tab context. Aborts on the first " +
      "failing step. Each step is {tool, params} where tool is any TaskWindow browser tool except browser_batch. " +
      "Tip: a common batch is navigate followed by a computer wait then read_page.",
    inputSchema: {
      steps: z.array(z.object({
        tool: z.string(),
        params: z.record(z.any()).optional().default({}),
      })).min(1).max(20),
    },
    timeoutMs: 300_000,
  },
  {
    name: "gif_record",
    description:
      "Record a GIF of the tab for `duration` seconds (captures CDP screenshots at `fps` and encodes GIF89a in an " +
      "offscreen document). Returns the GIF as base64. Use to document a multi-step interaction.",
    inputSchema: {
      tabId: tabId.optional(),
      duration: z.number().min(0.5).max(30).describe("Seconds to record (max 30)"),
      fps: z.number().min(1).max(10).optional().describe("Frames per second (default 5)"),
      maxWidth: z.number().int().min(100).max(1280).optional().describe("Downscale frames to at most this width (default 800)"),
    },
    timeoutMs: 180_000,
  },
  {
    name: "shortcuts_list",
    description: "List the extension-defined shortcut macros (named sequences of tool actions).",
    inputSchema: {},
    noSession: true, // reads the macro registry, never a tab
    timeoutMs: 10_000,
  },
  {
    name: "shortcuts_execute",
    description: "Run a shortcut macro defined in the extension and return each action's result.",
    inputSchema: { name: z.string().min(1) },
    timeoutMs: 120_000,
  },
];

/**
 * Every tool that reaches a tab is session-scoped, so `sessionToken` is added
 * here instead of being spread by hand into each schema — a tool whose handler
 * scopes by session but whose schema omitted the param is uncallable, which is
 * how read_network_requests shipped broken in v0.2.0. A tool that never touches
 * a tab opts out with `noSession`; a tool that declares its own sessionToken
 * (tabs_create's has different semantics) keeps it.
 */
const toolDefs = rawDefs.map((def) =>
  def.local || def.noSession ? def : { ...def, inputSchema: { sessionToken, ...def.inputSchema } }
);

const toolNames = new Set(toolDefs.filter((tool) => !tool.local).map((tool) => tool.name));

function toMcpResult(result) {
  const content = [];
  if (result && typeof result === "object" && result.image) {
    content.push({
      type: "image",
      data: result.image.data,
      mimeType: result.image.mimeType || "image/png",
    });
  }
  let text;
  if (result && typeof result === "object") {
    if (typeof result.text === "string") text = result.text;
    else if ("data" in result) text = JSON.stringify(result.data, null, 2);
    else text = JSON.stringify(result, null, 2);
  } else {
    text = String(result);
  }
  content.push({ type: "text", text });
  return { content };
}

export function registerTools(server, { bridge, version, updates = null, logger = console }) {
  const notice = () => updates?.notice({ extensionVersion: bridge.lastHello?.version || null }) ?? null;
  for (const def of toolDefs) {
    server.registerTool(def.name, { description: def.description, inputSchema: def.inputSchema }, async (args) => {
      try {
        if (def.local) {
          const connected = bridge.connected;
          return toMcpResult({
            data: {
              daemon: "running",
              daemonVersion: version,
              latestVersion: updates?.latest ?? null,
              extensionConnected: connected,
              extensionVersion: bridge.lastHello?.version || null,
              recovery: connected
                ? null
                : "Open Chrome and enable TaskWindow. If it remains disconnected, run `taskwindow doctor`, then `taskwindow pair`.",
              update: notice(),
            },
          });
        }
        if (def.name === "browser_batch") return await runBatch(args, bridge, logger);
        // save_to_disk is a daemon-side concern: the extension has no disk
        // access, so it is stripped here and applied to the returned image.
        const { save_to_disk, ...forwardedArgs } = args;
        // A first tabs_create has no token yet; mint it here rather than in the
        // extension so a call that times out on the way back can still name
        // it. The retry with that token (same task and url) then gets the tab
        // the first call opened, not a second tab in a second group.
        if (def.name === "tabs_create" && !forwardedArgs.sessionToken) forwardedArgs.sessionToken = randomUUID();
        let result;
        try {
          result = await bridge.sendTool(def.name, forwardedArgs, def.timeoutMs);
        } catch (err) {
          if (err.code !== "TIMEOUT") throw err;
          throw new Error(`${err.message}. ${timeoutAdvice(def.name, forwardedArgs)}`);
        }
        if (save_to_disk && result?.image) {
          try {
            const savedPath = await saveImageToDisk(result.image);
            result.text = `${result.text || "image"}\nSaved to: ${savedPath}`;
          } catch (err) {
            logger.error(`[mcp] save_to_disk failed:`, err.message);
            result.text = `${result.text || "image"}\nError saving to disk: ${err.message}`;
          }
        }
        const mcp = toMcpResult(result);
        // tabs_create is the first call of every agent session, so a newer
        // release (or a stale extension) is mentioned once per session, here,
        // instead of on every response.
        if (def.name === "tabs_create") {
          const line = notice();
          if (line) mcp.content.push({ type: "text", text: line });
        }
        return mcp;
      } catch (err) {
        logger.error(`[mcp] ${def.name} failed:`, err.message);
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    });
  }
}

/**
 * What to do after the extension missed a tool's deadline. Chrome is slow to
 * wake, not dead: the call usually completes seconds later (the daemon logs
 * it), so a blind repeat doubles whatever it did.
 */
function timeoutAdvice(tool, args) {
  if (tool === "tabs_create") {
    return (
      `The tab may still be opening. Retry this exact call with sessionToken "${args.sessionToken}" ` +
      "(same task and url): it returns the tab the first call opened instead of opening another."
    );
  }
  return "Chrome may still complete the action; check the page (screenshot or read_page) before repeating anything that has side effects.";
}

/**
 * Write an image result to the session temp dir (OS-cleaned, like Claude's
 * chrome extension does). Timestamped naming so repeat shots never overwrite.
 */
async function saveImageToDisk(image) {
  const dir = path.join(os.tmpdir(), "taskwindow-screenshots");
  await mkdir(dir, { recursive: true });
  const ext = image.mimeType === "image/jpeg" ? "jpg" : "png";
  const filePath = path.join(dir, `taskwindow-${Date.now()}-${process.pid}.${ext}`);
  await writeFile(filePath, Buffer.from(image.data, "base64"));
  return filePath;
}

async function runBatch({ steps, sessionToken }, bridge, logger) {
  const results = [];
  for (let i = 0; i < steps.length; i++) {
    const { tool, params } = steps[i];
    if (!toolNames.has(tool)) {
      return {
        content: [{ type: "text", text: `Error: step ${i + 1}: unknown tool "${tool}"` }],
        isError: true,
      };
    }
    if (tool === "browser_batch") {
      return {
        content: [{ type: "text", text: `Error: step ${i + 1}: browser_batch cannot be nested` }],
        isError: true,
      };
    }
    try {
      const def = toolDefs.find((d) => d.name === tool);
      const result = await bridge.sendTool(tool, { ...params, sessionToken }, def.timeoutMs);
      results.push({ step: i + 1, tool, ok: true, result });
    } catch (err) {
      logger.error(`[mcp] batch step ${i + 1} (${tool}) failed:`, err.message);
      const summary = results.map((r) => `${r.step}. ${r.tool}: ok`).join("\n");
      return {
        content: [{
          type: "text",
          text: `Error: batch aborted at step ${i + 1} (${tool}): ${err.message}\n` +
            `Completed steps:\n${summary || "(none)"}`,
        }],
        isError: true,
      };
    }
  }
  return toMcpResult({
    text: results
      .map((r) => {
        const body = r.result && typeof r.result.text === "string"
          ? r.result.text
          : JSON.stringify(r.result?.data ?? r.result ?? null, null, 2);
        return `${r.step}. ${r.tool}:\n${body}`;
      })
      .join("\n\n"),
    data: results.map((r) => ({ tool: r.tool, ok: true })),
  });
}

export { toolDefs };
