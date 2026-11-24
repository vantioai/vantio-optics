// VAN-395: one bad or hostile run file must not hang, crash, or break the tools.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { listRunLogs, loadRun, proveMarkdown, discoverLocal } from "../src/runs.js";
import { createOpticsMcpServer } from "../src/server.js";

const RUNS_JS = fileURLToPath(new URL("../src/runs.js", import.meta.url));
const POSIX = process.platform !== "win32";
const HAS_MKFIFO = POSIX && spawnSync("mkfifo", ["--help"]).error == null;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vantio-optics-mcp-hostile-"));
  const dir = join(root, "runs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "0xgood.json"), JSON.stringify({
    vantio_run_log: "1",
    trace_id: "0xgood",
    generated_at: "2026-11-23T00:00:00.000Z",
    calls: [{ hostname: "api.openai.com", action: "OBSERVED", bytes: 5, ts: "2026-11-23T00:00:00.000Z" }],
  }));
  return { root, dir };
}

// Runs the readers in a child so a hang or an abort fails the test instead of the runner.
function readersInChild(dir) {
  const script = `
    import(${JSON.stringify(RUNS_JS)}).then((m) => {
      const out = {
        list: m.listRunLogs(process.argv[1]).map((e) => e.trace_id).sort(),
        discover: m.discoverLocal(undefined, process.argv[1]).map((h) => h.hostname),
        latest: m.loadRun("latest", process.argv[1]).log?.trace_id ?? null,
      };
      process.stdout.write(JSON.stringify(out));
    });`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", script, dir], { encoding: "utf8", timeout: 15000 });
}

test("a FIFO in the runs folder is skipped, not waited on", { skip: !HAS_MKFIFO }, () => {
  const { root, dir } = fixture();
  try {
    spawnSync("mkfifo", [join(dir, "fifo.json")]);
    const result = readersInChild(dir);
    assert.equal(result.signal, null, "reader hung on a FIFO");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { list: ["0xgood"], discover: ["api.openai.com"], latest: "0xgood" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a symlink to /dev/zero is skipped, not read until memory runs out", { skip: !POSIX }, () => {
  const { root, dir } = fixture();
  try {
    symlinkSync("/dev/zero", join(dir, "zero.json"));
    const result = readersInChild(dir);
    assert.equal(result.signal, null, "reader did not finish");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).list, ["0xgood"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a symlink to a run file elsewhere is not followed", { skip: !POSIX }, () => {
  const { root, dir } = fixture();
  try {
    const outside = join(root, "outside.json");
    writeFileSync(outside, JSON.stringify({ vantio_run_log: "1", trace_id: "0xoutside", calls: [] }));
    symlinkSync(outside, join(dir, "linked.json"));
    assert.deepEqual(listRunLogs(dir).map((e) => e.trace_id), ["0xgood"]);
    assert.equal(loadRun("0xoutside", dir).error, "not_found");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("calls with null or non-object entries do not break discover, prove, or get_run", async () => {
  const { root, dir } = fixture();
  const previous = process.env.VANTIO_HOME;
  try {
    writeFileSync(join(dir, "0xnull.json"), JSON.stringify({
      vantio_run_log: "1",
      trace_id: "0xnull",
      generated_at: "2026-11-23T00:00:01.000Z",
      summary: { total_calls: 3, total_bytes: 0, hosts: [] },
      calls: [null, 7, { hostname: "api.anthropic.com", bytes: 2 }],
    }));
    writeFileSync(join(dir, "0xobj.json"), JSON.stringify({
      vantio_run_log: "1",
      trace_id: "0xobj",
      summary: "not an object",
      calls: {},
    }));
    const hosts = discoverLocal(30 * 24 * 60 * 60 * 1000, dir).map((h) => h.hostname).sort();
    assert.deepEqual(hosts, ["api.anthropic.com", "api.openai.com"]);
    const md = proveMarkdown(loadRun("0xnull", dir).log);
    assert.match(md, /\| 1 \| api\.anthropic\.com \|/);

    process.env.VANTIO_HOME = root;
    const server = createOpticsMcpServer();
    const tool = server._registeredTools.optics_get_run;
    for (const trace of ["0xnull", "0xobj"]) {
      const result = await tool.handler({ trace_id: trace });
      assert.notEqual(result.isError, true, result.content[0].text);
      const body = JSON.parse(result.content[0].text);
      assert.ok(Array.isArray(body.run.calls));
      assert.equal(typeof body.run.summary, "object");
    }
    const discover = await server._registeredTools.optics_discover_local.handler({ since_days: 30 });
    assert.notEqual(discover.isError, true, discover.content[0].text);
  } finally {
    if (previous === undefined) delete process.env.VANTIO_HOME;
    else process.env.VANTIO_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("proveMarkdown escapes hostile fields and keeps plain ones readable", () => {
  const md = proveMarkdown({
    vantio_run_log: "1",
    trace_id: "0x`evil`",
    machine: "<img src=x onerror=alert(1)>",
    summary: { total_calls: "<b>9</b>", hosts: ["h`|x"], providers: ["openai"] },
    calls: [{ hostname: "a|b", method: "GET", path: "/v1/[x](javascript:1)", status: 200, ts: "t" }],
  });
  const lines = md.split("\n");
  const row = lines.find((line) => line.startsWith("| 1 |"));
  const edges = row.replace(/\\\\/g, "").replace(/\\\|/g, "").split("|").length - 1;
  assert.equal(edges, 10, row);
  assert.doesNotMatch(md, /(^|[^\\])<(img|b)/);
  assert.match(md, /\| Trace ID \| 0x\\`evil\\` \|/);
  assert.match(md, /Hosts: h\\`\\\|x/);
  assert.match(md, /Providers: `openai`/);
  assert.match(row, /\\\[x\\\]\(javascript:1\)/);
});

test("optics_get_run and optics_list_runs show the home folder as ~", async () => {
  const root = mkdtempSync(join(homedir(), ".vantio-mcp-test-"));
  const dir = join(root, "runs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "0xhome.json"), JSON.stringify({ vantio_run_log: "1", trace_id: "0xhome", calls: [] }));
  const previous = process.env.VANTIO_HOME;
  try {
    process.env.VANTIO_HOME = root;
    const server = createOpticsMcpServer();
    const run = JSON.parse((await server._registeredTools.optics_get_run.handler({ trace_id: "0xhome" })).content[0].text);
    assert.equal(run.path.startsWith("~"), true, run.path);
    assert.equal(run.path.includes(homedir()), false);
    const list = JSON.parse((await server._registeredTools.optics_list_runs.handler({})).content[0].text);
    assert.equal(list.runs_dir.startsWith("~"), true, list.runs_dir);
  } finally {
    if (previous === undefined) delete process.env.VANTIO_HOME;
    else process.env.VANTIO_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a path outside the home folder is shown unchanged", async () => {
  const { root } = fixture();
  const previous = process.env.VANTIO_HOME;
  try {
    process.env.VANTIO_HOME = root;
    const server = createOpticsMcpServer();
    const run = JSON.parse((await server._registeredTools.optics_get_run.handler({ trace_id: "0xgood" })).content[0].text);
    if (!root.startsWith(homedir())) assert.equal(run.path, join(root, "runs", "0xgood.json"));
  } finally {
    if (previous === undefined) delete process.env.VANTIO_HOME;
    else process.env.VANTIO_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
