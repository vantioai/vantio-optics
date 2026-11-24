// VAN-394: a curl -K config or wget -i list that is a FIFO must not block the
// parent. The child reads it as usual.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INTERCEPTOR_PATH = join(__dirname, "..", "bin", "interceptor.cjs");
const has = (cmd) => {
  try {
    return spawnSync(cmd, ["--version"], { encoding: "utf8", timeout: 3000 }).status === 0;
  } catch {
    return false;
  }
};
const HAS_CURL = has("curl");
const HAS_WGET = has("wget");

function runAgent(script, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--require", INTERCEPTOR_PATH, "-e", script], {
      env: { PATH: process.env.PATH, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const killer = setTimeout(() => child.kill("SIGKILL"), 10000);
    child.on("close", (code, signal) => {
      clearTimeout(killer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function fifoScript(argvJson) {
  return `
const { spawn } = require("node:child_process");
const { writeFile } = require("node:fs");
const t0 = Date.now();
const child = spawn(${JSON.stringify(argvJson[0])}, ${JSON.stringify(argvJson.slice(1))}, { stdio: "ignore" });
const spawnMs = Date.now() - t0;
writeFile(process.env.FIFO, process.env.CONTENT, () => {});
child.on("exit", (code) => {
  process.stdout.write(JSON.stringify({ spawnMs, code }) + "\\n");
});
`;
}

async function check(tool, flag, content) {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/v1/fifo`;
  const dir = mkdtempSync(join(tmpdir(), "van394-"));
  const fifo = join(dir, "cfg");
  execFileSync("mkfifo", [fifo]);
  const home = mkdtempSync(join(tmpdir(), "van394-home-"));
  const argv = tool === "curl" ? ["curl", "-sS", "-o", "/dev/null", flag, fifo] : ["wget", "-q", "-O", "/dev/null", flag, fifo];
  try {
    const { code, signal, stdout, stderr } = await runAgent(fifoScript(argv), {
      VANTIO_HOME: home,
      VANTIO_TRACE_ID: `van394${tool}`,
      VANTIO_EXTRA_LLM_HOSTS: "127.0.0.1",
      FIFO: fifo,
      CONTENT: content(url),
    });
    assert.equal(signal, null, `the agent was killed: ${stderr}`);
    assert.equal(code, 0, `stderr: ${stderr} stdout: ${stdout}`);
    const out = JSON.parse(stdout.trim().split("\n").pop());
    assert.ok(out.spawnMs < 1000, `spawn took ${out.spawnMs} ms`);
    assert.equal(out.code, 0, `${tool} exit code`);
    assert.deepEqual(hits, ["/v1/fifo"], "the child read the whole config itself");
    // The URL is in the FIFO, which only the child may read, so the wrapper
    // cannot tell the host and records no call. The run file is still written.
    const file = join(home, "runs", `van394${tool}.json`);
    assert.ok(existsSync(file), "the run file is still written");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).calls, []);
  } finally {
    server.close();
  }
}

test("curl -K <fifo> does not block the parent", { skip: !HAS_CURL, timeout: 20000 }, async () => {
  await check("curl", "-K", (url) => `url = "${url}"\n`);
});

test("wget -i <fifo> does not block the parent", { skip: !HAS_WGET, timeout: 20000 }, async () => {
  await check("wget", "-i", (url) => `${url}\n`);
});
