// VAN-415: a JSON file in ~/.vantio/runs that is not a run log is never the
// latest run, and prove --run refuses it as tail does.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

// One real run, then a newer JSON file that is not a run log.
function home() {
  const dir = mkdtempSync(join(tmpdir(), "vantio-latest-"));
  const runs = join(dir, ".vantio", "runs");
  mkdirSync(runs, { recursive: true });
  writeFileSync(join(runs, "0xrealrun.json"), JSON.stringify({
    vantio_run_log: "1",
    trace_id: "0xrealrun",
    generated_at: "2026-11-24T00:00:01.000Z",
    calls: [{ hostname: "api.openai.com", status: 200, bytes: 1, ts: "2026-11-24T00:00:00.000Z" }],
  }));
  const notes = join(runs, "notes.json");
  writeFileSync(notes, JSON.stringify({ hello: "not a run" }));
  const later = new Date(Date.now() + 60 * 1000);
  utimesSync(notes, later, later);
  return dir;
}

describe("the latest run is a run log", () => {
  test("prove with no --run uses the newest run log, not a newer other JSON file", async () => {
    const dir = home();
    try {
      const out = await runCli(["prove", "--format=md"], dir);
      assert.equal(out.code, 0, out.stderr);
      assert.match(out.stderr, /Using most recent run log: ~\/\.vantio\/runs\/0xrealrun\.json/);
      assert.match(out.stdout, /0xrealrun/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("tail with no --run shows the newest run log", async () => {
    const dir = home();
    try {
      const out = await runCli(["tail"], dir);
      assert.equal(out.code, 0, out.stderr);
      assert.match(out.stdout, /trace 0xrealrun/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("prove --run refuses a file that is not a run log, as tail does", async () => {
    const dir = home();
    try {
      const prove = await runCli(["prove", "--run=notes", "--format=md"], dir);
      assert.equal(prove.code, 1);
      assert.match(prove.stderr, /^vantio prove: not a Vantio run log: /m);
      const tail = await runCli(["tail", "--run=notes"], dir);
      assert.equal(tail.code, 1);
      assert.match(tail.stderr, /^vantio tail: not a Vantio run log: /m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("prove --run on a run log still works (unchanged)", async () => {
    const dir = home();
    try {
      const out = await runCli(["prove", "--run=0xrealrun", "--format=md"], dir);
      assert.equal(out.code, 0, out.stderr);
      assert.match(out.stdout, /api\.openai\.com/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("prove --from still reads an explicit file as before (unchanged)", async () => {
    const dir = home();
    try {
      const out = await runCli(["prove", `--from=${join(dir, ".vantio", "runs", "notes.json")}`, "--format=md"], dir);
      assert.equal(out.code, 0, out.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
