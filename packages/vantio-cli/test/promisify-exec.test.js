// VAN-385: under the interceptor, util.promisify(exec/execFile) keeps Node's
// { stdout, stderr } shape, a failing command keeps Node's error shape, and
// each curl run is recorded exactly once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INTERCEPTOR_PATH = join(__dirname, "..", "bin", "interceptor.cjs");

const HAS_CURL = (() => {
  try {
    return spawnSync("curl", ["--version"], { encoding: "utf8", timeout: 3000 }).status === 0;
  } catch {
    return false;
  }
})();

function runScript(script, env, { interceptor = true } = {}) {
  return new Promise((resolve) => {
    const argv = interceptor ? ["--require", INTERCEPTOR_PATH, "-e", script] : ["-e", script];
    const child = spawn(process.execPath, argv, {
      env: { PATH: process.env.PATH, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const killer = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr });
    });
  });
}

function lastJson(stdout) {
  return JSON.parse(stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop());
}

const SHAPE_SCRIPT = `
const util = require("node:util");
const cp = require("node:child_process");
(async () => {
  const out = {};
  const r1 = await util.promisify(cp.exec)("echo hi");
  out.exec = { type: typeof r1, stdout: r1 && r1.stdout, stderr: r1 && r1.stderr };
  const r2 = await util.promisify(cp.execFile)(process.execPath, ["-e", "process.stdout.write('x')"]);
  out.execFile = { type: typeof r2, stdout: r2 && r2.stdout, stderr: r2 && r2.stderr };
  try {
    await util.promisify(cp.exec)("echo partial; exit 3");
    out.fail = "resolved";
  } catch (err) {
    out.fail = { code: err.code, stdout: err.stdout, hasStderr: typeof err.stderr === "string" };
  }
  try {
    await util.promisify(cp.execFile)(process.execPath, ["-e", "process.stdout.write('y'); process.exit(4)"]);
    out.failFile = "resolved";
  } catch (err) {
    out.failFile = { code: err.code, stdout: err.stdout };
  }
  const p = util.promisify(cp.exec)("echo child");
  out.hasChild = !!(p.child && typeof p.child.pid === "number");
  await p;
  await new Promise((resolve) => cp.exec("echo cb", (err, so) => { out.callback = { err: err === null, stdout: so }; resolve(); }));
  process.stdout.write(JSON.stringify(out) + "\\n");
})();
`;

test("promisify(exec/execFile) has the same shape with and without the interceptor", async () => {
  const home = mkdtempSync(join(tmpdir(), "van385-shape-"));
  const plain = await runScript(SHAPE_SCRIPT, { VANTIO_HOME: home }, { interceptor: false });
  const wrapped = await runScript(SHAPE_SCRIPT, { VANTIO_HOME: home, VANTIO_TRACE_ID: "van385shape" });
  assert.equal(plain.code, 0, plain.stderr);
  assert.equal(wrapped.code, 0, wrapped.stderr);
  const a = lastJson(plain.stdout);
  const b = lastJson(wrapped.stdout);
  assert.deepEqual(a.exec, { type: "object", stdout: "hi\n", stderr: "" });
  assert.deepEqual(b, a);
});

test("the interceptor still has a promisify.custom on exec and execFile", async () => {
  const script = `
const cp = require("node:child_process");
const sym = Symbol.for("nodejs.util.promisify.custom");
process.stdout.write(JSON.stringify({ exec: typeof cp.exec[sym], execFile: typeof cp.execFile[sym], patched: cp.exec.name }) + "\\n");
`;
  const { code, stdout, stderr } = await runScript(script, { VANTIO_HOME: mkdtempSync(join(tmpdir(), "van385-sym-")) });
  assert.equal(code, 0, stderr);
  assert.deepEqual(lastJson(stdout), { exec: "function", execFile: "function", patched: "vantioExec" });
});

test("a synchronous throw from exec happens once and reaches the caller", async () => {
  const script = `
const cp = require("node:child_process");
try {
  cp.exec(123, () => {});
  process.stdout.write(JSON.stringify({ threw: false }) + "\\n");
} catch (err) {
  process.stdout.write(JSON.stringify({ threw: true, code: err.code }) + "\\n");
}
`;
  const plain = lastJson((await runScript(script, {}, { interceptor: false })).stdout);
  const wrapped = lastJson((await runScript(script, { VANTIO_HOME: mkdtempSync(join(tmpdir(), "van385-throw-")) })).stdout);
  assert.equal(plain.threw, true);
  assert.deepEqual(wrapped, plain);
});

test("each curl run is recorded once, whichever child_process call starts it", { skip: !HAS_CURL, timeout: 60000 }, async () => {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/v1/x`;
  const calls = {
    exec: `cp.exec("curl -s ${url}", done)`,
    execFile: `cp.execFile("curl", ["-s", "${url}"], done)`,
    spawn: `cp.spawn("curl", ["-s", "${url}"]).on("close", () => done())`,
    execSync: `cp.execSync("curl -s ${url}"); done()`,
    execFileSync: `cp.execFileSync("curl", ["-s", "${url}"]); done()`,
    spawnSync: `cp.spawnSync("curl", ["-s", "${url}"]); done()`,
    promisifyExec: `util.promisify(cp.exec)("curl -s ${url}").then((r) => { if (typeof r !== "object") throw new Error("shape"); done(); })`,
    promisifyExecFile: `util.promisify(cp.execFile)("curl", ["-s", "${url}"]).then((r) => { if (typeof r !== "object") throw new Error("shape"); done(); })`,
  };
  try {
    const counts = {};
    for (const [name, call] of Object.entries(calls)) {
      const home = mkdtempSync(join(tmpdir(), `van385-${name}-`));
      const script = `const cp = require("node:child_process"); const util = require("node:util"); const done = () => {}; ${call};`;
      const { code, stderr } = await runScript(script, {
        VANTIO_HOME: home,
        VANTIO_TRACE_ID: "van385count",
        VANTIO_EXTRA_LLM_HOSTS: "127.0.0.1",
      });
      assert.equal(code, 0, `${name}: ${stderr}`);
      const file = join(home, "runs", "van385count.json");
      assert.ok(existsSync(file), `${name}: no run file`);
      const recorded = JSON.parse(readFileSync(file, "utf8")).calls;
      counts[name] = recorded.length;
      assert.ok(recorded.every((c) => c.mediation === "node_curl"), `${name}: ${JSON.stringify(recorded)}`);
    }
    assert.deepEqual(counts, Object.fromEntries(Object.keys(calls).map((k) => [k, 1])));
    assert.equal(hits.length, Object.keys(calls).length);
  } finally {
    server.close();
  }
});
