// VAN-394: the wrapper must find the same URL as main for every curl, wget,
// httpie and aria2c command line, config file and list file that it can read.
// The only changes from main are for a -K / -i file that is not a regular file
// (FIFO, device, socket, /dev/stdin) or is over the size cap.
//
// Fixture: fixtures/van394-shapes.json.
//   shapes   command shapes with a readable regular file or no file.
//   expected_main   the hosts main (8bee543) recorded for each shape, for Node
//                   and for Python. It is generated, not written by hand:
//     git archive 8bee543 packages/vantio-cli/bin packages/vantio-agent-sdk-py/vantio | tar -x -C <dir>
//     VAN394_MAIN_DIR=<dir> VAN394_MAIN_SHA=8bee543... node --test test/van394-shapes.test.js
//   special  shapes with a FIFO, a link to a FIFO, a socket, a directory,
//            /dev/stdin, /dev/null or an oversize file. Main cannot run these
//            (it hangs on a FIFO), so their expected hosts are written by hand
//            from the rule in each entry's `why`.
// Every command is a stand-in on PATH that exits 0. No network call is made.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INTERCEPTOR_PATH = join(__dirname, "..", "bin", "interceptor.cjs");
const FIXTURE_PATH = join(__dirname, "fixtures", "van394-shapes.json");
const PY_SDK_DIR = join(__dirname, "..", "..", "vantio-agent-sdk-py");
const PY_RUNNER = join(PY_SDK_DIR, "tests", "van394_shapes_runner.py");
const PY_FIXTURE = join(PY_SDK_DIR, "tests", "van394_shapes.json");
const HAS_PYTHON = existsSync(PY_RUNNER) && spawnSync("python3", ["--version"], { encoding: "utf8" }).status === 0;
const MARK = "mark.example.test";
const doc = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

const AGENT = `
const { spawnSync } = require("node:child_process");
const spans = [];
for (const [tool, argv] of JSON.parse(process.env.VAN394_COMMANDS)) {
  const t0 = Date.now();
  spawnSync(tool, argv, { stdio: "ignore", timeout: 10000 });
  spans.push(Date.now() - t0);
  spawnSync("curl", ["https://${MARK}/"], { stdio: "ignore", timeout: 10000 });
}
process.stdout.write(JSON.stringify({ max_spawn_ms: Math.max(0, ...spans) }) + "\\n");
`;

const HAS_PROCFS = existsSync("/proc/self/environ");

// A regular file that reports size 0 and has content: /proc/<pid>/environ of a
// child that sleeps. Its one environment entry is the line `entry`.
function procEnvFile(path, entry, sleepers) {
  const eq = entry.indexOf("=");
  const key = entry.slice(0, eq);
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { env: { [key]: entry.slice(eq + 1) }, stdio: "ignore" });
  sleepers.push(child);
  const environ = `/proc/${child.pid}/environ`;
  const until = Date.now() + 10000;
  // Right after spawn the child may still show the parent's environment.
  while (Date.now() < until) {
    try {
      if (readFileSync(environ, "utf8").startsWith(entry)) break;
    } catch { /* not there yet */ }
    execFileSync("sleep", ["0.05"]);
  }
  symlinkSync(environ, path);
}

function makeFiles(filesDir, keep, group, sleepers) {
  for (const [name, spec] of Object.entries(doc.files)) {
    const path = join(filesDir, name);
    if (spec.procenv) {
      if (group === "procfs") procEnvFile(path, spec.procenv, sleepers);
    } else if (spec.fifo) execFileSync("mkfifo", [path]);
    else if (spec.dir) mkdirSync(path);
    else if (spec.symlink) symlinkSync(spec.symlink.split("{dir}").join(filesDir), path);
    else if (spec.socket) {
      const server = createServer();
      server.listen(path);
      keep.push(server);
    } else {
      const text = (spec.text || "") + (spec.repeat || "").repeat(spec.times || 0) + (spec.then || "");
      writeFileSync(path, Buffer.from(text.split("{dir}").join(filesDir), "utf8"));
    }
  }
}

