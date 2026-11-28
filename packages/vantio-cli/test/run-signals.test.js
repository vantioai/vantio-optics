// VAN-402: a stop signal sent to `vantio run` reaches the program.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, "..", "bin", "vantio.js");
const POSIX = process.platform !== "win32";
const proc = createRequire(import.meta.url)("../bin/optics-proc.cjs");

const CHILD = `
const fs = require("node:fs");
const [flag, mode] = process.argv.slice(2);
fs.writeFileSync(flag + ".ready", String(process.pid));
if (mode === "trap") {
  process.on("SIGTERM", () => { fs.writeFileSync(flag, "SIGTERM"); process.exit(0); });
}
if (mode === "trapall") {
  for (const sig of ["SIGINT", "SIGHUP", "SIGQUIT"]) {
    process.on(sig, () => { fs.writeFileSync(flag, sig); setTimeout(() => process.exit(0), 300); });
  }
}
if (mode === "exit7") setTimeout(() => process.exit(7), 200);
setInterval(() => {}, 1000);
`;

// detached: the wrapper gets its own session with no terminal, as under a
// supervisor, so the result does not depend on how the tests were started.
function start(home, mode, detached = false) {
  const childPath = join(home, "child.js");
  writeFileSync(childPath, CHILD);
  const flag = join(home, "flag");
  const proc = spawn(process.execPath, [CLI_PATH, "run", "node", childPath, flag, mode], {
    env: { PATH: process.env.PATH, HOME: home, VANTIO_TELEMETRY_DISABLED: "1", VANTIO_MCP_AWARENESS: "off" },
    stdio: ["ignore", "pipe", "pipe"],
    detached,
  });
  let stderr = "";
  proc.stderr.on("data", (c) => (stderr += c));
  // "exit", not "close": an orphaned child would keep the pipes open.
  const closed = new Promise((resolve) => proc.on("exit", (code, signal) => resolve({ code, signal, stderr })));
  return { proc, flag, closed };
}

async function waitFor(path, ms = 10000) {
  const deadline = Date.now() + ms;
  while (!existsSync(path) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  return existsSync(path);
}

// Wait for the wrapper to exit, at most ms, so a wrapper that never exits
// fails the test instead of hanging the run.
function exited(closed, ms = 5000) {
  return Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), ms))]);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function killChild(flag) {
  try { process.kill(Number(readFileSync(`${flag}.ready`, "utf8")), "SIGKILL"); } catch { /* gone */ }
}

