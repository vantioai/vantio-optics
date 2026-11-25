// VAN-394, owner decision option A: a call with no known host is recorded, but
// it is left out of the call count, the byte totals and the run status.
//
// Part 1 goes through the real `vantio run` entry point and checks that the
// run file and every reader agree. Part 2 runs the shared curl / wget / aria2c
// vectors that the Python tests run too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, "..", "bin", "vantio.js");
const INTERCEPTOR_PATH = join(__dirname, "..", "bin", "interceptor.cjs");
const VECTORS_PATH = join(__dirname, "fixtures", "van394-curl-vectors.json");
// Sibling packages. They are in the repository, not in the published package.
const PY_SDK_DIR = join(__dirname, "..", "..", "vantio-agent-sdk-py");
const PY_VECTORS_PATH = join(PY_SDK_DIR, "tests", "van394_curl_vectors.json");
const MCP_RUNS_PATH = join(__dirname, "..", "..", "vantio-optics-mcp", "src", "runs.js");

const HAS_PYTHON = existsSync(join(PY_SDK_DIR, "vantio", "__init__.py"))
  && spawnSync("python3", ["--version"], { encoding: "utf8" }).status === 0;
const HAS_MCP = existsSync(MCP_RUNS_PATH);
const WATCHED = "llm.example.test";
const plain = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