// Runs every shape of one group through one interceptor, in one process.
async function runNode(interceptorPath, group) {
  const work = mkdtempSync(join(tmpdir(), "van394-shapes-"));
  const bin = join(work, "bin");
  const filesDir = join(work, "files");
  const home = join(work, "home");
  for (const d of [bin, filesDir, home]) mkdirSync(d);
  for (const tool of ["curl", "wget", "aria2c", "http"]) {
    writeFileSync(join(bin, tool), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, tool), 0o755);
  }
  const keep = [];
  const sleepers = [];
  try {
    makeFiles(filesDir, keep, group, sleepers);
    await Promise.all(keep.map((s) => new Promise((resolve) => s.once("listening", resolve))));
    const shapes = doc[group];
    const commands = shapes.map((s) => [s.tool, s.argv.map((a) => a.split("{dir}").join(filesDir))]);
    const run = await new Promise((resolve) => {
      // Not spawnSync: this process holds the socket files open.
      const child = spawn(process.execPath, ["--require", interceptorPath, "-e", AGENT], {
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          HOME: home,
          VANTIO_HOME: home,
          VANTIO_TRACE_ID: "van394shapes",
          VANTIO_EXTRA_LLM_HOSTS: `llm.example.test,${MARK}`,
          NO_PROXY: "*",
          VAN394_COMMANDS: JSON.stringify(commands),
        },
        stdio: ["ignore", "pipe", "ignore"],
      });
      let stdout = "";
      child.stdout.on("data", (c) => (stdout += c));
      const killer = setTimeout(() => child.kill("SIGKILL"), 150000);
      child.on("close", (code, signal) => {
        clearTimeout(killer);
        resolve({ code, signal, stdout });
      });
    });
    assert.equal(run.signal, null, "the agent was killed: a spawn hung");
    assert.equal(run.code, 0);
    const log = JSON.parse(readFileSync(join(home, "runs", "van394shapes.json"), "utf8"));
    const per = [[]];
    for (const call of log.calls) {
      if (call.hostname === MARK) per.push([]);
      else per[per.length - 1].push(call.hostname);
    }
    per.pop();
    assert.equal(per.length, shapes.length, "one mark call per shape");
    const { max_spawn_ms } = JSON.parse(run.stdout.trim().split("\n").pop());
    return { hosts: Object.fromEntries(shapes.map((s, i) => [s.id, per[i]])), max_spawn_ms };
  } finally {
    for (const s of keep) s.close();
    for (const c of sleepers) c.kill("SIGKILL");
    rmSync(work, { recursive: true, force: true });
  }
}

