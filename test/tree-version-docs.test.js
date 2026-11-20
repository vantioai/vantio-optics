// Quinn V212 (VAN-66, VAN-267): docs that say what "this tree" holds must name
// the versions in the package files, not the published ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(repoRoot, rel), "utf8");

function treeVersions() {
  const toml = read("packages/vantio-agent-sdk-py/pyproject.toml");
  return {
    cli: JSON.parse(read("packages/vantio-cli/package.json")).version,
    python: /^version = "([^"]+)"$/m.exec(toml)[1],
  };
}

// The CLI and Python versions each doc says this tree holds.
export function claims(files) {
  const out = [];
  const add = (file, kind, re, text) => {
    const found = [...text.matchAll(re)].map((m) => m[1]);
    if (found.length === 0) out.push({ file, kind, version: null });
    for (const version of found) out.push({ file, kind, version });
  };
  add("README.md", "cli", /This tree is `@vantio\/cli` (\d+\.\d+\.\d+)/g, files["README.md"]);
  add("README.md", "python", /This tree is `@vantio\/cli` [\d.]+ and `vantio-agent-sdk` (\d+\.\d+\.\d+)/g, files["README.md"]);
  add("CONTRIBUTING.md", "cli", /`@vantio\/cli` on npm\..*This tree: `(\d+\.\d+\.\d+)`/g, files["CONTRIBUTING.md"]);
  add("CONTRIBUTING.md", "python", /`vantio-agent-sdk` on PyPI\..*This tree: `(\d+\.\d+\.\d+)`/g, files["CONTRIBUTING.md"]);
  for (const f of ["QUICKSTART.md", "USER-MANUAL.md"]) {
    add(f, "cli", /This (?:git|source) tree is CLI (\d+\.\d+\.\d+)/g, files[f]);
    add(f, "python", /This (?:git|source) tree is CLI [\d.]+ and Python (\d+\.\d+\.\d+)/g, files[f]);
  }
  const meta = JSON.parse(files["VERSION-METADATA.json"]).source_tree || {};
  out.push({ file: "VERSION-METADATA.json", kind: "cli", version: meta["@vantio/cli"] ?? null });
  out.push({ file: "VERSION-METADATA.json", kind: "python", version: meta["vantio-agent-sdk"] ?? null });
  return out;
}

function wrong(found, versions) {
  return found.filter((c) => c.version !== versions[c.kind]).map((c) => `${c.file} ${c.kind}: ${c.version}`);
}

test("docs name the CLI and Python versions this tree holds", () => {
  const files = {
    "README.md": read("README.md"),
    "CONTRIBUTING.md": read("CONTRIBUTING.md"),
    "QUICKSTART.md": read("docs/products/optics/QUICKSTART.md"),
    "USER-MANUAL.md": read("docs/products/optics/USER-MANUAL.md"),
    "VERSION-METADATA.json": read("docs/products/optics/VERSION-METADATA.json"),
  };
  assert.deepEqual(wrong(claims(files), treeVersions()), []);
});

test("negative: a doc that names the published version as the tree is reported", () => {
  const files = {
    "README.md": "This tree's packages match the registry versions above.",
    "CONTRIBUTING.md": "| `@vantio/cli` on npm. Published: `0.3.27`. This tree: `0.3.27`. |\n| `vantio-agent-sdk` on PyPI. Published: `3.1.2`. This tree: `3.1.3`. |",
    "QUICKSTART.md": "This git tree is CLI 0.3.27 and Python 3.1.2.",
    "USER-MANUAL.md": "This source tree is CLI 0.3.28 and Python 3.1.3, which are not published.",
    "VERSION-METADATA.json": JSON.stringify({ source_tree: { "@vantio/cli": "0.3.27", "vantio-agent-sdk": "3.1.3" } }),
  };
  assert.deepEqual(wrong(claims(files), { cli: "0.3.28", python: "3.1.3" }), [
    "README.md cli: null",
    "README.md python: null",
    "CONTRIBUTING.md cli: 0.3.27",
    "QUICKSTART.md cli: 0.3.27",
    "QUICKSTART.md python: 3.1.2",
    "VERSION-METADATA.json cli: 0.3.27",
  ]);
});
