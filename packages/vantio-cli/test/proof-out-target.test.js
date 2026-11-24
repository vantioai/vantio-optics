// VAN-395 follow-up: --out may name a pipe or a terminal. /dev/stdout and
// /dev/fd/N are this process's own descriptors, a symlink to a device cannot
// replace a file, and only a regular file is made 0600.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, "..", "bin", "vantio.js");
const POSIX = process.platform !== "win32";
const HAS_MKFIFO = POSIX && spawnSync("mkfifo", ["--help"]).error == null;

function runCli(args, home) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: { PATH: process.env.PATH, HOME: home, VANTIO_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function homeWithRun() {
  const home = mkdtempSync(join(tmpdir(), "vantio-out-"));
  const dir = join(home, ".vantio", "runs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "0xout.json"), JSON.stringify({
    vantio_run_log: "1",
    trace_id: "0xout",
    generated_at: "2026-11-24T00:00:01.000Z",
    calls: [{ hostname: "api.openai.com", bytes: 1, ts: "2026-11-24T00:00:00.000Z" }],
  }));
  return home;
}

describe("prove --out to a pipe or a terminal", { skip: !POSIX }, () => {
  for (const target of ["/dev/stdout", "/dev/fd/1"]) {
    test(`--out=${target} writes the proof to this process's stdout`, async () => {
      const home = homeWithRun();
      try {
        const result = await runCli(["prove", "--run=0xout", `--out=${target}`], home);
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /<!DOCTYPE html>/);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }

  test("a symlink to a device is followed", async () => {
    const home = homeWithRun();
    try {
      const link = join(home, "to-null.html");
      symlinkSync("/dev/null", link);
      const result = await runCli(["prove", "--run=0xout", `--out=${link}`], home);
      assert.equal(result.code, 0, result.stderr);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a symlink to a regular file is still refused (unchanged)", async () => {
    const home = homeWithRun();
    try {
      const victim = join(home, "victim.txt");
      writeFileSync(victim, "keep", { mode: 0o644 });
      const link = join(home, "linked.html");
      symlinkSync(victim, link);
      const result = await runCli(["prove", "--run=0xout", `--out=${link}`], home);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /could not write/);
      assert.equal(readFileSync(victim, "utf8"), "keep");
      assert.equal(statSync(victim).mode & 0o777, 0o644);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a regular --out file is still made 0600 (unchanged)", async () => {
    const home = homeWithRun();
    try {
      const out = join(home, "proof.html");
      writeFileSync(out, "old", { mode: 0o644 });
      const result = await runCli(["prove", "--run=0xout", `--out=${out}`], home);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(statSync(out).mode & 0o777, 0o600);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a named pipe keeps its mode", { skip: !HAS_MKFIFO }, async () => {
    const home = homeWithRun();
    try {
      const fifo = join(home, "proof.fifo");
      assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
      chmodSync(fifo, 0o644);
      const reader = spawn("cat", [fifo], { stdio: ["ignore", "pipe", "ignore"] });
      let read = "";
      reader.stdout.on("data", (c) => (read += c));
      const readerDone = new Promise((resolve) => reader.on("close", resolve));
      const result = await runCli(["prove", "--run=0xout", `--out=${fifo}`], home);
      await readerDone;
      assert.equal(result.code, 0, result.stderr);
      assert.match(read, /<!DOCTYPE html>/);
      assert.equal(statSync(fifo).mode & 0o777, 0o644);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
