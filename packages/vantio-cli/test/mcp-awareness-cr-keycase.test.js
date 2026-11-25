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
    assert.equal(records[0].decision.action, "BLOCK");
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

// ---- keys past the 64-key cap (review round) ----

function polTools(def, tools) {
  return { schema: "vantio.mcp_policy.v1", mode: "enforce", injection: "log", rug_pull: "log", servers: { child: { default: def, tools } } };
}

function filler(n, from = 0) {
  const o = {};
  for (let i = from; i < from + n; i += 1) o[`k${i}`] = i;
  return o;
}

// jsonrpc, id, method, params, then 60 filler keys: 64 stored. The next key is the 65th.
function capFrame(extraTail, method = "tools/list", params = { name: "write_file", arguments: {} }) {
  const head = `{"jsonrpc":"2.0","id":1,"method":${JSON.stringify(method)},"params":${JSON.stringify(params)}`;
  const fill = JSON.stringify(filler(60)).slice(1, -1);
  return `${head},${fill}${extraTail}}\n`;
}

const DENY_BY_NAME = polTools("deny", { write_file: { effect: "deny" } });
const ALLOW_BY_DEFAULT = polTools("allow", { write_file: { effect: "deny" } });
const POLICIES = [DENY_BY_NAME, ALLOW_BY_DEFAULT, policy("enforce", "allow"), policy("enforce", null)];

test("METHOD past the 64th key is seen: the tools/list frame is withheld under every policy", () => {
  const frame = capFrame(',"METHOD":"tools/call"');
  for (const pol of POLICIES) {
    const records = decide(frame, pol);
    assert.equal(records[0].decision.action, "BLOCK");
    assert.equal(records[0].decision.reason, "duplicate_key");
    assert.equal(throughGate([frame], pol).forwarded, "");
  }
});

test("the case-variant key before the 64th key is withheld too", () => {
  const frame = `{"jsonrpc":"2.0","id":1,"method":"tools/list","METHOD":"tools/call",${JSON.stringify(filler(70)).slice(1, -1)}}\n`;
  for (const pol of POLICIES) assert.equal(throughGate([frame], pol).forwarded, "");
});

test("Params and Name past the cap make the object ambiguous", () => {
  const top = capFrame(',"Params":{"name":"x"}');
  assert.equal(decide(top, ENF_ALLOW)[0].decision.reason, "duplicate_key");
  const inner = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_file",${JSON.stringify(filler(70)).slice(1, -1)},"NAME":"write_file"}}\n`;
  for (const pol of POLICIES) {
    assert.equal(decide(inner, pol)[0].decision.reason, "duplicate_key");
    assert.equal(throughGate([inner], pol).forwarded, "");
  }
});

test("an exact duplicate of method past the cap is withheld", () => {
  const dup = capFrame(',"method":"tools/call"');
  assert.equal(decide(dup, ENF_ALLOW)[0].decision.reason, "duplicate_key");
  assert.equal(throughGate([dup], ENF_ALLOW).forwarded, "");
  const both = `{"jsonrpc":"2.0","id":1,${JSON.stringify(filler(70)).slice(1, -1)},"METHOD":"ping","METHOD":"tools/call"}\n`;
  assert.equal(decide(both, ENF_ALLOW)[0].decision.reason, "duplicate_key");
});

test("a case-variant key that is the only method key is read, even past the cap", () => {
  const line = `{"jsonrpc":"2.0","id":1,${JSON.stringify(filler(70)).slice(1, -1)},"METHOD":"tools/call","PARAMS":{"name":"write_file"}}\n`;
  const records = decide(line, ENF_ALLOW);
  assert.equal(records[0].method, "tools/call");
  assert.equal(records[0].decision.action, "BLOCK");
  assert.equal(throughGate([line], ENF_ALLOW).forwarded, "");
});

