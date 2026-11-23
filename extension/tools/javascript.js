import { resolveTab } from "./tabs.js";
import { withDebugger, send } from "./cdp.js";

let calls = 0;

// Evaluated over CDP (Runtime.evaluate), the same path the DevTools console
// uses: it runs in the page's main world and is exempt from the page's Content
// Security Policy. The earlier chrome.scripting + eval(src) approach was
// subject to that CSP, so every site without 'unsafe-eval' (x.com, reddit.com,
// GitHub, …) rejected the tool outright.
export async function javascriptExecute({ code, awaitPromise = true, tabId, sessionToken }) {
  const tab = await resolveTab(tabId, sessionToken);
  return withDebugger(tab.id, async (tid) => {
    const awaiting = awaitPromise !== false;
    // The result is taken as a handle first (see below). Chrome keeps the
    // object a handle names alive until the debugger detaches, which a tab
    // with render:true never does, so every handle of this call goes into one
    // group that is released when the call ends.
    const objectGroup = `javascript_execute:${++calls}`;
    try {
      let { result, exceptionDetails } = await send(tid, "Runtime.evaluate", {
        expression: code,
        awaitPromise: awaiting,
        returnByValue: false,
        userGesture: true,
        // REPL mode, as the DevTools console runs: a top-level `const ta = …`
        // from one call otherwise stays declared in the page for good, so the
        // next call reusing the name throws "Identifier 'ta' has already been
        // declared". It also allows top-level `await`.
        replMode: true,
        objectGroup,
      });
      // In REPL mode Chrome waits for a top-level `await` only. A Promise the
      // script evaluates to (`fetch(…).then(…)`, an async IIFE) comes back
      // pending, as the console prints it, and by value a Promise is `{}`: the
      // caller was told the page returned an empty object. So the value is
      // read in a second step, which waits for a Promise as `await` would.
      // A Promise the caller asked not to wait for stays a handle, reported
      // below as "Promise"; so does a symbol, which has no value form.
      const unawaited = !awaiting && result?.subtype === "promise";
      if (!exceptionDetails && result?.objectId && result.type !== "symbol" && !unawaited) {
        ({ result, exceptionDetails } = await send(tid, "Runtime.callFunctionOn", {
          objectId: result.objectId,
          functionDeclaration: "function () { return this; }",
          awaitPromise: awaiting,
          returnByValue: true,
        }));
      }
      if (exceptionDetails) {
        // A thrown or rejected string has no description, only its value.
        const thrown = exceptionDetails.exception;
        const detail = thrown?.description || thrown?.value || exceptionDetails.text || "Uncaught exception";
        throw new Error(`page script threw: ${detail}`);
      }
      let value = result?.value;
      if (value === undefined) {
        // Non-JSON results (undefined, NaN, symbols, an unawaited Promise…):
        // fall back to the description, or null so the result stays
        // serializable.
        value = result?.unserializableValue ?? result?.description ?? null;
      }
      return {
        data: { result: value },
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      };
    } finally {
      // Not through send(): it refuses a tab showing a dialog, and a script
      // that opened one has left its handle behind like any other. Chrome
      // runs the release once the dialog is answered.
      chrome.debugger.sendCommand({ tabId: tid }, "Runtime.releaseObjectGroup", { objectGroup }).catch(() => {});
    }
  });
}
