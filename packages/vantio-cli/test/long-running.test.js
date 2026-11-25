// VAN-458: signals and the running record of `vantio run`.
//
// Every test uses a throwaway HOME and VANTIO_HOME and a local stand-in server
// on 127.0.0.1. No real LLM provider is called. Waits poll with a timeout.
// There is no fixed sleep that a test depends on.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, "..", "bin", "vantio.js");
const SDK_PY = join(__dirname, "..", "..", "vantio-agent-sdk-py");
const features = require("../bin/optics-features.cjs");

const hasPython = spawnSync("python3", ["--version"]).status === 0;

let standIn;
let standInPort;
let work;

before(async () => {
  standIn = createServer((req, res) => { req.resume(); res.end("ok"); });
  await new Promise((resolve) => standIn.listen(0, "127.0.0.1", resolve));
  standInPort = standIn.address().port;
  work = mkdtempSync(join(tmpdir(), "van458-"));
  // A Node program that calls the stand-in, then reacts to signals by mode.
  writeFileSync(join(work, "agent.mjs"), `
import http from "node:http";
const [port, mode] = process.argv.slice(2);
let n = 0;
function call() {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/v1/c" + (n++), method: "POST" }, (res) => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("error", resolve);
    req.end("{}");
  });
}
let terms = 0;
if (mode === "exit3") process.on("SIGTERM", () => process.exit(3));
if (mode === "twice") {
  process.on("SIGTERM", () => {
    terms += 1;
    console.log("term " + terms);
    if (terms >= 2) process.exit(0);
  });
}
if (mode === "ignore") process.on("SIGTERM", () => console.log("ignored"));
await call();
console.log("ready " + process.pid);
if (mode === "finite") {
  await call();
  await call();
  process.exit(0);
}
setInterval(call, 100);
`);
  writeFileSync(join(work, "agent.py"), `
import os, signal, sys, time, urllib.request
port, mode = sys.argv[1], sys.argv[2]
n = 0
def call():
    global n
    req = urllib.request.Request("http://127.0.0.1:%s/v1/p%d" % (port, n), data=b"{}")
    n += 1
    try:
        urllib.request.urlopen(req, timeout=2).read()
    except Exception:
        pass
if mode == "exit3":
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(3))
call()
print("ready", os.getpid(), flush=True)
while True:
    call()
    time.sleep(0.1)
`);
});

const started = { procs: new Set(), pids: new Set() };

after(async () => {
  // Leave nothing behind, even when a test failed half way.
  for (const proc of started.procs) { try { proc.kill("SIGKILL"); } catch { /* gone */ } }
  for (const pid of started.pids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  standIn.closeAllConnections();
  await new Promise((resolve) => standIn.close(resolve));
  rmSync(work, { recursive: true, force: true });
});

async function until(fn, what, timeoutMs = 15000, stepMs = 25) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function newHome() {
  const home = mkdtempSync(join(tmpdir(), "van458-home-"));
  return { home, vantioHome: join(home, ".vantio"), runs: join(home, ".vantio", "runs") };
}

function envFor(h, extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: h.home,
    VANTIO_HOME: h.vantioHome,
    VANTIO_EXTRA_LLM_HOSTS: "127.0.0.1",
    VANTIO_RUN_RECORD_INTERVAL_MS: "1000",
    ...extra,
  };
}

// Start `vantio run ...`. Child output is collected so a test can wait on it.
function startRun(args, h, extra = {}) {
  const proc = spawn(process.execPath, [CLI_PATH, "run", ...args], {
    env: envFor(h, extra),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const run = { proc, stdout: "", stderr: "" };
  started.procs.add(proc);
  proc.stdout.on("data", (c) => { run.stdout += c; });
  proc.stderr.on("data", (c) => { run.stderr += c; });
  run.exited = new Promise((resolve) => proc.on("exit", (code, signal) => resolve({ code, signal })));
  run.childPid = async () => {
    const m = await until(() => /ready (\d+)/.exec(run.stdout), "the program to be ready");
    started.pids.add(Number(m[1]));
    return Number(m[1]);
  };
  return run;
}

function runFiles(h) {
  try { return readdirSync(h.runs).filter((f) => f.endsWith(".json")); } catch { return []; }
}

function readOnlyRun(h) {
  const files = runFiles(h);
  assert.equal(files.length, 1, `expected one run file, got ${files.join(",")}`);
  return JSON.parse(readFileSync(join(h.runs, files[0]), "utf8"));
}

function runCli(args, h, extra = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], { env: envFor(h, extra), encoding: "utf8" });
}