test("negative: 65 unrelated keys and no folding key are judged as before", () => {
  const line = `{"jsonrpc":"2.0","id":2,"method":"ping",${JSON.stringify(filler(65)).slice(1, -1)}}\n`;
  const records = decide(line, ENF_ALLOW);
  assert.equal(records[0].method, "ping");
  assert.equal(records[0].findings.some((f) => f.kind === "truncated_shape"), true);
  // As before this change: judged as ping, and a truncated shape is refused.
  assert.equal(records[0].decision.action, "BLOCK");
  assert.equal(records[0].decision.reason, "truncated_shape");
  assert.equal(throughGate([line], ENF_ALLOW).forwarded, "");
  // A truncated tools/list is the one passthrough that is still logged and forwarded.
  const list = `{"jsonrpc":"2.0","id":2,"method":"tools/list",${JSON.stringify(filler(65)).slice(1, -1)}}\n`;
  assert.equal(decide(list, ENF_ALLOW)[0].method, "tools/list");
  assert.equal(throughGate([list], ENF_ALLOW).forwarded, list);
});

test("negative: a tools/call with a large arguments object is judged by its real name", () => {
  const args = filler(70);
  const line = `${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "write_file", arguments: args } })}\n`;
  const [record] = decide(line, ALLOW_BY_DEFAULT);
  assert.equal(record.method, "tools/call");
  assert.equal(record.decision.action, "BLOCK");
  assert.equal(record.decision.reason, "truncated_shape");
  assert.equal(throughGate([line], ALLOW_BY_DEFAULT).forwarded, "");
});

test("observe: frames with keys past the cap reach the child unchanged", () => {
  const obs = policy("observe", "allow");
  for (const line of [capFrame(',"METHOD":"tools/call"'), capFrame(',"method":"tools/call"')]) {
    assert.equal(throughGate([line], obs).forwarded, line);
  }
});

// A reader that folds key case and takes the last key, as Go's encoding/json
// does. It writes the method and tool it ran to a file.
const LENIENT_CHILD = `
const fs = require("fs");
let buf = "";
process.stdin.on("data", (c) => {
  buf += c.toString("latin1");
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const low = (x) => { const r = {}; for (const k of Object.keys(x)) r[k.toLowerCase()] = x[k]; return r; };
    const r = low(o);
    const p = r.params && typeof r.params === "object" ? low(r.params) : {};
    fs.appendFileSync(process.env.SINK, "RAN " + r.method + " " + (p.name || "") + "\\n");
  }
});
`;

