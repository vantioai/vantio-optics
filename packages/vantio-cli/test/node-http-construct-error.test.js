// VAN-401: a node:http request that throws while it is created was never sent.
// The run file records it as an error, and the original request runs once.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INTERCEPTOR_PATH = join(__dirname, "..", "bin", "interceptor.cjs");

function runAgent(source, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--require", INTERCEPTOR_PATH, "-e", source], {
      env: { PATH: process.env.PATH, VANTIO_TELEMETRY_DISABLED: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function runLog(home, trace) {
  return JSON.parse(readFileSync(join(home, ".vantio", "runs", `${trace}.json`), "utf8"));
}

const THROWING = `
const http = require("node:http");
const out = {};
for (const [name, make] of [
  ["request", (o) => http.request(o)],
  ["get", (o) => http.get(o)],
  ["ctor", (o) => new http.ClientRequest(o)],
]) {
  let reads = 0;
  const opts = { hostname: "127.0.0.1", port: Number(process.env.PORT), path: "/v1/" + name, headers: { "bad header": "x" } };
  Object.defineProperty(opts, "method", { get() { reads += 1; return "POST"; }, enumerable: true });
  try { make(opts); out[name] = "no-throw"; } catch (err) { out[name] = err.code; }
  out[name + "_reads"] = reads;
}
process.stdout.write(JSON.stringify(out));
`;

test("a request that throws while created is an error record, and runs once", async () => {
  const home = mkdtempSync(join(tmpdir(), "vantio-http-throw-"));
  try {
    const plain = await new Promise((resolve) => {
      const child = spawn(process.execPath, ["-e", THROWING], { env: { PATH: process.env.PATH, PORT: "9" }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (c) => (out += c));
      child.on("close", () => resolve(JSON.parse(out)));
    });
    const result = await runAgent(THROWING, { HOME: home, VANTIO_TRACE_ID: "0xthrow", VANTIO_EXTRA_LLM_HOSTS: "127.0.0.1", PORT: "9" });
    assert.equal(result.code, 0, result.stderr);
    const seen = JSON.parse(result.stdout);
    assert.deepEqual(seen, plain, "the caller sees what plain Node does, and the option is read as often");
    const log = runLog(home, "0xthrow");
    assert.equal(log.calls.length, 3);
    for (const call of log.calls) {
      assert.equal(call.ok, false, JSON.stringify(call));
      assert.equal(call.error, "ERR_INVALID_HTTP_TOKEN");
    }
    assert.equal(log.summary.errors, 3);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a normal request is still recorded with its status", async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end("{}"));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const home = mkdtempSync(join(tmpdir(), "vantio-http-ok-"));
  try {
    const source = `
      const http = require("node:http");
      const req = http.request({ hostname: "127.0.0.1", port: Number(process.env.PORT), path: "/v1/ok", method: "POST" }, (res) => { res.resume(); res.on("end", () => process.stdout.write(String(res.statusCode))); });
      req.end("{}");
    `;
    const result = await runAgent(source, { HOME: home, VANTIO_TRACE_ID: "0xok", VANTIO_EXTRA_LLM_HOSTS: "127.0.0.1", PORT: String(server.address().port) });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "200");
    const [call] = runLog(home, "0xok").calls;
    assert.equal(call.status, 200);
    assert.equal(call.ok, true);
    assert.equal(call.error, null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
});
