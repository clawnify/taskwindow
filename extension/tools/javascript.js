import { resolveTab } from "./tabs.js";

export async function javascriptExecute({ code, awaitPromise = true, world = "MAIN", tabId }) {
  const tab = await resolveTab(tabId);
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: world === "ISOLATED" ? "ISOLATED" : "MAIN",
    injectImmediately: true,
    func: async (src, waitFor) => {
      const jsonify = (v) => {
        try {
          if (v === undefined) return null;
          if (v === null || typeof v !== "object") return v;
          return JSON.parse(JSON.stringify(v));
        } catch {
          try {
            return String(v);
          } catch {
            return "[unserializable]";
          }
        }
      };
      try {
        let result = eval(src);
        if (waitFor && result && typeof result.then === "function") result = await result;
        return { ok: true, value: jsonify(result) };
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    },
    args: [code, awaitPromise !== false],
  });

  const outcome = injection?.result;
  if (!outcome) throw new Error("script returned nothing (page may block script injection)");
  if (outcome.ok === false) throw new Error(`page script threw: ${outcome.error}`);
  return {
    data: { result: outcome.value },
    text: typeof outcome.value === "string" ? outcome.value : JSON.stringify(outcome.value, null, 2),
  };
}
