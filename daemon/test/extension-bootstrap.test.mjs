import test from "node:test";
import assert from "node:assert/strict";

test("the extension redeems an installer bootstrap without storing the code as its token", async () => {
  const writes = [];
  const requests = [];
  globalThis.chrome = {
    runtime: { getURL: (path) => `chrome-extension://taskwindow/${path}` },
    storage: { local: { set: async (value) => writes.push(value) } },
  };
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).startsWith("chrome-extension://")) {
      return new Response(JSON.stringify({ code: "ABC234", port: 9377 }), { status: 200 });
    }
    return new Response(JSON.stringify({ token: "daemon-secret" }), { status: 200 });
  };

  try {
    const { claimInstallerBootstrap } = await import("../../extension/tools/bootstrap.js");
    const result = await claimInstallerBootstrap();
    assert.deepEqual(result, { token: "daemon-secret", port: 9377 });
    assert.deepEqual(writes, [{ token: "daemon-secret", port: 9377 }]);
    assert.equal(requests[1].url, "http://127.0.0.1:9377/pair");
    assert.deepEqual(JSON.parse(requests[1].options.body), { code: "ABC234" });
    assert.equal(JSON.stringify(writes).includes("ABC234"), false);
  } finally {
    delete globalThis.chrome;
    delete globalThis.fetch;
  }
});

