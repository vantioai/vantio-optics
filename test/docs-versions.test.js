// VAN-191: docs that name "this tree" versions must match the package files.
// Published versions cannot be read from this tree, so every doc that names
// one must agree with docs/products/optics/VERSION-METADATA.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function treeVersions(root) {
  const npm = (dir) => JSON.parse(readFileSync(path.join(root, dir, "package.json"), "utf8")).version;
  const toml = readFileSync(path.join(root, "packages/vantio-agent-sdk-py/pyproject.toml"), "utf8");
  const py = /^version = "([^"]+)"$/m.exec(toml);
  return {
    "@vantio/cli": npm("packages/vantio-cli"),
    "@vantio/agent-sdk": npm("packages/vantio-agent-sdk"),
    "@vantio/optics-mcp": npm("packages/vantio-optics-mcp"),
    "vantio-agent-sdk": py ? py[1] : null,
  };
}

// Rows of the publishing.md registry table: | `pkg` | registry | latest | this tree |
function publishingTreeRows(md) {
  const rows = {};
  for (const line of md.split("\n")) {
    const m = /^\| `([^`]+)` \| (npm|PyPI) \| ([^|]+) \| ([^|]+) \|$/.exec(line.trim());
    if (m) rows[m[1]] = m[4].trim();
  }
  return rows;
}

// INSTALLATION.md: the "Source in this commit" version under each "Package" row.
function installationSourceRows(md) {
  const rows = {};
  let pkg = null;
  for (const line of md.split("\n")) {
    const p = /^\| Package \| `([^`]+)` \|/.exec(line);
    if (p) pkg = p[1];
    const s = /^\| Source in this commit \| `([^`]+)`/.exec(line);
    if (s && pkg) rows[pkg] = s[1];
    if (line.startsWith("## ")) pkg = null;
  }
  return rows;
}

function mismatches(rows, versions) {
  return Object.entries(rows)
    .filter(([pkg, v]) => versions[pkg] !== v)
    .map(([pkg, v]) => `${pkg}: docs ${v}, tree ${versions[pkg]}`);
}

// Latest column of the same publishing.md table.
function publishingLatestRows(md) {
  const rows = {};
  for (const line of md.split("\n")) {
    const m = /^\| `([^`]+)` \| (npm|PyPI) \| ([^|]+) \| ([^|]+) \|$/.exec(line.trim());
    if (m) rows[m[1]] = m[3].trim();
  }
  return rows;
}

// INSTALLATION.md: the "Public version" under each "Package" row.
function installationPublicRows(md) {
  const rows = {};
  let pkg = null;
  for (const line of md.split("\n")) {
    const p = /^\| Package \| `([^`]+)` \|/.exec(line);
    if (p) pkg = p[1];
    const s = /^\| Public version \| `([^`]+)`/.exec(line);
    if (s && pkg) rows[pkg] = s[1];
    if (line.startsWith("## ")) pkg = null;
  }
  return rows;
}

