/**
 * Login-service installer: keeps the daemon running across restarts without a
 * terminal. macOS uses launchd; Linux uses a systemd user unit; anything else
 * gets manual instructions.
 */
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { chmodSync, writeFileSync, unlinkSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";

const LABEL = "com.clawnify.taskwindow";
const EXTENSION_DIRNAME = "TaskWindow Extension";
const BOOTSTRAP_FILENAME = "taskwindow-bootstrap.json";

export function extensionInstallDir(home = homedir()) {
  return join(home, EXTENSION_DIRNAME);
}

export function extensionBootstrapPath(home = homedir()) {
  return join(extensionInstallDir(home), BOOTSTRAP_FILENAME);
}

export function removeExtensionBootstrap(home = homedir()) {
  try {
    unlinkSync(extensionBootstrapPath(home));
  } catch {}
}

function nodePath() {
  return process.execPath;
}

export function installService(daemonEntryPath, port) {
  const system = platform();
  const logPath = join(homedir(), ".taskwindow", "daemon.log");
  mkdirSync(join(homedir(), ".taskwindow"), { recursive: true });

  if (system === "darwin") {
    const uid = process.getuid?.() ?? 501;
    const labelTarget = `gui/${uid}/${LABEL}`;
    const plistPath = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath()}</string>
    <string>${daemonEntryPath}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${logPath}</string>
  <key>StandardErrorPath</key><string>${logPath}</string>
</dict>
</plist>
`;
    writeFileSync(plistPath, plist);

    // Unload any previously loaded instance. launchd is asynchronous about
    // bootout: bootstrap immediately after it fails with EIO, so wait until
    // the label is really gone (up to 5s).
    try {
      execSync(`launchctl bootout ${labelTarget} 2>/dev/null`);
    } catch {}
    const unloaded = () => {
      try {
        execSync(`launchctl print ${labelTarget}`, { stdio: "pipe" });
        return false;
      } catch {
        return true;
      }
    };
    const deadline = Date.now() + 5000;
    while (!unloaded() && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, Date.now() + 300);
    }
    if (!unloaded()) {
      throw new Error(`couldn't unload the previous service — run: launchctl bootout ${labelTarget}`);
    }
    try {
      execSync(`launchctl bootstrap gui/${uid} "${plistPath}"`, { stdio: "pipe" });
    } catch (err) {
      throw new Error(`launchctl bootstrap failed (${err.status ?? "?"}) — try: launchctl bootout ${labelTarget}, then re-run`);
    }
    console.log(`[taskwindow] login service installed (${plistPath})`);
    console.log(`[taskwindow] daemon starts at login, restarts on crash, logs to ${logPath}`);
    return;
  }

  if (system === "linux") {
    const unitPath = join(homedir(), ".config", "systemd", "user", "taskwindow.service");
    mkdirSync(join(homedir(), ".config", "systemd", "user"), { recursive: true });
    const unit = `[Unit]
Description=TaskWindow daemon

[Service]
ExecStart=${nodePath()} ${daemonEntryPath}
Restart=on-failure
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`;
    writeFileSync(unitPath, unit);
    execSync("systemctl --user daemon-reload");
    execSync("systemctl --user enable --now taskwindow.service");
    console.log(`[taskwindow] login service installed (${unitPath})`);
    return;
  }

  console.log(`[taskwindow] automatic login services aren't supported on ${system}.`);
  console.log(`[taskwindow] run the daemon with: node ${daemonEntryPath}`);
}

/**
 * Extension onboarding: fetch (or unzip a given) release zip, open Chrome at
 * chrome://extensions, and print the exact remaining clicks. Chrome blocks
 * programmatic unpacked installs, so a human does the final 3 clicks — the
 * command does everything else.
 */
/**
 * Download the extension zip of one release (`version` like "0.2.4"; omit for
 * the latest release). Returns the local zip path.
 */
export function downloadExtensionZip(version) {
  const releaseApi = version
    ? `https://api.github.com/repos/clawnify/taskwindow/releases/tags/v${version}`
    : "https://api.github.com/repos/clawnify/taskwindow/releases/latest";
  try {
    const release = JSON.parse(execFileSync("curl", ["-sL", releaseApi], { maxBuffer: 20e6 }).toString());
    const asset = (release.assets || []).find((a) => a.name.startsWith("TaskWindow-extension-"));
    if (!asset) throw new Error(`no extension asset in the ${version ? `v${version}` : "latest"} release`);
    mkdirSync(join(homedir(), ".taskwindow"), { recursive: true });
    const zipPath = join(homedir(), ".taskwindow", asset.name);
    execFileSync("curl", ["-sL", "-o", zipPath, asset.browser_download_url]);
    console.log(`[taskwindow] downloaded ${asset.name}`);
    return zipPath;
  } catch (err) {
    throw new Error(
      `couldn't download the extension zip (${err.message}). Download it from ` +
        "https://github.com/clawnify/taskwindow/releases and re-run with --extension <zip>"
    );
  }
}

/**
 * Replace the unpacked extension files with a zip's contents. The folder path
 * is what Chrome has loaded, so it is kept and emptied rather than recreated;
 * emptying first means files dropped by the new version don't linger.
 */
export function refreshExtensionFiles(zipPath) {
  const extDir = extensionInstallDir();
  mkdirSync(extDir, { recursive: true });
  for (const entry of readdirSync(extDir)) {
    if (entry === BOOTSTRAP_FILENAME) continue;
    rmSync(join(extDir, entry), { recursive: true, force: true });
  }
  execFileSync("unzip", ["-oq", zipPath, "-d", extDir]);
  return extDir;
}

export function installExtension(zipPath, { port, pairingCode } = {}) {
  // This folder must remain visible in macOS's file picker: Chrome asks the
  // user to select it after clicking "Load unpacked", and Finder hides paths
  // whose names begin with a period by default.
  const open = (u) => {
    try {
      execFileSync("open", ["-a", "Google Chrome", u]);
      return true;
    } catch {
      return false;
    }
  };

  const extDir = refreshExtensionFiles(zipPath || downloadExtensionZip());
  if (pairingCode && port) {
    const bootstrapPath = extensionBootstrapPath();
    writeFileSync(bootstrapPath, JSON.stringify({ code: pairingCode, port }, null, 2) + "\n", { mode: 0o600 });
    chmodSync(bootstrapPath, 0o600);
  }
  console.log(`[taskwindow] extension unpacked to ${extDir}`);
  if (open("chrome://extensions")) {
    console.log("[taskwindow] opened chrome://extensions in Chrome — finish in 3 clicks:");
  } else {
    console.log("[taskwindow] open chrome://extensions in Chrome — finish in 3 clicks:");
  }
  console.log("  1. turn on Developer mode (top right)");
  console.log(`  2. click "Load unpacked" and select: ${extDir}`);
  console.log("  3. TaskWindow will connect automatically");
  return extDir;
}

export function uninstallService() {
  const system = platform();
  try {
    if (system === "darwin") {
      const uid = process.getuid?.() ?? 501;
      try {
        execSync(`launchctl bootout gui/${uid}/${LABEL}`);
      } catch {}
      unlinkSync(join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`));
    } else if (system === "linux") {
      execSync("systemctl --user disable --now taskwindow.service");
      unlinkSync(join(homedir(), ".config", "systemd", "user", "taskwindow.service"));
      execSync("systemctl --user daemon-reload");
    } else {
      console.log("[taskwindow] nothing to uninstall on this platform");
      return;
    }
    console.log("[taskwindow] login service removed");
  } catch (err) {
    console.error("[taskwindow] uninstall failed:", err.message);
  }
}
