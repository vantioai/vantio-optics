// VAN-382: CI and `pnpm test` run every root test, including ones added later.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GLOB = "node --test test/*.test.js";

function ciRepositoryTestsCommand() {
  const yml = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const match = /- name: Repository tests\n\s+run: (.+)\n/.exec(yml);
  assert.ok(match, "ci.yml has a Repository tests step");
  return match[1].trim();
}

test("the CI step runs every test/*.test.js file", () => {
  assert.equal(ciRepositoryTestsCommand(), GLOB);
});

test("pnpm test runs the same root tests as CI", () => {
  const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts;
  assert.ok(scripts.test.endsWith(`&& ${GLOB}`), scripts.test);
});

test("there is at least one root test for the glob to find", () => {
  const files = readdirSync(join(ROOT, "test")).filter((name) => name.endsWith(".test.js"));
  assert.ok(files.includes("llms-full.test.js"));
  assert.ok(files.includes("root-tests-run.test.js"));
});
