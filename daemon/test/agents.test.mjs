import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addCodexAuthorization,
  codexConfigHasTaskWindow,
  inspectAgents,
  registerCodex,
  registerOpenClaw,
} from "../src/agents.js";

test("Codex detection and configuration are reported independently", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "taskwindow-agents-"));
  try {
    mkdirSync(join(homeDir, ".codex"));
    writeFileSync(
      join(homeDir, ".codex", "config.toml"),
      '[mcp_servers."taskwindow"]\nurl = "http://127.0.0.1:9377/mcp"\n'
    );
    const agents = inspectAgents({
      homeDir,
      codexHome: join(homeDir, ".codex"),
      hasCommand: (command) => command === "codex",
    });
    const codex = agents.find((agent) => agent.id === "codex");
    assert.deepEqual(codex, {
      id: "codex",
      label: "Codex",
      detected: true,
      configured: true,
    });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("Codex registration uses its CLI and adds the supported static header", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "taskwindow-agents-"));
  const configDir = join(homeDir, ".codex");
  const configPath = join(configDir, "config.toml");
  mkdirSync(configDir);
  writeFileSync(configPath, 'model = "gpt-test"\n');
  chmodSync(configPath, 0o644);
  const calls = [];
  const execFile = (command, args, options) => {
    calls.push({ command, args, stdio: options.stdio });
    if (args[1] === "add") {
      writeFileSync(
        configPath,
        'model = "gpt-test"\n\n[mcp_servers.taskwindow]\nurl = "http://127.0.0.1:9444/mcp"\n'
      );
    }
    if (args[1] === "get") {
      assert.match(readFileSync(configPath, "utf8"), /http_headers = \{ Authorization = "Bearer secret-token" \}/);
      return JSON.stringify({ enabled: true, transport: {
        type: "streamable_http", url: "http://127.0.0.1:9444/mcp",
        http_headers: { Authorization: "Bearer secret-token" },
      } });
    }
  };
  try {
    registerCodex(
      { port: 9444, token: "secret-token" },
      { homeDir, codexHome: configDir, execFile }
    );
    assert.deepEqual(calls, [
      {
        command: "codex",
        args: ["mcp", "add", "taskwindow", "--url", "http://127.0.0.1:9444/mcp"],
        stdio: ["ignore", "pipe", "pipe"],
      },
      { command: "codex", args: ["mcp", "get", "taskwindow", "--json"], stdio: ["ignore", "pipe", "pipe"] },
    ]);
    assert.match(readFileSync(configPath, "utf8"), /^model = "gpt-test"/);
    assert.equal(statSync(configPath).mode & 0o777, 0o600);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("failed Codex validation restores the original config", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "taskwindow-agents-"));
  const configDir = join(homeDir, ".codex");
  const configPath = join(configDir, "config.toml");
  const original = 'model = "keep-me"\n';
  mkdirSync(configDir);
  writeFileSync(configPath, original);
  chmodSync(configPath, 0o640);
  const execFile = (_command, args) => {
    if (args[1] === "add") {
      writeFileSync(configPath, '[mcp_servers.taskwindow]\nurl = "http://127.0.0.1:9377/mcp"\n');
    }
    if (args[1] === "get") throw new Error("invalid config");
  };
  try {
    assert.throws(
      () => registerCodex(
        { port: 9377, token: "token" },
        { homeDir, codexHome: configDir, execFile }
      ),
      /original configuration restored/
    );
    assert.equal(readFileSync(configPath, "utf8"), original);
    assert.equal(statSync(configPath).mode & 0o777, 0o640);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("Codex config matching ignores similarly named servers", () => {
  assert.equal(codexConfigHasTaskWindow("[mcp_servers.taskwindow-preview]\n"), false);
  assert.throws(() => addCodexAuthorization("[mcp_servers.other]\n", "token"), /did not create/);
});

test("a failed removal never proceeds to add or leaks command output", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "taskwindow-agents-"));
  const path = join(codexHome, "config.toml");
  const original = '[mcp_servers.taskwindow]\nurl = "http://127.0.0.1:9377/mcp"\n';
  writeFileSync(path, original);
  const calls = [];
  try {
    assert.throws(() => registerCodex({ port: 9377, token: "secret" }, {
      codexHome,
      execFile: (_command, args) => {
        calls.push(args[1]);
        throw new Error("failed command included secret");
      },
    }), (err) => {
      assert.doesNotMatch(err.message, /secret/);
      return /original configuration restored/.test(err.message);
    });
    assert.deepEqual(calls, ["remove"]);
    assert.equal(readFileSync(path, "utf8"), original);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("a parseable but incorrect registration is rejected and a new config is removed", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "taskwindow-agents-"));
  const path = join(codexHome, "config.toml");
  try {
    assert.throws(() => registerCodex({ port: 9377, token: "secret" }, {
      codexHome,
      execFile: (_command, args) => {
        if (args[1] === "add") writeFileSync(path, '[mcp_servers.taskwindow]\nurl = "http://127.0.0.1:9377/mcp"\n');
        return JSON.stringify({ enabled: false, transport: { type: "streamable_http" } });
      },
    }), /original configuration restored/);
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("header insertion stays inside the server table with CRLF and comments", () => {
  const contents = '[mcp_servers."taskwindow"] # local\r\n\r\nurl = "http://127.0.0.1:9377/mcp"\r\n\r\n[projects.other]\r\ntrust_level = "trusted"\r\n';
  assert.equal(addCodexAuthorization(contents, "token"), contents.replace(
    '# local\r\n', '# local\r\nhttp_headers = { Authorization = "Bearer token" }\r\n'
  ));
});

test("OpenClaw detection reads the config its state dir points at", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "taskwindow-agents-"));
  const stateDir = join(homeDir, "claw-state");
  try {
    mkdirSync(stateDir);
    writeFileSync(
      join(stateDir, "openclaw.json"),
      JSON.stringify({ mcp: { servers: { taskwindow: { url: "http://127.0.0.1:9377/mcp" } } } })
    );
    const agents = inspectAgents({
      homeDir,
      hasCommand: (command) => command === "openclaw",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    assert.deepEqual(agents.find((agent) => agent.id === "openclaw"), {
      id: "openclaw",
      label: "OpenClaw",
      detected: true,
      configured: true,
    });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("OpenClaw registration patches over stdin, keeping the token out of argv", () => {
  const calls = [];
  const execFile = (command, args, options) => {
    calls.push({ command, args, input: options.input });
    if (args[1] === "show") {
      return JSON.stringify({
        url: "http://127.0.0.1:9444/mcp",
        transport: "streamable-http",
        headers: { Authorization: "Bearer secret-token" },
      });
    }
    return "";
  };
  registerOpenClaw({ port: 9444, token: "secret-token" }, { execFile });
  assert.deepEqual(calls.map(({ command, args }) => [command, ...args]), [
    ["openclaw", "config", "patch", "--stdin", "--replace-path", "mcp.servers.taskwindow"],
    ["openclaw", "mcp", "show", "taskwindow", "--json"],
  ]);
  assert.deepEqual(JSON.parse(calls[0].input), {
    mcp: { servers: { taskwindow: {
      url: "http://127.0.0.1:9444/mcp",
      transport: "streamable-http",
      headers: { Authorization: "Bearer secret-token" },
    } } },
  });
  assert.doesNotMatch(calls.flatMap(({ args }) => args).join(" "), /secret-token/);
});

test("an OpenClaw entry that reads back wrong fails without leaking the token", () => {
  const execFile = (_command, args) => {
    if (args[1] === "show") {
      return JSON.stringify({ url: "http://127.0.0.1:9377/mcp", headers: { Authorization: "Bearer secret" } });
    }
    return "";
  };
  assert.throws(() => registerOpenClaw({ port: 9377, token: "secret" }, { execFile }), (err) => {
    assert.doesNotMatch(err.message, /secret/);
    return /OpenClaw registration failed/.test(err.message);
  });
});

test("a missing OpenClaw CLI says how to fix it", () => {
  const execFile = () => {
    throw Object.assign(new Error("spawn openclaw ENOENT"), { code: "ENOENT" });
  };
  assert.throws(
    () => registerOpenClaw({ port: 9377, token: "secret" }, { execFile }),
    /install the OpenClaw CLI/
  );
});
