import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MANUAL_DIR, buildLlmsFull, checkLlmsFull, listedPages } from "../scripts/check_llms_full.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts", "check_llms_full.mjs");

function copyManual() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llms-full-"));
  fs.cpSync(path.join(repoRoot, MANUAL_DIR), dir, { recursive: true });
  return dir;
}

function read(dir) {
  return fs.readFileSync(path.join(dir, "llms-full.txt"), "utf8");
}

test("llms-full.txt matches the manual pages it copies", () => {
  const result = checkLlmsFull(repoRoot);
  assert.equal(result.ok, true, result.errors.join("\n"));
});

test("every .md page in the manual is listed", () => {
  const listed = new Set(listedPages(fs.readFileSync(path.join(repoRoot, MANUAL_DIR, "llms-full.txt"), "utf8")));
  const pages = fs.readdirSync(path.join(repoRoot, MANUAL_DIR)).filter((n) => n.endsWith(".md"));
  assert.ok(pages.length > 0);
  for (const page of pages) assert.ok(listed.has(page), page);
});

test("a changed page is drift, and the rebuilt text carries the change", () => {
  const dir = copyManual();
  const page = path.join(dir, "USER-MANUAL.md");
  fs.writeFileSync(page, fs.readFileSync(page, "utf8").replace("Optics observes.", "Optics observes, changed."));
  const result = buildLlmsFull(dir, read(dir));
  assert.equal(result.ok, false);
  assert.equal(result.drift, true);
  assert.match(result.errors.join("\n"), /differs from the pages/);
  assert.match(result.expected, /Optics observes, changed\./);
  assert.equal(buildLlmsFull(dir, result.expected).ok, true);
});

test("a listed page that does not exist fails, and cannot be rebuilt", () => {
  const dir = copyManual();
  fs.rmSync(path.join(dir, "QUICKSTART.md"));
  const result = buildLlmsFull(dir, read(dir));
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /QUICKSTART\.md is listed but/);
  assert.equal(result.expected, null);
});

test("a page that is not listed fails", () => {
  const dir = copyManual();
  fs.writeFileSync(path.join(dir, "NEW-PAGE.md"), "# New\n");
  const result = buildLlmsFull(dir, read(dir));
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /NEW-PAGE\.md is not in llms-full\.txt/);
});

test("a section name with a path is refused", () => {
  const dir = copyManual();
  const text = read(dir).replace("FILE: README.md\n", "FILE: ../../../README.md\n");
  const result = buildLlmsFull(dir, text);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /is not a page name/);
});

test("a file with no sections fails", () => {
  const dir = copyManual();
  const result = buildLlmsFull(dir, "no sections here\n");
  assert.equal(result.ok, false);
  assert.equal(result.expected, null);
});

test("the command exits 1 on drift, and --write fixes it", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "llms-repo-"));
  fs.mkdirSync(path.join(work, "scripts"));
  fs.copyFileSync(script, path.join(work, "scripts", "check_llms_full.mjs"));
  fs.cpSync(path.join(repoRoot, MANUAL_DIR), path.join(work, MANUAL_DIR), { recursive: true });
  const copy = path.join(work, "scripts", "check_llms_full.mjs");
  assert.equal(spawnSync(process.execPath, [copy]).status, 0);
  const page = path.join(work, MANUAL_DIR, "INSTALLATION.md");
  fs.appendFileSync(page, "\nOne more line.\n");
  const failed = spawnSync(process.execPath, [copy], { encoding: "utf8" });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /--write/);
  execFileSync(process.execPath, [copy, "--write"]);
  assert.equal(spawnSync(process.execPath, [copy]).status, 0);
});

test("a page listed twice fails", () => {
  const dir = copyManual();
  const text = read(dir);
  const result = buildLlmsFull(dir, text.replace("FILE: QUICKSTART.md\n", "FILE: README.md\n"));
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /README\.md is listed twice/);
});
