// VAN-386: a stale seen.lock is taken over (a fresh one is not), and MCP
// awareness does not hold an event-stream body open after the caller cancels.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INTERCEPTOR_PATH = join(__dirname, "..", "bin", "interceptor.cjs");
const AWARENESS_PATH = join(__dirname, "..", "bin", "mcp-awareness-register.js");

// Same preload flags `vantio run node` passes (bin/vantio.js).
function runAgent(script, env, { awareness = false } = {}) {
  const argv = ["--require", INTERCEPTOR_PATH];
  if (awareness) argv.push("--import", AWARENESS_PATH);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...argv, "-e", script], {
      env: { PATH: process.env.PATH, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const killer = setTimeout(() => child.kill("SIGKILL"), 20000);
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr });
    });
  });
}

function lastJson(stdout) {
  return JSON.parse(stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop());
}

async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

const TIMED_FETCHES = `
(async () => {
  const times = [];
  for (let i = 0; i < 2; i++) {
    const t0 = Date.now();
    await (await fetch(process.env.TARGET_URL)).text();
    times.push(Date.now() - t0);
  }
  process.stdout.write(JSON.stringify({ times }) + "\\n");
})();
`;

test("a stale seen.lock is taken over, so calls are not delayed", { timeout: 30000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "van386-stale-"));
  const lock = join(home, "seen.lock");
  mkdirSync(lock);
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  await withServer((_req, res) => res.end("ok"), async (base) => {
    const { code, stdout, stderr } = await runAgent(TIMED_FETCHES, {
      VANTIO_HOME: home,
      VANTIO_TRACE_ID: "van386stale",
      VANTIO_EXTRA_LLM_HOSTS: "127.0.0.1",
      TARGET_URL: `${base}/v1/x`,
    });
    assert.equal(code, 0, stderr);
    const { times } = lastJson(stdout);
    assert.ok(times.every((t) => t < 1500), `times ${times}`);
  });
  assert.equal(existsSync(lock), false, "the lock is released after use");
  assert.deepEqual(readdirSync(home).filter((n) => n.startsWith("seen.lock")), []);
  const seen = JSON.parse(readFileSync(join(home, "seen-destinations.json"), "utf8"));
  assert.ok(JSON.stringify(seen).includes("127.0.0.1"));
});

test("a fresh seen.lock is left alone (another process holds it)", { timeout: 30000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "van386-fresh-"));
  const lock = join(home, "seen.lock");
  mkdirSync(lock);
  await withServer((_req, res) => res.end("ok"), async (base) => {
    const { code, stdout, stderr } = await runAgent(
      TIMED_FETCHES.replace("i < 2", "i < 1"),
      {
        VANTIO_HOME: home,
        VANTIO_TRACE_ID: "van386fresh",
        VANTIO_EXTRA_LLM_HOSTS: "127.0.0.1",
        TARGET_URL: `${base}/v1/x`,
      },
    );
    assert.equal(code, 0, stderr);
    assert.equal(lastJson(stdout).times.length, 1, "the call still completes");
  });
  assert.equal(existsSync(lock), true, "a live lock must not be taken");
});

test("awareness does not keep an MCP event stream open after cancel", { timeout: 30000 }, async () => {
  let events = 0;
  let closedAfter = null;
  const handler = (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const timer = setInterval(() => {
      events += 1;
      res.write(`data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"n":${events}}}\n\n`);
    }, 50);
    req.on("close", () => {
      clearInterval(timer);
      closedAfter = events;
    });
    res.on("close", () => {
      clearInterval(timer);
      if (closedAfter === null) closedAfter = events;
    });
  };
  const script = `
(async () => {
  const t0 = Date.now();
  const res = await fetch(process.env.TARGET_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x", arguments: {} } }),
  });
  const reader = res.body.getReader();
  await reader.read();
  const tCancel = Date.now();
  const watchdog = setTimeout(() => {
    process.stdout.write(JSON.stringify({ cancelled: false }) + "\\n");
    process.exit(0);
  }, 3000);
  await reader.cancel();
  clearTimeout(watchdog);
  process.stdout.write(JSON.stringify({ cancelled: true, ms: Date.now() - tCancel }) + "\\n");
  setTimeout(() => process.exit(0), 400);
})();
`;
  const home = mkdtempSync(join(tmpdir(), "van386-sse-"));
  await withServer(handler, async (base) => {
    const { code, stdout, stderr } = await runAgent(script, {
      VANTIO_HOME: home,
      VANTIO_MCP_AWARENESS: "on",
      TARGET_URL: `${base}/mcp`,
    }, { awareness: true });
    assert.equal(code, 0, stderr);
    const out = lastJson(stdout);
    assert.equal(out.cancelled, true, "cancel() must finish");
    assert.ok(out.ms < 1000, `cancel took ${out.ms} ms`);
  });
  assert.notEqual(closedAfter, null, "the server must see the client close");
  assert.ok(closedAfter < 20, `server sent ${closedAfter} events before the close`);
  const log = join(home, "mcp-observations.jsonl");
  assert.ok(existsSync(log), "awareness still writes its log");
  const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(
    lines.some((r) => r.decision && r.decision.action === "GAP" && r.decision.reason === "stream_not_inspected"),
    JSON.stringify(lines),
  );
});
