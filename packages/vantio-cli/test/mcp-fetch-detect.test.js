// VAN-405: a fetch body is an MCP message when it has a top-level "jsonrpc"
// key, wherever the key is. The MCP TypeScript SDK writes it after "params".
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, "..", "bin", "vantio.js");

// The agent starts a local server that answers every POST with a JSON-RPC
// result, posts BODY to it, and prints what came back.
const AGENT = `
const http = require("node:http");
const srv = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }));
  });
});
srv.listen(0, "127.0.0.1", async () => {
  const res = await fetch("http://127.0.0.1:" + srv.address().port + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: process.env.BODY,
  });
  process.stdout.write(await res.text());
  srv.close();
});
`;

function runAgent(body, flags) {
  const home = mkdtempSync(join(tmpdir(), "vantio-mcp-fetch-"));
  writeFileSync(join(home, "agent.js"), AGENT);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, "run", ...flags, "node", "agent.js"], {
      env: { PATH: process.env.PATH, HOME: home, VANTIO_TELEMETRY_DISABLED: "1", BODY: body },
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
      const path = join(home, ".vantio", "mcp-observations.jsonl");
      const records = existsSync(path)
        ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
        : [];
      rmSync(home, { recursive: true, force: true });
      resolve({ code, stdout, stderr, records });
    });
  });
}

// Field order as the MCP TypeScript SDK sends it: method, params, jsonrpc, id.
function sdkOrderCall(argumentBytes) {
  return JSON.stringify({
    method: "tools/call",
    params: { name: "write_file", arguments: { path: "/tmp/x", text: "a".repeat(argumentBytes) } },
    jsonrpc: "2.0",
    id: 1,
  });
}

const WITHHELD = /vantio_mcp_policy_block/;

describe("MCP over fetch: which bodies are MCP messages", () => {
  test("a short request is withheld under --mcp-enforce (unchanged)", async () => {
    const out = await runAgent(sdkOrderCall(10), ["--mcp-enforce"]);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, WITHHELD);
    assert.equal(out.records.length, 1);
  });

  test("a request whose jsonrpc key comes after 256 bytes is withheld under --mcp-enforce", async () => {
    const body = sdkOrderCall(400);
    assert.ok(body.indexOf("\"jsonrpc\"") > 256);
    const out = await runAgent(body, ["--mcp-enforce"]);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, WITHHELD);
    assert.equal(out.records.length, 1);
    assert.equal(out.records[0].decision.action, "BLOCK");
  });

  test("the same request is recorded in observe mode and still sent", async () => {
    const out = await runAgent(sdkOrderCall(400), []);
    assert.equal(out.code, 0, out.stderr);
    assert.doesNotMatch(out.stdout, WITHHELD);
    assert.match(out.stdout, /"result"/);
    // The request and the server's answer are both recorded.
    assert.deepEqual(out.records.map((r) => r.direction).sort(), ["client_to_server", "server_to_client"]);
  });

  test("a JSON-RPC batch goes to the policy, which does not accept batches", async () => {
    const batch = JSON.stringify([{ method: "tools/list", jsonrpc: "2.0", id: 1 }]);
    const out = await runAgent(batch, ["--mcp-enforce"]);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, WITHHELD);
    assert.equal(out.records[0].decision.reason, "batch_rejected");
  });

  test("an LLM request that only mentions jsonrpc in its text is not an MCP message", async () => {
    const prompt = JSON.stringify({
      model: "gpt-x",
      messages: [{ role: "user", content: "Explain this: {\"jsonrpc\": \"2.0\", \"method\": \"tools/call\"}" }],
    });
    const out = await runAgent(prompt, ["--mcp-enforce"]);
    assert.equal(out.code, 0, out.stderr);
    assert.doesNotMatch(out.stdout, WITHHELD);
    assert.deepEqual(out.records, []);
  });

  test("a text body that is not JSON is not an MCP message", async () => {
    const out = await runAgent("plain text that says \"jsonrpc\": somewhere", ["--mcp-enforce"]);
    assert.equal(out.code, 0, out.stderr);
    assert.doesNotMatch(out.stdout, WITHHELD);
    assert.deepEqual(out.records, []);
  });
});
