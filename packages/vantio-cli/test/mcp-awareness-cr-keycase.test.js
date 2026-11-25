// VAN-455: a lone CR ends a line for the check, and `method`/`jsonrpc` (and
// params, name, id) are read in any letter case. Forwarded bytes never change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { PassThrough, Writable } from "node:stream";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, "..", "bin", "vantio.js");
const LIB = pathToFileURL(join(__dirname, "..", "bin", "mcp-awareness", "index.js")).href;
const { createRuntime } = await import(LIB);

const CALL = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "write_file", arguments: { path: "CANARY_VAN455" } } });
const PING = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" });

function policy(mode, def) {
  return { schema: "vantio.mcp_policy.v1", mode, injection: "log", rug_pull: "log", servers: def ? { child: { default: def, tools: {} } } : {} };
}

// Push chunks through the stdio pair gate. Returns what reached the child.
function throughGate(chunks, pol) {
  const runtime = createRuntime();
  const fromChild = new PassThrough();
  const seen = [];
  const toChild = new Writable({
    write(chunk, _enc, cb) {
      seen.push(Buffer.from(chunk));
      cb();
    },
  });
  const records = [];
  const gate = runtime.createStdioPairGate({ fromChild, toChild, serverId: "child", policy: pol, onRecord: (r) => records.push(r) });
  assert.equal(gate.ok, true);
  for (const chunk of chunks) gate.stdin.write(Buffer.from(chunk));
  gate.stdin.end();
  return { forwarded: Buffer.concat(seen).toString("latin1"), records };
}

function decide(line, pol) {
  const runtime = createRuntime();
  const out = runtime.observeBuffer(Buffer.from(line), { transport: "stdio", direction: "client_to_server", serverId: "child", policy: pol });
  return out.records;
}

// Same runtime (same HMAC key) for several lines, so hashes can be compared.
function decideSame(lines, pol) {
  const runtime = createRuntime();
  return lines.map((line) => runtime.observeBuffer(Buffer.from(line), { transport: "stdio", direction: "client_to_server", serverId: "child", policy: pol }).records[0]);
}

const ENF_ALLOW = policy("enforce", "allow");

// ---- carriage return ----

test("x CR frame LF: the frame is withheld and the CR stays where it was", () => {
  const { forwarded } = throughGate([`x\r${CALL}\n`], ENF_ALLOW);
  assert.equal(forwarded, "x\r");
  assert.equal(forwarded.includes("CANARY_VAN455"), false);
});

test("x CR frame CR frame LF: both frames are withheld", () => {
  const { forwarded } = throughGate([`x\r${CALL}\r${CALL}\n`], ENF_ALLOW);
  assert.equal(forwarded, "x\r");
});

test("negative: allowed frames after a CR are forwarded byte for byte", () => {
  const input = `x\r${PING}\r${PING}\n`;
  const { forwarded } = throughGate([input], ENF_ALLOW);
  assert.equal(forwarded, input);
});

test("a CR at a chunk boundary does not hide the next frame", () => {
  const { forwarded } = throughGate(["x\r", `${CALL}\n`], ENF_ALLOW);
  assert.equal(forwarded, "x\r");
});

test("CRLF split across chunks: a withheld line is withheld whole", () => {
  const { forwarded } = throughGate([`${CALL}\r`, "\n"], ENF_ALLOW);
  assert.equal(forwarded, "");
});

test("CRLF split across chunks: an allowed line is forwarded whole and unchanged", () => {
  const { forwarded } = throughGate([`${PING}\r`, "\n", `${PING}\n`], ENF_ALLOW);
  assert.equal(forwarded, `${PING}\r\n${PING}\n`);
});

test("CRLF in one chunk: a withheld line takes its LF with it", () => {
  const { forwarded } = throughGate([`${CALL}\r\n${PING}\n`], ENF_ALLOW);
  assert.equal(forwarded, `${PING}\n`);
});

