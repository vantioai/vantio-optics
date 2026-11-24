// VAN-387 item 1: every Node process in one `vantio run` writes the same
// <trace>.json. A parent's exit must not erase the calls its children made.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, "..", "bin", "vantio.js");
const INTERCEPTOR_PATH = join(__dirname, "..", "bin", "interceptor.cjs");

let server;
let target;

before(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{\"ok\":true}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  target = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function spawnNode(args, env, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function baseEnv(home, extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    VANTIO_TELEMETRY_DISABLED: "1",
    VANTIO_MCP_AWARENESS: "off",
    VANTIO_EXTRA_LLM_HOSTS: "127.0.0.1",
    TARGET_URL: target,
    ...extra,
  };
}

function runLogs(home) {
  const dir = join(home, ".vantio", "runs");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));
}

function writeScripts(home) {
  const child = join(home, "child.js");
  writeFileSync(child, "fetch(process.env.TARGET_URL).then((r) => r.text());\n");
  const serial = join(home, "serial.js");
  writeFileSync(serial, [
    "const { execFileSync } = require('node:child_process');",
    `execFileSync(process.execPath, [${JSON.stringify(child)}], { stdio: 'inherit' });`,
    "",
  ].join("\n"));
  const parallel = join(home, "parallel.js");
  writeFileSync(parallel, [
    "const { spawn } = require('node:child_process');",
    "let left = 4;",
    "for (let i = 0; i < 4; i += 1) {",
    `  spawn(process.execPath, [${JSON.stringify(child)}], { stdio: 'inherit' }).on('exit', () => { left -= 1; });`,
    "}",
    "",
  ].join("\n"));
  return { child, serial, parallel };
}

describe("run log merge across processes", () => {
  test("a child's call stays in the run log after the parent exits", async () => {
    const home = mkdtempSync(join(tmpdir(), "vantio-merge-"));
    try {
      const { serial } = writeScripts(home);
      const result = await spawnNode([CLI_PATH, "run", "node", serial], baseEnv(home), home);
      assert.equal(result.code, 0, result.stderr);
      const logs = runLogs(home);
      assert.equal(logs.length, 1);
      const [log] = logs;
      assert.equal(log.calls.length, 1, JSON.stringify(log.calls));
      assert.equal(log.summary.total_calls, 1);
      assert.deepEqual(log.summary.hosts, ["127.0.0.1"]);
      assert.equal(log.summary.by_host["127.0.0.1"].calls, 1);
      assert.equal(typeof log.run_id, "string");
      // The parent started first, so it keeps the run identity.
      assert.equal(log.program, "serial.js");
      assert.equal(readdirSync(join(home, ".vantio", "runs")).some((n) => n.endsWith(".lock") || n.endsWith(".tmp")), false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("four children that exit together all keep their calls", async () => {
    const home = mkdtempSync(join(tmpdir(), "vantio-merge-par-"));
    try {
      const { parallel } = writeScripts(home);
      const result = await spawnNode([CLI_PATH, "run", "node", parallel], baseEnv(home), home);
      assert.equal(result.code, 0, result.stderr);
      const [log] = runLogs(home);
      assert.equal(log.calls.length, 4, JSON.stringify(log.calls));
      assert.equal(log.summary.total_calls, 4);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a log from another run with the same trace id is replaced, not merged", async () => {
    const home = mkdtempSync(join(tmpdir(), "vantio-merge-other-"));
    try {
      const { child } = writeScripts(home);
      const env = baseEnv(home, { VANTIO_TRACE_ID: "0xfixedtrace" });
      const first = await spawnNode([CLI_PATH, "run", "node", child], env, home);
      assert.equal(first.code, 0, first.stderr);
      const second = await spawnNode([CLI_PATH, "run", "node", child], env, home);
      assert.equal(second.code, 0, second.stderr);
      const [log] = runLogs(home);
      assert.equal(log.calls.length, 1, "the second run must not add the first run's call");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("without vantio run (no run id) the interceptor replaces the file as before", async () => {
    const home = mkdtempSync(join(tmpdir(), "vantio-merge-norun-"));
    try {
      const { child } = writeScripts(home);
      const env = baseEnv(home, { VANTIO_TRACE_ID: "0xplaintrace" });
      for (let i = 0; i < 2; i += 1) {
        const result = await spawnNode(["--require", INTERCEPTOR_PATH, child], env, home);
        assert.equal(result.code, 0, result.stderr);
      }
      const [log] = runLogs(home);
      assert.equal(log.calls.length, 1);
      assert.equal(log.run_id, undefined);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("tail --follow still sees a run log that is replaced by rename, twice", async () => {
    const home = mkdtempSync(join(tmpdir(), "vantio-merge-tail-"));
    const dir = join(home, ".vantio", "runs");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "0xtailrename.json");
    const log = (n) => JSON.stringify({
      vantio_run_log: "1",
      trace_id: "0xtailrename",
      generated_at: new Date().toISOString(),
      calls: Array.from({ length: n }, (_, i) => ({ hostname: `host${i + 1}.example`, bytes: 1, ts: new Date().toISOString() })),
    });
    const replace = (n) => {
      writeFileSync(`${path}.tmp`, log(n));
      renameSync(`${path}.tmp`, path);
    };
    writeFileSync(path, log(1));
    const child = spawn(process.execPath, [CLI_PATH, "tail", "--follow", "--run=0xtailrename"], {
      env: { PATH: process.env.PATH, HOME: home, VANTIO_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c));
    const waitFor = async (needle) => {
      const deadline = Date.now() + 8000;
      while (!stdout.includes(needle) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      return stdout.includes(needle);
    };
    try {
      assert.ok(await waitFor("host1.example"), stdout);
      await new Promise((r) => setTimeout(r, 300));
      replace(2);
      assert.ok(await waitFor("host2.example"), `first rename not seen: ${stdout}`);
      replace(3);
      assert.ok(await waitFor("host3.example"), `second rename not seen: ${stdout}`);
    } finally {
      child.kill("SIGTERM");
      await new Promise((r) => child.on("close", r));
      rmSync(home, { recursive: true, force: true });
    }
  });
});
