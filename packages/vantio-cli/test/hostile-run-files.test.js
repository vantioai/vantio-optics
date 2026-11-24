// VAN-395: run files from someone else must not inject markup into a proof,
// hang a reader, or be followed through a symlink.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, statSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const features = require("../bin/optics-features.cjs");

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, "..", "bin", "vantio.js");
const HAS_MKFIFO = process.platform !== "win32" && spawnSync("mkfifo", ["--help"]).error == null;

function runCli(args, env = {}, cwd = undefined) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd,
      env: { PATH: process.env.PATH, HOME: env.HOME, VANTIO_TELEMETRY_DISABLED: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function hostileHome() {
  const home = mkdtempSync(join(tmpdir(), "vantio-hostile-"));
  const dir = join(home, ".vantio", "runs");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "0xevil.json"), JSON.stringify({
    vantio_run_log: "1",
    trace_id: "0xevil",
    cli_version: "<script>v</script>",
    started_at: "2026-11-23T00:00:00.000Z",
    generated_at: "2026-11-23T00:00:01.000Z",
    summary: { total_calls: "<img src=x onerror=alert(1)>", total_bytes: 3 },
    calls: [{ hostname: "a`<b>`|x](javascript:1)", bytes: 3, ts: "t|`" }],
  }));
  return { home, dir };
}

