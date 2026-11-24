// VAN-408: an MCP record's time ("at") is used by coverage, destinations and
// export, so --since keeps a recent MCP tool and a first-use flag is shown.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, "..", "bin", "vantio.js");
const features = createRequire(import.meta.url)("../bin/optics-features.cjs");

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

function mcpRecord(tool, at) {
  const record = {
    schema: "vantio.mcp_observation.v1",
    transport: "stdio",
    direction: "client_to_server",
    server_id: "fs",
    method: "tools/call",
    tool_name: tool,
    findings: [],
    decision: { action: "LOG", reason: "observed" },
  };
  if (at) record.at = at;
  return record;
}

function homeWith(records) {
  const home = mkdtempSync(join(tmpdir(), "vantio-mcp-time-"));
  mkdirSync(join(home, ".vantio"), { recursive: true });
  writeFileSync(join(home, ".vantio", "mcp-observations.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return home;
}

const minuteAgo = () => new Date(Date.now() - 60 * 1000).toISOString();
const fortyDaysAgo = () => new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();

describe("MCP record time", () => {
  test("destinations --since=24h flags a tool first used a minute ago, once", async () => {
    const home = homeWith([mcpRecord("read_file", minuteAgo())]);
    try {
      const first = await runCli(["destinations", "--since=24h", "--json"], home);
      assert.equal(first.code, 0, first.stderr);
      const alerts = JSON.parse(first.stdout).alerts;
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].destination, "mcp read_file");
      assert.equal(alerts[0].kind, "mcp_tool");
      assert.ok(alerts[0].first_connection);
      const again = await runCli(["destinations", "--json"], home);
      assert.equal(again.code, 0, again.stderr);
      assert.deepEqual(JSON.parse(again.stdout).alerts, []);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("coverage --since=24h keeps a recent MCP record and does not call it undated", async () => {
    const home = homeWith([mcpRecord("read_file", minuteAgo())]);
    try {
      const out = await runCli(["coverage", "--since=24h", "--json"], home);
      assert.equal(out.code, 0, out.stderr);
      const coverage = JSON.parse(out.stdout);
      const rows = coverage.connections.filter((row) => row.kind === "mcp_tool");
      assert.equal(rows.length, 1);
      assert.ok(rows[0].time);
      assert.equal(coverage.undated_excluded, 0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an MCP record older than the window stays out and is not counted as undated", () => {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const out = features.collectObservations([], [mcpRecord("old_tool", fortyDaysAgo())], "box", cutoff);
    assert.deepEqual(out.observations, []);
    assert.equal(out.undatedExcluded, 0);
  });

  test("an old MCP record is not flagged by destinations --since=24h", async () => {
    const home = homeWith([mcpRecord("old_tool", fortyDaysAgo())]);
    try {
      const out = await runCli(["destinations", "--since=24h", "--json"], home);
      assert.equal(out.code, 0, out.stderr);
      assert.deepEqual(JSON.parse(out.stdout).alerts, []);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an MCP record with no time is still counted as undated (unchanged)", () => {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const out = features.collectObservations([], [mcpRecord("no_time", null)], "box", cutoff);
    assert.deepEqual(out.observations, []);
    assert.equal(out.undatedExcluded, 1);
  });
});
