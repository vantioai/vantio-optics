// VAN-399: in observe mode a child that never received a JSON-RPC frame is
// not an MCP server. Its JSON log lines and large output are not MCP records.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      cwd: home,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function records(home) {
  const path = join(home, ".vantio", "mcp-observations.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function runAgent(source) {
  const home = mkdtempSync(join(tmpdir(), "vantio-non-mcp-"));
  writeFileSync(join(home, "agent.js"), source);
  const result = await runCli(["run", "node", "agent.js"], home);
  return { home, result };
}

describe("MCP awareness and children that are not MCP servers", () => {
  test("a child that prints JSON log lines writes no MCP record", async () => {
    const { home, result } = await runAgent(`
      const { spawn } = require("node:child_process");
      const c = spawn(process.execPath, ["-e", "for (let i = 0; i < 3; i++) console.log(JSON.stringify({ level: 'info', i }))"]);
      c.stdout.on("data", () => {});
    `);
    try {
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(records(home), []);
      const coverage = await runCli(["coverage", "--json"], home);
      assert.equal(coverage.code, 0, coverage.stderr);
      const mcpRows = JSON.parse(coverage.stdout).connections.filter((row) => row.kind === "mcp_tool");
      assert.deepEqual(mcpRows, []);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("large output or input without a newline writes no oversize gap", async () => {
    const { home, result } = await runAgent(`
      const { spawn } = require("node:child_process");
      const big = spawn(process.execPath, ["-e", "process.stdout.write('A'.repeat(400 * 1024))"]);
      big.stdout.on("data", () => {});
      const sink = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "inherit"] });
      sink.stdin.write(Buffer.alloc(300 * 1024, 0x41));
      sink.stdin.end("\\n");
    `);
    try {
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(records(home), []);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a real JSON-RPC exchange is still recorded in both directions", async () => {
    const { home, result } = await runAgent(`
      const { spawn } = require("node:child_process");
      const server = spawn(process.execPath, ["-e", \`
        let buf = "";
        process.stdin.on("data", (d) => {
          buf += d;
          if (buf.includes("\\\\n")) {
            process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }) + "\\\\n");
            process.exit(0);
          }
        });
      \`]);
      server.stdout.on("data", () => {});
      server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) + "\\n");
    `);
    try {
      assert.equal(result.code, 0, result.stderr);
      const directions = new Set(records(home).map((r) => r.direction));
      assert.ok(directions.has("client_to_server"), JSON.stringify(records(home)));
      assert.ok(directions.has("server_to_client"), JSON.stringify(records(home)));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
