const RETRY_MS = 300;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function readHealth(port) {
  try {
    const response = await fetchWithTimeout(`http://127.0.0.1:${port}/health`);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function waitForHealth(port, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    const health = await readHealth(port);
    if (health && predicate(health)) return health;
    await delay(RETRY_MS);
  } while (Date.now() < deadline);
  return null;
}

export function waitForDaemon(port, timeoutMs = 10_000) {
  return waitForHealth(port, (health) => health.ok === true, timeoutMs);
}

export function waitForExtension(port, timeoutMs = 5 * 60 * 1000) {
  return waitForHealth(port, (health) => health.extensionConnected === true, timeoutMs);
}

export async function requestPairCode({ port, token }) {
  const response = await fetchWithTimeout(
    `http://127.0.0.1:${port}/pair/request`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    },
    3000
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.code) {
    throw new Error(body.error || `pairing request failed (HTTP ${response.status})`);
  }
  return body;
}

/** Extension connected and running exactly `version` (after an update/reload). */
export function waitForExtensionVersion(port, version, timeoutMs = 90_000) {
  return waitForHealth(port, (health) => health.extensionConnected === true && health.extensionVersion === version, timeoutMs);
}

/**
 * Ask the daemon to have the extension reload itself (re-reads the unpacked
 * files from disk). Resolves {ok:true} or {ok:false, error} — an extension
 * that predates the reload handler answers "Unknown tool", and a daemon that
 * predates the endpoint answers 404; both mean "reload by hand".
 */
export async function requestExtensionReload({ port, token }) {
  try {
    const response = await fetchWithTimeout(
      `http://127.0.0.1:${port}/extension/reload`,
      { method: "POST", headers: { authorization: `Bearer ${token}` } },
      10_000
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, error: body.error || `HTTP ${response.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
