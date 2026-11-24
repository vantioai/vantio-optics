// VAN-400: a full trace id picks its run even when it is the start of another id.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, "..", "bin", "vantio.js");

function runCli(args, home) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: { PATH: process.env.PATH, HOME: home, VANTIO_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "vantio-exact-"));
  const dir = join(home, ".vantio", "runs");
  mkdirSync(dir, { recursive: true });
  for (const [trace, host] of [["0xabc", "api.openai.com"], ["0xabcd", "api.anthropic.com"]]) {
    writeFileSync(join(dir, `${trace}.json`), JSON.stringify({
      vantio_run_log: "1",
      trace_id: trace,
      generated_at: "2026-11-23T00:00:00.000Z",
      calls: [{ hostname: host, bytes: 1, status: 200 }],
    }));
  }
  return home;
}

test("a full trace id that is also a prefix of another picks its own run", async () => {
  const home = fixture();
  try {
    const proved = await runCli(["prove", "--run=0xabc", "--json"], home);
    assert.equal(proved.code, 0, proved.stderr);
    assert.equal(JSON.parse(proved.stdout).trace_id, "0xabc");
    const searched = await runCli(["search", "--run=0xabc", "--json", "api"], home);
    assert.equal(searched.code, 0, searched.stderr);
    assert.deepEqual(JSON.parse(searched.stdout).calls.map((c) => c.hostname), ["api.openai.com"]);
    const tailed = await runCli(["tail", "--run=0xabc", "--json"], home);
    assert.equal(tailed.code, 0, tailed.stderr);
    assert.equal(JSON.parse(tailed.stdout).trace_id, "0xabc");
    const diffed = await runCli(["diff", "0xabc", "0xabcd", "--json"], home);
    assert.equal(diffed.code, 0, diffed.stderr);
    const body = JSON.parse(diffed.stdout);
    assert.equal(body.a.trace_id, "0xabc");
    assert.equal(body.b.trace_id, "0xabcd");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a prefix that matches two runs still asks for a longer one", async () => {
  const home = fixture();
  try {
    const result = await runCli(["prove", "--run=0xab", "--json"], home);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /matches 2 runs/);
    const longer = await runCli(["prove", "--run=0xabcd", "--json"], home);
    assert.equal(longer.code, 0, longer.stderr);
    assert.equal(JSON.parse(longer.stdout).trace_id, "0xabcd");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
