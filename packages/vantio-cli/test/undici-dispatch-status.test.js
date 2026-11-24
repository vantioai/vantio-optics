// VAN-387: undici pool.stream / pipeline / raw dispatch record the real status,
// ok flag and duration instead of "ok: true, status: null".
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = join(__dirname, "..");
const INTERCEPTOR_PATH = join(PKG, "bin", "interceptor.cjs");

function runAgent(script, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--require", INTERCEPTOR_PATH, "-e", script], {
      env: { PATH: process.env.PATH, ...env },
      cwd: PKG,
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

const SCRIPT = `
const undici = require("undici");
const { Writable } = require("node:stream");
const sink = () => new Writable({ write(_c, _e, cb) { cb(); } });
(async () => {
  const base = process.env.BASE;
  const pool = new undici.Pool(base);
  await pool.stream({ path: "/v1/fail", method: "POST", body: "x" }, sink);
  await pool.stream({ path: "/v1/ok", method: "GET" }, sink);
  await new Promise((resolve, reject) => {
    const s = undici.pipeline(base + "/v1/teapot", { method: "GET" }, ({ body }) => body);
    s.on("data", () => {}).on("end", resolve).on("error", reject);
    s.end();
  });
  await new Promise((resolve) => {
    pool.dispatch({ path: "/v1/slow", method: "GET" }, {
      onConnect() {}, onHeaders() { return true; }, onData() { return true; },
      onComplete() { resolve(); }, onError() { resolve(); },
    });
  });
  await pool.close();
  const dead = new undici.Pool("http://127.0.0.1:" + process.env.DEAD_PORT);
  try {
    await dead.stream({ path: "/v1/refused", method: "GET" }, sink);
  } catch (err) {
    process.stdout.write(JSON.stringify({ refused: err.code || err.name }) + "\\n");
  }
  await dead.close().catch(() => {});
})();
`;

test("undici dispatch paths record status, ok and duration", { timeout: 30000 }, async () => {
  const server = createServer((req, res) => {
    if (req.url === "/v1/fail") { res.statusCode = 500; res.end("no"); return; }
    if (req.url === "/v1/teapot") { res.statusCode = 418; res.end("tea"); return; }
    if (req.url === "/v1/slow") { setTimeout(() => res.end("slow"), 300); return; }
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dead = createServer();
  await new Promise((resolve) => dead.listen(0, "127.0.0.1", resolve));
  const deadPort = dead.address().port;
  await new Promise((resolve) => dead.close(resolve));
  const home = mkdtempSync(join(tmpdir(), "van387-undici-"));
  try {
    const { code, stdout, stderr } = await runAgent(SCRIPT, {
      VANTIO_HOME: home,
      VANTIO_TRACE_ID: "van387undici",
      VANTIO_EXTRA_LLM_HOSTS: "127.0.0.1",
      BASE: `http://127.0.0.1:${server.address().port}`,
      DEAD_PORT: String(deadPort),
    });
    assert.equal(code, 0, stderr);
    assert.match(stdout, /"refused":"ECONNREFUSED"/);
    const calls = JSON.parse(readFileSync(join(home, "runs", "van387undici.json"), "utf8")).calls
      .filter((c) => c.mediation === "undici_dispatch");
    const byPath = Object.fromEntries(calls.map((c) => [c.path, c]));
    assert.equal(byPath["/v1/fail"].status, 500);
    assert.equal(byPath["/v1/fail"].ok, false);
    assert.equal(byPath["/v1/ok"].status, 200);
    assert.equal(byPath["/v1/ok"].ok, true);
    assert.equal(byPath["/v1/ok"].content_type, "application/json");
    assert.equal(byPath["/v1/teapot"].status, 418);
    assert.equal(byPath["/v1/teapot"].ok, false);
    assert.equal(byPath["/v1/slow"].status, 200);
    assert.ok(byPath["/v1/slow"].duration_ms >= 250, `duration ${byPath["/v1/slow"].duration_ms}`);
    assert.equal(byPath["/v1/refused"].ok, false);
    assert.equal(byPath["/v1/refused"].status, null);
    assert.equal(byPath["/v1/refused"].error, "ECONNREFUSED");
  } finally {
    server.close();
  }
});
