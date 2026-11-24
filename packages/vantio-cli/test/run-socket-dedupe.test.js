// VAN-407: a call that Node or Python recorded by host name is not written a
// second time as a raw-IP proc_socket row when `vantio run` reads /proc.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, "..", "bin", "vantio.js");
const require = createRequire(import.meta.url);
const proc = require("../bin/optics-proc.cjs");
const features = require("../bin/optics-features.cjs");

// The /proc read skips loopback, so the end-to-end cases need an address of
// this machine that is not loopback.
const LOCAL_IP = Object.values(networkInterfaces()).flat()
  .find((addr) => addr && addr.family === "IPv4" && !addr.internal)?.address || null;
const E2E = process.platform === "linux" && LOCAL_IP != null;

// The agent resolves llm.example.test to LOCAL_IP itself, so no DNS or
// /etc/hosts entry is needed. The server answers after 300 ms, so the /proc
// read sees the open socket.
const AGENT = `
const http = require("node:http");
const req = http.request({
  host: process.env.TARGET_HOST,
  port: Number(process.env.TARGET_PORT),
  path: "/v1/chat/completions",
  method: "POST",
  lookup: (host, opts, cb) => (opts && opts.all
    ? cb(null, [{ address: process.env.TARGET_IP, family: 4 }])
    : cb(null, process.env.TARGET_IP, 4)),
}, (res) => { res.resume(); res.on("end", () => {}); });
req.end("{}");
`;

async function slowServer() {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    }, 300));
  });
  await new Promise((resolve) => server.listen(0, LOCAL_IP, resolve));
  return server;
}

function runAgent(home, env) {
  writeFileSync(join(home, "agent.js"), AGENT);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, "run", "node", "agent.js"], {
      cwd: home,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        VANTIO_TELEMETRY_DISABLED: "1",
        VANTIO_MCP_AWARENESS: "off",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => {
      clearTimeout(timer);
      const dir = join(home, ".vantio", "runs");
      const logs = readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")));
      resolve({ code, stderr, logs });
    });
  });
}

describe("socket rows and calls recorded by name", () => {
  test("canonicalIp gives one spelling for the same address", () => {
    assert.equal(proc.canonicalIp("::ffff:192.0.2.2"), "192.0.2.2");
    assert.equal(proc.canonicalIp("0:0:0:0:0:ffff:c000:202"), "192.0.2.2");
    assert.equal(proc.canonicalIp("192.0.2.2"), "192.0.2.2");
    assert.equal(proc.canonicalIp("2606:4700::6810:84E5"), "2606:4700:0:0:0:0:6810:84e5");
    assert.equal(proc.canonicalIp("2606:4700:0:0:0:0:6810:84e5"), "2606:4700:0:0:0:0:6810:84e5");
    assert.equal(proc.canonicalIp("[::1]"), "0:0:0:0:0:0:0:1");
    assert.equal(proc.canonicalIp("fe80::1%eth0"), "fe80:0:0:0:0:0:0:1");
    // The same address as /proc/net/tcp6 lists it.
    const row = "  0: 0000000000000000FFFF00000100007F:A3C4 0000000000000000FFFF0000020200C0:01BB 01 00000000:00000000 00:00000000 00000000     0        0 12345 1";
    const [socket] = [...proc.parseTcpTable(`header\n${row}`, true).values()];
    assert.equal(proc.canonicalIp(socket.ip), "192.0.2.2");
  });

  test("a socket listed in a call's remote_addresses is not added again; another socket is", () => {
    const home = mkdtempSync(join(tmpdir(), "vantio-dedupe-"));
    const previous = process.env.VANTIO_HOME;
    process.env.VANTIO_HOME = home;
    try {
      mkdirSync(join(home, "runs"), { recursive: true });
      writeFileSync(join(home, "runs", "0xdedupe.json"), JSON.stringify({
        vantio_run_log: "1",
        trace_id: "0xdedupe",
        program: "agent.js",
        pid: 11,
        calls: [{
          hostname: "llm.example.test",
          status: 200,
          ts: "2026-11-24T00:00:00.000Z",
          remote_addresses: [{ address: "::ffff:192.0.2.2", port: 443 }],
        }],
      }));
      const { log } = features.recordWrappedRun({
        traceId: "0xdedupe",
        program: "node",
        pid: 11,
        ppid: 1,
        processes: [{ pid: 11, ppid: 1, program: "node" }],
        connections: [
          { pid: 11, ppid: 1, program: "node", destination: "192.0.2.2", ip: "192.0.2.2", port: 443 },
          { pid: 11, ppid: 1, program: "node", destination: "192.0.2.2", ip: "192.0.2.2", port: 5432 },
          { pid: 11, ppid: 1, program: "node", destination: "192.0.2.9", ip: "192.0.2.9", port: 443 },
        ],
      });
      assert.deepEqual(log.calls.map((call) => [call.hostname, call.mediation || null, call.port ?? null]), [
        ["llm.example.test", null, null],
        ["192.0.2.2", "proc_socket", 5432],
        ["192.0.2.9", "proc_socket", 443],
      ]);
      assert.equal(log.summary.total_calls, 3);
    } finally {
      if (previous == null) delete process.env.VANTIO_HOME;
      else process.env.VANTIO_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("vantio run node: one in-scope call to a host that resolves to a non-loopback IP is one call", { skip: !E2E }, async () => {
    const server = await slowServer();
    const home = mkdtempSync(join(tmpdir(), "vantio-dedupe-e2e-"));
    try {
      const out = await runAgent(home, {
        VANTIO_EXTRA_LLM_HOSTS: "llm.example.test",
        TARGET_HOST: "llm.example.test",
        TARGET_IP: LOCAL_IP,
        TARGET_PORT: String(server.address().port),
      });
      assert.equal(out.code, 0, out.stderr);
      assert.equal(out.logs.length, 1);
      const [log] = out.logs;
      assert.deepEqual(log.calls.map((call) => call.hostname), ["llm.example.test"], JSON.stringify(log.calls));
      assert.equal(log.summary.total_calls, 1);
      assert.deepEqual(log.summary.hosts, ["llm.example.test"]);
      assert.deepEqual(log.calls[0].remote_addresses, [{ address: LOCAL_IP, port: server.address().port }]);
    } finally {
      server.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("vantio run node: a socket to a host that is not in scope is still a proc_socket row (unchanged)", { skip: !E2E }, async () => {
    const server = await slowServer();
    const home = mkdtempSync(join(tmpdir(), "vantio-dedupe-out-"));
    try {
      const out = await runAgent(home, {
        TARGET_HOST: "other.example.test",
        TARGET_IP: LOCAL_IP,
        TARGET_PORT: String(server.address().port),
      });
      assert.equal(out.code, 0, out.stderr);
      const [log] = out.logs;
      assert.deepEqual(log.calls.map((call) => [call.hostname, call.mediation]), [[LOCAL_IP, "proc_socket"]]);
    } finally {
      server.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
