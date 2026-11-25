// VAN-393: Python MCP awareness leaves non-MCP child stdin alone, and
// --mcp-enforce also covers communicate() and subprocess.run(input=...).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, "..", "bin", "vantio.js");
const HAS_PY = spawnSync("python3", ["--version"], { encoding: "utf8" }).status === 0;
const CANARY = "CANARY_VAN393_7c1e";

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: { PATH: process.env.PATH, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const killer = setTimeout(() => child.kill("SIGKILL"), 30000);
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr });
    });
  });
}

function result(stdout) {
  const line = stdout.split("\n").find((l) => l.startsWith("RESULT "));
  assert.ok(line, stdout);
  return JSON.parse(line.slice(7));
}

const FRAME = JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "write_file", arguments: { path: CANARY } } });

const PLAIN_AGENT = `
import json, subprocess, threading, time
out = {}
p = subprocess.Popen(["cat"], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
p.stdin.write(b"hello"); p.stdin.flush()
got = []
t = threading.Thread(target=lambda: got.append(p.stdout.read1(5)), daemon=True); t.start(); t.join(3)
out["partial"] = got[0].decode() if got else None
p.kill(); p.wait()
p = subprocess.Popen(["cat"], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL)
t0 = time.time()
for i in range(200):
    p.stdin.write(b"line %d\\n" % i)
p.stdin.close(); p.wait()
out["lines_s"] = time.time() - t0
p = subprocess.Popen(["cat"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
o, _ = p.communicate('  {"a": 1}\\nplain\\n{"jsonrpc": no newline')
out["text_echo"] = o
out["run_echo"] = subprocess.run(["cat"], input=b"x\\n{\\"k\\":2}\\n", capture_output=True).stdout.decode()
print("RESULT " + json.dumps(out))
`;

const ENFORCE_AGENT = `
import json, os, subprocess
frame = os.environ["FRAME"] + "\\n"
out = {}
out["run"] = subprocess.run(["cat"], input=("before\\n" + frame + "after\\n").encode(), capture_output=True).stdout.decode()
p = subprocess.Popen(["cat"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
o, _ = p.communicate(frame)
out["communicate_text"] = o
p = subprocess.Popen(["cat"], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
p.stdin.writelines([b"one\\n", frame.encode()]); p.stdin.close()
out["writelines"] = p.stdout.read().decode(); p.wait()
print("RESULT " + json.dumps(out))
`;

