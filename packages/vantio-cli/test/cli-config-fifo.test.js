// VAN-394: a curl -K config or wget -i list that is a FIFO must not block the
// parent. The child reads it as usual. The wrapper never opens a FIFO, a
// device, a socket or /dev/stdin, and records such a call with no host.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INTERCEPTOR_PATH = join(__dirname, "..", "bin", "interceptor.cjs");
const has = (cmd) => {
  try {
    return spawnSync(cmd, ["--version"], { encoding: "utf8", timeout: 3000 }).status === 0;
  } catch {
    return false;
  }
};
const HAS_CURL = has("curl");
const HAS_WGET = has("wget");

function runAgent(script, env, input) {
  return new Promise((resolve) => {
    // With input, the agent's stdin is a real pipe fed by printf. (A "pipe"
    // from node is a socket pair, and /dev/stdin cannot be opened on one.)
    const nodeArgs = ["--require", INTERCEPTOR_PATH, "-e", script];
    const child = input == null
      ? spawn(process.execPath, nodeArgs, { env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] })
      : spawn("sh", ["-c", 'printf "%s" "$VAN394_INPUT" | "$0" "$@"', process.execPath, ...nodeArgs], {
        env: { PATH: process.env.PATH, ...env, VAN394_INPUT: input },
        stdio: ["ignore", "pipe", "pipe"],
      });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const killer = setTimeout(() => child.kill("SIGKILL"), 10000);
    child.on("close", (code, signal) => {
      clearTimeout(killer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function fifoScript(argvJson) {
  return `
const { spawn } = require("node:child_process");
const { writeFile } = require("node:fs");
const t0 = Date.now();
const child = spawn(${JSON.stringify(argvJson[0])}, ${JSON.stringify(argvJson.slice(1))}, { stdio: "ignore" });
const spawnMs = Date.now() - t0;
writeFile(process.env.FIFO, process.env.CONTENT, () => {});
child.on("exit", (code) => {
  process.stdout.write(JSON.stringify({ spawnMs, code }) + "\\n");
});
`;
}

async function check(tool, flag, content) {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/v1/fifo`;
  const dir = mkdtempSync(join(tmpdir(), "van394-"));
  const fifo = join(dir, "cfg");
  execFileSync("mkfifo", [fifo]);
  const home = mkdtempSync(join(tmpdir(), "van394-home-"));
  const argv = tool === "curl" ? ["curl", "-sS", "-o", "/dev/null", flag, fifo] : ["wget", "-q", "-O", "/dev/null", flag, fifo];
  try {
    const { code, signal, stdout, stderr } = await runAgent(fifoScript(argv), {
      VANTIO_HOME: home,
      VANTIO_TRACE_ID: `van394${tool}`,
      VANTIO_EXTRA_LLM_HOSTS: "127.0.0.1",
      FIFO: fifo,
      CONTENT: content(url),
    });
    assert.equal(signal, null, `the agent was killed: ${stderr}`);
    assert.equal(code, 0, `stderr: ${stderr} stdout: ${stdout}`);
    const out = JSON.parse(stdout.trim().split("\n").pop());
    assert.ok(out.spawnMs < 1000, `spawn took ${out.spawnMs} ms`);
    assert.equal(out.code, 0, `${tool} exit code`);
    assert.deepEqual(hits, ["/v1/fifo"], "the child read the whole config itself");
    // The URL is in the FIFO, which only the child may read, so the wrapper
    // cannot tell the host. The call is recorded with no host and no URL.
    assertOneCallWithoutHost(home, `van394${tool}`, tool, [url, "/v1/fifo", "127.0.0.1"]);
  } finally {
    server.close();
  }
}

test("curl -K <fifo> does not block the parent", { skip: !HAS_CURL, timeout: 20000 }, async () => {
  await check("curl", "-K", (url) => `url = "${url}"\n`);
});

test("wget -i <fifo> does not block the parent", { skip: !HAS_WGET, timeout: 20000 }, async () => {
  await check("wget", "-i", (url) => `${url}\n`);
});

// ── Review fixes (Nov 25): no network below; curl and wget are fakes on PATH ──

function readRun(home, trace) {
  const file = join(home, "runs", `${trace}.json`);
  assert.ok(existsSync(file), "the run file is written");
  const text = readFileSync(file, "utf8");
  return { text, log: JSON.parse(text) };
}

function assertOneCallWithoutHost(home, trace, tool, absent) {
  const { text, log } = readRun(home, trace);
  assert.equal(log.calls.length, 1, "one call is recorded");
  const call = log.calls[0];
  assert.equal(call.hostname, null);
  assert.equal(call.path, null);
  assert.equal(call.provider, "unknown");
  assert.equal(call.mediation, `node_${tool}`);
  assert.equal(call.action, "OBSERVED");
  // Owner decision, option A: the record is kept, and it is left out of the
  // call count, the host list and the byte totals.
  assert.deepEqual(log.summary.by_host, {}, "no host is counted");
  assert.deepEqual(log.summary.hosts, []);
  assert.equal(log.summary.total_calls, 0);
  assert.equal(log.summary.total_bytes, 0);
  assert.equal(log.summary.calls_without_host, 1);
  for (const piece of absent) assert.ok(!text.includes(piece), `the run file holds ${piece}`);
}

// A stand-in for curl and wget: it saves what it reads from the -K / -i file.
function fakeBin() {
  const dir = mkdtempSync(join(tmpdir(), "van394-bin-"));
  const body = [
    "#!/bin/sh",
    'f=""',
    'while [ $# -gt 0 ]; do',
    '  case "$1" in -K|-i) f="$2"; shift ;; esac',
    "  shift",
    "done",
    'exec cat "$f" > "$VAN394_OUT"',
    "",
  ].join("\n");
  for (const name of ["curl", "wget"]) {
    writeFileSync(join(dir, name), body);
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

// Let go of anything still blocked on the FIFO after a failed run.
function releaseFifo(fifo) {
  for (const flag of [constants.O_RDONLY, constants.O_WRONLY]) {
    try {
      closeSync(openSync(fifo, flag | constants.O_NONBLOCK));
    } catch { /* nobody is waiting on that side */ }
  }
}

function fakeEnv(tool, extra) {
  const work = mkdtempSync(join(tmpdir(), "van394-work-"));
  const home = join(work, "home");
  mkdirSync(home);
  return {
    work,
    home,
    out: join(work, "child-read"),
    env: {
      PATH: `${fakeBin()}:${process.env.PATH}`,
      VANTIO_HOME: home,
      VANTIO_EXTRA_LLM_HOSTS: "llm.example.test",
      VAN394_OUT: join(work, "child-read"),
      VAN394_TOOL: tool,
      VAN394_FLAG: tool === "curl" ? "-K" : "-i",
      ...extra,
    },
  };
}

// The writer is blocked in open(fifo, O_WRONLY) before the spawn.
const WRITER_FIRST_SCRIPT = `
const { spawn } = require("node:child_process");
const { readFileSync } = require("node:fs");
const out = { timedOut: false };
let left = 2;
let watchdog = null;
const finish = () => {
  if (--left > 0) return;
  clearTimeout(watchdog);
  process.stdout.write(JSON.stringify(out) + "\\n");
};
const writer = spawn("sh", ["-c", 'printf "%s" "$CONTENT" > "$FIFO"'], { stdio: "ignore" });
writer.on("exit", (code, signal) => { out.writer = { code, signal }; finish(); });
const asleep = () => {
  try {
    return readFileSync("/proc/" + writer.pid + "/stat", "utf8").split(") ").pop().startsWith("S");
  } catch { return true; }
};
const startedAt = Date.now();
const waitForWriter = () => {
  if (!asleep() && Date.now() - startedAt < 2000) return setTimeout(waitForWriter, 10);
  setTimeout(() => {
    out.writerWaiting = writer.exitCode === null && writer.signalCode === null;
    const t0 = Date.now();
    const child = spawn(process.env.VAN394_TOOL, [process.env.VAN394_FLAG, process.env.FIFO], { stdio: "ignore" });
    out.spawnMs = Date.now() - t0;
    child.on("exit", (code, signal) => { out.child = { code, signal }; finish(); });
    watchdog = setTimeout(() => {
      out.timedOut = true;
      child.kill("SIGKILL");
      writer.kill("SIGKILL");
    }, 5000);
  }, 200);
};
waitForWriter();
`;

async function checkWriterFirst(tool, content) {
  const t = fakeEnv(tool, { VANTIO_TRACE_ID: `van394first${tool}`, CONTENT: content });
  const fifo = join(t.work, "cfg");
  execFileSync("mkfifo", [fifo]);
  try {
    const { code, signal, stdout, stderr } = await runAgent(WRITER_FIRST_SCRIPT, { ...t.env, FIFO: fifo });
    assert.equal(signal, null, `the agent was killed: ${stderr}`);
    assert.equal(code, 0, `stderr: ${stderr} stdout: ${stdout}`);
    const out = JSON.parse(stdout.trim().split("\n").pop());
    assert.equal(out.writerWaiting, true, "the writer was waiting before the spawn");
    assert.equal(out.timedOut, false, `the child or the writer hung: ${JSON.stringify(out)}`);
    assert.deepEqual(out.writer, { code: 0, signal: null }, "the writer was not cut off (no SIGPIPE)");
    assert.deepEqual(out.child, { code: 0, signal: null });
    assert.equal(readFileSync(t.out, "utf8"), content, "the child got every byte");
    assert.ok(out.spawnMs < 1000, `spawn took ${out.spawnMs} ms`);
    assertOneCallWithoutHost(t.home, `van394first${tool}`, tool, ["llm.example.test", "s3cret"]);
  } finally {
    releaseFifo(fifo);
  }
}

test("curl -K <fifo> with a writer already waiting: the child gets every byte", { timeout: 20000 }, async () => {
  await checkWriterFirst("curl", 'header = "Authorization: Bearer s3cret"\nurl = "https://llm.example.test/v1/x"\n');
});

test("wget -i <fifo> with a writer already waiting: the child gets every byte", { timeout: 20000 }, async () => {
  await checkWriterFirst("wget", "https://llm.example.test/v1/x?k=s3cret\n");
});

const SPAWN_ONCE_SCRIPT = `
const { spawn } = require("node:child_process");
const child = spawn(process.env.VAN394_TOOL, [process.env.VAN394_FLAG, process.env.TARGET], { stdio: ["inherit", "ignore", "ignore"] });
const watchdog = setTimeout(() => child.kill("SIGKILL"), 5000);
child.on("exit", (code, signal) => {
  clearTimeout(watchdog);
  process.stdout.write(JSON.stringify({ code, signal }) + "\\n");
});
`;

async function spawnOnce(tool, trace, target, input) {
  const t = fakeEnv(tool, { VANTIO_TRACE_ID: trace, TARGET: target });
  const { code, signal, stdout, stderr } = await runAgent(SPAWN_ONCE_SCRIPT, t.env, input);
  assert.equal(signal, null, `the agent was killed: ${stderr}`);
  assert.equal(code, 0, `stderr: ${stderr} stdout: ${stdout}`);
  assert.deepEqual(JSON.parse(stdout.trim().split("\n").pop()), { code: 0, signal: null });
  return t;
}

async function checkDevStdin(tool, content) {
  const trace = `van394stdin${tool}`;
  const t = await spawnOnce(tool, trace, "/dev/stdin", content);
  assert.equal(readFileSync(t.out, "utf8"), content, "the child got every byte of stdin");
  assertOneCallWithoutHost(t.home, trace, tool, ["llm.example.test", "s3cret"]);
}

test("curl -K /dev/stdin: stdin is left to the child and the call has no host", { timeout: 20000 }, async () => {
  await checkDevStdin("curl", 'header = "Authorization: Bearer s3cret"\nurl = "https://llm.example.test/v1/x"\n');
});

test("wget -i /dev/stdin: stdin is left to the child and the call has no host", { timeout: 20000 }, async () => {
  await checkDevStdin("wget", "https://llm.example.test/v1/x?k=s3cret\n");
});

// /dev/stdin names the child's stdin. When stdin is a regular file, a plain
// stat would say "regular file", so only the path rule keeps the wrapper from
// reading it. It must not be read: the call is recorded with no host.
test("curl -K /dev/stdin with stdin a regular file: the wrapper does not read it", { timeout: 20000 }, async () => {
  const content = 'url = "https://llm.example.test/v1/x"\n';
  const t = fakeEnv("curl", { VANTIO_TRACE_ID: "van394stdinfile", TARGET: "/dev/stdin" });
  const fd = openSync(regularFile(content), "r");
  const out = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["--require", INTERCEPTOR_PATH, "-e", SPAWN_ONCE_SCRIPT], {
      env: { PATH: process.env.PATH, ...t.env },
      stdio: [fd, "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    const killer = setTimeout(() => child.kill("SIGKILL"), 10000);
    child.on("close", (code, signal) => {
      clearTimeout(killer);
      resolve({ code, signal, stderr });
    });
  });
  closeSync(fd);
  assert.equal(out.signal, null, out.stderr);
  assert.equal(out.code, 0, out.stderr);
  assert.equal(readFileSync(t.out, "utf8"), content, "the child got every byte of stdin");
  assertOneCallWithoutHost(t.home, "van394stdinfile", "curl", ["llm.example.test"]);
});

function regularFile(content) {
  const path = join(mkdtempSync(join(tmpdir(), "van394-file-")), "cfg");
  writeFileSync(path, content);
  return path;
}

test("a regular file is still read: the call is recorded with its host", { timeout: 20000 }, async () => {
  for (const [tool, content] of [["curl", 'url = "https://llm.example.test/v1/x"\n'], ["wget", "https://llm.example.test/v1/x\n"]]) {
    const trace = `van394regular${tool}`;
    const t = await spawnOnce(tool, trace, regularFile(content));
    assert.equal(readFileSync(t.out, "utf8"), content);
    const { log } = readRun(t.home, trace);
    assert.deepEqual(log.calls.map((c) => c.hostname), ["llm.example.test"]);
    assert.deepEqual(log.summary.hosts, ["llm.example.test"]);
  }
});

test("no call is recorded for a file with no URL, a missing file or a directory", { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "van394-none-"));
  const targets = [regularFile("# nothing here\n"), join(dir, "missing"), dir];
  for (const tool of ["curl", "wget"]) {
    for (const [i, target] of targets.entries()) {
      const trace = `van394none${tool}${i}`;
      const t = fakeEnv(tool, { VANTIO_TRACE_ID: trace, TARGET: target });
      const { signal } = await runAgent(SPAWN_ONCE_SCRIPT, t.env);
      assert.equal(signal, null);
      assert.deepEqual(readRun(t.home, trace).log.calls, [], `${tool} ${target}`);
    }
  }
});

test("a file with a URL to a host that is not watched records nothing", { timeout: 20000 }, async () => {
  const trace = "van394unwatched";
  const t = await spawnOnce("curl", trace, regularFile('url = "https://other.example.test/v1/x"\n'));
  assert.deepEqual(readRun(t.home, trace).log.calls, []);
});

test("a curl config is read up to 1 MiB: a URL after 200 KiB is recorded", { timeout: 20000 }, async () => {
  const trace = "van394cap200k";
  const content = "# pad\n".repeat(Math.ceil((200 * 1024) / 6)) + 'url = "https://llm.example.test/v1/late"\n';
  const t = await spawnOnce("curl", trace, regularFile(content));
  assert.deepEqual(readRun(t.home, trace).log.calls.map((c) => c.hostname), ["llm.example.test"]);
});

test("a URL after the first 1 MiB of a curl config is not read: the call is recorded with no host", { timeout: 20000 }, async () => {
  const trace = "van394cap1m";
  const content = "# pad\n".repeat(Math.ceil((1024 * 1024) / 6) + 1) + 'url = "https://llm.example.test/v1/late"\n';
  const t = await spawnOnce("curl", trace, regularFile(content));
  assert.equal(readFileSync(t.out, "utf8").length, content.length, "the child still reads the whole file");
  // The part that was not read could hold a watched URL, so the call is kept
  // with no host, as for a FIFO.
  assertOneCallWithoutHost(t.home, trace, "curl", ["llm.example.test"]);
});

test("a wget list is read up to 64 KiB: a URL after that is not read, and the call has no host", { timeout: 20000 }, async () => {
  const pad = "# pad\n".repeat(Math.ceil((64 * 1024) / 6) + 1);
  const early = await spawnOnce("wget", "van394listearly", regularFile("https://llm.example.test/v1/a\n" + pad));
  assert.deepEqual(readRun(early.home, "van394listearly").log.calls.map((c) => c.hostname), ["llm.example.test"]);
  const late = await spawnOnce("wget", "van394listlate", regularFile(pad + "https://llm.example.test/v1/a\n"));
  assertOneCallWithoutHost(late.home, "van394listlate", "wget", ["llm.example.test"]);
});

// ── Owner decision, option A: a call with no known host is kept, and it is
// left out of the LLM call count and the byte totals ──

const CLI_PATH = join(__dirname, "..", "bin", "vantio.js");
const plain = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

// Runs the stand-in curl once per argv in VAN394_ARGVS, one after another.
const SPAWN_EACH_SCRIPT = `
const { spawnSync } = require("node:child_process");
for (const argv of JSON.parse(process.env.VAN394_ARGVS)) spawnSync("curl", argv, { stdio: "ignore", timeout: 5000 });
`;

const NO_HOST_ARGV = ["-K", "/dev/null", "-d", "x".repeat(5000)];
const KNOWN_HOST_ARGV = ["-d", "y".repeat(300), "https://llm.example.test/v1/x"];

async function runCurls(trace, argvs, extraEnv) {
  const t = fakeEnv("curl", { VANTIO_TRACE_ID: trace, VAN394_ARGVS: JSON.stringify(argvs), ...extraEnv });
  const { code, signal, stderr } = await runAgent(SPAWN_EACH_SCRIPT, t.env);
  assert.equal(signal, null, `the agent was killed: ${stderr}`);
  assert.equal(code, 0, `stderr: ${stderr}`);
  return { summaryText: plain(stderr), log: readRun(t.home, trace).log };
}

test("a call with no known host is kept, and left out of the call count and the byte totals", { timeout: 20000 }, async () => {
  const { summaryText, log } = await runCurls("van394optiona", [NO_HOST_ARGV, KNOWN_HOST_ARGV]);
  assert.deepEqual(log.calls.map((c) => c.hostname), [null, "llm.example.test"], "both records are kept");
  assert.equal(log.calls[0].request_bytes, 5000, "the record keeps its own size");
  assert.equal(log.summary.total_calls, 1);
  assert.equal(log.summary.total_bytes, 300);
  assert.equal(log.summary.calls_without_host, 1);
  assert.deepEqual(log.summary.hosts, ["llm.example.test"]);
  assert.deepEqual(log.summary.by_host, { "llm.example.test": { calls: 1, bytes: 300, errors: 0 } });
  assert.equal(Object.values(log.summary.by_provider).reduce((a, p) => a + p.bytes, 0), 300);
  assert.match(summaryText, /LLM calls: +1\n/);
  assert.match(summaryText, /Hosts: +llm\.example\.test\n/);
  assert.match(summaryText, /Total bytes: +300\n/);
  assert.match(summaryText, /Calls with no known host: 1 \(not counted above\)\n/);
});

test("a run with only a no-host call shows zero LLM calls and the no-host count", { timeout: 20000 }, async () => {
  const { summaryText, log } = await runCurls("van394optionaonly", [NO_HOST_ARGV]);
  assert.equal(log.calls.length, 1, "the record is kept");
  assert.equal(log.summary.total_calls, 0);
  assert.equal(log.summary.total_bytes, 0);
  assert.match(summaryText, /LLM calls: +0\n/);
  assert.match(summaryText, /Hosts: +none\n/);
  assert.match(summaryText, /Total bytes: +0\n/, "the run file says 0, so the summary says 0");
  assert.match(summaryText, /Calls with no known host: 1 \(not counted above\)\n/);
});

test("a call to a known host is still counted with its bytes, and no no-host line is printed", { timeout: 20000 }, async () => {
  const { summaryText, log } = await runCurls("van394optionaknown", [KNOWN_HOST_ARGV]);
  assert.deepEqual(log.calls.map((c) => c.hostname), ["llm.example.test"]);
  assert.equal(log.summary.total_calls, 1);
  assert.equal(log.summary.total_bytes, 300);
  assert.equal(log.summary.calls_without_host, 0);
  assert.deepEqual(log.summary.by_host, { "llm.example.test": { calls: 1, bytes: 300, errors: 0 } });
  assert.match(summaryText, /LLM calls: +1\n/);
  assert.match(summaryText, /Total bytes: +300\n/);
  assert.ok(!summaryText.includes("no known host"), summaryText);
});

function discoverLocal(calls, extraArgs) {
  const home = mkdtempSync(join(tmpdir(), "van394-discover-"));
  const runs = join(home, ".vantio", "runs");
  mkdirSync(runs, { recursive: true });
  writeFileSync(join(runs, "van394discover.json"), JSON.stringify({
    vantio_run_log: "1",
    trace_id: "van394discover",
    generated_at: new Date().toISOString(),
    calls,
    summary: optionASummary(calls),
  }));
  const run = spawnSync(process.execPath, [CLI_PATH, "discover", "--local", ...extraArgs], {
    env: { PATH: process.env.PATH, HOME: home },
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

// A log written under option A has `calls_without_host` in its summary. A log
// without a summary here is made like that, so the readers treat it as new.
function optionASummary(calls) {
  const counted = calls.filter((c) => c && c.hostname);
  return { total_calls: counted.length, calls_without_host: calls.length - counted.length };
}

const NO_HOST_CALL = { hostname: null, provider: "unknown", bytes: 5000, action: "OBSERVED", mediation: "node_curl" };
const KNOWN_HOST_CALL = { hostname: "llm.example.test", provider: "unknown", bytes: 300, action: "OBSERVED", mediation: "node_curl" };

test("vantio discover leaves a no-host call out of the rows and totals, and counts it on its own line", { timeout: 40000 }, () => {
  const json = JSON.parse(discoverLocal([NO_HOST_CALL, KNOWN_HOST_CALL], ["--json"]));
  assert.deepEqual(json.hosts.map((h) => [h.host, h.total, h.bytes]), [["llm.example.test", 1, 300]]);
  assert.equal(json.calls_without_host, 1);
  const text = discoverLocal([NO_HOST_CALL, KNOWN_HOST_CALL], []);
  assert.match(text, /1 host\(s\) {2}\| {2}1 total call\(s\) observed locally\n/);
  assert.match(text, /Calls with no known host: 1 \(not counted above\)\n/);
  assert.ok(!/^unknown /m.test(text), text);
  const only = discoverLocal([NO_HOST_CALL], []);
  assert.match(only, /No LLM calls recorded/);
  assert.match(only, /Calls with no known host: 1 \(not counted above\)\n/);
});

test("vantio discover still counts a known-host call with its bytes, and prints no no-host line", { timeout: 40000 }, () => {
  const json = JSON.parse(discoverLocal([KNOWN_HOST_CALL], ["--json"]));
  assert.deepEqual(json.hosts.map((h) => [h.host, h.total, h.bytes]), [["llm.example.test", 1, 300]]);
  assert.equal(json.calls_without_host, 0);
  const text = discoverLocal([KNOWN_HOST_CALL], []);
  assert.match(text, /llm\.example\.test +1 +300 /);
  assert.ok(!text.includes("no known host"), text);
});

// 4. The run status uses the same counted set as the totals.

function runSummaryEvent(stderr) {
  const line = stderr.split("\n").find((l) => l.includes('"run_summary"'));
  assert.ok(line, `no run_summary event in: ${stderr}`);
  return JSON.parse(line);
}

test("a run with only a no-host call reports NOT_OBSERVED with zero calls", { timeout: 20000 }, async () => {
  const { summaryText } = await runCurls("van394status", [NO_HOST_ARGV], { VANTIO_JSON: "1" });
  const event = runSummaryEvent(summaryText);
  assert.equal(event.calls, 0);
  assert.equal(event.calls_without_host, 1);
  assert.equal(event.opticsStatus, "NOT_OBSERVED");
  assert.equal(event.applicationStatus, "NOT_OBSERVED");
});

test("a run with a known-host call still reports SUCCESS", { timeout: 20000 }, async () => {
  const { summaryText } = await runCurls("van394statusknown", [NO_HOST_ARGV, KNOWN_HOST_ARGV], { VANTIO_JSON: "1" });
  const event = runSummaryEvent(summaryText);
  assert.equal(event.calls, 1);
  assert.equal(event.opticsStatus, "SUCCESS");
});

// 2, 3 and 5. The readers agree with the run summary.

function cliWithLogs(logs) {
  const home = mkdtempSync(join(tmpdir(), "van394-readers-"));
  const runs = join(home, ".vantio", "runs");
  mkdirSync(runs, { recursive: true });
  for (const log of logs) {
    writeFileSync(join(runs, `${log.trace_id}.json`), JSON.stringify({
      vantio_run_log: "1",
      generated_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      ...(log.summary === undefined ? { summary: optionASummary(log.calls || []) } : {}),
      ...log,
    }));
  }
  const cli = (args) => {
    const run = spawnSync(process.execPath, [CLI_PATH, ...args], {
      env: { PATH: process.env.PATH, HOME: home },
      encoding: "utf8",
      timeout: 15000,
    });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout;
  };
  cli.home = home;
  return cli;
}

// A Node run log written under option A, and a Python one (no by_host).
const MIXED_NODE_LOG = {
  trace_id: "van394mixed",
  calls: [NO_HOST_CALL, KNOWN_HOST_CALL],
  summary: { total_calls: 1, total_bytes: 300, calls_without_host: 1, hosts: ["llm.example.test"] },
};
const KNOWN_NODE_LOG = {
  trace_id: "van394known",
  calls: [KNOWN_HOST_CALL],
  summary: { total_calls: 1, total_bytes: 300, calls_without_host: 0, hosts: ["llm.example.test"] },
};

test("vantio prove: the call log heading matches its rows and names the no-host count", { timeout: 40000 }, () => {
  const cli = cliWithLogs([MIXED_NODE_LOG]);
  const md = cli(["prove", "--run=van394mixed", "--format=md"]);
  assert.match(md, /## Call log \(2 calls\)\n/);
  assert.equal(md.split("\n").filter((l) => /^\| \d+ \|/.test(l)).length, 2, "both rows are listed");
  assert.match(md, /\| Total calls \| \*\*1\*\* \|/);
  assert.match(md, /\nCalls with no known host: 1 \(listed above, not counted in the summary\)\n/);
  const htmlPath = join(mkdtempSync(join(tmpdir(), "van394-proof-")), "proof.html");
  cli(["prove", "--run=van394mixed", "--format=html", `--out=${htmlPath}`]);
  const html = readFileSync(htmlPath, "utf8");
  assert.match(html, /<h2>Call log \(2 calls\)<\/h2>/);
  assert.match(html, /Calls with no known host: 1 \(listed above, not counted in the summary\)/);
  const json = JSON.parse(cli(["prove", "--run=van394mixed", "--json"]));
  assert.equal(json.calls.length, 2);
  assert.equal(json.summary.total_calls, 1);
  assert.equal(json.summary.calls_without_host, 1);
});

test("vantio prove: a no-host-only log is not reported as a successful observation", { timeout: 40000 }, () => {
  const cli = cliWithLogs([{ trace_id: "van394only", calls: [NO_HOST_CALL] }]);
  const json = JSON.parse(cli(["prove", "--run=van394only", "--json"]));
  assert.equal(json.opticsStatus, "NOT_OBSERVED");
  assert.equal(json.summary.total_calls, 0);
  assert.equal(json.summary.total_bytes, 0);
  assert.equal(json.calls.length, 1, "the row is still listed");
});

test("vantio prove: a log with only known-host calls has no no-host line", { timeout: 40000 }, () => {
  const cli = cliWithLogs([KNOWN_NODE_LOG]);
  const md = cli(["prove", "--run=van394known", "--format=md"]);
  assert.match(md, /## Call log \(1 call\)\n/);
  assert.ok(!md.includes("no known host"), md);
  const json = JSON.parse(cli(["prove", "--run=van394known", "--json"]));
  assert.equal(json.opticsStatus, "SUCCESS");
  assert.equal(json.summary.calls_without_host, 0);
});

test("vantio diff: a Python run log with a no-host call adds no `unknown` host", { timeout: 40000 }, () => {
  // Python run logs have no by_host and no total_bytes.
  const cli = cliWithLogs([
    { trace_id: "van394pya", runtime: "python", calls: [KNOWN_HOST_CALL], summary: { hosts: ["llm.example.test"], calls_without_host: 0 } },
    { trace_id: "van394pyb", runtime: "python", calls: [KNOWN_HOST_CALL, NO_HOST_CALL], summary: { hosts: ["llm.example.test"], calls_without_host: 1 } },
  ]);
  const json = JSON.parse(cli(["diff", "van394pya", "van394pyb", "--json"]));
  const text = JSON.stringify(json);
  assert.ok(!text.includes("unknown"), text);
  assert.equal(json.delta_calls, 0);
  assert.equal(json.delta_bytes, 0);
});

test("vantio diff: a new known host is still reported with its calls and bytes", { timeout: 40000 }, () => {
  const other = { ...KNOWN_HOST_CALL, hostname: "llm2.example.test", bytes: 70 };
  const cli = cliWithLogs([
    { trace_id: "van394pyc", runtime: "python", calls: [KNOWN_HOST_CALL] },
    { trace_id: "van394pyd", runtime: "python", calls: [KNOWN_HOST_CALL, other, NO_HOST_CALL] },
  ]);
  const json = JSON.parse(cli(["diff", "van394pyc", "van394pyd", "--json"]));
  assert.equal(json.delta_calls, 1);
  assert.equal(json.delta_bytes, 70);
  assert.ok(JSON.stringify(json).includes("llm2.example.test"));
  assert.ok(!JSON.stringify(json).includes("unknown"));
});

test("vantio coverage: a no-host call gets no destination row and its own count", { timeout: 40000 }, () => {
  const cli = cliWithLogs([{ trace_id: "van394cov", program: "agent.js", calls: [NO_HOST_CALL, KNOWN_HOST_CALL] }]);
  const json = JSON.parse(cli(["coverage", "--json"]));
  const rows = json.systems.flatMap((sys) => [...sys.under_authority, ...sys.outside_authority]);
  const mine = rows.filter((r) => r.destination === "llm.example.test");
  assert.deepEqual(mine.map((r) => [r.calls, r.bytes]), [[1, 300]]);
  assert.ok(!rows.some((r) => r.destination === "unknown"), JSON.stringify(rows));
  assert.equal(json.counts.calls_without_host, 1);
  assert.equal(json.connections.filter((c) => c.trace_id === "van394cov").length, 2, "both connections are listed");
  assert.match(cli(["coverage"]), /\nCalls with no known host: 1 \(not counted above\)\n/);
});

test("vantio coverage: with only known-host calls there is no no-host line", { timeout: 40000 }, () => {
  const cli = cliWithLogs([{ trace_id: "van394cov2", program: "agent.js", calls: [KNOWN_HOST_CALL] }]);
  const json = JSON.parse(cli(["coverage", "--json"]));
  assert.equal(json.counts.calls_without_host, 0);
  assert.ok(!cli(["coverage"]).includes("no known host"));
});

test("vantio discover --host prints no no-host line; without --host it does", { timeout: 40000 }, () => {
  const filtered = discoverLocal([NO_HOST_CALL, KNOWN_HOST_CALL], ["--host=llm.example"]);
  assert.match(filtered, /llm\.example\.test +1 +300 /);
  assert.ok(!filtered.includes("no known host"), filtered);
  const filteredJson = JSON.parse(discoverLocal([NO_HOST_CALL, KNOWN_HOST_CALL], ["--host=llm.example", "--json"]));
  assert.ok(!("calls_without_host" in filteredJson));
  assert.match(discoverLocal([NO_HOST_CALL, KNOWN_HOST_CALL], []), /Calls with no known host: 1 \(not counted above\)\n/);
});

// A log written before option A has no `calls_without_host`, and its summary
// counts the call with no known host. prove must not say it is "not counted in
// the summary" for such a log.
const OLD_LOG = {
  trace_id: "van394old",
  calls: [NO_HOST_CALL, KNOWN_HOST_CALL],
  summary: { total_calls: 2, total_bytes: 5300, hosts: ["llm.example.test", "unknown"] },
};

test("vantio prove: a log from before option A prints no 'not counted' line and no count", { timeout: 40000 }, () => {
  const cli = cliWithLogs([OLD_LOG]);
  const md = cli(["prove", "--run=van394old", "--format=md"]);
  assert.match(md, /\| Total calls \| \*\*2\*\* \|/, "the old summary is shown as it was written");
  assert.ok(!md.includes("no known host"), md);
  const htmlPath = join(mkdtempSync(join(tmpdir(), "van394-proof-")), "proof.html");
  cli(["prove", "--run=van394old", "--format=html", `--out=${htmlPath}`]);
  assert.ok(!readFileSync(htmlPath, "utf8").includes("no known host"));
  const json = JSON.parse(cli(["prove", "--run=van394old", "--json"]));
  assert.equal(json.summary.total_calls, 2);
  assert.ok(!("calls_without_host" in json.summary));
});

test("vantio prove: a log from after option A with the same calls still prints the line", { timeout: 40000 }, () => {
  const cli = cliWithLogs([{ ...OLD_LOG, trace_id: "van394new", summary: { total_calls: 1, total_bytes: 300, calls_without_host: 1, hosts: ["llm.example.test"] } }]);
  assert.match(cli(["prove", "--run=van394new", "--format=md"]), /\nCalls with no known host: 1 \(listed above, not counted in the summary\)\n/);
});

// tail and search on a log with a no-host call: rows are listed, counts follow the rule.
test("vantio tail and search --json: the no-host row is listed, total_calls and status follow the counting rule", { timeout: 40000 }, () => {
  const cli = cliWithLogs([
    { trace_id: "van394tailonly", calls: [NO_HOST_CALL], summary: { total_calls: 0, calls_without_host: 1, hosts: [] } },
    MIXED_NODE_LOG,
    KNOWN_NODE_LOG,
  ]);
  const only = JSON.parse(cli(["tail", "--run=van394tailonly", "--json", "--all"]));
  assert.equal(only.calls.length, 1);
  assert.equal(only.total_calls, 0);
  assert.equal(only.opticsStatus, "NOT_OBSERVED");
  const mixed = JSON.parse(cli(["tail", "--run=van394mixed", "--json", "--all"]));
  assert.equal(mixed.calls.length, 2);
  assert.equal(mixed.total_calls, 1);
  assert.equal(mixed.opticsStatus, "SUCCESS");
  const known = JSON.parse(cli(["tail", "--run=van394known", "--json", "--all"]));
  assert.equal(known.total_calls, 1);
  assert.equal(known.opticsStatus, "SUCCESS");
  const searchOnly = JSON.parse(cli(["search", "--run=van394tailonly", "--json"]));
  assert.equal(searchOnly.calls.length, 1);
  assert.equal(searchOnly.opticsStatus, "NOT_OBSERVED");
  const searchMixed = JSON.parse(cli(["search", "--run=van394mixed", "--json"]));
  assert.equal(searchMixed.calls.length, 2);
  assert.equal(searchMixed.opticsStatus, "SUCCESS");
});

test("vantio export --jsonl: the no-host call is marked, a known call is not", { timeout: 40000 }, () => {
  const cli = cliWithLogs([{ trace_id: "van394exp", program: "agent.js", calls: [NO_HOST_CALL, KNOWN_HOST_CALL] }]);
  const events = cli(["export", "--jsonl=-"]).split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l))
    .filter((e) => e.kind === "observation");
  assert.equal(events.length, 2);
  assert.deepEqual(events.filter((e) => e.no_host === true).map((e) => e.destination), ["unknown"]);
  assert.ok(events.filter((e) => e.destination === "llm.example.test").every((e) => !("no_host" in e)));
});

// ── Round 6 ──

// One rule for a log from before option A: it is read as main read it. Every
// call counts, and no reader shows a no-host count, line or marker. All the
// readers give the same total for the same log.
test("a log from before option A: every reader gives the same total and shows no no-host count", { timeout: 60000 }, () => {
  const cli = cliWithLogs([{ ...OLD_LOG, trace_id: "van394oldall", program: "agent.js" }]);
  const run = "--run=van394oldall";
  assert.match(cli(["prove", run, "--format=md"]), /\| Total calls \| \*\*2\*\* \|/);
  assert.equal(JSON.parse(cli(["prove", run, "--json"])).summary.total_calls, 2);
  assert.match(cli(["prove", "--list"]), /^van394oldall +2 +/m);
  const tail = JSON.parse(cli(["tail", run, "--json", "--all"]));
  assert.equal(tail.total_calls, 2);
  assert.equal(tail.opticsStatus, "SUCCESS");
  assert.ok(!("calls_without_host" in tail));
  const discover = JSON.parse(cli(["discover", "--local", "--json"]));
  assert.deepEqual(discover.hosts.map((h) => [h.host, h.total]).sort(), [["llm.example.test", 1], ["unknown", 1]]);
  assert.equal(discover.calls_without_host, 0);
  const discoverText = cli(["discover", "--local"]);
  assert.match(discoverText, /2 host\(s\) {2}\| {2}2 total call\(s\)/);
  assert.ok(!discoverText.includes("no known host"), discoverText);
  const coverage = JSON.parse(cli(["coverage", "--json"]));
  // Other connections of this machine may be listed too, so count this log's.
  assert.equal(coverage.connections.filter((c) => c.trace_id === "van394oldall").length, 2);
  assert.equal(coverage.counts.connections, coverage.connections.length, "every connection is counted");
  assert.equal(coverage.counts.calls_without_host, 0);
  assert.ok(coverage.connections.every((c) => !("no_host" in c)));
  const coverageText = cli(["coverage"]);
  assert.match(coverageText, new RegExp(`Connections seen: ${coverage.connections.length}\\n`));
  assert.ok(!coverageText.includes("no known host"));
  const events = cli(["export", "--jsonl=-"]).split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l))
    .filter((e) => e.kind === "observation");
  assert.equal(events.length, 2);
  assert.ok(events.every((e) => !("no_host" in e)));
  assert.equal(JSON.parse(cli(["search", run, "--json"])).opticsStatus, "SUCCESS");
});

test("a log from after option A, with the same calls: the readers count one call and show the no-host count", { timeout: 60000 }, () => {
  const cli = cliWithLogs([{ ...MIXED_NODE_LOG, trace_id: "van394newall", program: "agent.js" }]);
  assert.equal(JSON.parse(cli(["prove", "--run=van394newall", "--json"])).summary.total_calls, 1);
  assert.equal(JSON.parse(cli(["tail", "--run=van394newall", "--json", "--all"])).total_calls, 1);
  const coverage = JSON.parse(cli(["coverage", "--json"]));
  assert.equal(coverage.counts.connections, coverage.connections.length - 1, "the no-host call is not counted");
  assert.equal(JSON.parse(cli(["discover", "--local", "--json"])).hosts.length, 1);
});

// tail: the status and the totals come from the whole run, and text and JSON agree.
test("vantio tail -n 1 on a mixed run: the status is the run's, not the shown row's", { timeout: 40000 }, () => {
  const cli = cliWithLogs([MIXED_NODE_LOG, { trace_id: "van394tailonly2", calls: [NO_HOST_CALL], summary: { total_calls: 0, calls_without_host: 1, hosts: [] } }]);
  // The last row of MIXED_NODE_LOG is the known call; reverse it so the last row is the no-host call.
  const reversed = cliWithLogs([{ ...MIXED_NODE_LOG, trace_id: "van394rev", calls: [KNOWN_HOST_CALL, NO_HOST_CALL] }]);
  const last = JSON.parse(reversed(["tail", "--run=van394rev", "--json", "-n", "1"]));
  assert.equal(last.shown, 1);
  assert.equal(last.total_calls, 1);
  assert.equal(last.opticsStatus, "SUCCESS", "the shown row has no host, but the run has a counted call");
  assert.equal(JSON.parse(reversed(["prove", "--run=van394rev", "--json"])).opticsStatus, "SUCCESS");
  assert.equal(JSON.parse(reversed(["search", "--run=van394rev", "--json"])).opticsStatus, "SUCCESS");
  const only = JSON.parse(cli(["tail", "--run=van394tailonly2", "--json", "-n", "1"]));
  assert.equal(only.opticsStatus, "NOT_OBSERVED");
});

test("vantio tail: the text says what the JSON says for a no-host-only run", { timeout: 40000 }, () => {
  const cli = cliWithLogs([{ trace_id: "van394text", calls: [NO_HOST_CALL], summary: { total_calls: 0, calls_without_host: 1, hosts: [] } }]);
  const json = JSON.parse(cli(["tail", "--run=van394text", "--json"]));
  assert.equal(json.total_calls, 0);
  assert.equal(json.calls_without_host, 1);
  assert.equal(json.shown, 1);
  const text = cli(["tail", "--run=van394text"]);
  assert.match(text, /showing 1 of 1 call\(s\) \(0 counted, 1 with no known host\)/);
  const known = cliWithLogs([KNOWN_NODE_LOG]);
  assert.match(known(["tail", "--run=van394known"]), /showing 1 of 1 call\(s\)\n/);
});

// coverage: counts.connections leaves the no-host call out.
test("vantio coverage: counts.connections and the text leave the no-host call out", { timeout: 40000 }, () => {
  const cli = cliWithLogs([{ trace_id: "van394covn", program: "agent.js", calls: [NO_HOST_CALL, KNOWN_HOST_CALL], summary: { total_calls: 1, calls_without_host: 1, hosts: ["llm.example.test"] } }]);
  const json = JSON.parse(cli(["coverage", "--json"]));
  const mine = json.connections.filter((c) => c.trace_id === "van394covn");
  assert.equal(mine.length, 2);
  assert.equal(mine.filter((c) => c.no_host === true).length, 1);
  // Other connections of this machine may be listed too. The no-host call is the only one not counted.
  assert.equal(json.counts.connections, json.connections.length - 1);
  assert.equal(json.counts.calls_without_host, 1);
  assert.match(cli(["coverage"]), new RegExp(`Connections seen: ${json.counts.connections}\n`));
});

// OTLP: a no-host call is kept as a span and a log record, marked `vantio.no_host`
// with no `server.address`, and it is left out of the byte metric.
async function otlpPayloads(logs) {
  const cli = cliWithLogs(logs);
  const got = {};
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      got[req.url] = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const child = spawn(process.execPath, [CLI_PATH, "export", `--otlp=http://127.0.0.1:${server.address().port}`], {
      env: { PATH: process.env.PATH, HOME: cli.home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    const code = await new Promise((resolve) => {
      const killer = setTimeout(() => child.kill("SIGKILL"), 15000);
      child.on("close", (c) => { clearTimeout(killer); resolve(c); });
    });
    assert.equal(code, 0, stderr);
  } finally {
    server.close();
  }
  const attr = (list, key) => (list || []).find((a) => a.key === key);
  const spans = got["/v1/traces"].resourceSpans[0].scopeSpans[0].spans;
  const records = got["/v1/logs"].resourceLogs[0].scopeLogs[0].logRecords;
  const points = got["/v1/metrics"].resourceMetrics[0].scopeMetrics[0].metrics[0].gauge.dataPoints;
  return { spans, records, points, attr, raw: JSON.stringify(got) };
}

test("OTLP export: a no-host-only run has a marked span and log record, and no byte metric", { timeout: 60000 }, async () => {
  const { spans, records, points, attr, raw } = await otlpPayloads([{ trace_id: "van394otlpo", program: "agent.js", calls: [NO_HOST_CALL] }]);
  assert.equal(spans.length, 1);
  assert.equal(attr(spans[0].attributes, "server.address"), undefined);
  assert.deepEqual(attr(spans[0].attributes, "vantio.no_host").value, { boolValue: true });
  assert.equal(records.length, 1);
  assert.equal(attr(records[0].attributes, "server.address"), undefined);
  assert.deepEqual(points, []);
  assert.ok(!raw.includes('{"key":"server.address","value":{"stringValue":"unknown"}}'), raw);
});

test("OTLP export: a known-host run is unchanged", { timeout: 60000 }, async () => {
  const { spans, points, attr } = await otlpPayloads([{ trace_id: "van394otlpk", program: "agent.js", calls: [KNOWN_HOST_CALL] }]);
  assert.equal(spans.length, 1);
  assert.equal(attr(spans[0].attributes, "server.address").value.stringValue, "llm.example.test");
  assert.equal(attr(spans[0].attributes, "vantio.no_host"), undefined);
  assert.deepEqual(points.map((p) => [attr(p.attributes, "server.address").value.stringValue, p.asInt]), [["llm.example.test", "300"]]);
});

test("OTLP export: in a mixed run the no-host call is in no host row and no byte total", { timeout: 60000 }, async () => {
  const { spans, records, points, attr, raw } = await otlpPayloads([{ trace_id: "van394otlpm", program: "agent.js", calls: [NO_HOST_CALL, KNOWN_HOST_CALL] }]);
  assert.equal(spans.length, 2);
  // The known host also gets its own "New destination" record. The no-host call gets exactly one record, with no host.
  assert.equal(records.filter((r) => attr(r.attributes, "vantio.no_host")).length, 1);
  assert.ok(records.filter((r) => !attr(r.attributes, "server.address")).every((r) => attr(r.attributes, "vantio.no_host")));
  assert.equal(spans.filter((sp) => attr(sp.attributes, "vantio.no_host")).length, 1);
  assert.deepEqual(points.map((p) => [attr(p.attributes, "server.address").value.stringValue, p.asInt]), [["llm.example.test", "300"]]);
  assert.ok(!raw.includes('{"key":"server.address","value":{"stringValue":"unknown"}}'), raw);
});

// The second check after the open (fstat) and the non-blocking open. The test
// makes stat say "regular file" for a FIFO, as if the path were swapped after
// the stat. The FIFO has no reader of its own and a writer holds data: if the
// wrapper read it, the host in the data would be recorded. If the open were
// blocking, the agent would hang and be killed by the timeout below.
const SWAP_SCRIPT = `
const fs = require("node:fs");
const realStat = fs.statSync;
fs.statSync = (p, ...a) => (String(p) === process.env.FIFO ? realStat(process.env.REGULAR, ...a) : realStat(p, ...a));
require(process.env.INTERCEPTOR);
const { spawn } = require("node:child_process");
// A writer, opened non-blocking, puts the config in the FIFO once the wrapper has its fd.
const child = spawn("curl", ["-K", process.env.FIFO], { stdio: "ignore" });
child.on("exit", (code) => process.stdout.write(JSON.stringify({ code }) + "\\n"));
`;

async function swapRun(withWriter) {
  const work = mkdtempSync(join(tmpdir(), "van394-swap-"));
  const home = join(work, "home");
  mkdirSync(home);
  const fifo = join(work, "cfg");
  execFileSync("mkfifo", [fifo]);
  const regular = regularFile('url = "https://llm.example.test/v1/x"\n');
  // A stand-in curl that exits at once and never opens the path, so only the wrapper could read it.
  const bin = mkdtempSync(join(tmpdir(), "van394-bin-"));
  writeFileSync(join(bin, "curl"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "curl"), 0o755);
  // A holder keeps the FIFO open for writing with the config in it, so a read would see the URL.
  // Without the holder the FIFO has no writer: a blocking open of it would wait for ever.
  const holder = withWriter
    ? spawn("sh", ["-c", 'exec 3<>"$FIFO"; printf "%s" "$CONTENT" >&3; sleep 8'], {
      env: { FIFO: fifo, CONTENT: 'url = "https://llm.example.test/v1/x"\n' },
      stdio: "ignore",
    })
    : null;
  await new Promise((resolve) => setTimeout(resolve, 300));
  try {
    const out = await new Promise((resolve) => {
      const child = spawn(process.execPath, ["-e", SWAP_SCRIPT], {
        env: {
          PATH: `${bin}:${process.env.PATH}`, HOME: home, VANTIO_HOME: home, VANTIO_TRACE_ID: "van394swap",
          VANTIO_EXTRA_LLM_HOSTS: "llm.example.test", VAN394_OUT: join(work, "out"), FIFO: fifo, REGULAR: regular,
          INTERCEPTOR: INTERCEPTOR_PATH,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (c) => (stderr += c));
      const killer = setTimeout(() => child.kill("SIGKILL"), 6000);
      child.on("close", (code, signal) => { clearTimeout(killer); resolve({ code, signal, stderr }); });
    });
    assert.equal(out.signal, null, `the agent hung: a blocking open? ${out.stderr}`);
    assert.equal(out.code, 0, out.stderr);
    const { log } = readRun(home, "van394swap");
    assert.deepEqual(log.calls.map((c) => c.hostname), [null], "the FIFO was not read: the call has no host");
  } finally {
    if (holder) holder.kill("SIGKILL");
    releaseFifo(fifo);
  }
}

test("a path swapped to a FIFO after the stat, with a writer: closed without a read (the fstat check)", { timeout: 30000 }, async () => {
  await swapRun(true);
});

test("a path swapped to a FIFO after the stat, with no writer: no blocking open (O_NONBLOCK)", { timeout: 30000 }, async () => {
  await swapRun(false);
});