test("a frame that ends at a lone CR and then the stream ends is still checked", () => {
  const { forwarded } = throughGate([`${CALL}\r`], ENF_ALLOW);
  assert.equal(forwarded, "");
});

test("two CRs in a row: the empty line between them is forwarded, the frame is not", () => {
  const { forwarded } = throughGate([`${CALL}\r\rx\n`], ENF_ALLOW);
  assert.equal(forwarded, "\rx\n");
});

test("a raw CR inside a JSON string splits the line and the broken half is withheld", () => {
  const raw = '{"jsonrpc":"2.0","id":1,"method":"ping","params":{"a":"p\rq"}}\n';
  const { forwarded } = throughGate([raw], ENF_ALLOW);
  assert.equal(forwarded.includes('"method"'), false);
  // The part after the CR is not JSON on its own, so it passes as non-JSON text.
  assert.equal(forwarded, 'q"}}\n');
});

test("an escaped CR inside a JSON string is not a line end", () => {
  const line = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping", params: { a: "p\rq" } });
  assert.equal(line.includes("\r"), false);
  const { forwarded } = throughGate([`${line}\n`], ENF_ALLOW);
  assert.equal(forwarded, `${line}\n`);
});

test("observe: every shape reaches the child unchanged", () => {
  const obs = policy("observe", "allow");
  const shapes = [`x\r${CALL}\n`, `x\r${CALL}\r${CALL}\n`, `${CALL}\r\n`, `${CALL}\r\r\n`, "\r\r\r", `{"a":"p\rq"}\r`];
  for (const shape of shapes) {
    assert.equal(throughGate([shape], obs).forwarded, shape);
    const split = [shape.slice(0, 3), shape.slice(3)];
    assert.equal(throughGate(split, obs).forwarded, shape);
  }
});

test("a frame in a CR-only stream is judged on its own record", () => {
  const records = decide(`x\r${CALL}\n`, ENF_ALLOW);
  const actions = records.map((r) => r.decision.action);
  assert.deepEqual(actions, ["ALLOW", "BLOCK"]);
});

// ---- key case ----

const FOLDED_CALL = JSON.stringify({ JSONRPC: "2.0", ID: 7, Method: "tools/call", Params: { Name: "write_file", Arguments: { path: "CANARY_VAN455" } } });

function summary(line, pol) {
  return decide(line, pol).map((r) => `${r.decision.action}:${r.decision.reason}:${r.method || r.method_class}:${r.id_type}:${r.id_number}`);
}

test("Method/JSONRPC with default allow is judged like the exact-case frame", () => {
  const exact = summary(`${CALL}\n`, ENF_ALLOW);
  const folded = summary(`${FOLDED_CALL}\n`, ENF_ALLOW);
  assert.deepEqual(folded, exact);
  assert.match(exact[0], /^BLOCK:/);
  assert.equal(throughGate([`${FOLDED_CALL}\n`], ENF_ALLOW).forwarded, "");
});

test("mixed-case keys with default deny and with no policy are judged like exact case", () => {
  for (const pol of [policy("enforce", "deny"), policy("enforce", null)]) {
    assert.deepEqual(summary(`${FOLDED_CALL}\n`, pol), summary(`${CALL}\n`, pol));
    assert.equal(throughGate([`${FOLDED_CALL}\n`], pol).forwarded, "");
  }
});

test("tool name, arguments and id are read in any letter case", () => {
  const [exact, folded] = decideSame([`${CALL}\n`, `${FOLDED_CALL}\n`], ENF_ALLOW);
  assert.equal(typeof exact.tool_hmac, "string");
  assert.equal(folded.tool_hmac, exact.tool_hmac);
  assert.equal(folded.id_number, 7);
  assert.equal(folded.id_type, "number");
  assert.deepEqual(folded.findings, exact.findings);
});

