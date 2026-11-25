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
  assert.deepEqual(Object.keys(log.summary.by_host), ["unknown"], "no watched host is counted");
  assert.deepEqual(log.summary.hosts, ["unknown"]);
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

test("a URL after the first 1 MiB of a curl config is not recorded", { timeout: 20000 }, async () => {
  const trace = "van394cap1m";
  const content = "# pad\n".repeat(Math.ceil((1024 * 1024) / 6) + 1) + 'url = "https://llm.example.test/v1/late"\n';
  const t = await spawnOnce("curl", trace, regularFile(content));
  assert.equal(readFileSync(t.out, "utf8").length, content.length, "the child still reads the whole file");
  assert.deepEqual(readRun(t.home, trace).log.calls, []);
});

test("a wget list is read up to 64 KiB: a URL after that is not recorded", { timeout: 20000 }, async () => {
  const pad = "# pad\n".repeat(Math.ceil((64 * 1024) / 6) + 1);
  const early = await spawnOnce("wget", "van394listearly", regularFile("https://llm.example.test/v1/a\n" + pad));
  assert.deepEqual(readRun(early.home, "van394listearly").log.calls.map((c) => c.hostname), ["llm.example.test"]);
  const late = await spawnOnce("wget", "van394listlate", regularFile(pad + "https://llm.example.test/v1/a\n"));
  assert.deepEqual(readRun(late.home, "van394listlate").log.calls, []);
});
