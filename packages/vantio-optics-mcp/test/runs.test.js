import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRunLogs, loadRun, proveMarkdown, discoverLocal, UPGRADE_PATH } from "../src/runs.js";

test("list/load/prove/discover from fixture runs dir", () => {
  const root = mkdtempSync(join(tmpdir(), "vantio-optics-mcp-"));
  const dir = join(root, "runs");
  mkdirSync(dir, { recursive: true });

  const log = {
    vantio_run_log: "1",
    trace_id: "0xabcoptics01",
    pid: 42,
    machine: "test",
    started_at: "2026-07-17T00:00:00.000Z",
    generated_at: "2026-07-17T00:00:01.000Z",
    duration_ms: 1000,
    cli_version: "0.3.0",
    calls: [
      { hostname: "api.openai.com", action: "OBSERVED", bytes: 1200, ts: "2026-07-17T00:00:00.500Z" },
      { hostname: "api.anthropic.com", action: "OBSERVED", bytes: 800, ts: "2026-07-17T00:00:00.800Z" },
    ],
    summary: {
      total_calls: 2,
      total_bytes: 2000,
      hosts: ["api.openai.com", "api.anthropic.com"],
      redacted: 0,
      blocked: 0,
    },
  };
  writeFileSync(join(dir, "0xabcoptics01.json"), JSON.stringify(log, null, 2));

  const listed = listRunLogs(dir);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].trace_id, "0xabcoptics01");

  const loaded = loadRun("0xabc", dir);
  assert.ok(loaded.log);
  assert.equal(loaded.log.trace_id, "0xabcoptics01");

  const md = proveMarkdown(loaded.log);
  assert.match(md, /Vantio Optics/);
  assert.match(md, /api\.openai\.com/);
  assert.match(md, /metadata only|No prompts or completions/i);
  assert.match(md, /Developer egress data log|Traffic metadata only/i);
  assert.doesNotMatch(md, /"role"\s*:\s*"user"|completion_tokens/);

  const hosts = discoverLocal(30 * 24 * 60 * 60 * 1000, dir);
  assert.equal(hosts.length, 2);
  assert.equal(UPGRADE_PATH.next[0].brand, "Vantio Phantom Engine");
  assert.match(UPGRADE_PATH.fence, /read-only/i);

  rmSync(root, { recursive: true, force: true });
});

// VAN-394, owner decision option A: a call with no known host is listed, but
// it is left out of the host rows, the call count and the byte totals.

function fixtureDir(log) {
  const root = mkdtempSync(join(tmpdir(), "vantio-optics-mcp-van394-"));
  const dir = join(root, "runs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${log.trace_id}.json`), JSON.stringify(log));
  return { root, dir };
}

const NO_HOST = { hostname: null, action: "OBSERVED", bytes: 5000, ts: "2026-11-25T00:00:00.500Z" };
const KNOWN = { hostname: "llm.example.test", action: "OBSERVED", bytes: 300, ts: "2026-11-25T00:00:00.800Z" };

test("a no-host call gets no discover row, no place in the totals, and its own count", () => {
  const { root, dir } = fixtureDir({ vantio_run_log: "1", trace_id: "van394mcp", calls: [NO_HOST, KNOWN], summary: { total_calls: 1, total_bytes: 300, calls_without_host: 1, hosts: ["llm.example.test"] } });
  const hosts = discoverLocal(30 * 24 * 60 * 60 * 1000, dir);
  assert.deepEqual(hosts.map((h) => [h.hostname, h.calls, h.bytes]), [["llm.example.test", 1, 300]]);
  assert.equal(hosts.calls_without_host, 1);
  const listed = listRunLogs(dir);
  assert.equal(listed[0].total_calls, 1);
  assert.equal(listed[0].total_bytes, 300);
  const md = proveMarkdown(loadRun("van394mcp", dir).log);
  assert.match(md, /- Total calls: \*\*1\*\*/);
  assert.match(md, /- Total bytes: \*\*300\*\*/);
  assert.match(md, /## Calls \(2\)\n/);
  assert.equal(md.split("\n").filter((l) => /^\| \d+ \|/.test(l)).length, 2, "both rows are listed");
  assert.match(md, /\nCalls with no known host: 1 \(listed above, not counted in the summary\)\n/);
  rmSync(root, { recursive: true, force: true });
});

test("a known-host call is still counted with its bytes, with no no-host line", () => {
  const { root, dir } = fixtureDir({ vantio_run_log: "1", trace_id: "van394mcpk", calls: [KNOWN] });
  const hosts = discoverLocal(30 * 24 * 60 * 60 * 1000, dir);
  assert.deepEqual(hosts.map((h) => [h.hostname, h.calls, h.bytes]), [["llm.example.test", 1, 300]]);
  assert.equal(hosts.calls_without_host, 0);
  const md = proveMarkdown(loadRun("van394mcpk", dir).log);
  assert.match(md, /- Total calls: \*\*1\*\*/);
  assert.match(md, /## Calls \(1\)\n/);
  assert.ok(!md.includes("no known host"), md);
  rmSync(root, { recursive: true, force: true });
});

test("a log from before option A prints no no-host line, as its summary counts that call", () => {
  const { root, dir } = fixtureDir({
    vantio_run_log: "1",
    trace_id: "van394mcpold",
    calls: [NO_HOST, KNOWN],
    summary: { total_calls: 2, total_bytes: 5300, hosts: ["llm.example.test", "unknown"] },
  });
  const md = proveMarkdown(loadRun("van394mcpold", dir).log);
  assert.match(md, /- Total calls: \*\*2\*\*/);
  assert.ok(!md.includes("no known host"), md);
  rmSync(root, { recursive: true, force: true });
});
