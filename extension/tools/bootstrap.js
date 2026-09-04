const BOOTSTRAP_FILE = "taskwindow-bootstrap.json";
let rejectedCode = null;

/**
 * Redeem the installer-created, short-lived code on first launch. The file
 * never contains the daemon token; the token is returned only by localhost
 * after a successful one-time claim.
 */
export async function claimInstallerBootstrap() {
  let bootstrap;
  try {
    const file = await fetch(chrome.runtime.getURL(BOOTSTRAP_FILE), { cache: "no-store" });
    if (!file.ok) return null;
    bootstrap = await file.json();
  } catch {
    return null;
  }

  const code = String(bootstrap?.code || "").trim().toUpperCase();
  const port = Number(bootstrap?.port) || 9377;
  if (!code || code === rejectedCode) return null;

  let response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
  } catch {
    return null; // daemon may still be starting; retry on the next connection attempt
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.token) {
    rejectedCode = code;
    return null;
  }
  await chrome.storage.local.set({ token: body.token, port });
  return { token: body.token, port };
}