// Manual README.md table: | `pkg` (registry) | **fresh install** | **this tree**. note |
function readmeRows(md) {
  const published = {};
  const tree = {};
  for (const line of md.split("\n")) {
    const m = /^\| `([^`]+)` \((npm|PyPI)\) \| \*\*([^*]+)\*\* \| \*\*([^*]+)\*\*/.exec(line.trim());
    if (m) {
      published[m[1]] = m[3];
      tree[m[1]] = m[4];
    }
  }
  return { published, tree };
}

// TELEMETRY.md names the current PyPI release in a sentence and in a heading.
function telemetryCurrentPython(md) {
  const found = [];
  for (const re of [/The current release is (\d+\.\d+\.\d+)\b/g, /^## Published Python (\d+\.\d+\.\d+) and this tree$/gm]) {
    for (const m of md.matchAll(re)) found.push(m[1]);
  }
  return found;
}

// VERSION-METADATA.json: published versions by package, npm and PyPI together.
function metadataPublished(meta) {
  return { ...meta.registry.npm, ...meta.registry.pypi };
}

// The text between the first pair of """ in a Python file.
function moduleDocstring(py) {
  const m = /"""([\s\S]*?)"""/.exec(py);
  return m ? m[1] : null;
}

function versionNumbers(text) {
  return text.match(/\b\d+\.\d+\.\d+\b/g) ?? [];
}

const read = (rel) => readFileSync(path.join(repoRoot, rel), "utf8");
const metadata = () => JSON.parse(read("docs/products/optics/VERSION-METADATA.json"));
const ALL = ["@vantio/agent-sdk", "@vantio/cli", "@vantio/optics-mcp", "vantio-agent-sdk"];

test("VERSION-METADATA.json source_tree names the versions in this tree", () => {
  const rows = metadata().source_tree;
  assert.deepEqual(Object.keys(rows).sort(), ALL);
  assert.deepEqual(mismatches(rows, treeVersions(repoRoot)), []);
});

test("manual README.md table names the versions in this tree and the published versions", () => {
  const { published, tree } = readmeRows(read("docs/products/optics/README.md"));
  assert.deepEqual(Object.keys(tree).sort(), ALL);
  assert.deepEqual(mismatches(tree, treeVersions(repoRoot)), []);
  assert.deepEqual(mismatches(published, metadataPublished(metadata())), []);
});

test("publishing.md and INSTALLATION.md name the published versions in VERSION-METADATA.json", () => {
  const published = metadataPublished(metadata());
  const latest = publishingLatestRows(read("docs/publishing.md"));
  assert.deepEqual(Object.keys(latest).sort(), ALL);
  assert.deepEqual(mismatches(latest, published), []);
  const pub = installationPublicRows(read("docs/products/optics/INSTALLATION.md"));
  assert.deepEqual(Object.keys(pub).sort(), ALL);
  assert.deepEqual(mismatches(pub, published), []);
});

test("TELEMETRY.md names the published Python version in VERSION-METADATA.json", () => {
  const found = telemetryCurrentPython(read("docs/products/optics/TELEMETRY.md"));
  assert.equal(found.length, 2);
  const want = metadataPublished(metadata())["vantio-agent-sdk"];
  assert.deepEqual(found, [want, want]);
});

test("the drift script header names no version number", () => {
  const doc = moduleDocstring(read("scripts/check_open_core_drift.py"));
  assert.ok(doc && doc.includes("docs/publishing.md"));
  assert.deepEqual(versionNumbers(doc), []);
});

test("a stale README row, published version, or header version is reported", () => {
  const versions = { "@vantio/cli": "0.3.27", "vantio-agent-sdk": "3.1.3" };
  const published = { "@vantio/cli": "0.3.27", "vantio-agent-sdk": "3.1.2" };
  const readme =
    "| `@vantio/cli` (npm) | **0.3.27** | **0.3.27**. note |\n" +
    "| `vantio-agent-sdk` (PyPI) | **3.1.1** | **3.1.2**. `pip install vantio-agent-sdk` installs 3.1.1. |\n";
  const rows = readmeRows(readme);
  assert.deepEqual(mismatches(rows.tree, versions), ["vantio-agent-sdk: docs 3.1.2, tree 3.1.3"]);
  assert.deepEqual(mismatches(rows.published, published), ["vantio-agent-sdk: docs 3.1.1, tree 3.1.2"]);
  assert.deepEqual(
    mismatches(publishingLatestRows("| `vantio-agent-sdk` | PyPI | 3.1.1 | 3.1.3 |\n"), published),
    ["vantio-agent-sdk: docs 3.1.1, tree 3.1.2"],
  );
  const install = "| Package | `vantio-agent-sdk` |\n| Public version | `3.1.1` (PyPI latest on 2026-10-21) |\n";
  assert.deepEqual(mismatches(installationPublicRows(install), published), ["vantio-agent-sdk: docs 3.1.1, tree 3.1.2"]);
  assert.deepEqual(
    telemetryCurrentPython("The current release is 3.1.1, described above.\n\n## Published Python 3.1.1 and this tree\n"),
    ["3.1.1", "3.1.1"],
  );
  const header = '#!/usr/bin/env python3\n"""Fail on drift.\n\n@vantio/cli 0.3.26 and vantio-agent-sdk 3.1.2 from sealed bytes.\n"""\nX = "9.9.9"\n';
  assert.deepEqual(versionNumbers(moduleDocstring(header)), ["0.3.26", "3.1.2"]);
});

test("text that is not a version row or a header is left alone", () => {
  assert.deepEqual(readmeRows("| `@vantio/cli` (npm) | 0.3.27 | 0.3.27 |\n"), { published: {}, tree: {} });
  assert.deepEqual(installationPublicRows("| Package | `@vantio/cli` |\n## Other\n| Public version | `9.9.9` |\n"), {});
  assert.deepEqual(telemetryCurrentPython("Pin `==3.0.14` to get it.\n## Older release: Python 3.0.14\n"), []);
  assert.equal(moduleDocstring("x = 1\n"), null);
  assert.deepEqual(versionNumbers('"""No numbers. See docs/publishing.md."""'), []);
});

test("publishing.md table names the versions in this tree", () => {
  const rows = publishingTreeRows(readFileSync(path.join(repoRoot, "docs/publishing.md"), "utf8"));
  assert.deepEqual(Object.keys(rows).sort(), ["@vantio/agent-sdk", "@vantio/cli", "@vantio/optics-mcp", "vantio-agent-sdk"]);
  assert.deepEqual(mismatches(rows, treeVersions(repoRoot)), []);
});

test("INSTALLATION.md 'Source in this commit' names the versions in this tree", () => {
  const rows = installationSourceRows(readFileSync(path.join(repoRoot, "docs/products/optics/INSTALLATION.md"), "utf8"));
  assert.deepEqual(Object.keys(rows).sort(), ["@vantio/cli", "vantio-agent-sdk"]);
  assert.deepEqual(mismatches(rows, treeVersions(repoRoot)), []);
});

test("a stale docs version is reported", () => {
  const versions = { "@vantio/cli": "0.3.27", "vantio-agent-sdk": "3.1.3" };
  const md = "| `@vantio/cli` | npm | 0.3.27 | 0.3.26 |\n| `vantio-agent-sdk` | PyPI | 3.1.2 | 3.1.2 |\n";
  assert.deepEqual(mismatches(publishingTreeRows(md), versions), [
    "@vantio/cli: docs 0.3.26, tree 0.3.27",
    "vantio-agent-sdk: docs 3.1.2, tree 3.1.3",
  ]);
  const install = "## Python SDK\n| Package | `vantio-agent-sdk` |\n| Source in this commit | `3.1.2`, not the PyPI package |\n";
  assert.deepEqual(mismatches(installationSourceRows(install), versions), ["vantio-agent-sdk: docs 3.1.2, tree 3.1.3"]);
});

test("a Source row under a later heading is not credited to the previous package", () => {
  const md = "| Package | `@vantio/cli` |\n## Other\n| Source in this commit | `9.9.9` |\n";
  assert.deepEqual(installationSourceRows(md), {});
});
