// VAN-191: docs that name "this tree" versions must match the package files.
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
