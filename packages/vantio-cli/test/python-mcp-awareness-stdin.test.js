// VAN-393: Python MCP awareness leaves non-MCP child stdin alone, and
// --mcp-enforce also covers communicate() and subprocess.run(input=...).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
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
    const { code, stdout, stderr } = await runCli(args, { HOME: home, FRAME, ...extraEnv });
    assert.equal(code, 0, stderr);
    const logPath = join(home, ".vantio", "mcp-observations.jsonl");
    return { out: result(stdout), log: existsSync(logPath) ? readFileSync(logPath, "utf8") : "" };
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
