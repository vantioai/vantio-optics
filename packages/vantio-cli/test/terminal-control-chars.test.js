// VAN-403: text from a run file reaches the terminal without control characters.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, "..", "bin", "vantio.js");
const features = createRequire(import.meta.url)("../bin/optics-features.cjs");
// Any C0 or C1 control character other than the CLI's own newline.
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

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

function fixture(hostile) {
  const home = mkdtempSync(join(tmpdir(), "vantio-ctl-"));
  const dir = join(home, ".vantio", "runs");
  mkdirSync(dir, { recursive: true });
  const trace = hostile ? "0xesc\u001b[2J" : "0xplainrun";
  writeFileSync(join(dir, "0xfirst.json"), JSON.stringify({
    vantio_run_log: "1",
    trace_id: trace,
    program: hostile ? "agent\u001b[1m.js" : "agent.js",
    generated_at: "2026-11-24T00:00:01.000Z",
    summary: { total_calls: 1 },
    calls: [{
      hostname: hostile ? "api.openai.com\u001b]0;PWNED\u0007" : "api.openai.com",
      path: hostile ? "/v1\u001b[31mred\r\nFAKE LINE\u009b" : "/v1/chat/completions",
      bytes: 1,
      ts: "2026-11-24T00:00:00.000Z",
    }],
  }));
  writeFileSync(join(dir, "0xsecond.json"), JSON.stringify({
    vantio_run_log: "1",
    trace_id: "0xsecond",
    generated_at: "2026-11-23T00:00:00.000Z",
    calls: [],
  }));
  return home;
}

const COMMANDS = [
  ["tail"],
  ["search", "api"],
  ["discover", "--since=30d"],
  ["prove", "--list"],
  ["diff", "0xfirst", "0xsecond"],
  ["prove", "--run=0xfirst", "--format=md"],
  ["coverage"],
  ["destinations", "--dry-run"],
];

test("hostile run fields print with control characters replaced", async () => {
  const home = fixture(true);
  try {
    for (const args of COMMANDS) {
      const result = await runCli(args, home);
      assert.equal(result.code, 0, `${args.join(" ")}: ${result.stderr}`);
      assert.doesNotMatch(result.stdout, CONTROL, args.join(" "));
      assert.doesNotMatch(result.stderr, CONTROL, args.join(" "));
      assert.doesNotMatch(result.stdout, /^FAKE LINE/m, args.join(" "));
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("ordinary values print unchanged", async () => {
  const home = fixture(false);
  try {
    const tail = await runCli(["tail"], home);
    assert.equal(tail.code, 0, tail.stderr);
    assert.match(tail.stdout, /api\.openai\.com/);
    assert.match(tail.stdout, /\/v1\/chat\/completions/);
    assert.match(tail.stdout, /0xplainrun/);
    const diff = await runCli(["diff", "0xfirst", "0xsecond"], home);
    assert.match(diff.stdout, /- api\.openai\.com {2}\(1 call\(s\)\)/);
    const coverage = await runCli(["coverage"], home);
    assert.equal(coverage.code, 0, coverage.stderr);
    assert.match(coverage.stdout, /^ {2}api\.openai\.com$/m);
    assert.match(coverage.stdout, /program agent\.js {2}calls 1/);
    const destinations = await runCli(["destinations", "--dry-run"], home);
    assert.equal(destinations.code, 0, destinations.stderr);
    assert.match(destinations.stdout, /Destination\n {2}api\.openai\.com\nProgram\n {2}agent\.js\n/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a live New destination line has control characters replaced", () => {
  const hostile = features.formatLiveAlert({
    clock: "12:00:00\u001b[2J",
    destination: "api.openai.com\u001b]0;PWNED\u0007",
    program: "agent\r\nFAKE LINE",
  });
  assert.doesNotMatch(hostile, CONTROL);
  assert.doesNotMatch(hostile, /^FAKE LINE/m);
  const plain = features.formatLiveAlert({ clock: "12:00:00", destination: "api.openai.com", program: "agent.js" });
  assert.equal(plain, "New destination\n  First connection: 12:00:00\n  Destination: api.openai.com\n  Program: agent.js\n");
});
