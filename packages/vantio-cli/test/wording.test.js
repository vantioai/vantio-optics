// Release wording guard (Quinn V205, VAN-58 item 3).
// `vantio prove` writes an unsigned local report, and `--mcp-enforce` acts only
// inside the program `vantio run` starts. Copy must not claim more.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(PKG, "bin", "vantio.js");

const OVERCLAIMS = [
  /self-contained proof/i,
  /auditor-ready proof/i,
  /\battested release\b/i,
  /\btwo-person approv/i,
];

export function overclaims(text) {
  return OVERCLAIMS.filter((re) => re.test(text)).map((re) => re.source);
}

function help(args) {
  const out = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return `${out.stdout}\n${out.stderr}`;
}

test("run help states the --mcp-enforce scope and that Node fails open", () => {
  const text = help(["--help"]);
  assert.match(text, /Applies only inside the program vantio run starts/);
  assert.match(text, /If the library does not load,\s+Node runs without it\./);
});

test("prove help and the package README call the report unsigned and make no proof claim", () => {
  const proveHelp = help(["prove", "--help"]);
  const readme = readFileSync(join(PKG, "README.md"), "utf8");
  assert.match(proveHelp, /unsigned local report/);
  assert.match(readme, /unsigned local report/);
  assert.deepEqual(overclaims(proveHelp), []);
  assert.deepEqual(overclaims(readme), []);
});

test("negative: the guard flags the retired wording", () => {
  const old = "generates a self-contained proof document for an attested release, two-person approved";
  assert.deepEqual(overclaims(old).length, 3);
});