describe("hostile run files", () => {
  test("the HTML proof escapes a string total_calls", async () => {
    const { home } = hostileHome();
    try {
      const out = join(home, "p.html");
      const result = await runCli(["prove", "--run=0xevil", `--out=${out}`], { HOME: home });
      assert.equal(result.code, 0, result.stderr);
      const html = readFileSync(out, "utf8");
      assert.doesNotMatch(html, /<img/);
      assert.doesNotMatch(html, /<script>v/);
      assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the Markdown proof cannot break out of a code span or a table cell", async () => {
    const { home } = hostileHome();
    try {
      const result = await runCli(["prove", "--run=0xevil", "--format=md"], { HOME: home });
      assert.equal(result.code, 0, result.stderr);
      const row = result.stdout.split("\n").find((line) => line.startsWith("| 1 |"));
      assert.ok(row, result.stdout);
      // Seven cells: every pipe inside a field is escaped.
      const edges = row.replace(/\\\\/g, "").replace(/\\\|/g, "").split("|").length - 1;
      assert.equal(edges, 8, row);
      // Outside code spans, no tag survives unescaped. Inside one it is plain text.
      const outsideCode = result.stdout.replace(/(^|[^\\])`[^`]*`/g, "$1");
      assert.doesNotMatch(outsideCode, /(^|[^\\])<(img|b|script)/);
      assert.match(row, /a\\`\\<b\\>\\`\\\|x\\\]\(javascript:1\)/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("ordinary values keep their code spans in the Markdown proof", async () => {
    const home = mkdtempSync(join(tmpdir(), "vantio-plain-"));
    const dir = join(home, ".vantio", "runs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "0xplain.json"), JSON.stringify({
      vantio_run_log: "1",
      trace_id: "0xplain",
      cli_version: "0.3.27",
      generated_at: "2026-11-23T00:00:01.000Z",
      calls: [{ hostname: "api.openai.com", bytes: 1200, ts: "2026-11-23T00:00:00.500Z", status: 200 }],
    }));
    try {
      const result = await runCli(["prove", "--run=0xplain", "--format=md"], { HOME: home });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /\| Trace ID \| `0xplain` \|/);
      assert.match(result.stdout, /\| 1 \| `api\.openai\.com` \| .* \| 200 \| 1,200 \| `2026-11-23T00:00:00\.500Z` \|/);
      assert.match(result.stdout, /Hosts: `api\.openai\.com`/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a FIFO in the runs folder is refused, not waited on", { skip: !HAS_MKFIFO }, async () => {
    const { home, dir } = hostileHome();
    try {
      spawnSync("mkfifo", [join(dir, "fifo.json")]);
      for (const args of [["prove", "--list"], ["discover"], ["coverage"], ["search", "x"], ["tail"]]) {
        const result = await runCli(args, { HOME: home });
        assert.equal(result.signal, null, `${args.join(" ")} hung`);
        assert.equal(result.code, 1, args.join(" "));
        assert.match(result.stderr, /fifo\.json: is not a regular file/, args.join(" "));
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a symlink in the runs folder is refused", { skip: process.platform === "win32" }, async () => {
    const { home, dir } = hostileHome();
    try {
      symlinkSync("/dev/zero", join(dir, "zero.json"));
      for (const args of [["prove", "--list"], ["discover"], ["coverage"]]) {
        const result = await runCli(args, { HOME: home });
        assert.equal(result.signal, null, `${args.join(" ")} did not finish`);
        assert.equal(result.code, 1, `${args.join(" ")} ${result.stderr}`);
        assert.match(result.stderr, /zero\.json: is a symbolic link/, args.join(" "));
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an explicit --from symlink to a run file still works", { skip: process.platform === "win32" }, async () => {
    const { home, dir } = hostileHome();
    try {
      const link = join(home, "link.json");
      symlinkSync(join(dir, "0xevil.json"), link);
      const result = await runCli(["prove", `--from=${link}`, "--json"], { HOME: home });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).trace_id, "0xevil");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an operator-named pipe is still read for --from and --allowlist", { skip: process.platform === "win32" }, () => {
    const { home, dir } = hostileHome();
    try {
      const allow = join(home, "allow.json");
      writeFileSync(allow, JSON.stringify({ schema: "vantio.optics.allowlist.v1", destinations: [] }));
      const env = { PATH: process.env.PATH, HOME: home, VANTIO_TELEMETRY_DISABLED: "1" };
      // `cat |` gives the CLI a real pipe on /dev/stdin.
      const fromPipe = spawnSync("bash", ["-c", 'cat "$2" | "$0" "$1" prove --from=/dev/stdin --json', process.execPath, CLI_PATH, join(dir, "0xevil.json")], { encoding: "utf8", env, timeout: 15000 });
      assert.equal(fromPipe.status, 0, fromPipe.stderr);
      assert.equal(JSON.parse(fromPipe.stdout).trace_id, "0xevil");
      const allowPipe = spawnSync("bash", ["-c", 'cat "$2" | "$0" "$1" coverage --json --allowlist=/dev/stdin', process.execPath, CLI_PATH, allow], { encoding: "utf8", env, timeout: 15000 });
      assert.equal(allowPipe.status, 0, allowPipe.stderr);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the proof file is owner-only and is not written through a symlink", { skip: process.platform === "win32" }, async () => {
    const { home } = hostileHome();
    try {
      const out = join(home, "proof.html");
      writeFileSync(out, "old", { mode: 0o644 });
      const first = await runCli(["prove", "--run=0xevil", `--out=${out}`], { HOME: home });
      assert.equal(first.code, 0, first.stderr);
      assert.equal(statSync(out).mode & 0o777, 0o600);
      assert.match(readFileSync(out, "utf8"), /<!DOCTYPE html>/);

      const victim = join(home, "victim.txt");
      writeFileSync(victim, "keep");
      const link = join(home, "linked.html");
      symlinkSync(victim, link);
      const second = await runCli(["prove", "--run=0xevil", `--out=${link}`], { HOME: home });
      assert.equal(second.code, 1);
      assert.match(second.stderr, /could not write/);
      assert.equal(readFileSync(victim, "utf8"), "keep");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the default proof file in the working folder is owner-only", async () => {
    const { home } = hostileHome();
    try {
      const result = await runCli(["prove", "--run=0xevil"], { HOME: home }, home);
      assert.equal(result.code, 0, result.stderr);
      const out = join(home, "vantio-proof-0xevil.html");
      assert.equal(existsSync(out), true);
      if (process.platform !== "win32") assert.equal(statSync(out).mode & 0o777, 0o600);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("readRecordFile reads a regular file and refuses other types and oversize files", () => {
    const home = mkdtempSync(join(tmpdir(), "vantio-reader-"));
    try {
      const plain = join(home, "plain.json");
      writeFileSync(plain, "{\"a\":1}");
      assert.equal(features.readRecordFile(plain), "{\"a\":1}");
      assert.equal(features.readRecordFile(plain, { nofollow: true }), "{\"a\":1}");
      assert.throws(() => features.readRecordFile(plain, { maxBytes: 3 }), (err) => err.code === "EFBIG");
      assert.throws(() => features.readRecordFile(home), (err) => err.code === "EFTYPE" || err.code === "EISDIR");
      assert.throws(() => features.readRecordFile(join(home, "missing.json")), (err) => err.code === "ENOENT");
      if (process.platform !== "win32") {
        const link = join(home, "link.json");
        symlinkSync(plain, link);
        assert.equal(features.readRecordFile(link), "{\"a\":1}");
        assert.throws(() => features.readRecordFile(link, { nofollow: true }), (err) => err.code === "ELOOP");
        assert.throws(() => features.readRecordFile("/dev/zero"), (err) => err.code === "EFTYPE");
        assert.throws(() => features.readRecordFile("/dev/zero", { explicit: true, maxBytes: 1 << 20 }), (err) => err.code === "EFBIG");
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
