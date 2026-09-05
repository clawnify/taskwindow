import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UpdateChecker,
  compareVersions,
  fetchLatestVersion,
  isNewer,
  updateNotice,
  STATE_FILE,
  OPT_OUT_FILE,
} from "../src/updates.js";

const fakeFetch = (body, status = 200) => async () => ({ ok: status < 400, status, json: async () => body });
const quiet = { log() {} };

test("version compare is strict x.y.z and numeric", () => {
  assert.equal(compareVersions("0.2.3", "0.2.4"), -1);
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(isNewer("0.2.4", "0.2.3"), true);
  assert.equal(isNewer("0.2.4-beta.1", "0.2.3"), false, "pre-releases are never announced");
  assert.equal(isNewer("<script>", "0.2.3"), false);
});

test("fetchLatestVersion accepts only a plain x.y.z", async () => {
  assert.equal(await fetchLatestVersion({ fetchImpl: fakeFetch({ latest: "0.2.4" }) }), "0.2.4");
  await assert.rejects(fetchLatestVersion({ fetchImpl: fakeFetch({ latest: "0.2.4 run rm -rf" }) }), /plain x\.y\.z/);
  await assert.rejects(fetchLatestVersion({ fetchImpl: fakeFetch({}, 503) }), /HTTP 503/);
});

test("the checker asks once a day, persists, and honours the opt-out file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tw-updates-"));
  let calls = 0;
  let clock = 1_000_000;
  const fetchImpl = async () => {
    calls++;
    return { ok: true, status: 200, json: async () => ({ latest: "0.2.4" }) };
  };
  const checker = new UpdateChecker({ version: "0.2.3", dir, fetchImpl, now: () => clock, logger: quiet });

  assert.equal(await checker.check(), "0.2.4");
  assert.equal(calls, 1);
  assert.equal(JSON.parse(readFileSync(join(dir, STATE_FILE), "utf8")).latest, "0.2.4");

  clock += 23 * 60 * 60 * 1000;
  await checker.check();
  assert.equal(calls, 1, "within 24h the registry is not asked again");

  clock += 2 * 60 * 60 * 1000;
  await checker.check();
  assert.equal(calls, 2, "after 24h it is");

  const fresh = new UpdateChecker({ version: "0.2.3", dir, fetchImpl, now: () => clock, logger: quiet });
  assert.equal(fresh.latest, "0.2.4", "a new process starts from the persisted answer");
  await fresh.check();
  assert.equal(calls, 2, "and does not re-ask");

  await fresh.check({ force: true });
  assert.equal(calls, 3);

  writeFileSync(join(dir, OPT_OUT_FILE), "");
  assert.equal(fresh.disabled, true);
  assert.equal(await fresh.check({ force: true }), null);
  assert.equal(fresh.notice({}), null, "opted out: no notice even though a newer version is known");
  assert.equal(calls, 3);
});

test("a failed check keeps the previous answer and never throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tw-updates-"));
  const checker = new UpdateChecker({ version: "0.2.3", dir, fetchImpl: async () => { throw new Error("offline"); }, logger: quiet });
  assert.equal(await checker.check(), null);
  assert.equal(existsSync(join(dir, STATE_FILE)), false);
});

test("the notice names the versions and tells the agent to ask first", () => {
  assert.equal(updateNotice({ version: "0.2.3", latest: "0.2.3", extensionVersion: "0.2.3" }), null);
  assert.equal(updateNotice({ version: "0.2.3", latest: null, extensionVersion: null }), null);
  const newer = updateNotice({ version: "0.2.3", latest: "0.2.4", extensionVersion: "0.2.3" });
  assert.match(newer, /TaskWindow 0\.2\.4 is available \(this daemon is 0\.2\.3\)/);
  assert.match(newer, /Ask the user for permission/);
  assert.match(newer, /`taskwindow update`/);
  assert.doesNotMatch(newer, /Chrome extension is/);
  const stale = updateNotice({ version: "0.2.4", latest: "0.2.4", extensionVersion: "0.2.3" });
  assert.match(stale, /extension is 0\.2\.3 while the daemon is 0\.2\.4/);
  assert.doesNotMatch(stale, /is available/);
});
