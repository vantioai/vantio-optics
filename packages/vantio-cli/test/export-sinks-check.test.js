// VAN-409: vantio export checks every destination before it reads or sends.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import http2 from "node:http2";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, "..", "bin", "vantio.js");
const features = createRequire(import.meta.url)("../bin/optics-features.cjs");
// TEST-NET-1: never reached. Plain http to it is refused before any connect.
const REMOTE_HTTP = "http://192.0.2.10:4318";

function runCli(args, home, ms = 4000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: { PATH: process.env.PATH, HOME: home, VANTIO_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stopped = false;
    const timer = setTimeout(() => { stopped = true; child.kill("SIGINT"); }, ms);
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, stopped });
    });
  });
}

function homeWithRun() {
  const home = mkdtempSync(join(tmpdir(), "vantio-export-check-"));
  const runs = join(home, ".vantio", "runs");
  mkdirSync(runs, { recursive: true });
  writeFileSync(join(runs, "0xexport.json"), JSON.stringify({
    vantio_run_log: "1",
    trace_id: "0xexport",
    generated_at: "2026-11-24T00:00:01.000Z",
    calls: [{ hostname: "api.openai.com", method: "POST", path: "/v1/chat/completions", ts: "2026-11-24T00:00:00.000Z" }],
  }));
  return home;
}

function grpcSink() {
  const server = http2.createServer();
  server.streams = 0;
  server.on("stream", (stream) => {
    server.streams += 1;
    stream.on("data", () => {});
    stream.on("end", () => {
      stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
      stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
      stream.end(Buffer.from([0, 0, 0, 0, 0]));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

describe("export checks destinations first", () => {
  test("--follow with a refused URL exits 1 at once instead of retrying", async () => {
    const home = homeWithRun();
    try {
      const out = await runCli(["export", "--follow", `--otlp=${REMOTE_HTTP}`], home);
      assert.equal(out.stopped, false, "export --follow kept running");
      assert.equal(out.code, 1);
      assert.match(out.stderr, /otlp refuses plaintext to a remote host/);
      assert.doesNotMatch(out.stderr, /Following live events|Retrying/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("--follow with a refused gRPC URL exits 1 at once", async () => {
    const home = homeWithRun();
    try {
      const out = await runCli(["export", "--follow", "--otlp-grpc=grpc://192.0.2.10:4317"], home);
      assert.equal(out.stopped, false, "export --follow kept running");
      assert.equal(out.code, 1);
      assert.match(out.stderr, /otlp grpc refuses plaintext to a remote host/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a one-shot export sends nothing when one destination is refused", async () => {
    const home = homeWithRun();
    const sink = await grpcSink();
    try {
      const port = sink.address().port;
      const out = await runCli(["export", `--otlp-grpc=grpc://127.0.0.1:${port}`, `--otlp=${REMOTE_HTTP}`], home);
      assert.equal(out.code, 1, out.stderr);
      assert.match(out.stderr, /otlp refuses plaintext to a remote host/);
      assert.equal(sink.streams, 0);
    } finally {
      sink.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("valid destinations still send (unchanged)", async () => {
    const home = homeWithRun();
    const paths = [];
    const server = http.createServer((req, res) => {
      paths.push(req.url);
      req.resume();
      req.on("end", () => { res.writeHead(200); res.end("{}"); });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const out = await runCli(["export", `--otlp=http://127.0.0.1:${server.address().port}`], home);
      assert.equal(out.code, 0, out.stderr);
      assert.deepEqual(paths.sort(), ["/v1/logs", "/v1/metrics", "/v1/traces"]);
    } finally {
      server.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("--follow with a valid destination keeps running until stopped (unchanged)", async () => {
    const home = homeWithRun();
    try {
      const out = await runCli(["export", "--follow", "--otlp=http://127.0.0.1:9"], home, 1500);
      assert.equal(out.stopped, true);
      assert.match(out.stderr, /Following live events/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("checkExportSinks names the destination it refuses", () => {
    assert.doesNotThrow(() => features.checkExportSinks({ otlp: "https://collector.example", syslog: "udp://127.0.0.1:514" }));
    assert.throws(() => features.checkExportSinks({ webhook: "http://hooks.example/x" }), /webhook refuses plaintext/);
    assert.throws(() => features.checkExportSinks({ otlpGrpc: "not a url" }), /otlp grpc URL is not valid/);
    assert.throws(() => features.checkExportSinks({ syslog: "ftp://127.0.0.1:21" }), /syslog URL must be udp or tcp/);
  });
});