test("end to end: a reader that folds case does not run the frame the policy did not judge", async () => {
  const home = mkdtempSync(join(tmpdir(), "vantio-van455-lenient-"));
  try {
    const child = join(home, "child.js");
    writeFileSync(child, LENIENT_CHILD);
    const agent = join(home, "agent.js");
    writeFileSync(
      agent,
      `const { spawn } = require("node:child_process");
const c = spawn(process.execPath, [process.env.CHILD], { stdio: ["pipe", "pipe", "ignore"], env: process.env });
c.stdout.on("data", () => {});
c.stdin.write(process.env.FRAME);
c.stdin.end();
c.on("close", () => process.exit(0));`,
    );
    const tooMany = JSON.stringify(filler(60)).slice(1, -1);
    const frame = `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"name":"write_file"},${tooMany},"METHOD":"tools/call"}\n`;
    for (const def of ["allow", "deny", null]) {
      const sink = join(home, `sink-${def}`);
      writeFileSync(sink, "");
      const policyFile = join(home, `policy-${def}.json`);
      writeFileSync(policyFile, JSON.stringify({ servers: def ? { node: { default: def, tools: { write_file: { effect: "deny" } } } } : {} }));
      const result = await runCli(["run", "--mcp-enforce", "node", agent], { HOME: home, CHILD: child, FRAME: frame, SINK: sink, VANTIO_MCP_POLICY: policyFile });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(readFileSync(sink, "utf8").includes("RAN"), false, `policy ${def}`);
    }
    // Control: the reader does run a frame that is allowed.
    const sink = join(home, "sink-control");
    writeFileSync(sink, "");
    const policyFile = join(home, "policy-control.json");
    writeFileSync(policyFile, JSON.stringify({ servers: { node: { default: "allow", tools: {} } } }));
    const ok = `${PING}\n`;
    const result = await runCli(["run", "--mcp-enforce", "node", agent], { HOME: home, CHILD: child, FRAME: ok, SINK: sink, VANTIO_MCP_POLICY: policyFile });
    assert.equal(result.code, 0, result.stderr);
    assert.match(readFileSync(sink, "utf8"), /RAN ping/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- one big write, and the server side (review round) ----

function timed(fn) {
  const start = Date.now();
  const value = fn();
  return { value, ms: Date.now() - start };
}

test("one write of 200,000 CR bytes, then a ping line: enforce and observe finish and keep the bytes", () => {
  for (const mode of ["enforce", "observe"]) {
    const input = `${"\r".repeat(200000)}${PING}\n`;
    const { value, ms } = timed(() => throughGate([input], policy(mode, "allow")));
    assert.equal(value.forwarded, input, mode);
    assert.equal(ms < 10000, true, `${mode} took ${ms} ms`);
    assert.equal(value.records.some((r) => r.method === "ping"), true);
  }
});

test("one write of 200,000 LF bytes, then a ping line", () => {
  for (const mode of ["enforce", "observe"]) {
    const input = `${"\n".repeat(200000)}${PING}\n`;
    const { value } = timed(() => throughGate([input], policy(mode, "allow")));
    assert.equal(value.forwarded, input, mode);
  }
});

test("1,000,000 mixed CR, LF and text bytes in one write", () => {
  const parts = [];
  let seed = 7;
  let size = 0;
  while (size < 1000000) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const piece = ["\r", "\n", "\r\n", "x", "abc", PING + "\r", "\r\r"][seed % 7];
    parts.push(piece);
    size += piece.length;
  }
  const input = parts.join("");
  for (const mode of ["enforce", "observe"]) {
    const { value, ms } = timed(() => throughGate([input], policy(mode, "allow")));
    assert.equal(value.forwarded, input, mode);
    assert.equal(ms < 20000, true, `${mode} took ${ms} ms`);
  }
});

test("a blocked frame inside a large CR run is still withheld", () => {
  const input = `${"\r".repeat(150000)}${CALL}\r${"\r".repeat(50000)}${PING}\n`;
  const { forwarded } = throughGate([input], ENF_ALLOW);
  assert.equal(forwarded.includes("CANARY_VAN455"), false);
  assert.equal(forwarded.endsWith(`${PING}\n`), true);
  assert.equal(forwarded.length, 200000 + PING.length + 1);
});

test("the gate does not hang when the child stream cannot be written", () => {
  const runtime = createRuntime();
  const fromChild = new PassThrough();
  const toChild = new Writable({
    write() {
      throw new Error("closed");
    },
  });
  const gate = runtime.createStdioPairGate({ fromChild, toChild, serverId: "child", policy: ENF_ALLOW, onRecord: () => {} });
  const done = new Promise((resolve) => gate.stdin.end(Buffer.from(`${PING}\n`), resolve));
  return done;
});

function gateWithServer(serverChunks, pol) {
  const runtime = createRuntime();
  const fromChild = new PassThrough();
  const out = [];
  const records = [];
  const gate = runtime.createStdioPairGate({
    fromChild,
    toChild: new Writable({ write: (_c, _e, cb) => cb() }),
    serverId: "child",
    policy: pol,
    onRecord: (r) => records.push(r),
  });
  gate.stdout.on("data", (c) => out.push(Buffer.from(c)));
  for (const chunk of serverChunks) fromChild.write(Buffer.from(chunk));
  fromChild.end();
  return new Promise((resolve) => fromChild.on("end", () => setImmediate(() => resolve({ out: Buffer.concat(out).toString("latin1"), records }))));
}

test("server side: the child's last line without a line end is flushed and judged", async () => {
  const plain = await gateWithServer(["first\n", "tail"], ENF_ALLOW);
  assert.equal(plain.out, "first\ntail");
  const json = await gateWithServer([`{"jsonrpc":"2.0","method":"notifications/message","params":{}}`], ENF_ALLOW);
  assert.equal(json.records.some((r) => r.direction === "server_to_client"), true);
});

test("server side: an unterminated JSON tail is withheld in enforce when the policy refuses it", async () => {
  const refused = await gateWithServer([`{"jsonrpc":"2.0","method":"sampling/createMessage","id":3,"params":{}}`], policy("enforce", null));
  assert.equal(refused.out.includes("sampling/createMessage"), false);
  const observed = await gateWithServer([`{"jsonrpc":"2.0","method":"sampling/createMessage","id":3,"params":{}}`], policy("observe", null));
  assert.equal(observed.out, `{"jsonrpc":"2.0","method":"sampling/createMessage","id":3,"params":{}}`);
});
