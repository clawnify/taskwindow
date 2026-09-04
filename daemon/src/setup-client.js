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