test("non-MCP children get their stdin unchanged and at once", { skip: !HAS_PY, timeout: 60000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "van393-plain-"));
  const agent = join(home, "agent.py");
  writeFileSync(agent, PLAIN_AGENT);
  try {
    const { code, stdout, stderr } = await runCli(["run", "python3", agent], { HOME: home });
    assert.equal(code, 0, stderr);
    assert.match(stderr, /mcp awareness mode=observe/);
    const out = result(stdout);
    assert.equal(out.partial, "hello");
    assert.ok(out.lines_s < 1, `200 lines took ${out.lines_s}s`);
    assert.equal(out.text_echo, '  {"a": 1}\nplain\n{"jsonrpc": no newline');
    assert.equal(out.run_echo, 'x\n{"k":2}\n');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("--mcp-enforce withholds a frame sent with run(input=), communicate() and writelines()", { skip: !HAS_PY, timeout: 60000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "van393-enforce-"));
  const agent = join(home, "agent.py");
  writeFileSync(agent, ENFORCE_AGENT);
  try {
    const { code, stdout, stderr } = await runCli(["run", "--mcp-enforce", "python3", agent], { HOME: home, FRAME });
    assert.equal(code, 0, stderr);
    const out = result(stdout);
    for (const key of ["run", "communicate_text", "writelines"]) {
      assert.equal(out[key].includes(CANARY), false, `${key}: ${out[key]}`);
      assert.match(out[key], /vantio_mcp_policy_block/, key);
    }
    assert.match(out.run, /before\n/);
    assert.match(out.run, /after\n/);
    assert.match(out.writelines, /one\n/);
    const log = join(home, ".vantio", "mcp-observations.jsonl");
    assert.ok(existsSync(log));
    assert.equal(readFileSync(log, "utf8").includes(CANARY), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("observe mode still logs a frame sent with communicate(), and the child gets it", { skip: !HAS_PY, timeout: 60000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "van393-observe-"));
  const agent = join(home, "agent.py");
  writeFileSync(agent, `
import os, subprocess
o, _ = subprocess.Popen(["cat"], stdin=subprocess.PIPE, stdout=subprocess.PIPE).communicate((os.environ["FRAME"] + "\\n").encode())
print("RESULT " + __import__("json").dumps({"echo": o.decode()}))
`);
  try {
    const { code, stdout, stderr } = await runCli(["run", "python3", agent], { HOME: home, FRAME });
    assert.equal(code, 0, stderr);
    assert.equal(result(stdout).echo, `${FRAME}\n`);
    const log = readFileSync(join(home, ".vantio", "mcp-observations.jsonl"), "utf8");
    assert.match(log, /tools\/call/);
    assert.equal(log.includes(CANARY), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// A `{` line is held only up to the Node library's MAX_FRAME (256 KiB).
const BIG_OBSERVE_AGENT = `
import json, subprocess, threading
out = {}
big = b"{" + b"a" * 300000
p = subprocess.Popen(["cat"], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
got = bytearray()
def pump():
    while len(got) < len(big):
        chunk = p.stdout.read1(65536)
        if not chunk:
            break
        got.extend(chunk)
t = threading.Thread(target=pump, daemon=True); t.start()
p.stdin.write(big); p.stdin.flush()
t.join(8)
out["before_newline"] = len(got)
p.stdin.write(b"tail\\nnext\\n"); p.stdin.close()
t.join(8)
rest = p.stdout.read(); p.wait()
out["same"] = bytes(got) + rest == big + b"tail\\nnext\\n"
under = b"{" + b"b" * (256 * 1024 - 2) + b"\\n"
out["under_same"] = subprocess.run(["cat"], input=under, capture_output=True).stdout == under
print("RESULT " + json.dumps(out))
`;

const BIG_ENFORCE_AGENT = `
import json, os, subprocess
out = {}
big = ("{" + '"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"pad":"' + "a" * 300000 + os.environ["CANARY"] + '"}}\\n').encode()
o = subprocess.run(["cat"], input=b"before\\n" + big + b"after\\n", capture_output=True).stdout.decode()
out["has_canary"] = os.environ["CANARY"] in o
out["len"] = len(o)
out["before"] = "before\\n" in o
out["after"] = "after\\n" in o
out["blocked"] = "vantio_mcp_policy_block" in o
p = subprocess.Popen(["cat"], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
p.stdin.write(big[:-1])
out["held_bytes"] = len(p._vantio_gate.held)
p.stdin.close()
o2 = p.stdout.read().decode(); p.wait()  # nothing is forwarded, so cat's pipe cannot fill
out["no_newline_len"] = len(o2)
out["no_newline_blocked"] = "vantio_mcp_policy_block" in o2
print("RESULT " + json.dumps(out))
`;

test("observe: a `{` line past 256 KiB is forwarded before its newline and logged as an oversize gap", { skip: !HAS_PY, timeout: 60000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "van393-big-observe-"));
  const agent = join(home, "agent.py");
  writeFileSync(agent, BIG_OBSERVE_AGENT);
  try {
    const { code, stdout, stderr } = await runCli(["run", "python3", agent], { HOME: home });
    assert.equal(code, 0, stderr);
    const out = result(stdout);
    assert.equal(out.before_newline, 300001, "the child got the whole oversize part before the newline");
    assert.equal(out.same, true, "the child's bytes are unchanged");
    assert.equal(out.under_same, true, "a line under the bound is unchanged");
    const log = readFileSync(join(home, ".vantio", "mcp-observations.jsonl"), "utf8");
    assert.match(log, /"reason":"oversize"/);
    assert.equal(log.split("\n").filter((l) => l.includes('"reason":"oversize"')).length, 1, "one gap, and none for the line under the bound");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("--mcp-enforce withholds a `{` line past 256 KiB up to its newline and answers with the fixed error", { skip: !HAS_PY, timeout: 60000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "van393-big-enforce-"));
  const agent = join(home, "agent.py");
  writeFileSync(agent, BIG_ENFORCE_AGENT);
  try {
    const { code, stdout, stderr } = await runCli(["run", "--mcp-enforce", "python3", agent], { HOME: home, CANARY });
    assert.equal(code, 0, stderr);
    const out = result(stdout);
    assert.equal(out.has_canary, false);
    assert.ok(out.len < 1024, `child output was ${out.len} bytes`);
    assert.equal(out.before, true);
    assert.equal(out.after, true);
    assert.equal(out.blocked, true);
    assert.equal(out.held_bytes, 0, "nothing is kept in memory past the bound");
    assert.ok(out.no_newline_len < 1024, `no-newline output was ${out.no_newline_len} bytes`);
    assert.equal(out.no_newline_blocked, true);
    const log = readFileSync(join(home, ".vantio", "mcp-observations.jsonl"), "utf8");
    assert.match(log, /"reason":"oversize"/);
    assert.equal(log.includes(CANARY), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Fixes after the independent review of 2806c7a (findings 1 to 4, 6, 8, 9).
// The agents below run once under plain `vantio run` (observe) and once under
// `vantio run --mcp-enforce`, with `cat` as the child.
const PRELUDE = String.raw`
import json, os, subprocess, threading, time
P = subprocess.PIPE
FRAME = os.environ["FRAME"].encode()
out = {}

def arrives(data, want, **kw):
    """Write and flush without closing. Return how many bytes cat echoed."""
    p = subprocess.Popen(["cat"], stdin=P, stdout=P, **kw)
    got = bytearray()
    def pump():
        while True:
            chunk = os.read(p.stdout.fileno(), 65536)
            if not chunk:
                break
            got.extend(chunk)
    t = threading.Thread(target=pump, daemon=True); t.start()
    p.stdin.write(data); p.stdin.flush()
    deadline = time.time() + 4
    while len(got) < want and time.time() < deadline:
        time.sleep(0.02)
    n = len(got)
    gate = p._vantio_gate
    held = len(gate.held) + len(getattr(gate, "pre", b""))
    p.stdin.close(); t.join(5); p.wait()
    return [n, held]

def piped(data):
    p = subprocess.Popen(["cat"], stdin=P, stdout=P)
    p.stdin.write(data); p.stdin.close()
    o = p.stdout.read(); p.wait()
    return o.decode("utf-8", "replace")

def done():
    print("RESULT " + json.dumps(out))
`;

async function runAgent(body, enforce, extraEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), "van393-fix-"));
  const agent = join(home, "agent.py");
  writeFileSync(agent, `${PRELUDE}\n${body}\ndone()\n`);
  try {
    const args = enforce ? ["run", "--mcp-enforce", "python3", agent] : ["run", "python3", agent];
    const { code, stdout, stderr } = await runCli(args, { HOME: home, FRAME, REAL_NODE: process.execPath, ...extraEnv });
    assert.equal(code, 0, stderr);
    const logPath = join(home, ".vantio", "mcp-observations.jsonl");
    return { out: result(stdout), log: existsSync(logPath) ? readFileSync(logPath, "utf8") : "", stderr };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const BLOCK = /vantio_mcp_policy_block/;

// Finding 1.
const TAIL_AGENT = String.raw`
def tail(first, **kw):
    p = subprocess.Popen(["cat"], stdin=P, stdout=P, **kw)
    p.stdin.write(first)
    o, _ = p.communicate(timeout=20)
    return o.decode()
out["json_tail"] = tail(b'{"a":1}')
out["blank_tail"] = tail(b"x\n  ")
out["frame_tail"] = tail(FRAME)
out["frame_tail_3_pipes"] = tail(FRAME, stderr=P)
with subprocess.Popen(["cat"], stdin=P, stdout=P) as p:
    p.stdin.write(b'{"b":2}'); p.stdin.close()
    out["close_tail"] = p.stdout.read().decode()
`;

test("bytes written before communicate() with no input are not lost (observe), and are checked (enforce)", { skip: !HAS_PY, timeout: 120000 }, async () => {
  const observe = await runAgent(TAIL_AGENT, false);
  assert.equal(observe.out.json_tail, '{"a":1}');
  assert.equal(observe.out.blank_tail, "x\n  ");
  assert.equal(observe.out.frame_tail, FRAME);
  assert.equal(observe.out.frame_tail_3_pipes, FRAME);
  assert.equal(observe.out.close_tail, '{"b":2}');
  assert.match(observe.log, /tools\/call/, "the frame with no newline is still logged");
  assert.equal(observe.log.includes(CANARY), false);

  const enforce = await runAgent(TAIL_AGENT, true);
  // Negative case: JSON that is not JSON-RPC, and blanks, still reach the child.
  assert.equal(enforce.out.json_tail, '{"a":1}');
  assert.equal(enforce.out.blank_tail, "x\n  ");
  assert.equal(enforce.out.close_tail, '{"b":2}');
  for (const key of ["frame_tail", "frame_tail_3_pipes"]) {
    assert.equal(enforce.out[key].includes(CANARY), false, key);
    assert.match(enforce.out[key], BLOCK, key);
  }
});

// Finding 2.
const BLANK_AGENT = String.raw`
out["space"] = arrives(b" ", 1)
out["tab"] = arrives(b"\t", 1)
out["cr"] = arrives(b"\r", 1)
out["newline"] = arrives(b"\n", 1)
out["after_line"] = arrives(b"abc\n\t", 5)
out["million"] = arrives(b" " * 1000000, 1000000)
blank_frame = b"  \t\r" + FRAME + b"\nafter\n"
out["blank_frame_same"] = piped(blank_frame) == blank_frame.decode()
out["blank_frame"] = piped(blank_frame).replace(FRAME.decode(), "<frame>")
`;

test("leading blanks reach the child at once and are never kept; a frame after blanks is still checked", { skip: !HAS_PY, timeout: 120000 }, async () => {
  for (const enforce of [false, true]) {
    const { out, log } = await runAgent(BLANK_AGENT, enforce);
    const mode = enforce ? "enforce" : "observe";
    assert.deepEqual(out.space, [1, 0], mode);
    assert.deepEqual(out.tab, [1, 0], mode);
    assert.deepEqual(out.cr, [1, 0], mode);
    assert.deepEqual(out.newline, [1, 0], mode);
    assert.deepEqual(out.after_line, [5, 0], mode);
    assert.deepEqual(out.million, [1000000, 0], mode);
    assert.match(log, /tools\/call/, `${mode}: the frame after blanks went to the helper`);
    if (enforce) {
      assert.equal(out.blank_frame.includes(CANARY), false);
      assert.match(out.blank_frame, BLOCK);
      assert.match(out.blank_frame, /after\n/);
    } else {
      assert.equal(out.blank_frame_same, true);
    }
  }
});

// Finding 3. Sizes are the line's total bytes, newline included.
const BOUND_AGENT = String.raw`
for size in (262143, 262144, 262145, 262146, 262147):
    line = b'{"k":"' + b"a" * (size - 9) + b'"}\n'
    assert len(line) == size
    data = b"before\n" + line + b"after\nlast\n"
    o = subprocess.run(["cat"], input=data, capture_output=True, timeout=30).stdout
    out[str(size)] = {
        "same": o == data,
        "len": len(o),
        "before": b"before\n" in o,
        "after": b"after\nlast\n" in o,
        "blocked": b"vantio_mcp_policy_block" in o,
    }
`;

test("a `{` line of 256 KiB minus 1 to plus 3 bytes never costs the next line", { skip: !HAS_PY, timeout: 120000 }, async () => {
  const sizes = [262143, 262144, 262145, 262146, 262147];
  const observe = await runAgent(BOUND_AGENT, false);
  for (const size of sizes) assert.equal(observe.out[size].same, true, `observe ${size}: bytes identical`);
  assert.equal(observe.log.split("\n").filter((l) => l.includes('"reason":"oversize"')).length, 3, "one gap for each line over the bound, none at or under it");

  const enforce = await runAgent(BOUND_AGENT, true);
  for (const size of sizes) {
    const got = enforce.out[size];
    assert.equal(got.before, true, `enforce ${size}: the line before`);
    assert.equal(got.after, true, `enforce ${size}: the next lines survive`);
    if (size <= 262144) {
      // Negative case: at or under the bound, plain JSON is not withheld.
      assert.equal(got.same, true, `enforce ${size}: unchanged`);
    } else {
      assert.equal(got.blocked, true, `enforce ${size}: fixed error`);
      assert.ok(got.len < 1024, `enforce ${size}: line withheld, child output ${got.len} bytes`);
    }
  }
});

// Finding 4.
const SHAPES_AGENT = String.raw`
text = FRAME.decode()
shapes = {
    "escaped_key": text.replace('"jsonrpc"', '"\\u006asonrpc"').encode() + b"\n",
    "batch": b"[" + FRAME + b"]\n",
    "bom": b"\xef\xbb\xbf" + FRAME + b"\n",
    "form_feed": b"\x0c" + FRAME + b"\n",
    "no_break_space": b"\xc2\xa0" + FRAME + b"\n",
    "does_not_parse": b'{"jsonrpc":"2.0","method":"tools/call","params":{"name":"' + os.environ["CANARY"].encode() + b'"\n',
}
for name, line in shapes.items():
    o = piped(line + b"after\n")
    out[name] = {"same": o == (line + b"after\n").decode(), "canary": os.environ["CANARY"] in o,
                 "blocked": "vantio_mcp_policy_block" in o, "after": "after\n" in o}
plain = b'{"a":1}\n[1,2,3]\n[]\n[{"a":1},"x"]\n  {"jsonrpc_like":true}\n"jsonrpc"\n'
out["plain_same"] = piped(plain) == plain.decode()
p = subprocess.Popen(["cat"], stdin=P, stdout=subprocess.DEVNULL)
t0 = time.time()
for i in range(200):
    p.stdin.write(b'{"n":%d}\n' % i)
p.stdin.close(); p.wait()
out["plain_200_s"] = time.time() - t0
`;

test("--mcp-enforce checks an escaped jsonrpc key, a batch, a frame after a BOM or form feed, and a line that does not parse", { skip: !HAS_PY, timeout: 120000 }, async () => {
  const names = ["escaped_key", "batch", "bom", "form_feed", "no_break_space", "does_not_parse"];
  const enforce = await runAgent(SHAPES_AGENT, true, { CANARY });
  for (const name of names) {
    assert.equal(enforce.out[name].canary, false, `${name} reached the child`);
    assert.equal(enforce.out[name].blocked, true, name);
    assert.equal(enforce.out[name].after, true, `${name}: next line`);
  }
  assert.match(enforce.log, /"reason":"batch_rejected"/);
  assert.equal(enforce.log.includes(CANARY), false);
  // Negative case: JSON that is not JSON-RPC passes, and no helper is started for it.
  assert.equal(enforce.out.plain_same, true);
  assert.ok(enforce.out.plain_200_s < 2, `200 plain JSON lines took ${enforce.out.plain_200_s}s`);
  assert.equal(enforce.log.split("\n").filter(Boolean).length, names.length, "one record per checked line, none for plain JSON");

  const observe = await runAgent(SHAPES_AGENT, false, { CANARY });
  for (const name of names) assert.equal(observe.out[name].same, true, `observe ${name}: bytes identical`);
  assert.equal(observe.out.plain_same, true);
  assert.ok(observe.out.plain_200_s < 2, `200 plain JSON lines took ${observe.out.plain_200_s}s`);
  assert.equal(observe.log.split("\n").filter((l) => l.includes("tools/call")).length, 4, "escaped key, BOM, form feed and no-break space frames are logged");
  assert.match(observe.log, /"reason":"batch_rejected"/);
  assert.equal(observe.log.includes(CANARY), false);
});

// Finding 6.
const TEXT_AGENT = String.raw`
def text_pipe(s):
    p = subprocess.Popen(["cat"], stdin=P, stdout=P, text=True, encoding="utf-8")
    got = []
    t = threading.Thread(target=lambda: got.append(p.stdout.read()), daemon=True); t.start()
    p.stdin.write(s); p.stdin.close(); t.join(20); p.wait()
    return got[0] if got else ""
big = "{" + "a" * 262143 + "é" * 10 + "\nend\n"
o = text_pipe(big)
out["big"] = {"same": o == big, "replaced": o.count("�"), "end": o.endswith("end\n"), "len": len(o)}
small = "€uro\n　{\"k\":\"é\"}\né{x\n"
out["small_same"] = text_pipe(small) == small
`;

test("a text-mode line over the bound is not cut inside a multi-byte character", { skip: !HAS_PY, timeout: 120000 }, async () => {
  const observe = await runAgent(TEXT_AGENT, false);
  assert.deepEqual(observe.out.big, { same: true, replaced: 0, end: true, len: 262159 });
  assert.equal(observe.out.small_same, true);
  const enforce = await runAgent(TEXT_AGENT, true);
  // Enforce withholds the oversize line; what does reach the child is whole.
  assert.equal(enforce.out.big.replaced, 0);
  assert.equal(enforce.out.big.end, true);
  assert.ok(enforce.out.big.len < 1024);
  assert.equal(enforce.out.small_same, true, "negative case: multi-byte text under the bound is unchanged");
});

// Finding 8.
const RETRY_AGENT = String.raw`
def retry(data):
    p = subprocess.Popen(["sh", "-c", "sleep 2; cat"], stdin=P, stdout=P)
    try:
        p.communicate(data, timeout=0.5)
        return "no timeout"
    except subprocess.TimeoutExpired:
        return p.communicate(timeout=20)[0].decode()
out["retry"] = retry(b"keep\n" + FRAME + b"\n")
out["retry_plain"] = retry(b"keep\n")
`;

test("--mcp-enforce: the error survives a communicate() timeout and retry", { skip: !HAS_PY, timeout: 120000 }, async () => {
  const { out } = await runAgent(RETRY_AGENT, true);
  assert.match(out.retry, BLOCK);
  assert.match(out.retry, /keep\n/);
  assert.equal(out.retry.includes(CANARY), false);
  assert.equal(out.retry_plain, "keep\n", "negative case: no error when nothing was withheld");
});

// Finding 9.
const TYPE_AGENT = String.raw`
p = subprocess.Popen(["cat"], stdin=P, stdout=P)
try:
    out["str_on_binary"] = repr(p.stdin.write("text\n"))
except TypeError:
    out["str_on_binary"] = "TypeError"
out["bytes_on_binary"] = p.stdin.write(b"text\n")
p.stdin.close(); out["binary_echo"] = p.stdout.read().decode(); p.wait()
p = subprocess.Popen(["cat"], stdin=P, stdout=P, text=True)
try:
    out["bytes_on_text"] = repr(p.stdin.write(b"text\n"))
except TypeError:
    out["bytes_on_text"] = "TypeError"
out["str_on_text"] = p.stdin.write("text\n")
p.stdin.close(); p.wait()
`;

test("a str written to a binary pipe raises TypeError, as in plain Python", { skip: !HAS_PY, timeout: 120000 }, async () => {
  for (const enforce of [false, true]) {
    const { out } = await runAgent(TYPE_AGENT, enforce);
    assert.equal(out.str_on_binary, "TypeError");
    assert.equal(out.bytes_on_text, "TypeError");
    // Negative case: the right type is written and counted as before.
    assert.equal(out.bytes_on_binary, 5);
    assert.equal(out.str_on_text, 5);
    assert.equal(out.binary_echo, "text\n");
  }
});

// Fixes after the independent review of 20db6af (N1, N3, N5, N6, N8).
// fake_node() puts a `node` first on PATH that notes each start in a file,
// waits, then runs the real node. The count shows whether the helper ran.
const FAKE_NODE = String.raw`
import stat
def fake_node(delay):
    d = os.path.join(os.environ["HOME"], "fake-bin")
    os.makedirs(d, exist_ok=True)
    count = os.path.join(d, "starts")
    with open(os.path.join(d, "node"), "w") as fh:
        fh.write('#!/bin/sh\necho start >> "%s"\nsleep %s\nexec "%s" "$@"\n' % (count, delay, os.environ["REAL_NODE"]))
    os.chmod(os.path.join(d, "node"), 0o755)
    os.environ["PATH"] = d + os.pathsep + os.environ["PATH"]
    return count
def starts(count):
    return len(open(count).read().splitlines()) if os.path.exists(count) else 0
def probe(data):
    o = piped(data)
    return {"same": o == data.decode("utf-8", "replace"), "canary": os.environ["CANARY"] in o,
            "blocked": "vantio_mcp_policy_block" in o, "id7": '"id":7' in o, "after": "after\n" in o}
`;

// N1.
const METHOD_KEY_AGENT = String.raw`
count = fake_node(0)
nokey = b'{"id":7,"method":"tools/call","params":{"name":"' + os.environ["CANARY"].encode() + b'","arguments":{}}}'
out["write"] = probe(b"before\n" + nokey + b"\nafter\n")
o = subprocess.run(["cat"], input=b"before\n" + nokey + b"\nafter\n", capture_output=True).stdout.decode()
out["run"] = {"canary": os.environ["CANARY"] in o, "blocked": "vantio_mcp_policy_block" in o, "after": "after\n" in o,
              "same": o == (b"before\n" + nokey + b"\nafter\n").decode()}
out["batch"] = probe(b"[" + nokey + b"]\nafter\n")
out["starts_method"] = starts(count)
neither = b'{"id":7,"params":{"name":"t","arguments":{}}}\n[{"id":8},[{"result":1}]]\n{"params":{"method":"tools/call"}}\n'
n0 = starts(count)
out["neither_same"] = piped(neither) == neither.decode()
out["neither_run_same"] = subprocess.run(["cat"], input=neither, capture_output=True).stdout == neither
out["starts_neither"] = starts(count) - n0
`;

test("an object with a method key and no jsonrpc key goes to the helper, also inside a batch; --mcp-enforce withholds it", { skip: !HAS_PY, timeout: 120000 }, async () => {
  const enforce = await runAgent(`${FAKE_NODE}\n${METHOD_KEY_AGENT}`, true, { CANARY });
  for (const key of ["write", "run", "batch"]) {
    assert.equal(enforce.out[key].canary, false, `${key} reached the child`);
    assert.equal(enforce.out[key].blocked, true, key);
    assert.equal(enforce.out[key].after, true, `${key}: next line`);
  }
  assert.equal(enforce.out.write.id7, true, "the error carries the request id");
  assert.equal(enforce.out.starts_method, 3, "one node start per checked line");
  assert.match(enforce.log, /"reason":"batch_rejected"/);
  assert.equal(enforce.log.includes(CANARY), false);
  // Negative case: an object with neither key passes, and node is not started
  // (the fake node on PATH notes every start; the count does not move).
  assert.equal(enforce.out.neither_same, true);
  assert.equal(enforce.out.neither_run_same, true);
  assert.equal(enforce.out.starts_neither, 0, "no node start for JSON with neither key");

  const observe = await runAgent(`${FAKE_NODE}\n${METHOD_KEY_AGENT}`, false, { CANARY });
  for (const key of ["write", "run", "batch"]) assert.equal(observe.out[key].same, true, `observe ${key}: bytes identical`);
  assert.equal(observe.out.starts_method, 3, "observe sends the same three lines to the helper");
  assert.equal(observe.log.split("\n").filter((l) => l.includes("tools/call")).length, 2);
  assert.equal(observe.out.neither_same, true);
  assert.equal(observe.out.neither_run_same, true);
  assert.equal(observe.out.starts_neither, 0);
  assert.equal(observe.log.includes(CANARY), false);
});

// N6.
const BROKEN_UTF8_AGENT = String.raw`
count = fake_node(0)
shapes = {
    "c2": b"\xc2" + FRAME,
    "ff": b"\xff" + FRAME,
    "e2_80": b"\xe2\x80" + FRAME,
    "bom_then_ff": b"\xef\xbb\xbf \xff" + FRAME,
    "deep_batch": b"[" * 10 + FRAME + b"]" * 10,
}
for name, line in shapes.items():
    out[name] = probe(line + b"\nafter\n")
n0 = starts(count)
binary = (b"\xff\xd8\xff\xe0 jpeg {x}\n" + b"\xffplain\n" + b"\xc2\xa9 2026 {a}\n" + "é{x\n€[y\n".encode()
          + b"\xc2 {x\n" + b"\x80\n" + b"[[[[[[[[[[1]]]]]]]]]]\n" + bytes(range(128, 256)) + b"\n")
out["binary_same"] = piped(binary) == binary.decode("utf-8", "replace")
out["binary_run_same"] = subprocess.run(["cat"], input=binary, capture_output=True).stdout == binary
out["starts_binary"] = starts(count) - n0
out["lone_ff"] = arrives(b"\xff", 1)
out["ff_then_x"] = arrives(b"\xffx", 2)
`;

test("--mcp-enforce withholds a frame after a broken UTF-8 byte and a batch nested 10 deep; binary lines still pass", { skip: !HAS_PY, timeout: 120000 }, async () => {
  const names = ["c2", "ff", "e2_80", "bom_then_ff", "deep_batch"];
  const enforce = await runAgent(`${FAKE_NODE}\n${BROKEN_UTF8_AGENT}`, true, { CANARY });
  for (const name of names) {
    assert.equal(enforce.out[name].canary, false, `${name} reached the child`);
    assert.equal(enforce.out[name].blocked, true, name);
    assert.equal(enforce.out[name].after, true, `${name}: next line`);
  }
  assert.equal(enforce.log.split("\n").filter((l) => l.includes('"reason":"invalid_utf8"')).length, 4);
  assert.match(enforce.log, /"reason":"batch_rejected"/);
  assert.equal(enforce.log.includes(CANARY), false);
  // Negative case: binary lines that do not have `{` or `[` right after the
  // broken bytes are unchanged, and node is not started for them.
  assert.equal(enforce.out.binary_same, true);
  assert.equal(enforce.out.binary_run_same, true);
  assert.equal(enforce.out.starts_binary, 0);
  assert.deepEqual(enforce.out.ff_then_x, [2, 0], "the bytes go on as soon as the next byte is not `{` or `[`");

  const observe = await runAgent(`${FAKE_NODE}\n${BROKEN_UTF8_AGENT}`, false, { CANARY });
  for (const name of names) assert.equal(observe.out[name].same, true, `observe ${name}: bytes identical`);
  assert.equal(observe.out.binary_same, true);
  assert.equal(observe.out.binary_run_same, true);
  assert.equal(observe.out.starts_binary, 0);
  assert.equal(observe.out.lone_ff[0], 1, "observe: a lone 0xFF reaches the child at once");
});

// N3. The fake node waits 2 s, so a child that gets its bytes in under 1.5 s
// got them before the helper finished.
const ORDER_AGENT = String.raw`
count = fake_node(2)
def timed(bufsize, how, data):
    p = subprocess.Popen(["cat"], stdin=P, stdout=P, bufsize=bufsize)
    seen = {}
    def pump():
        while True:
            chunk = os.read(p.stdout.fileno(), 65536)
            if not chunk:
                seen["eof"] = time.time()
                break
            seen.setdefault("first", time.time())
    t = threading.Thread(target=pump, daemon=True); t.start()
    t0 = time.time()
    p.stdin.write(data)
    if how == "flush":
        p.stdin.flush()
    else:
        p.stdin.close()
    call = time.time() - t0
    p.stdin.close(); t.join(10); p.wait()
    return {"first": seen["first"] - t0, "eof": seen["eof"] - t0, "call": call}
line = FRAME + b"\n"
out["flush"] = timed(-1, "flush", line)
out["unbuffered"] = timed(0, "flush", line)
out["close"] = timed(-1, "close", line)
sink = os.path.join(os.environ["HOME"], "sink")
p = subprocess.Popen(["sh", "-c", 'cat > "$1"', "sh", sink], stdin=P)
seen = {}
def poll():
    while "first" not in seen:
        if os.path.exists(sink) and os.path.getsize(sink) > 0:
            seen["first"] = time.time()
        time.sleep(0.01)
t = threading.Thread(target=poll, daemon=True); t.start()
t0 = time.time()
p.communicate(b"first\n" + line)
out["communicate"] = {"call": time.time() - t0, "first": seen.get("first", t0 + 99) - t0}
out["starts_frames"] = starts(count)
n0 = starts(count)
out["plain"] = timed(-1, "flush", b'plain\n{"a":1}\n')
out["starts_plain"] = starts(count) - n0
`;

test("observe: the child gets a JSON-RPC line before the helper runs (flush, unbuffered write, close, communicate)", { skip: !HAS_PY, timeout: 120000 }, async () => {
  const { out, log } = await runAgent(`${FAKE_NODE}\n${ORDER_AGENT}`, false);
  for (const key of ["flush", "unbuffered", "close", "communicate"]) {
    assert.ok(out[key].first < 1.5, `${key}: first byte after ${out[key].first}s`);
    assert.ok(out[key].call >= 1.9, `${key}: the helper still ran inside the call (${out[key].call}s)`);
  }
  assert.ok(out.close.eof < 1.5, `close: end of input after ${out.close.eof}s`);
  assert.equal(out.starts_frames, 4);
  assert.equal(log.split("\n").filter((l) => l.includes("tools/call")).length, 4, "each frame is still logged");
  // Negative case: lines that are not JSON-RPC do not start node at all.
  assert.equal(out.starts_plain, 0);
  assert.ok(out.plain.call < 1, `plain lines took ${out.plain.call}s`);
});

// N5.
const DEVNULL_AGENT = String.raw`
p = subprocess.Popen(["cat"], stdin=P, stdout=subprocess.DEVNULL)
p.stdin.write(b"plain\n" + (FRAME + b"\n" if os.environ["SEND_FRAME"] == "1" else b'{"a":1}\n'))
p.stdin.close(); p.wait()
`;

test("--mcp-enforce: a frame withheld on stdin.write prints the notice when stdout is not a pipe", { skip: !HAS_PY, timeout: 120000 }, async () => {
  const NOTICE = /mcp frame withheld \(stdout not captured\)/g;
  const withheld = await runAgent(DEVNULL_AGENT, true, { SEND_FRAME: "1" });
  assert.equal((withheld.stderr.match(NOTICE) || []).length, 1, withheld.stderr);
  assert.equal(withheld.stderr.includes(CANARY), false);
  // Negative cases: nothing withheld, no notice; observe withholds nothing.
  const nothing = await runAgent(DEVNULL_AGENT, true, { SEND_FRAME: "0" });
  assert.equal((nothing.stderr.match(NOTICE) || []).length, 0, nothing.stderr);
  const observe = await runAgent(DEVNULL_AGENT, false, { SEND_FRAME: "1" });
  assert.equal((observe.stderr.match(NOTICE) || []).length, 0, observe.stderr);
});

// N8. The unwrapped method, called through the class, gives plain Python's text.
const CLOSED_AGENT = String.raw`
import io
def closed(kind, item, **kw):
    p = subprocess.Popen(["cat"], stdin=P, stdout=P, **kw)
    p.stdin.close()
    got = {}
    for name, call in (("wrapped", lambda: p.stdin.writelines([item])), ("python", lambda: kind.writelines(p.stdin, [item])),
                       ("wrapped_empty", lambda: p.stdin.writelines([]))):
        try:
            call(); got[name] = "no error"
        except ValueError as exc:
            got[name] = "ValueError: " + str(exc)
    p.stdout.close(); p.wait()
    return got
out["buffered"] = closed(io.BufferedWriter, b"x\n")
out["unbuffered"] = closed(io.FileIO, b"x\n", bufsize=0)
out["text"] = closed(io.TextIOWrapper, "x\n", text=True)
p = subprocess.Popen(["cat"], stdin=P, stdout=P)
p.stdin.writelines([b"one\n", bytearray(b"two\n")]); p.stdin.close()
out["open_echo"] = p.stdout.read().decode(); p.wait()
`;

test("writelines() on a closed stdin raises ValueError with plain Python's text", { skip: !HAS_PY, timeout: 120000 }, async () => {
  for (const enforce of [false, true]) {
    const { out } = await runAgent(CLOSED_AGENT, enforce);
    for (const key of ["buffered", "unbuffered", "text"]) {
      assert.match(out[key].python, /^ValueError: /, key);
      assert.equal(out[key].wrapped, out[key].python, key);
      assert.equal(out[key].wrapped_empty, out[key].python, `${key}: empty list`);
    }
    // Negative case: an open stdin is written as before.
    assert.equal(out.open_echo, "one\ntwo\n");
  }
});

// Fixes after the independent review of 7b2daba (findings 1, 2, 3 and 6).

// Finding 1. bad_node() puts a `node` first on PATH that reads its input and
// then answers in a way the real helper never does for a line it lets through.
const HELPER_FAIL_AGENT = String.raw`
ALLOW = '{"records":[{"schema":"vantio.mcp_observation.v1","decision":{"action":"ALLOW","reason":"allow"}}],"error":null}'
KINDS = {
    "empty": "cat >/dev/null\n",
    "empty_object": "cat >/dev/null\nprintf '{}'\n",
    "no_records": "cat >/dev/null\nprintf '{\"records\":[],\"error\":null}'\n",
    "no_error_key": "cat >/dev/null\nprintf '{\"records\":[{\"schema\":\"vantio.mcp_observation.v1\",\"decision\":{\"action\":\"ALLOW\"}}]}'\n",
    "block_record_null_error": "cat >/dev/null\nprintf '{\"records\":[{\"schema\":\"vantio.mcp_observation.v1\",\"decision\":{\"action\":\"BLOCK\"}}],\"error\":null}'\n",
    "allow_but_exit_1": "cat >/dev/null\nprintf '%s' '" + ALLOW + "'\nexit 1\n",
    "garbage_exit_3": "cat >/dev/null\necho 'garbage<<>>'\nexit 3\n",
    "not_executable_output": "cat >/dev/null\nprintf '[]'\n",
}
PATH0 = os.environ["PATH"]
def bad_node(script):
    d = os.path.join(os.environ["HOME"], "bad-bin")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "node"), "w") as fh:
        fh.write("#!/bin/sh\n" + script)
    os.chmod(os.path.join(d, "node"), 0o755)
    os.environ["PATH"] = d + os.pathsep + PATH0
def both(data):
    o = piped(data)
    r = subprocess.run(["cat"], input=data, capture_output=True).stdout.decode("utf-8", "replace")
    return {"same": o == data.decode() and r == data.decode(), "canary": os.environ["CANARY"] in o + r,
            "failed": o.count('"finding":"helper_failed"') + r.count('"finding":"helper_failed"'),
            "after": o.endswith("after\n") and r.endswith("after\n"), "before": "before\n" in o and "before\n" in r}
line = b"before\n" + FRAME + b"\nafter\n"
for kind, script in KINDS.items():
    bad_node(script)
    out[kind] = both(line)
plain = b'before\n{"a":1}\n[1,2]\nafter\n'
out["plain_with_bad_node"] = both(plain)
os.environ["PATH"] = PATH0
os.environ["NODE_OPTIONS"] = "--no-such-flag-van393"
out["bad_node_options"] = both(line)
del os.environ["NODE_OPTIONS"]
out["real_block"] = both(line)
policy = os.path.join(os.environ["HOME"], "policy.json")
with open(policy, "w") as fh:
    json.dump({"servers": {"cat": {"default": "allow"}}}, fh)
os.environ["VANTIO_MCP_POLICY"] = policy
out["real_allow"] = both(b'before\n{"jsonrpc":"2.0","id":1,"method":"ping"}\nafter\n')
`;

test("--mcp-enforce withholds a frame when the helper gives no usable answer; a real allow answer still passes", { skip: !HAS_PY, timeout: 120000 }, async () => {
  const kinds = ["empty", "empty_object", "no_records", "no_error_key", "block_record_null_error", "allow_but_exit_1", "garbage_exit_3", "not_executable_output", "bad_node_options"];
  const enforce = await runAgent(HELPER_FAIL_AGENT, true, { CANARY });
  for (const kind of kinds) {
    assert.equal(enforce.out[kind].canary, false, `${kind}: the frame reached the child`);
    assert.equal(enforce.out[kind].failed, 2, `${kind}: helper_failed on write and on run(input=)`);
    assert.equal(enforce.out[kind].before && enforce.out[kind].after, true, `${kind}: lines around it`);
  }
  assert.equal(enforce.log.includes(CANARY), false);
  // Negative cases: a line the helper is not asked about passes with a broken
  // node; a working helper's block keeps its own reason; a working helper's
  // allow (policy default allow, a ping) lets the line through unchanged.
  assert.equal(enforce.out.plain_with_bad_node.same, true);
  assert.equal(enforce.out.real_block.canary, false);
  assert.equal(enforce.out.real_block.failed, 0, "a real block is not reported as helper_failed");
  assert.equal(enforce.out.real_allow.same, true, "a real allow answer forwards the line");
  assert.match(enforce.log, /"action":"ALLOW"/);

  // Observe: no helper failure changes the child's bytes.
  const observe = await runAgent(HELPER_FAIL_AGENT, false, { CANARY });
  for (const kind of [...kinds, "plain_with_bad_node", "real_block", "real_allow"]) {
    assert.equal(observe.out[kind].same, true, `observe ${kind}: bytes identical`);
  }
});

test("--mcp-enforce withholds a frame when the helper cannot load its library", { skip: !HAS_PY, timeout: 120000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "van393-helper-"));
  const agent = join(home, "agent.py");
  const run = (cli, args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { PATH: process.env.PATH, HOME: home, FRAME, CANARY }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.resume();
    const killer = setTimeout(() => child.kill("SIGKILL"), 60000);
    child.on("close", (code) => { clearTimeout(killer); resolve({ code, stdout }); });
  });
  writeFileSync(agent, `${PRELUDE}
line = b"before\\n" + FRAME + b"\\nafter\\n"
o = piped(line)
out["same"] = o == line.decode()
out["canary"] = os.environ["CANARY"] in o
out["failed"] = '"finding":"helper_failed"' in o
out["around"] = "before\\n" in o and o.endswith("after\\n")
done()
`);
  try {
    // A copy of the CLI whose helper throws while loading its imports.
    const pkg = join(home, "cli");
    cpSync(join(__dirname, "..", "bin"), join(pkg, "bin"), { recursive: true });
    cpSync(join(__dirname, "..", "package.json"), join(pkg, "package.json"));
    writeFileSync(join(pkg, "bin", "mcp-awareness-paths.js"), 'throw new Error("x");\n');
    const broken = join(pkg, "bin", "vantio.js");
    const enforce = result((await run(broken, ["run", "--mcp-enforce", "python3", agent])).stdout);
    assert.equal(enforce.canary, false, "the frame reached the child");
    assert.equal(enforce.failed, true);
    assert.equal(enforce.around, true);
    const observe = result((await run(broken, ["run", "python3", agent])).stdout);
    assert.equal(observe.same, true, "observe: bytes identical with a helper that cannot load");
    // Negative case: the unchanged CLI blocks the same frame with the helper's own reason.
    const intact = result((await run(CLI_PATH, ["run", "--mcp-enforce", "python3", agent])).stdout);
    assert.equal(intact.canary, false);
    assert.equal(intact.failed, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Finding 2. A reader with universal newlines takes a lone CR as a line end.
const CR_AGENT = String.raw`
count = fake_node(0)
def shape(data, text=False):
    if text:
        p = subprocess.Popen(["cat"], stdin=P, stdout=P, text=True, encoding="utf-8")
        p.stdin.write(data.decode()); p.stdin.close()
        o = p.stdout.read().encode(); p.wait()
        # Python's text read turns each CR into a newline; compare like for like.
        same = o == data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    else:
        p = subprocess.Popen(["cat"], stdin=P, stdout=P)
        p.stdin.write(data); p.stdin.close()
        o = p.stdout.read(); p.wait()
        same = o == data
    r = subprocess.run(["cat"], input=data, capture_output=True).stdout
    return {"same": same and r == data, "canary": os.environ["CANARY"].encode() in o + r,
            "blocks": o.count(b"vantio_mcp_policy_block"), "run_blocks": r.count(b"vantio_mcp_policy_block"),
            "child": o.split(b"\n", o.count(b"vantio_mcp_policy_block"))[-1].decode("utf-8", "replace")}
out["x_cr_frame"] = shape(b"x\r" + FRAME + b"\nafter\n")
out["x_cr_two_frames"] = shape(b"x\r" + FRAME + b"\r" + FRAME + b"\nafter\n")
out["json_cr_frame"] = shape(b'{"a":1}\r' + FRAME + b"\nafter\n")
out["frame_cr_text"] = shape(FRAME + b"\rtail\nafter\n")
out["frame_crlf"] = shape(b"before\n" + FRAME + b"\r\nafter\n")
out["text_pipe"] = shape(b"x\r" + FRAME + b"\nafter\n", text=True)
one = bytearray()
p = subprocess.Popen(["cat"], stdin=P, stdout=P, bufsize=0)
for b in b"x\r" + FRAME + b"\r" + FRAME + b"\nafter\n":
    p.stdin.write(bytes([b]))
p.stdin.close(); o = p.stdout.read(); p.wait()
out["one_byte_writes"] = {"canary": os.environ["CANARY"].encode() in o, "blocks": o.count(b"vantio_mcp_policy_block"),
                          "child": o.split(b"\n", 2)[-1].decode()}
out["starts_frames"] = starts(count)
n0 = starts(count)
plain = b'x\ry\r{"a":1}\rz\n 10%\r 20%\r 30%\r\n{"a":1}\r\n[1,2]\r\n\r\r{"b":2}\r"method"\rdone\n'
out["plain"] = shape(plain)
out["plain_text"] = shape(plain, text=True)
out["starts_plain"] = starts(count) - n0
`;

test("--mcp-enforce checks a frame after a lone CR like a line of its own; other bytes keep their CR", { skip: !HAS_PY, timeout: 120000 }, async () => {
  const enforce = await runAgent(`${FAKE_NODE}\n${CR_AGENT}`, true, { CANARY });
  const want = { x_cr_frame: [1, "x\rafter\n"], x_cr_two_frames: [2, "x\rafter\n"], json_cr_frame: [1, '{"a":1}\rafter\n'],
    frame_cr_text: [1, "tail\nafter\n"], frame_crlf: [1, "before\nafter\n"], text_pipe: [1, "x\nafter\n"] };
  for (const [name, [blocks, child]] of Object.entries(want)) {
    assert.equal(enforce.out[name].canary, false, `${name}: a frame reached the child`);
    assert.equal(enforce.out[name].blocks, blocks, `${name}: errors on stdin.write`);
    assert.equal(enforce.out[name].run_blocks, blocks, `${name}: errors on run(input=)`);
    assert.equal(enforce.out[name].child, child, `${name}: what the child got`);
  }
  assert.deepEqual(enforce.out.one_byte_writes, { canary: false, blocks: 2, child: "x\rafter\n" });
  assert.equal(enforce.log.includes(CANARY), false);
  // Negative case: CR-separated text and plain JSON reach the child byte for
  // byte, CRs included, and node is not started for them.
  assert.equal(enforce.out.plain.same, true);
  assert.equal(enforce.out.plain_text.same, true);
  assert.equal(enforce.out.starts_plain, 0);

  // Observe: bytes are never changed, and the frames after a CR are logged.
  const observe = await runAgent(`${FAKE_NODE}\n${CR_AGENT}`, false, { CANARY });
  for (const name of [...Object.keys(want), "plain", "plain_text"]) assert.equal(observe.out[name].same, true, `observe ${name}: bytes identical`);
  assert.equal(observe.out.starts_frames, enforce.out.starts_frames, "observe sends the same lines to the helper");
  assert.equal(observe.log.split("\n").filter((l) => l.includes("tools/call")).length, observe.out.starts_frames);
  assert.equal(observe.out.starts_plain, 0);
  assert.equal(observe.log.includes(CANARY), false);
});

// Finding 3. Some JSON decoders match field names without regard to case.
const KEY_CASE_AGENT = String.raw`
count = fake_node(0)
tail = b':"tools/call","params":{"name":"' + os.environ["CANARY"].encode() + b'","arguments":{}}}'
shapes = {
    "both_upper": b'{"JSONRPC":"2.0","id":7,"Method"' + tail,
    "method_only": b'{"id":7,"METHOD"' + tail,
    "mixed": b'{"JsonRpc":"2.0","id":7,"mEtHoD"' + tail,
    "nested_batch": b'[[{"id":7,"Method"' + tail + b"]]",
}
for name, line in shapes.items():
    out[name] = probe(line + b"\nafter\n")
    r = subprocess.run(["cat"], input=line + b"\nafter\n", capture_output=True).stdout.decode()
    out[name]["run_canary"] = os.environ["CANARY"] in r
    out[name]["run_blocked"] = "vantio_mcp_policy_block" in r
out["starts_shapes"] = starts(count)
n0 = starts(count)
other = b'{"Methods":1,"JSON_RPC":"2.0"}\n{"params":{"Method":"tools/call"}}\n[{"ID":8,"Params":{}}]\n{"meth":"od"}\n'
out["other_same"] = piped(other) == other.decode()
out["other_run_same"] = subprocess.run(["cat"], input=other, capture_output=True).stdout == other
out["starts_other"] = starts(count) - n0
`;

test("a line with JSONRPC or Method keys in another case goes to the helper, also inside a batch; --mcp-enforce withholds it", { skip: !HAS_PY, timeout: 120000 }, async () => {
  const names = ["both_upper", "method_only", "mixed", "nested_batch"];
  const enforce = await runAgent(`${FAKE_NODE}\n${KEY_CASE_AGENT}`, true, { CANARY });
  for (const name of names) {
    assert.equal(enforce.out[name].canary || enforce.out[name].run_canary, false, `${name} reached the child`);
    assert.equal(enforce.out[name].blocked && enforce.out[name].run_blocked, true, name);
    assert.equal(enforce.out[name].after, true, `${name}: next line`);
  }
  assert.equal(enforce.out.starts_shapes, 8, "one node start per checked line");
  assert.equal(enforce.log.includes(CANARY), false);
  // Negative case: keys that only look alike pass, and node is not started.
  assert.equal(enforce.out.other_same, true);
  assert.equal(enforce.out.other_run_same, true);
  assert.equal(enforce.out.starts_other, 0);

  const observe = await runAgent(`${FAKE_NODE}\n${KEY_CASE_AGENT}`, false, { CANARY });
  for (const name of names) assert.equal(observe.out[name].same, true, `observe ${name}: bytes identical`);
  assert.equal(observe.out.starts_shapes, 8, "observe sends the same lines to the helper");
  assert.equal(observe.out.other_same, true);
  assert.equal(observe.out.other_run_same, true);
  assert.equal(observe.out.starts_other, 0);
  assert.equal(observe.log.includes(CANARY), false);
});

// Finding 6. The slow node notes its own pid and the pid of a process it
// starts, then waits 60 s. The wrapper gives the helper 5 s.
const HANG_AGENT = String.raw`
d = os.path.join(os.environ["HOME"], "slow-bin")
os.makedirs(d, exist_ok=True)
pids = os.path.join(d, "pids")
with open(os.path.join(d, "node"), "w") as fh:
    fh.write('#!/bin/sh\necho $$ >> "%s"\nsleep 60 &\necho $! >> "%s"\nwait\n' % (pids, pids))
os.chmod(os.path.join(d, "node"), 0o755)
PATH0 = os.environ["PATH"]
def running(pid):
    try:
        with open("/proc/%d/stat" % pid) as fh:
            return fh.read().rsplit(")", 1)[1].split()[0] != "Z"
    except OSError:
        if os.path.isdir("/proc"):
            return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False
def left():
    deadline = time.time() + 3
    while True:
        alive = [pid for pid in map(int, open(pids).read().split()) if running(pid)]
        if not alive or time.time() > deadline:
            return len(alive)
        time.sleep(0.05)
line = b"before\n" + FRAME + b"\nafter\n"
os.environ["PATH"] = d + os.pathsep + PATH0
t0 = time.time()
o = subprocess.run(["cat"], input=line, capture_output=True, timeout=60).stdout.decode()
out["slow"] = {"s": time.time() - t0, "same": o == line.decode(), "canary": os.environ["CANARY"] in o,
               "failed": '"finding":"helper_failed"' in o, "around": "before\n" in o and o.endswith("after\n"),
               "started": len(open(pids).read().split()), "left": left()}
os.environ["PATH"] = PATH0
t0 = time.time()
o = subprocess.run(["cat"], input=line, capture_output=True, timeout=60).stdout.decode()
out["fast"] = {"s": time.time() - t0, "same": o == line.decode(), "canary": os.environ["CANARY"] in o,
               "failed": '"finding":"helper_failed"' in o, "blocked": "vantio_mcp_policy_block" in o}
`;

test("a helper that hangs is stopped after the timeout and no helper process is left running", { skip: !HAS_PY, timeout: 120000 }, async () => {
  const enforce = await runAgent(HANG_AGENT, true, { CANARY });
  assert.equal(enforce.out.slow.started, 2, "the slow node and its own child both started");
  assert.equal(enforce.out.slow.left, 0, "enforce: helper processes still running");
  assert.ok(enforce.out.slow.s >= 4.5 && enforce.out.slow.s < 15, `enforce waited ${enforce.out.slow.s}s`);
  assert.equal(enforce.out.slow.canary, false, "the frame reached the child");
  assert.equal(enforce.out.slow.failed && enforce.out.slow.around, true);
  // Negative case: a helper that answers in time is used as before.
  assert.equal(enforce.out.fast.failed, false);
  assert.equal(enforce.out.fast.blocked, true);
  assert.equal(enforce.out.fast.canary, false);
  assert.ok(enforce.out.fast.s < 4, `a working helper took ${enforce.out.fast.s}s`);

  const observe = await runAgent(HANG_AGENT, false, { CANARY });
  assert.equal(observe.out.slow.started, 2);
  assert.equal(observe.out.slow.left, 0, "observe: helper processes still running");
  assert.ok(observe.out.slow.s >= 4.5 && observe.out.slow.s < 15, `observe waited ${observe.out.slow.s}s`);
  assert.equal(observe.out.slow.same, true, "observe: bytes identical with a hung helper");
  assert.equal(observe.out.fast.same, true);
  assert.match(observe.log, /tools\/call/, "the working helper's record is logged");
});