test("the long s folds into params", () => {
  const line = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", "param\u017f": { name: "write_file" } });
  const exact = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "write_file" } });
  assert.deepEqual(summary(`${line}\n`, ENF_ALLOW), summary(`${exact}\n`, ENF_ALLOW));
  const [a, b] = decideSame([`${line}\n`, `${exact}\n`], ENF_ALLOW);
  assert.equal(a.tool_hmac, b.tool_hmac);
});

test("both method and Method: withheld in enforce, whatever the policy", () => {
  const ambiguous = '{"jsonrpc":"2.0","id":1,"method":"ping","Method":"tools/call","params":{"name":"write_file"}}\n';
  for (const pol of [ENF_ALLOW, policy("enforce", "deny"), policy("enforce", null)]) {
    const records = decide(ambiguous, pol);
    assert.equal(records[0].decision.action, "GAP");
    assert.equal(records[0].decision.reason, "duplicate_key");
    assert.equal(throughGate([ambiguous], pol).forwarded, "");
  }
  const reversed = '{"Method":"tools/call","method":"ping","jsonrpc":"2.0","id":1}\n';
  assert.equal(throughGate([reversed], ENF_ALLOW).forwarded, "");
});

test("both name and Name inside params: withheld in enforce", () => {
  const line = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"a","Name":"b"}}\n';
  assert.equal(decide(line, ENF_ALLOW)[0].decision.reason, "duplicate_key");
  assert.equal(throughGate([line], ENF_ALLOW).forwarded, "");
});

test("negative: a folded benign request is forwarded unchanged", () => {
  const line = `${JSON.stringify({ JSONRPC: "2.0", Id: 5, METHOD: "ping" })}\n`;
  assert.equal(throughGate([line], ENF_ALLOW).forwarded, line);
});

test("negative: other key names are not folded into method", () => {
  const line = `${JSON.stringify({ jsonrpc: "2.0", id: 1, methods: "tools/call", method_: "tools/call" })}\n`;
  const records = decide(line, ENF_ALLOW);
  assert.notEqual(records[0].method, "tools/call");
  assert.equal(records[0].method_class, "other");
});

test("a wrong jsonrpc version in any case is still refused", () => {
  const line = `${JSON.stringify({ JSONRPC: "1.0", id: 1, method: "ping" })}\n`;
  assert.equal(decide(line, ENF_ALLOW)[0].decision.action, "GAP");
  assert.equal(throughGate([line], ENF_ALLOW).forwarded, "");
});

test("observe: a folded frame and an ambiguous frame reach the child unchanged", () => {
  const obs = policy("observe", "allow");
  const ambiguous = '{"method":"ping","Method":"tools/call"}\n';
  for (const line of [`${FOLDED_CALL}\n`, ambiguous]) {
    assert.equal(throughGate([line], obs).forwarded, line);
  }
});

// ---- vantio run with a cat child ----

function runCli(args, env, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], { env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    let stderr = "";
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    const killer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code, stdout: Buffer.concat(out), stderr });
    });
  });
}

