// node:http, node:https and node:http2 calls must carry the HTTP status into the
// run log, so `prove`, `search` and `tail` can show the application outcome.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INTERCEPTOR_PATH = join(__dirname, "..", "bin", "interceptor.cjs");

function runAgent(env, script) {
  const home = mkdtempSync(join(tmpdir(), "vantio-http-outcome-"));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--require", INTERCEPTOR_PATH, "-e", script], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        VANTIO_HOME: join(home, ".vantio"),
        VANTIO_EXTRA_LLM_HOSTS: "127.0.0.1",
        VANTIO_TELEMETRY_DISABLED: "1",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    const killer = setTimeout(() => child.kill("SIGKILL"), 8000);
    child.on("close", (code) => {
      clearTimeout(killer);
      const runsDir = join(home, ".vantio", "runs");
      const files = readdirSync(runsDir).filter((f) => f.endsWith(".json"));
      const log = JSON.parse(readFileSync(join(runsDir, files[0]), "utf8"));
      rmSync(home, { recursive: true, force: true });
      resolve({ code, stderr, calls: log.calls.filter((c) => c.hostname === "127.0.0.1") });
    });
  });
}

const HTTP_GET = `
const http = require("http");
http.get(process.env.TARGET_URL + "?q=secret", (res) => { res.resume(); })
  .on("error", () => {});
`;

const HTTP_REQUEST_POST = `
const http = require("http");
const req = http.request(process.env.TARGET_URL, { method: "POST" }, (res) => { res.resume(); });
req.on("error", () => {});
req.end("{}");
`;

const HTTP2_GET = `
const http2 = require("http2");
const session = http2.connect(process.env.H2_ORIGIN);
const stream = session.request({ ":path": "/v1/h2?q=secret" });
stream.on("response", () => {});
stream.on("data", () => {});
stream.on("end", () => session.close());
stream.end();
`;

describe("node:http/http2 application outcome", { timeout: 60000 }, () => {
  let server;
  let h2Server;
  let base;
  let h2Origin;
  let closedPort;

  before(async () => {
    server = http.createServer((req, res) => {
      const status = req.url.startsWith("/v1/denied") ? 401 : 200;
      const payload = JSON.stringify({ ok: status === 200 });
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(payload),
      });
      res.end(payload);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;

    h2Server = http2.createServer();
    h2Server.on("stream", (stream) => {
      stream.respond({ ":status": 403, "content-type": "application/json" });
      stream.end("{}");
    });
    await new Promise((r) => h2Server.listen(0, "127.0.0.1", r));
    h2Origin = `http://127.0.0.1:${h2Server.address().port}`;

    // A port with nothing listening, for the connection-refused case.
    const probe = net.createServer();
    await new Promise((r) => probe.listen(0, "127.0.0.1", r));
    closedPort = probe.address().port;
    await new Promise((r) => probe.close(r));
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    await new Promise((r) => h2Server.close(r));
  });

  test("http.get 401 records GET, path without query, status 401, ok=false", async () => {
    const { code, calls } = await runAgent({ TARGET_URL: `${base}/v1/denied` }, HTTP_GET);
    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.method, "GET");
    assert.equal(call.path, "/v1/denied");
    assert.equal(call.status, 401);
    assert.equal(call.ok, false);
    assert.equal(call.content_type, "application/json");
    assert.ok(call.bytes > 0);
    assert.equal(call.error, null);
  });

  test("http.request POST 200 records POST, status 200, ok=true", async () => {
    const { code, calls } = await runAgent({ TARGET_URL: `${base}/v1/chat` }, HTTP_REQUEST_POST);
    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].path, "/v1/chat");
    assert.equal(calls[0].status, 200);
    assert.equal(calls[0].ok, true);
  });

  test("http2 403 records method, path and status", async () => {
    const { code, calls } = await runAgent({ H2_ORIGIN: h2Origin }, HTTP2_GET);
    assert.equal(code, 0);
    const h2 = calls.filter((c) => c.scheme === "http2");
    assert.equal(h2.length, 1);
    assert.equal(h2[0].method, "GET");
    assert.equal(h2[0].path, "/v1/h2");
    assert.equal(h2[0].status, 403);
    assert.equal(h2[0].ok, false);
  });

  test("negative: connection refused records an error and no status", async () => {
    const { code, calls } = await runAgent(
      { TARGET_URL: `http://127.0.0.1:${closedPort}/v1/denied` },
      HTTP_GET,
    );
    assert.equal(code, 0);
    const call = calls.find((c) => c.method === "GET");
    assert.ok(call, "the attempted call is still recorded");
    assert.equal(call.status, null);
    assert.equal(call.ok, false);
    assert.equal(call.error, "ECONNREFUSED");
  });
});