describe("vantio run and stop signals", { skip: !POSIX, timeout: 60000 }, () => {
  test("SIGTERM to the wrapper reaches the program, and the wrapper exits with its status", { timeout: 15000 }, async () => {
    const home = mkdtempSync(join(tmpdir(), "vantio-sig-term-"));
    const { proc, flag, closed } = start(home, "trap");
    try {
      assert.ok(await waitFor(`${flag}.ready`), "child did not start");
      proc.kill("SIGTERM");
      const result = await closed;
      assert.equal(readFileSync(flag, "utf8"), "SIGTERM");
      assert.equal(result.code, 0, result.stderr);
      const childPid = Number(readFileSync(`${flag}.ready`, "utf8"));
      assert.equal(alive(childPid), false);
    } finally {
      proc.kill("SIGKILL");
      killChild(flag);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a program that dies of SIGTERM still ends the wrapper with SIGTERM", { timeout: 15000 }, async () => {
    const home = mkdtempSync(join(tmpdir(), "vantio-sig-default-"));
    const { proc, flag, closed } = start(home, "plain");
    try {
      assert.ok(await waitFor(`${flag}.ready`), "child did not start");
      proc.kill("SIGTERM");
      const result = await closed;
      assert.equal(result.signal, "SIGTERM", result.stderr);
      const childPid = Number(readFileSync(`${flag}.ready`, "utf8"));
      assert.equal(alive(childPid), false);
    } finally {
      proc.kill("SIGKILL");
      killChild(flag);
      rmSync(home, { recursive: true, force: true });
    }
  });

  for (const sig of ["SIGINT", "SIGHUP", "SIGQUIT"]) {
    test(`${sig} sent to the wrapper alone, not from a terminal, reaches the program`, { timeout: 15000 }, async () => {
      const home = mkdtempSync(join(tmpdir(), "vantio-sig-fwd-"));
      const { proc: wrapper, flag, closed } = start(home, "trapall", true);
      try {
        assert.ok(await waitFor(`${flag}.ready`), "child did not start");
        wrapper.kill(sig);
        assert.ok(await waitFor(flag, 5000), `the program did not get ${sig}`);
        assert.equal(readFileSync(flag, "utf8"), sig);
        // The program takes 300 ms to stop. The wrapper waits for it.
        assert.equal(wrapper.exitCode, null, "the wrapper must still be running");
        const result = await exited(closed);
        assert.equal(result.timedOut, undefined, "the wrapper did not exit");
        assert.equal(result.code, 0, result.stderr);
      } finally {
        wrapper.kill("SIGKILL");
        killChild(flag);
        rmSync(home, { recursive: true, force: true });
      }
    });
  }

  test("a program that dies of a forwarded SIGINT ends the wrapper with SIGINT", { timeout: 15000 }, async () => {
    const home = mkdtempSync(join(tmpdir(), "vantio-sig-int-"));
    const { proc: wrapper, flag, closed } = start(home, "plain", true);
    try {
      assert.ok(await waitFor(`${flag}.ready`), "child did not start");
      const childPid = Number(readFileSync(`${flag}.ready`, "utf8"));
      wrapper.kill("SIGINT");
      const result = await exited(closed);
      assert.equal(result.timedOut, undefined, "the wrapper did not exit");
      assert.equal(result.signal, "SIGINT", result.stderr);
      assert.equal(alive(childPid), false);
    } finally {
      wrapper.kill("SIGKILL");
      killChild(flag);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a normal exit code still passes through", { timeout: 15000 }, async () => {
    const home = mkdtempSync(join(tmpdir(), "vantio-sig-exit-"));
    const { proc, flag, closed } = start(home, "exit7");
    try {
      const result = await closed;
      assert.equal(result.code, 7, result.stderr);
    } finally {
      proc.kill("SIGKILL");
      killChild(flag);
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("terminal signals are not sent twice", () => {
  // /proc/<pid>/stat: pid (comm) state ppid pgrp session tty_nr tpgid ...
  const stat = (pgrp, tpgid, comm = "node") => `4242 (${comm}) S 1 ${pgrp} ${pgrp} 34816 ${tpgid} 4194304 0 0`;

  test("in the terminal's foreground group, the signal came from the terminal", () => {
    assert.equal(proc.inTerminalForeground(stat(4242, 4242)), true);
    assert.equal(proc.inTerminalForeground(stat(4242, 4242, "a) b (c")), true);
  });

  test("no terminal, or a background group, means the signal is forwarded", () => {
    assert.equal(proc.inTerminalForeground(stat(4242, -1)), false);
    assert.equal(proc.inTerminalForeground(stat(4242, 5000)), false);
    assert.equal(proc.inTerminalForeground(""), false);
    assert.equal(proc.inTerminalForeground("garbage"), false);
  });

  test("signalFromTerminal reads the stat file under procRoot", () => {
    const root = mkdtempSync(join(tmpdir(), "vantio-sig-proc-"));
    try {
      mkdirSync(join(root, "self"));
      writeFileSync(join(root, "self", "stat"), stat(7, 7));
      assert.equal(proc.signalFromTerminal({ procRoot: root }), true);
      writeFileSync(join(root, "self", "stat"), stat(7, -1));
      assert.equal(proc.signalFromTerminal({ procRoot: root }), false);
      rmSync(join(root, "self", "stat"));
      assert.equal(proc.signalFromTerminal({ procRoot: root }), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