function runPython(sdkDir, group) {
  const work = mkdtempSync(join(tmpdir(), "van394-shapes-py-"));
  try {
    const run = spawnSync("python3", ["-I", PY_RUNNER, sdkDir, PY_FIXTURE, join(work, "run"), group], {
      encoding: "utf8",
      timeout: 200000,
      env: { PATH: process.env.PATH },
    });
    assert.equal(run.status, 0, `the Python runner failed: ${run.stderr}`);
    return JSON.parse(run.stdout.trim().split("\n").pop());
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const generateFrom = process.env.VAN394_MAIN_DIR;
if (generateFrom) {
  test("generate expected_main from a checkout of main", { timeout: 600000 }, async () => {
    assert.ok(HAS_PYTHON, "python3 is needed to generate the Python side");
    const node = await runNode(join(generateFrom, "packages", "vantio-cli", "bin", "interceptor.cjs"), "shapes");
    const python = runPython(join(generateFrom, "packages", "vantio-agent-sdk-py"), "shapes");
    doc.expected_main = {
      generated_from: process.env.VAN394_MAIN_SHA || "unknown",
      node: node.hosts,
      python: python.hosts,
    };
    if (HAS_PROCFS) {
      doc.expected_main.node_procfs = (await runNode(join(generateFrom, "packages", "vantio-cli", "bin", "interceptor.cjs"), "procfs")).hosts;
      doc.expected_main.python_procfs = runPython(join(generateFrom, "packages", "vantio-agent-sdk-py"), "procfs").hosts;
    }
    doc.known_main_mismatch = Object.keys(node.hosts).filter((id) => JSON.stringify(node.hosts[id]) !== JSON.stringify(python.hosts[id]));
    const text = JSON.stringify(doc, null, 1) + "\n";
    writeFileSync(FIXTURE_PATH, text);
    writeFileSync(PY_FIXTURE, text);
  });
} else {
  test("the fixture has main's results and the two copies are the same file", () => {
    assert.ok(doc.expected_main && doc.expected_main.generated_from, "expected_main is missing: generate it from main");
    assert.ok(doc.shapes.length >= 178, `only ${doc.shapes.length} shapes`);
    assert.deepEqual(Object.keys(doc.expected_main.node), doc.shapes.map((s) => s.id));
    assert.deepEqual(Object.keys(doc.expected_main.python), doc.shapes.map((s) => s.id));
    const differ = doc.shapes.map((s) => s.id).filter((id) => JSON.stringify(doc.expected_main.node[id]) !== JSON.stringify(doc.expected_main.python[id]));
    assert.deepEqual(doc.known_main_mismatch, differ, "known_main_mismatch lists exactly where main's Node and Python differ");
    if (existsSync(PY_FIXTURE)) assert.equal(readFileSync(PY_FIXTURE, "utf8"), readFileSync(FIXTURE_PATH, "utf8"));
  });

  test("Node records the same hosts as main for every shape with a readable file or no file", { timeout: 200000 }, async () => {
    const got = await runNode(INTERCEPTOR_PATH, "shapes");
    const wrong = doc.shapes
      .filter((s) => JSON.stringify(got.hosts[s.id]) !== JSON.stringify(doc.expected_main.node[s.id]))
      .map((s) => `${s.id} ${s.tool} ${JSON.stringify(s.argv)}: got ${JSON.stringify(got.hosts[s.id])}, main ${JSON.stringify(doc.expected_main.node[s.id])}`);
    assert.deepEqual(wrong, []);
    assert.ok(got.max_spawn_ms < 3000, `a spawn took ${got.max_spawn_ms} ms`);
  });

  test("Node reads a regular file that reports size 0 (procfs): as main's Python reads it, and as main's Node reads a curl config", { skip: HAS_PROCFS ? false : "no /proc here", timeout: 100000 }, async () => {
    const got = await runNode(INTERCEPTOR_PATH, "procfs");
    const ids = doc.procfs.map((s) => s.id);
    assert.deepEqual(Object.keys(doc.expected_main.node_procfs), ids);
    assert.deepEqual(Object.keys(doc.expected_main.python_procfs), ids);
    // Main's Python reads every one of these files and finds the URL.
    for (const id of ids) assert.deepEqual(doc.expected_main.python_procfs[id], ["api.openai.com"], `main's Python result for ${id}`);
    assert.deepEqual(got.hosts, doc.expected_main.python_procfs);
    // Main's Node read a size-0 curl config (p001) but sized the buffer of a -i list from fstat, so it read
    // nothing from a size-0 list (p002 to p004). That is a main difference between Node and Python, now closed.
    assert.deepEqual(got.hosts.p001, doc.expected_main.node_procfs.p001);
    for (const id of ["p002", "p003", "p004"]) assert.deepEqual(doc.expected_main.node_procfs[id], [], `main's Node result for ${id}`);
  });

  test("Node on FIFO, link to FIFO, socket, directory, /dev/stdin, /dev/null and oversize files: no hang, no-host call where the rule says", { timeout: 200000 }, async () => {
    const got = await runNode(INTERCEPTOR_PATH, "special");
    const wrong = doc.special
      .filter((s) => JSON.stringify(got.hosts[s.id]) !== JSON.stringify(s.hosts))
      .map((s) => `${s.id} ${s.tool} ${JSON.stringify(s.argv)}: got ${JSON.stringify(got.hosts[s.id])}, expected ${JSON.stringify(s.hosts)} (${s.why})`);
    assert.deepEqual(wrong, []);
    assert.ok(got.max_spawn_ms < 3000, `a spawn took ${got.max_spawn_ms} ms`);
  });

  test("Node and Python record the same hosts on every shape, except where main's own Node and Python differ", { skip: HAS_PYTHON ? false : "python3 or the Python package is not here", timeout: 400000 }, async () => {
    const mismatch = new Set(doc.known_main_mismatch);
    for (const group of HAS_PROCFS ? ["shapes", "special", "procfs"] : ["shapes", "special"]) {
      const node = await runNode(INTERCEPTOR_PATH, group);
      const py = runPython(PY_SDK_DIR, group);
      const wrong = [];
      for (const s of doc[group]) {
        const want = group === "shapes" ? doc.expected_main[mismatch.has(s.id) ? "python" : "node"][s.id] : (s.hosts_python || s.hosts);
        if (group === "procfs") {
          if (JSON.stringify(node.hosts[s.id]) !== JSON.stringify(py.hosts[s.id])) wrong.push(`${s.id}: Node ${JSON.stringify(node.hosts[s.id])}, Python ${JSON.stringify(py.hosts[s.id])}`);
        } else if (group === "shapes" && mismatch.has(s.id)) {
          // Same as main, each in its own runtime.
          if (JSON.stringify(py.hosts[s.id]) !== JSON.stringify(want)) wrong.push(`${s.id}: Python ${JSON.stringify(py.hosts[s.id])}, main ${JSON.stringify(want)}`);
        } else if (group === "special" && s.hosts_python) {
          if (JSON.stringify(py.hosts[s.id]) !== JSON.stringify(s.hosts_python)) wrong.push(`${s.id}: Python ${JSON.stringify(py.hosts[s.id])}, expected ${JSON.stringify(s.hosts_python)}`);
        } else if (JSON.stringify(node.hosts[s.id]) !== JSON.stringify(py.hosts[s.id])) {
          wrong.push(`${s.id} ${s.tool} ${JSON.stringify(s.argv)}: Node ${JSON.stringify(node.hosts[s.id])}, Python ${JSON.stringify(py.hosts[s.id])}`);
        }
      }
      assert.deepEqual(wrong, [], group);
    }
  });
}