const SIGNAL_NUMBER = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

describe("signals reach the program and the run record is written", () => {
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    test(`node program: ${signal} stops the program, writes the run file, ends with ${signal}`, async () => {
      const h = newHome();
      const run = startRun(["node", join(work, "agent.mjs"), String(standInPort), "plain"], h);
      const pid = await run.childPid();
      // The program dies without writing its own final record (default signal
      // action). The calls come from its last running record, so wait for it.
      await until(() => {
        try { return JSON.parse(readFileSync(join(h.runs, runFiles(h)[0]), "utf8")).calls.length >= 1; } catch { return false; }
      }, "a running record with a call");
      run.proc.kill(signal);
      const { code, signal: endedBy } = await run.exited;
      // vantio run ends itself with the same signal: the shell sees 128 + n.
      assert.equal(endedBy, signal, `exit was code=${code} signal=${endedBy}`);
      assert.equal(128 + SIGNAL_NUMBER[signal], 128 + SIGNAL_NUMBER[endedBy]);
      await until(() => !alive(pid), "the program to be gone", 5000);
      const log = readOnlyRun(h);
      assert.equal(log.vantio_run_log, "1");
      assert.equal(log.run_state, undefined, "the final record is not marked running");
      assert.equal(log.exit_signal, signal);
      assert.equal(log.exit_code, null);
      assert.ok(log.calls.length >= 1, "the call made before the signal is in the record");
      assert.ok(log.calls.every((c) => c.hostname === "127.0.0.1"));
      rmSync(h.home, { recursive: true, force: true });
    });
  }

  test("a program that handles SIGTERM and exits 3 gives vantio run exit code 3", async () => {
    const h = newHome();
    const run = startRun(["node", join(work, "agent.mjs"), String(standInPort), "exit3"], h);
    const pid = await run.childPid();
    run.proc.kill("SIGTERM");
    const { code, signal } = await run.exited;
    assert.equal(signal, null);
    assert.equal(code, 3);
    assert.equal(alive(pid), false);
    assert.equal(readOnlyRun(h).run_state, undefined);
    rmSync(h.home, { recursive: true, force: true });
  });

  test("a second signal is passed on and the program is not orphaned", async () => {
    const h = newHome();
    const run = startRun(["node", join(work, "agent.mjs"), String(standInPort), "twice"], h);
    const pid = await run.childPid();
    run.proc.kill("SIGTERM");
    await until(() => /term 1/.test(run.stdout), "the program to see the first SIGTERM");
    // The program survived the first signal, so vantio run must still be waiting.
    assert.equal(run.proc.exitCode, null);
    assert.equal(run.proc.signalCode, null);
    assert.equal(alive(pid), true);
    run.proc.kill("SIGTERM");
    const { code, signal } = await run.exited;
    assert.match(run.stdout, /term 2/);
    assert.equal(signal, null);
    assert.equal(code, 0);
    assert.equal(alive(pid), false);
    rmSync(h.home, { recursive: true, force: true });
  });

  test("negative: a program that ignores SIGTERM keeps vantio run waiting; vantio run is not ended by the signal", async () => {
    const h = newHome();
    const run = startRun(["node", join(work, "agent.mjs"), String(standInPort), "ignore"], h);
    const pid = await run.childPid();
    run.proc.kill("SIGTERM");
    await until(() => /ignored/.test(run.stdout), "the program to ignore SIGTERM");
    assert.equal(run.proc.exitCode, null, "vantio run must not exit while the program lives");
    assert.equal(run.proc.signalCode, null);
    assert.equal(alive(pid), true);
    // vantio run does not escalate. End the program by hand.
    process.kill(pid, "SIGKILL");
    const { signal } = await run.exited;
    assert.equal(signal, "SIGKILL", "vantio run reports how the program ended");
    await until(() => !alive(pid), "the program to be gone", 5000);
    const log = readOnlyRun(h);
    assert.equal(log.exit_signal, "SIGKILL");
    rmSync(h.home, { recursive: true, force: true });
  });

  test("a program that is not Node or Python: SIGTERM is passed to it", async () => {
    const h = newHome();
    const script = 'trap "exit 7" TERM; echo ready $$; while :; do sleep 0.05; done';
    const run = startRun(["sh", "-c", script], h);
    const pid = await run.childPid();
    run.proc.kill("SIGTERM");
    const { code, signal } = await run.exited;
    assert.equal(signal, null);
    assert.equal(code, 7);
    await until(() => !alive(pid), "the shell to be gone", 5000);
    const log = readOnlyRun(h);
    assert.equal(log.run_state, undefined);
    assert.equal(log.exit_code, 7);
    rmSync(h.home, { recursive: true, force: true });
  });

  test("a program that exits on its own keeps its exit code", async () => {
    const h = newHome();
    const run = startRun(["sh", "-c", "exit 5"], h);
    const { code, signal } = await run.exited;
    assert.equal(signal, null);
    assert.equal(code, 5);
    rmSync(h.home, { recursive: true, force: true });
  });

  test("python program: SIGTERM stops it and the run file is written", { skip: !hasPython }, async () => {
    const h = newHome();
    const run = startRun(["python3", join(work, "agent.py"), String(standInPort), "plain"], h, { PYTHONPATH: SDK_PY });
    const pid = await run.childPid();
    run.proc.kill("SIGTERM");
    const { signal } = await run.exited;
    assert.equal(signal, "SIGTERM");
    await until(() => !alive(pid), "the program to be gone", 5000);
    const log = readOnlyRun(h);
    assert.equal(log.run_state, undefined);
    assert.equal(log.exit_signal, "SIGTERM");
    assert.ok(log.calls.length >= 1);
    rmSync(h.home, { recursive: true, force: true });
  });

  test("python program that exits 3 on SIGTERM gives exit code 3", { skip: !hasPython }, async () => {
    const h = newHome();
    const run = startRun(["python3", join(work, "agent.py"), String(standInPort), "exit3"], h, { PYTHONPATH: SDK_PY });
    const pid = await run.childPid();
    run.proc.kill("SIGTERM");
    const { code, signal } = await run.exited;
    assert.equal(signal, null);
    assert.equal(code, 3);
    assert.equal(alive(pid), false);
    rmSync(h.home, { recursive: true, force: true });
  });
});

