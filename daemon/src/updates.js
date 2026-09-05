/**
 * "Is there a newer TaskWindow?" — asked of the npm registry (the same place
 * `npm install -g taskwindow@latest` resolves, so a version announced here is
 * always installable), at most once a day, persisted so daemon restarts don't
 * re-ask. Nothing about the machine is sent: it is a GET of the package's
 * dist-tags. Opt out with the `no-update-check` marker file in the TaskWindow
 * dir (the daemon runs under launchd/systemd and sees no shell environment) or
 * TASKWINDOW_NO_UPDATE_CHECK=1 for ad-hoc runs.
 *
 * The result reaches agents as a line in `tabs_create` results (the first tool
 * every agent calls) and in `taskwindow_status`; see notice().
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const REGISTRY_URL = "https://registry.npmjs.org/-/package/taskwindow/dist-tags";
export const STATE_FILE = "update-check.json";
export const OPT_OUT_FILE = "no-update-check";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RECHECK_MS = 6 * 60 * 60 * 1000;
const SEMVER = /^\d+\.\d+\.\d+$/;

/** Strict x.y.z compare; anything else (pre-releases, garbage) is never "newer". */
export function compareVersions(a, b) {
  if (!SEMVER.test(String(a)) || !SEMVER.test(String(b))) return 0;
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

export function isNewer(candidate, current) {
  return compareVersions(candidate, current) > 0;
}

/** One network round trip; throws on failure or on a malformed answer. */
export async function fetchLatestVersion({ url = process.env.TASKWINDOW_UPDATE_CHECK_URL || REGISTRY_URL, fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`registry answered HTTP ${response.status}`);
    const body = await response.json();
    const latest = body?.latest;
    // Only a plain x.y.z ever gets interpolated into text an agent reads.
    if (!SEMVER.test(String(latest))) throw new Error("registry answer had no plain x.y.z latest version");
    return String(latest);
  } finally {
    clearTimeout(timer);
  }
}

export function readUpdateState(dir) {
  try {
    const state = JSON.parse(readFileSync(join(dir, STATE_FILE), "utf8"));
    return {
      checkedAt: Number(state?.checkedAt) || 0,
      latest: SEMVER.test(String(state?.latest)) ? String(state.latest) : null,
    };
  } catch {
    return { checkedAt: 0, latest: null };
  }
}

export function updateCheckDisabled(dir, env = process.env) {
  return env.TASKWINDOW_NO_UPDATE_CHECK === "1" || existsSync(join(dir, OPT_OUT_FILE));
}

/** The line agents get. `null` when everything is current (or unknown). */
export function updateNotice({ version, latest, extensionVersion }) {
  const problems = [];
  if (latest && isNewer(latest, version)) {
    problems.push(`TaskWindow ${latest} is available (this daemon is ${version}).`);
  }
  if (extensionVersion && extensionVersion !== version) {
    problems.push(`The TaskWindow Chrome extension is ${extensionVersion} while the daemon is ${version}.`);
  }
  if (problems.length === 0) return null;
  return (
    `${problems.join(" ")} Ask the user for permission, then run \`taskwindow update\` in a terminal ` +
    "(about a minute; open tabs survive, the tools reconnect on their own — check with taskwindow_status). " +
    "Never run it without the user's OK."
  );
}

export class UpdateChecker {
  constructor({ version, dir, fetchImpl, now = Date.now, logger = console }) {
    this.version = version;
    this.dir = dir;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.logger = logger;
    this.state = readUpdateState(dir);
    this.timer = null;
  }

  get disabled() {
    return updateCheckDisabled(this.dir);
  }

  /** Latest known version, from this process or an earlier one via the state file. */
  get latest() {
    return this.state.latest;
  }

  notice({ extensionVersion } = {}) {
    return updateNotice({ version: this.version, latest: this.disabled ? null : this.latest, extensionVersion });
  }

  /** Refresh if the last check is older than a day (or `force`). Never throws. */
  async check({ force = false } = {}) {
    if (this.disabled) return null;
    const fresh = this.state.checkedAt > 0 && this.now() - this.state.checkedAt < MAX_AGE_MS;
    if (!force && fresh) return this.state.latest;
    try {
      const latest = await fetchLatestVersion({ fetchImpl: this.fetchImpl });
      this.state = { checkedAt: this.now(), latest };
      try {
        writeFileSync(join(this.dir, STATE_FILE), JSON.stringify(this.state, null, 2) + "\n");
      } catch {}
      if (isNewer(latest, this.version)) this.logger.log(`[taskwindow] update available: ${latest} (running ${this.version}) — taskwindow update`);
      return latest;
    } catch (err) {
      this.logger.log(`[taskwindow] update check skipped: ${err.message}`);
      return this.state.latest;
    }
  }

  start() {
    if (this.disabled) return;
    this.check();
    this.timer = setInterval(() => this.check(), RECHECK_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}
