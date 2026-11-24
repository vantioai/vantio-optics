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
