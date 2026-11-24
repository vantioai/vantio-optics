// VAN-402: a stop signal sent to `vantio run` reaches the program.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, "..", "bin", "vantio.js");
const POSIX = process.platform !== "win32";

const CHILD = `
const fs = require("node:fs");
const [flag, mode] = process.argv.slice(2);
fs.writeFileSync(flag + ".ready", String(process.pid));
if (mode === "trap") {
  process.on("SIGTERM", () => { fs.writeFileSync(flag, "SIGTERM"); process.exit(0); });
}
if (mode === "exit7") setTimeout(() => process.exit(7), 200);
setInterval(() => {}, 1000);
`;

function start(home, mode) {
  const childPath = join(home, "child.js");
  writeFileSync(childPath, CHILD);
  const flag = join(home, "flag");
  const proc = spawn(process.execPath, [CLI_PATH, "run", "node", childPath, flag, mode], {
    env: { PATH: process.env.PATH, HOME: home, VANTIO_TELEMETRY_DISABLED: "1", VANTIO_MCP_AWARENESS: "off" },
    stdio: ["ignore", "pipe", "pipe"],
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

  test("SIGINT to the wrapper alone does not end it before the program", { timeout: 15000 }, async () => {
    const home = mkdtempSync(join(tmpdir(), "vantio-sig-int-"));
    const { proc, flag, closed } = start(home, "plain");
    try {
      assert.ok(await waitFor(`${flag}.ready`), "child did not start");
      const childPid = Number(readFileSync(`${flag}.ready`, "utf8"));
      proc.kill("SIGINT");
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(proc.exitCode, null, "the wrapper must still be running");
      assert.equal(proc.signalCode, null);
      assert.equal(alive(childPid), true);
      process.kill(childPid, "SIGTERM");
      const result = await closed;
      assert.equal(result.signal, "SIGTERM");
    } finally {
      proc.kill("SIGKILL");
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