// The agent reads the bytes to send from a file, writes them to `cat` in the
// given chunk sizes, and prints what cat returned as hex.
const CAT_AGENT = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const data = fs.readFileSync(process.env.INPUT);
const size = Number(process.env.CHUNK || 0) || data.length || 1;
const child = spawn("cat", [], { stdio: ["pipe", "pipe", "ignore"] });
const out = [];
child.stdout.on("data", (c) => out.push(c));
child.on("close", () => process.stdout.write(Buffer.concat(out).toString("hex")));
for (let i = 0; i < data.length; i += size) child.stdin.write(data.subarray(i, i + size));
child.stdin.end();
`;

async function viaCat(home, input, { enforce, chunk, policyFile }) {
  const inputFile = join(home, "input.bin");
  writeFileSync(inputFile, input);
  const agent = join(home, "agent.js");
  writeFileSync(agent, CAT_AGENT);
  const args = enforce ? ["run", "--mcp-enforce", "node", agent] : ["run", "node", agent];
  const env = { HOME: home, INPUT: inputFile, CHUNK: String(chunk || 0) };
  if (policyFile) env.VANTIO_MCP_POLICY = policyFile;
  const result = await runCli(args, env);
  assert.equal(result.code, 0, result.stderr);
  const hex = result.stdout.toString("utf8");
  const match = hex.match(/^[0-9a-f]*/)[0];
  return Buffer.from(match, "hex");
}

test("vantio run --mcp-enforce with a cat child: CR shapes do not hide a frame", async () => {
  const home = mkdtempSync(join(tmpdir(), "vantio-van455-"));
  try {
    const policyFile = join(home, "policy.json");
    writeFileSync(policyFile, JSON.stringify({ servers: { cat: { default: "allow", tools: {} } } }));
    const opts = { enforce: true, policyFile };
    const one = await viaCat(home, `x\r${CALL}\n`, opts);
    assert.equal(one.includes("CANARY_VAN455"), false);
    assert.equal(one.toString("latin1").includes("x\r"), true);
    const two = await viaCat(home, `x\r${CALL}\r${CALL}\n`, opts);
    assert.equal(two.includes("CANARY_VAN455"), false);
    const split = await viaCat(home, `${CALL}\r\n`, { ...opts, chunk: CALL.length + 1 });
    assert.equal(split.includes("CANARY_VAN455"), false);
    const folded = await viaCat(home, `${FOLDED_CALL}\n`, opts);
    assert.equal(folded.includes("CANARY_VAN455"), false);
    const same = `x\r${PING}\r\n`;
    assert.equal((await viaCat(home, same, opts)).toString("latin1"), same);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("vantio run observe with a cat child: bytes are identical, 1 MB binary and JSON with many CRs", async () => {
  const home = mkdtempSync(join(tmpdir(), "vantio-van455-obs-"));
  try {
    const binary = randomBytes(1024 * 1024);
    const rows = [];
    while (rows.join("").length < 1024 * 1024) rows.push(`${CALL}\r${PING}\r\n${FOLDED_CALL}\r\r`);
    const json = Buffer.from(rows.join(""));
    for (const input of [binary, json]) {
      const got = await viaCat(home, input, { enforce: false, chunk: 65536 });
      assert.equal(createHash("sha256").update(got).digest("hex"), createHash("sha256").update(input).digest("hex"));
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("enforce without a stdout pipe: a CR shape is withheld on the stdin line path", async () => {
  const home = mkdtempSync(join(tmpdir(), "vantio-van455-line-"));
  const sink = join(home, "sink");
  const agent = join(home, "agent.js");
  writeFileSync(
    agent,
    `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", \`
  const fs = require("fs");
  const chunks = [];
  process.stdin.on("data", (c) => chunks.push(c));
  process.stdin.on("end", () => fs.writeFileSync(process.env.SINK, Buffer.concat(chunks)));
\`], { stdio: ["pipe", "ignore", "ignore"], env: process.env });
child.stdin.write("x\\r");
child.stdin.write(process.env.FRAME + "\\r");
child.stdin.write("\\n");
child.stdin.write(process.env.PING + "\\r\\n");
child.stdin.end();
child.on("close", () => process.exit(0));
`,
  );
  const policyFile = join(home, "policy.json");
  writeFileSync(policyFile, JSON.stringify({ servers: { node: { default: "allow", tools: {} } } }));
  try {
    const result = await runCli(["run", "--mcp-enforce", "node", agent], { HOME: home, SINK: sink, FRAME: CALL, PING, VANTIO_MCP_POLICY: policyFile });
    assert.equal(result.code, 0, result.stderr);
    const received = readFileSync(sink, "latin1");
    assert.equal(received.includes("CANARY_VAN455"), false);
    assert.equal(received, `x\r${PING}\r\n`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