describe("a running program keeps a run record", () => {
  test("node: a running record is visible to discover, then the final record replaces it", async () => {
    const h = newHome();
    const run = startRun(["node", join(work, "agent.mjs"), String(standInPort), "plain"], h);
    const pid = await run.childPid();
    const seen = await until(() => {
      const files = runFiles(h);
      if (!files.length) return null;
      try {
        const log = JSON.parse(readFileSync(join(h.runs, files[0]), "utf8"));
        return log.run_state === "running" && log.calls.length >= 1 ? log : null;
      } catch { return null; }
    }, "a running record with a call");
    assert.equal(seen.update_interval_ms, 1000);
    assert.equal(seen.vantio_run_log, "1");
    // discover reads it while the program is still running.
    const found = runCli(["discover", "--json"], h);
    assert.equal(found.status, 0, found.stderr);
    const report = JSON.parse(found.stdout);
    assert.equal(report.running_runs, 1);
    assert.equal(report.unfinished_runs, 0);
    assert.ok(report.hosts.some((row) => row.host === "127.0.0.1" && row.total >= 1));
    const text = runCli(["discover"], h);
    assert.match(text.stdout, /1 run\(s\) still running/);
    // The record holds metadata only.
    const raw = readFileSync(join(h.runs, runFiles(h)[0]), "utf8");
    assert.doesNotMatch(raw, /"body"|authorization|"headers"/i);
    run.proc.kill("SIGTERM");
    await run.exited;
    await until(() => !alive(pid), "the program to be gone", 5000);
    const final = readOnlyRun(h);
    assert.equal(final.run_state, undefined);
    assert.equal(final.update_interval_ms, undefined);
    assert.equal(runCli(["discover", "--json"], h).stdout.includes('"running_runs": 0'), true);
    rmSync(h.home, { recursive: true, force: true });
  });

  test("node: a program that exits on its own writes a final record with no run_state", async () => {
    const h = newHome();
    const run = startRun(["node", join(work, "agent.mjs"), String(standInPort), "finite"], h);
    const { code } = await run.exited;
    assert.equal(code, 0);
    const log = readOnlyRun(h);
    assert.equal(log.run_state, undefined);
    assert.equal(log.calls.length, 3);
    rmSync(h.home, { recursive: true, force: true });
  });

  test("negative: VANTIO_RUN_RECORD_INTERVAL_MS=off writes no record while the program runs", async () => {
    const h = newHome();
    const run = startRun(["node", join(work, "agent.mjs"), String(standInPort), "plain"], h, {
      VANTIO_RUN_RECORD_INTERVAL_MS: "off",
    });
    const pid = await run.childPid();
    // Wait until the program has made several more calls, then look.
    await until(() => (run.stdout.match(/ready/g) || []).length >= 1, "ready");
    assert.deepEqual(runFiles(h), [], "no running record when the interval is off");
    run.proc.kill("SIGTERM");
    await run.exited;
    await until(() => !alive(pid), "the program to be gone", 5000);
    // The final record is still written by vantio run.
    assert.equal(readOnlyRun(h).run_state, undefined);
    rmSync(h.home, { recursive: true, force: true });
  });

  test("a reader polling the file in a tight loop never sees invalid JSON", async () => {
    const h = newHome();
    const run = startRun(["node", join(work, "agent.mjs"), String(standInPort), "plain"], h, {
      VANTIO_RUN_RECORD_INTERVAL_MS: "1000",
    });
    const pid = await run.childPid();
    await until(() => runFiles(h).length === 1, "the run file");
    const file = join(h.runs, runFiles(h)[0]);
    const stamps = new Set();
    let reads = 0;
    let bad = 0;
    const end = Date.now() + 3500;
    while (Date.now() < end) {
      try {
        const log = JSON.parse(readFileSync(file, "utf8"));
        stamps.add(log.generated_at);
        reads += 1;
      } catch { bad += 1; }
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(bad, 0, `${bad} of ${reads + bad} reads failed to parse`);
    assert.ok(reads > 100, `only ${reads} reads`);
    assert.ok(stamps.size >= 2, "the record was rewritten while it was read");
    run.proc.kill("SIGTERM");
    await run.exited;
    await until(() => !alive(pid), "the program to be gone", 5000);
    rmSync(h.home, { recursive: true, force: true });
  });

  test("a non-Node program has a running record written by vantio run, replaced at exit", async () => {
    const h = newHome();
    const run = startRun(["sh", "-c", 'trap "exit 0" TERM; echo ready $$; while :; do sleep 0.05; done'], h);
    await run.childPid();
    const seen = await until(() => {
      const files = runFiles(h);
      if (!files.length) return null;
      try {
        const log = JSON.parse(readFileSync(join(h.runs, files[0]), "utf8"));
        return log.run_state === "running" ? log : null;
      } catch { return null; }
    }, "a running record from vantio run");
    assert.equal(seen.update_interval_ms, 1000);
    assert.ok(seen.processes.length >= 1);
    run.proc.kill("SIGTERM");
    await run.exited;
    assert.equal(readOnlyRun(h).run_state, undefined);
    rmSync(h.home, { recursive: true, force: true });
  });

  test("SIGKILL of vantio run leaves the last running record, still marked running", async () => {
    const h = newHome();
    const run = startRun(["node", join(work, "agent.mjs"), String(standInPort), "plain"], h);
    const pid = await run.childPid();
    await until(() => {
      try { return JSON.parse(readFileSync(join(h.runs, runFiles(h)[0]), "utf8")).calls.length >= 1; } catch { return false; }
    }, "a running record with a call");
    run.proc.kill("SIGKILL");
    const { signal } = await run.exited;
    assert.equal(signal, "SIGKILL");
    const log = readOnlyRun(h);
    assert.equal(log.run_state, "running", "nothing could replace the running record");
    // The program is not ours to leave behind in the test.
    process.kill(pid, "SIGKILL");
    await until(() => !alive(pid), "the program to be gone", 5000);
    rmSync(h.home, { recursive: true, force: true });
  });

  test("python: a running record is visible while the program runs", { skip: !hasPython }, async () => {
    const h = newHome();
    const run = startRun(["python3", join(work, "agent.py"), String(standInPort), "plain"], h, { PYTHONPATH: SDK_PY });
    const pid = await run.childPid();
    const seen = await until(() => {
      const files = runFiles(h);
      if (!files.length) return null;
      try {
        const log = JSON.parse(readFileSync(join(h.runs, files[0]), "utf8"));
        return log.run_state === "running" && log.calls.length >= 1 ? log : null;
      } catch { return null; }
    }, "a running record with a call");
    assert.equal(seen.update_interval_ms, 1000);
    assert.equal(seen.calls[0].method, "POST");
    const report = JSON.parse(runCli(["discover", "--json"], h).stdout);
    assert.equal(report.running_runs, 1);
    run.proc.kill("SIGTERM");
    await run.exited;
    await until(() => !alive(pid), "the program to be gone", 5000);
    assert.equal(readOnlyRun(h).run_state, undefined);
    rmSync(h.home, { recursive: true, force: true });
  });
});

describe("readers handle running and unfinished records", () => {
  function fixtureLog(trace, extra) {
    const now = Date.now();
    return {
      vantio_run_log: "1",
      schema_version: 2,
      plane: "optics",
      trace_id: trace,
      program: "svc",
      system_hostname: "fixture-host",
      pid: 4242,
      started_at: new Date(now - 600000).toISOString(),
      generated_at: new Date(now).toISOString(),
      calls: [{ hostname: "api.openai.com", provider: "openai", method: "POST", path: "/v1/x", bytes: 10, status: 200, ok: true, action: "OBSERVED", ts: new Date(now).toISOString() }],
      summary: { total_calls: 1, total_bytes: 10, hosts: ["api.openai.com"] },
      ...extra,
    };
  }
  let h;
  before(() => {
    h = newHome();
    mkdirSync(h.runs, { recursive: true });
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    // A writer that was killed half way leaves a temp file. Readers skip it.
    mkdirSync(join(h.runs, ".tmp"), { recursive: true });
    writeFileSync(join(h.runs, ".tmp", "1-1-half.json"), "{\"vantio_run_log\": ");
    writeFileSync(join(h.runs, "fin1.json.1.1.tmp"), "{");
    writeFileSync(join(h.runs, "fin1.json"), JSON.stringify(fixtureLog("fin1")));
    writeFileSync(join(h.runs, "run1.json"), JSON.stringify(fixtureLog("run1", { run_state: "running", update_interval_ms: 5000 })));
    writeFileSync(join(h.runs, "stale1.json"), JSON.stringify(fixtureLog("stale1", { run_state: "running", update_interval_ms: 5000, generated_at: old })));
  });
  after(() => rmSync(h.home, { recursive: true, force: true }));

  test("discover counts running and unfinished runs and still lists their hosts", () => {
    const report = JSON.parse(runCli(["discover", "--json"], h).stdout);
    assert.equal(report.scanned_runs, 3);
    assert.equal(report.running_runs, 1);
    assert.equal(report.unfinished_runs, 1);
    assert.equal(report.hosts[0].total, 3);
    const text = runCli(["discover"], h).stdout;
    assert.match(text, /1 run\(s\) still running/);
    assert.match(text, /1 run\(s\) unfinished.*crashed or been killed/);
  });

  test("prove marks the run state in json, markdown and the list", () => {
    const state = (id) => JSON.parse(runCli(["prove", "--run", id, "--json"], h).stdout).run_state;
    assert.equal(state("fin1"), "finished");
    assert.equal(state("run1"), "running");
    assert.equal(state("stale1"), "unfinished");
    assert.match(runCli(["prove", "--run", "run1", "--format", "md"], h).stdout, /Run state \| still running/);
    assert.match(runCli(["prove", "--run", "stale1", "--format", "md"], h).stdout, /Run state \| unfinished, no update for \d+s/);
    assert.doesNotMatch(runCli(["prove", "--run", "fin1", "--format", "md"], h).stdout, /Run state/);
    const list = runCli(["prove", "--list"], h).stdout;
    assert.match(list, /run1 \[running\]/);
    assert.match(list, /stale1 \[unfinished\]/);
    assert.doesNotMatch(list, /fin1 \[/);
  });

  test("diff reports the state of each side", () => {
    const json = JSON.parse(runCli(["diff", "fin1", "run1", "--json"], h).stdout);
    assert.equal(json.a.run_state, "finished");
    assert.equal(json.b.run_state, "running");
    const text = runCli(["diff", "fin1", "stale1"], h).stdout;
    assert.match(text, /Note: run B is unfinished/);
    assert.doesNotMatch(runCli(["diff", "fin1", "fin1"], h).stdout, /Note: run/);
  });

  test("coverage counts running and unfinished run records", () => {
    const report = JSON.parse(runCli(["coverage", "--json"], h).stdout);
    assert.deepEqual(report.run_records, { running: 1, unfinished: 1 });
    assert.match(runCli(["coverage"], h).stdout, /Run records still running: 1/);
    assert.match(runCli(["coverage"], h).stdout, /Run records unfinished: 1/);
  });
});

describe("run record helpers", () => {
  test("runRecordIntervalMs: default, floor, off, and bad input", () => {
    const f = (v) => features.runRecordIntervalMs(v === undefined ? null : v);
    assert.equal(f(undefined), 5000);
    assert.equal(f(""), 5000);
    assert.equal(f("2500"), 2500);
    assert.equal(f("10"), 1000, "a value below 1000 is raised to 1000");
    assert.equal(f("0"), 0);
    assert.equal(f("off"), 0);
    assert.equal(f("OFF"), 0);
    assert.equal(f("fast"), 5000, "an unreadable value falls back to the default");
    assert.equal(f("-5"), 5000);
    assert.equal(f("99999999999"), 3600000);
  });

  test("runStateOf: finished, running, unfinished", () => {
    const now = Date.parse("2026-11-25T12:00:00Z");
    const at = (ms) => new Date(now - ms).toISOString();
    assert.equal(features.runStateOf({ calls: [] }, now).state, "finished");
    assert.equal(features.runStateOf({ run_state: "finished" }, now).state, "finished");
    assert.equal(features.runStateOf({ run_state: "running", update_interval_ms: 5000, generated_at: at(14000) }, now).state, "running");
    assert.equal(features.runStateOf({ run_state: "running", update_interval_ms: 5000, generated_at: at(16000) }, now).state, "unfinished");
    // Three intervals when that is longer than 15 seconds.
    assert.equal(features.runStateOf({ run_state: "running", update_interval_ms: 20000, generated_at: at(59000) }, now).state, "running");
    assert.equal(features.runStateOf({ run_state: "running", update_interval_ms: 20000, generated_at: at(61000) }, now).state, "unfinished");
    assert.equal(features.runStateOf({ run_state: "running", generated_at: "not a date" }, now).state, "unfinished");
  });

  test("writeRunFileAtomic: a reader in another process never sees half a file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "van458-atomic-"));
    const file = join(dir, "run.json");
    writeFileSync(file, JSON.stringify({ n: -1 }));
    const writer = spawn(process.execPath, ["-e", `
      const { writeRunFileAtomic } = require(${JSON.stringify(join(__dirname, "..", "bin", "optics-features.cjs"))});
      const filler = "x".repeat(200000);
      for (let i = 0; i < 300; i += 1) writeRunFileAtomic(process.argv[1], { n: i, filler }, i % 2 ? { finalRecord: true } : undefined);
    `, file], { stdio: "ignore" });
    const done = new Promise((resolve) => writer.on("exit", resolve));
    let finished = false;
    done.then(() => { finished = true; });
    let reads = 0;
    let bad = 0;
    while (!finished) {
      try { JSON.parse(readFileSync(file, "utf8")); reads += 1; } catch { bad += 1; }
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(await done, 0);
    assert.equal(bad, 0, `${bad} of ${reads + bad} reads failed to parse`);
    assert.ok(reads > 10);
    assert.deepEqual(readdirSync(dir).filter((n) => n !== ".tmp"), ["run.json"], "no temp file is left behind");
    assert.deepEqual(readdirSync(join(dir, ".tmp")), [], "no temp file is left in .tmp");
    rmSync(dir, { recursive: true, force: true });
  });
});
