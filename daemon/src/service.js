/**
 * Login-service installer: keeps the daemon running across restarts without a
 * terminal. macOS uses launchd; Linux uses a systemd user unit; anything else
 * gets manual instructions.
 */
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const LABEL = "com.clawnify.taskwindow";

function nodePath() {
  return process.execPath;
}

export function installService(daemonEntryPath, port) {
  const system = platform();
  const logPath = join(homedir(), ".taskwindow", "daemon.log");
  mkdirSync(join(homedir(), ".taskwindow"), { recursive: true });

  if (system === "darwin") {
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
    const uid = process.getuid?.() ?? 501;
    try {
      execSync(`launchctl bootout gui/${uid}/${LABEL} 2>/dev/null`, { shell: "/bin/bash" });
    } catch {}
    execSync(`launchctl bootstrap gui/${uid} "${plistPath}"`);
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
