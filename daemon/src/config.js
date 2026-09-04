import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";

export function loadConfig() {
  const port = Number(process.env.TASKWINDOW_PORT || process.env.AGENTTAB_PORT || 9377);
  const dir = process.env.TASKWINDOW_DIR || process.env.OPENTAB_DIR || process.env.AGENTTAB_DIR || join(homedir(), ".taskwindow");
  let token = process.env.TASKWINDOW_TOKEN || process.env.OPENTAB_TOKEN || process.env.AGENTTAB_TOKEN;

  if (!token) {
    const tokenPath = join(dir, "token");
    try {
      token = readFileSync(tokenPath, "utf8").trim();
    } catch {
      mkdirSync(dir, { recursive: true });
      // One-time migration from pre-rename config dirs.
      const legacyPaths = [join(homedir(), ".opentab", "token"), join(homedir(), ".agenttab", "token")];
      let migrated = null;
      for (const legacyPath of legacyPaths || []) {
        try {
          token = readFileSync(legacyPath, "utf8").trim();
          migrated = legacyPath;
          break;
        } catch {}
      }
      try {
        if (migrated) {
          writeFileSync(tokenPath, token + "\n", { mode: 0o600 });
          console.log(`[taskwindow] migrated token from ${migrated} to ${tokenPath}`);
        } else {
          token = randomBytes(24).toString("base64url");
          writeFileSync(tokenPath, token + "\n", { mode: 0o600 });
          console.log(`[taskwindow] generated new token at ${tokenPath}`);
        }
      } catch (err) {
        console.error(`[taskwindow] token bootstrap failed:`, err.message);
        process.exit(1);
      }
    }
  }

  return { port, dir, token };
}
