// VAN-387 item 1: the wrapper's own run log write (proc socket rows and the
// process tree) takes the same <trace>.json.lock as the interceptor, so a
// child that is still writing does not lose its calls, or the wrapper its rows.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";

const features = createRequire(import.meta.url)("../bin/optics-features.cjs");

// A writer like the interceptor: take the lock, read the log, wait, then
// write the log with one more call and drop the lock.
const SLOW_WRITER = `
const fs = require("node:fs");
const [path, ready] = process.argv.slice(1);
const fd = fs.openSync(path + ".lock", "wx", 0o600);
const log = JSON.parse(fs.readFileSync(path, "utf8"));
fs.writeFileSync(ready, "1");
setTimeout(() => {
  log.calls.push({ hostname: "child.example", mediation: "node_fetch", ts: "2026-11-24T00:00:02.000Z" });
  fs.writeFileSync(path + ".tmp-child", JSON.stringify(log));
  fs.renameSync(path + ".tmp-child", path);
  fs.closeSync(fd);
  fs.unlinkSync(path + ".lock");
}, 600);
`;

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "vantio-wrap-lock-"));
  const previous = process.env.VANTIO_HOME;
  process.env.VANTIO_HOME = home;
  const done = () => {
    if (previous == null) delete process.env.VANTIO_HOME;
    else process.env.VANTIO_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  };
  return Promise.resolve(fn(home)).finally(done);
}

function baseLog(traceId) {
  return {
    vantio_run_log: "1",
    trace_id: traceId,
    run_id: "run-1",
    program: "agent.js",
    pid: 11,
    started_at: "2026-11-24T00:00:00.000Z",
    calls: [{ hostname: "parent.example", mediation: "node_fetch", ts: "2026-11-24T00:00:01.000Z" }],
  };
}

const SOCKET = { pid: 12, ppid: 11, program: "curl", destination: "socket.example", port: 443 };

describe("wrapper run log write and the run log lock", () => {
  test("the wrapper waits for a writer that holds the lock, and keeps its calls", async () => {
    await withHome(async (home) => {
      const runs = join(home, "runs");
      mkdirSync(runs, { recursive: true });
      const path = join(runs, "0xlock.json");
      writeFileSync(path, JSON.stringify(baseLog("0xlock")));
      const ready = join(home, "ready");
      const writer = spawn(process.execPath, ["-e", SLOW_WRITER, path, ready], { stdio: "ignore" });
      const exited = new Promise((resolve) => writer.on("exit", resolve));
      const deadline = Date.now() + 10000;
      while (!existsSync(ready) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      assert.ok(existsSync(ready), "the writer did not start");
      features.recordWrappedRun({
        traceId: "0xlock",
        runId: "run-1",
        program: "node",
        pid: 11,
        ppid: 1,
        startedAt: "2026-11-24T00:00:00.000Z",
        processes: [{ pid: 11, ppid: 1, program: "node" }, { pid: 12, ppid: 11, program: "curl" }],
        connections: [SOCKET],
      });
      await exited;
      const log = JSON.parse(readFileSync(path, "utf8"));
      const hosts = log.calls.map((call) => call.hostname).sort();
      assert.deepEqual(hosts, ["child.example", "parent.example", "socket.example"]);
      assert.equal(existsSync(`${path}.lock`), false);
    });
  });

  test("a lock older than 10 s is taken over at once", async () => {
    await withHome(async (home) => {
      const runs = join(home, "runs");
      mkdirSync(runs, { recursive: true });
      const path = join(runs, "0xstale.json");
      writeFileSync(path, JSON.stringify(baseLog("0xstale")));
      writeFileSync(`${path}.lock`, "");
      const old = new Date(Date.now() - 60 * 1000);
      utimesSync(`${path}.lock`, old, old);
      const started = Date.now();
      features.recordWrappedRun({ traceId: "0xstale", runId: "run-1", program: "node", pid: 11, ppid: 1, processes: [], connections: [SOCKET] });
      assert.ok(Date.now() - started < 1000, "took the stale lock over without waiting");
      const log = JSON.parse(readFileSync(path, "utf8"));
      assert.deepEqual(log.calls.map((call) => call.hostname).sort(), ["parent.example", "socket.example"]);
      assert.equal(existsSync(`${path}.lock`), false);
    });
  });

  test("with no earlier log, the wrapper's log carries the run id", async () => {
    await withHome(async (home) => {
      const { log } = features.recordWrappedRun({ traceId: "0xfresh", runId: "run-fresh", program: "node", pid: 11, ppid: 1, processes: [], connections: [] });
      assert.equal(log.run_id, "run-fresh");
      const onDisk = JSON.parse(readFileSync(join(home, "runs", "0xfresh.json"), "utf8"));
      assert.equal(onDisk.run_id, "run-fresh");
    });
  });

  test("an earlier log keeps its own run id and calls (unchanged)", async () => {
    await withHome(async (home) => {
      const runs = join(home, "runs");
      mkdirSync(runs, { recursive: true });
      writeFileSync(join(runs, "0xkeep.json"), JSON.stringify(baseLog("0xkeep")));
      const { log } = features.recordWrappedRun({ traceId: "0xkeep", runId: "other", program: "node", pid: 11, ppid: 1, processes: [], connections: [] });
      assert.equal(log.run_id, "run-1");
      assert.equal(log.program, "agent.js");
      assert.deepEqual(log.calls.map((call) => call.hostname), ["parent.example"]);
    });
  });
});
