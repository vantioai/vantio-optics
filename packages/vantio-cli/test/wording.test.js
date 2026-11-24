// Release wording guard (Quinn V205/V206, VAN-58 item 3).
// `vantio prove` writes an unsigned local report, and `--mcp-enforce` acts only
// inside the Node or Python process `vantio run` starts. Copy must not claim more.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(PKG, "bin", "vantio.js");
// Present in vantio-open-core; vantio-optics does not carry docs/prove.md.
const PROVE_DOC = join(PKG, "..", "..", "docs", "prove.md");

const OVERCLAIMS = [
  /self-contained proof/i,
  /auditor-ready proof/i,
  /auditor-ready document/i,
  /\battested release\b/i,
  /\btwo-person approv/i,
  /children that inherit/i,
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
  assert.match(text, /withholds MCP stdio inside the Node or Python\s+process vantio run starts/);
  assert.match(text, /It does not cover other programs or other transports\./);
  assert.match(text, /If the Node library does not load, Node runs without it\./);
  assert.deepEqual(overclaims(text), []);
});

test("prove help and the package README call the report unsigned and make no proof claim", () => {
  const proveHelp = help(["prove", "--help"]);
  const readme = readFileSync(join(PKG, "README.md"), "utf8");
  assert.match(proveHelp, /unsigned local report/);
  assert.match(readme, /unsigned local report/);
  assert.match(readme, /It does not cover a Python child of a Node run/);
  assert.deepEqual(overclaims(proveHelp), []);
  assert.deepEqual(overclaims(readme), []);
});

test("docs/prove.md calls the report unsigned and makes no proof claim", (t) => {
  if (!existsSync(PROVE_DOC)) {
    t.skip("docs/prove.md is not in this repository");
    return;
  }
  const doc = readFileSync(PROVE_DOC, "utf8");
  assert.match(doc, /renders an unsigned local report\. The report is not signed and it does not use a key\./);
  assert.deepEqual(overclaims(doc), []);
});

test("negative: the guard flags the retired wording", () => {
  const old = "renders them as an auditor-ready document, a self-contained proof document for an attested release, two-person approved, and Node or Python children that inherit its environment";
  assert.equal(overclaims(old).length, 5);
});
