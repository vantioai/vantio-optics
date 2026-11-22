import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLEANED, checkRetiredName, report } from "../scripts/check_retired_name.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIRST = CLEANED[0];
const OTHER = "fixture-only/other.md";
const KEPT = "gate-mcp-kept-name";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retired-name-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const relative of CLEANED) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, relative), path.join(root, relative));
  }
  return root;
}

function append(root, relative, text) {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.appendFileSync(path.join(root, relative), text);
  return fs.readFileSync(path.join(root, relative), "utf8").split(/\r?\n/).length - 1;
}

test("the cleaned files in this checkout have no hit", () => {
  const { code, text } = report(checkRetiredName(repoRoot));
  assert.equal(code, 0, text);
  assert.match(text, new RegExp(`files=${CLEANED.length} hits=0 cannot_read=0`));
});

test("the capitalised word fails", (t) => {
  const root = fixture(t);
  const line = append(root, FIRST, "\nPolicy lives in the Gate control plane.\n");
  const { code, text } = report(checkRetiredName(root));
  assert.equal(code, 1, text);
  assert.match(text, new RegExp(`FAIL ${FIRST}:${line}: capitalised`));
});

for (const word of ["vantio-gate", "VANTIO_GATE", "Vantio  gate"]) {
  test(`the prefixed name fails: ${word}`, (t) => {
    const root = fixture(t);
    const line = append(root, FIRST, `\nSee ${word} for policy.\n`);
    const { code, text } = report(checkRetiredName(root));
    assert.equal(code, 1, text);
    assert.match(text, new RegExp(`FAIL ${FIRST}:${line}: prefixed`));
  });
}

for (const word of ["gate-mcp", "gate on-prem", "gate_onprem"]) {
  test(`the component name fails: ${word}`, (t) => {
    const root = fixture(t);
    const line = append(root, FIRST, `\nRun the ${word} server.\n`);
    const { code, text } = report(checkRetiredName(root));
    assert.equal(code, 1, text);
    assert.match(text, new RegExp(`FAIL ${FIRST}:${line}: component`));
  });
}

test("ordinary English and COST-GATE pass", (t) => {
  const root = fixture(t);
  append(root, FIRST, "\nThe exit gate and the live gate stay. COST-GATE stays. A gated rollout.\n");
  const { code, text } = report(checkRetiredName(root));
  assert.equal(code, 0, text);
});

test("an allowed identifier passes only in its own file", (t) => {
  const root = fixture(t);
  const options = { cleaned: [...CLEANED, OTHER], allow: { [FIRST]: [KEPT] } };
  append(root, OTHER, "Plain text.\n");
  append(root, FIRST, `\nSet \`${KEPT}\` first.\n`);
  let result = report(checkRetiredName(root, options));
  assert.equal(result.code, 0, result.text);
  append(root, OTHER, `Set \`${KEPT}\` first.\n`);
  result = report(checkRetiredName(root, options));
  assert.equal(result.code, 1, result.text);
  assert.match(result.text, new RegExp(`FAIL ${OTHER}:2: component`));
});

test("other text on an allowed line still counts", (t) => {
  const root = fixture(t);
  const line = append(root, FIRST, `\nSet \`${KEPT}\` for the Gate plane.\n`);
  const { code, text } = report(checkRetiredName(root, { allow: { [FIRST]: [KEPT] } }));
  assert.equal(code, 1, text);
  assert.match(text, new RegExp(`FAIL ${FIRST}:${line}: capitalised`));
});

test("a missing cleaned file cannot run", (t) => {
  const root = fixture(t);
  fs.rmSync(path.join(root, FIRST));
  const { code, text } = report(checkRetiredName(root));
  assert.equal(code, 2, text);
  assert.match(text, new RegExp(`cannot run: ${FIRST}: missing`));
});