// Stand-ins for curl, wget and aria2c. They make no network call.
function standInBin() {
  const dir = mkdtempSync(join(tmpdir(), "van394-run-bin-"));
  for (const name of ["curl", "wget", "aria2c"]) {
    writeFileSync(join(dir, name), "#!/bin/sh\nexit 0\n");
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}
const BIN = standInBin();

// ── Part 1: `vantio run`, then every reader ──

const NO_HOST_ARGV = ["-K", "/dev/null", "-d", "abc"];
const KNOWN_ARGV = ["-d", "abcde", `https://${WATCHED}/v1/x`];
const SCENARIOS = {
  nohost: { argvs: [NO_HOST_ARGV], known: 0, noHost: 1 },
  known: { argvs: [KNOWN_ARGV], known: 1, noHost: 0 },
  mixed: { argvs: [NO_HOST_ARGV, KNOWN_ARGV], known: 1, noHost: 1 },
};

function agentFile(runtime, argvs) {
  const dir = mkdtempSync(join(tmpdir(), "van394-agent-"));
  if (runtime === "node") {
    const file = join(dir, "agent.js");
    writeFileSync(file, `const { spawnSync } = require("node:child_process");
for (const argv of ${JSON.stringify(argvs)}) spawnSync("curl", argv, { stdio: "ignore" });
`);
    return ["node", file];
  }
  const file = join(dir, "agent.py");
  writeFileSync(file, `import json, subprocess
for argv in json.loads(${JSON.stringify(JSON.stringify(argvs))}):
    subprocess.run(["curl", *argv], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
`);
  return ["python3", file];
}

function vantio(home, args, extraEnv) {
  const run = spawnSync(process.execPath, [CLI_PATH, ...args], {
    env: {
      PATH: `${BIN}:${process.env.PATH}`,
      HOME: home,
      VANTIO_EXTRA_LLM_HOSTS: WATCHED,
      ...(HAS_PYTHON ? { PYTHONPATH: PY_SDK_DIR } : {}),
      ...extraEnv,
    },
    encoding: "utf8",
    timeout: 60000,
  });
  assert.equal(run.status, 0, `vantio ${args.join(" ")}: ${run.stderr}`);
  return { stdout: run.stdout, stderr: plain(run.stderr) };
}

function runFile(home, trace) {
  return JSON.parse(readFileSync(join(home, ".vantio", "runs", `${trace}.json`), "utf8"));
}

function vantioRun(runtime, name, flag) {
  const home = mkdtempSync(join(tmpdir(), `van394-run-${runtime}-${name}-`));
  const trace = `van394-${runtime}-${name}`;
  const out = vantio(home, ["run", flag, ...agentFile(runtime, SCENARIOS[name].argvs)], { VANTIO_TRACE_ID: trace });
  return { home, trace, ...out };
}

async function checkReaders(runtime, name) {
  const { known, noHost } = SCENARIOS[name];
  const rows = known + noHost;
  // The Python wrapper stores no `bytes` on a call, so every byte total is 0.
  const bytes = runtime === "node" ? known * 5 : 0;
  const status = known ? "SUCCESS" : "NOT_OBSERVED";
  const noHostLine = `Calls with no known host: ${noHost} (not counted above)`;
  const listedLine = `Calls with no known host: ${noHost} (listed above, not counted in the summary)`;
  const say = (what) => `${runtime} ${name}: ${what}`;

  const { home, trace, stderr } = vantioRun(runtime, name, "--summary");

  // The run file, after `vantio run` has rewritten it.
  const log = runFile(home, trace);
  assert.equal(log.calls.length, rows, say("every call is kept in the run file"));
  assert.equal(log.calls.filter((c) => !c.hostname).length, noHost);
  assert.equal(log.summary.total_calls, known, say("run file total_calls"));
  assert.equal(log.summary.calls_without_host, noHost, say("run file calls_without_host"));
  assert.deepEqual(log.summary.hosts, known ? [WATCHED] : [], say("run file hosts"));
  if (runtime === "node") {
    assert.equal(log.summary.total_bytes, bytes);
    assert.deepEqual(Object.keys(log.summary.by_host), known ? [WATCHED] : []);
    // The run summary text. The Python wrapper prints none.
    assert.match(stderr, new RegExp(`LLM calls: +${known}\\n`), say("summary text"));
    assert.match(stderr, new RegExp(`Total bytes: +${bytes}\\n`));
    assert.equal(stderr.includes(noHostLine), noHost > 0, say("summary no-host line"));
    // The JSON event.
    const jsonRun = vantioRun(runtime, name, "--json");
    const eventLine = jsonRun.stderr.split("\n").find((l) => l.includes('"run_summary"'));
    assert.ok(eventLine, say(`no run_summary event in ${jsonRun.stderr}`));
    const event = JSON.parse(eventLine);
    assert.equal(event.calls, known, say("event calls"));
    assert.equal(event.calls_without_host, noHost);
    assert.equal(event.total_bytes, bytes);
    assert.equal(event.opticsStatus, status, say("event status"));
  } else {
    assert.equal(log.summary.opticsStatus, status, say("run file status"));
  }

  // discover: text, --json, --host.
  const discover = JSON.parse(vantio(home, ["discover", "--local", "--json"]).stdout);
  assert.deepEqual(discover.hosts.map((h) => [h.host, h.total, h.bytes]), known ? [[WATCHED, known, bytes]] : [], say("discover rows"));
  assert.equal(discover.calls_without_host, noHost, say("discover count"));
  assert.equal(discover.opticsStatus, status);
  const discoverText = vantio(home, ["discover", "--local"]).stdout;
  assert.equal(discoverText.includes(noHostLine), noHost > 0, say("discover line"));
  assert.ok(!/^unknown /m.test(discoverText), discoverText);
  if (known) assert.match(discoverText, new RegExp(`1 host\\(s\\) {2}\\| {2}${known} total call\\(s\\)`));
  const discoverHost = vantio(home, ["discover", "--local", "--host=llm.example"]).stdout;
  assert.ok(!discoverHost.includes("no known host"), say("discover --host prints no no-host line"));

  // prove: --json, md, html, --list.
  const prove = JSON.parse(vantio(home, ["prove", `--run=${trace}`, "--json"]).stdout);
  assert.equal(prove.calls.length, rows, say("prove rows"));
  assert.equal(prove.summary.total_calls, known, say("prove total_calls"));
  assert.equal(prove.summary.total_bytes, bytes);
  assert.equal(prove.summary.calls_without_host, noHost);
  assert.equal(prove.opticsStatus, status, say("prove status"));
  const md = vantio(home, ["prove", `--run=${trace}`, "--format=md"]).stdout;
  assert.match(md, new RegExp(`## Call log \\(${rows} call${rows === 1 ? "" : "s"}\\)\\n`), say("prove md heading"));
  assert.equal(md.split("\n").filter((l) => /^\| \d+ \|/.test(l)).length, rows);
  assert.match(md, new RegExp(`\\| Total calls \\| \\*\\*${known}\\*\\* \\|`), say("prove md total"));
  assert.equal(md.includes(listedLine), noHost > 0, say("prove md line"));
  const htmlPath = join(mkdtempSync(join(tmpdir(), "van394-proof-")), "proof.html");
  vantio(home, ["prove", `--run=${trace}`, "--format=html", `--out=${htmlPath}`]);
  const html = readFileSync(htmlPath, "utf8");
  assert.match(html, new RegExp(`<h2>Call log \\(${rows} call${rows === 1 ? "" : "s"}\\)</h2>`), say("prove html heading"));
  assert.match(html, new RegExp(`<div class="metric-value">${known}</div><div class="metric-label">Total calls</div>`));
  assert.equal(html.includes(listedLine), noHost > 0, say("prove html line"));
  const list = vantio(home, ["prove", "--list"]).stdout;
  assert.match(list, new RegExp(`^${trace} +${known} +`, "m"), say(`prove --list: ${list}`));

  // coverage: --json and text. Other programs on this machine may add rows,
  // so only this trace is checked.
  const coverage = JSON.parse(vantio(home, ["coverage", "--json"]).stdout);
  const mine = coverage.connections.filter((c) => c.trace_id === trace);
  assert.equal(mine.length, rows, say("coverage lists every connection"));
  assert.equal(mine.filter((c) => c.no_host === true).length, noHost, say("coverage marks the no-host entry"));
  assert.ok(mine.filter((c) => c.destination === WATCHED).every((c) => !("no_host" in c)));
  assert.equal(coverage.counts.calls_without_host, noHost, say("coverage count"));
  const destinationRows = coverage.systems.flatMap((sys) => [...sys.under_authority, ...sys.outside_authority]);
  assert.ok(!destinationRows.some((r) => r.destination === "unknown"), say("coverage has no `unknown` row"));
  assert.deepEqual(destinationRows.filter((r) => r.destination === WATCHED).map((r) => r.calls), known ? [known] : []);
  const coverageText = vantio(home, ["coverage"]).stdout;
  assert.equal(coverageText.includes(noHostLine), noHost > 0, say("coverage line"));

  // destinations: a call with no known host is never a new destination.
  const destinations = JSON.parse(vantio(home, ["destinations", "--json"]).stdout);
  assert.ok(!JSON.stringify(destinations.alerts).includes("unknown"), say("destinations"));

  // The MCP readers.
  if (HAS_MCP) {
    const mcp = await import(pathToFileURL(MCP_RUNS_PATH).href);
    const runsDir = join(home, ".vantio", "runs");
    const hosts = mcp.discoverLocal(24 * 60 * 60 * 1000, runsDir);
    assert.deepEqual(hosts.map((h) => [h.hostname, h.calls, h.bytes]), known ? [[WATCHED, known, bytes]] : [], say("MCP discover"));
    assert.equal(hosts.calls_without_host, noHost);
    const listed = mcp.listRunLogs(runsDir).find((e) => e.trace_id === trace);
    assert.equal(listed.total_calls, known, say("MCP list"));
    const mcpMd = mcp.proveMarkdown(mcp.loadRun(trace, runsDir).log);
    assert.match(mcpMd, new RegExp(`- Total calls: \\*\\*${known}\\*\\*`), say("MCP prove total"));
    assert.match(mcpMd, new RegExp(`## Calls \\(${rows}\\)\\n`), say("MCP prove heading"));
    assert.equal(mcpMd.includes(listedLine), noHost > 0, say("MCP prove line"));
  }
  return { home, trace };
}

function checkDiff(runtime, runs) {
  // All three runs of one runtime in one home.
  const home = mkdtempSync(join(tmpdir(), `van394-diff-${runtime}-`));
  mkdirSync(join(home, ".vantio", "runs"), { recursive: true });
  for (const run of Object.values(runs)) {
    cpSync(join(run.home, ".vantio", "runs", `${run.trace}.json`), join(home, ".vantio", "runs", `${run.trace}.json`));
  }
  const bytes = runtime === "node" ? 5 : 0;
  const diff = (a, b) => JSON.parse(vantio(home, ["diff", runs[a].trace, runs[b].trace, "--json"]).stdout);
  const knownToMixed = diff("known", "mixed");
  assert.equal(knownToMixed.delta_calls, 0, `${runtime}: the no-host call adds nothing to diff`);
  assert.equal(knownToMixed.delta_bytes, 0);
  assert.ok(!JSON.stringify(knownToMixed).includes("unknown"), JSON.stringify(knownToMixed));
  const noHostToMixed = diff("nohost", "mixed");
  assert.equal(noHostToMixed.a.total_calls, 0);
  assert.equal(noHostToMixed.delta_calls, 1, `${runtime}: the known-host call is still counted in diff`);
  assert.equal(noHostToMixed.delta_bytes, bytes);
  assert.ok(JSON.stringify(noHostToMixed).includes(WATCHED));
  assert.ok(!JSON.stringify(noHostToMixed).includes("unknown"));
}

for (const runtime of ["node", "python"]) {
  const skip = runtime === "python" && !HAS_PYTHON ? "python3 or the Python package is not here" : false;
  const runs = {};
  for (const name of Object.keys(SCENARIOS)) {
    test(`vantio run (${runtime}), ${name}: the run file and every reader agree`, { skip, timeout: 120000 }, async () => {
      runs[name] = await checkReaders(runtime, name);
    });
  }
  test(`vantio diff (${runtime}): runs made by vantio run`, { skip, timeout: 120000 }, () => {
    assert.equal(Object.keys(runs).length, 3, "the three runs above must have passed");
    checkDiff(runtime, runs);
  });
}

test("the CLI and the MCP package count calls by the same rule", { skip: HAS_MCP ? false : "the MCP package is not here" }, async () => {
  const { countedCalls } = require("../bin/optics-cx.cjs");
  const mcp = await import(pathToFileURL(MCP_RUNS_PATH).href);
  const calls = [{ hostname: "a.example.test" }, { hostname: null }, { hostname: "" }, {}, null, { hostname: "b.example.test" }];
  assert.deepEqual(countedCalls(calls), [calls[0], calls[5]]);
  assert.deepEqual(mcp.countedCalls(calls), countedCalls(calls));
});

// ── Part 2: the shared vectors ──

const VECTORS = JSON.parse(readFileSync(VECTORS_PATH, "utf8"));

function writeVectorFiles() {
  const dir = mkdtempSync(join(tmpdir(), "van394-vectors-"));
  for (const [name, spec] of Object.entries(VECTORS.files)) {
    const path = join(dir, name);
    if (spec.fifo) execFileSync("mkfifo", [path]);
    else writeFileSync(path, (spec.text || "") + (spec.repeat || "").repeat(spec.times || 0) + (spec.then || ""));
  }
  return dir;
}

// One wrapped process runs every vector. A call to the mark host after each
// one splits the recorded calls back into vectors.
const VECTOR_AGENT = `
const { spawnSync } = require("node:child_process");
for (const [tool, argv] of JSON.parse(process.env.VAN394_COMMANDS)) {
  spawnSync(tool, argv, { stdio: "ignore", timeout: 5000 });
  spawnSync("curl", ["https://" + process.env.VAN394_MARK + "/"], { stdio: "ignore", timeout: 5000 });
}
`;

function recordedHostsPerVector(interceptorPath) {
  const dir = writeVectorFiles();
  const home = mkdtempSync(join(tmpdir(), "van394-vectors-home-"));
  const commands = VECTORS.vectors.map((v) => [v.tool, v.argv.map((a) => a.replace("{dir}", dir))]);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--require", interceptorPath, "-e", VECTOR_AGENT], {
      env: {
        PATH: `${BIN}:${process.env.PATH}`,
        VANTIO_HOME: home,
        VANTIO_TRACE_ID: "van394vectors",
        VANTIO_EXTRA_LLM_HOSTS: `${VECTORS.watched},${VECTORS.mark}`,
        VAN394_COMMANDS: JSON.stringify(commands),
        VAN394_MARK: VECTORS.mark,
      },
      stdio: "ignore",
    });
    const killer = setTimeout(() => child.kill("SIGKILL"), 90000);
    child.on("close", (code, signal) => {
      clearTimeout(killer);
      if (code !== 0) return reject(new Error(`the agent ended with ${code} ${signal}`));
      const log = JSON.parse(readFileSync(join(home, "runs", "van394vectors.json"), "utf8"));
      const perVector = [[]];
      for (const call of log.calls) {
        if (call.hostname === VECTORS.mark) perVector.push([]);
        else perVector[perVector.length - 1].push(call.hostname);
      }
      perVector.pop();
      resolve(perVector);
    });
  });
}

test("shared vectors: each command records the hosts the vector file names", { timeout: 120000 }, async () => {
  const got = await recordedHostsPerVector(process.env.VAN394_INTERCEPTOR || INTERCEPTOR_PATH);
  assert.equal(got.length, VECTORS.vectors.length, "one mark call per vector");
  const wrong = [];
  VECTORS.vectors.forEach((v, i) => {
    if (JSON.stringify(got[i]) !== JSON.stringify(v.hosts)) {
      wrong.push(`[${v.group}] ${v.name}: ${v.tool} ${JSON.stringify(v.argv)} recorded ${JSON.stringify(got[i])}, expected ${JSON.stringify(v.hosts)}`);
    }
  });
  assert.deepEqual(wrong, []);
});

test("shared vectors: the Node and Python copies are the same file", { skip: existsSync(PY_VECTORS_PATH) ? false : "the Python package is not here" }, () => {
  assert.equal(readFileSync(PY_VECTORS_PATH, "utf8"), readFileSync(VECTORS_PATH, "utf8"));
});
