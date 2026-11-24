/**
 * Advisory floors for body-parser (2.4.0), fast-uri (3.1.9), ip-address
 * (10.7.4) and qs (6.16.1) (VAN-308). Mirror of vantio-open-core's
 * packages/vantio-gate-mcp/test/advisory_pins_transitive.test.js, for the one
 * lockfile in this repository.
 *
 * body-parser before 2.4.0: GHSA-27r3-jxmh-p828.
 * fast-uri before 3.1.9: GHSA-qw65-cvwx-89v3, GHSA-v2hh-gcrm-f6hx and 10 more.
 * ip-address before 10.7.4: GHSA-mwp4-54f8-5fhr, GHSA-rxp7-6hxx-x8q5 and 6 more.
 * qs before 6.16.1: GHSA-6pq8-jhm2-2vcw, GHSA-4mjr-xmp4-gh2g,
 * GHSA-x5fp-wj9c-mxmx.
 * All four reach @vantio/optics-mcp through @modelcontextprotocol/sdk, so
 * Dependabot cannot update them.
 *
 * pnpm-lock.yaml must resolve each floor or later, and pnpm-workspace.yaml
 * must keep the overrides. Reads files only; no network.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const FLOORS = {
  "body-parser": [2, 4, 0],
  "fast-uri": [3, 1, 9],
  "ip-address": [10, 7, 4],
  qs: [6, 16, 1],
};

function below(version, floor) {
  const parts = version.split(".").map((n) => Number.parseInt(n, 10));
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n))) {
    throw new Error(`not a plain semver: ${version}`);
  }
  for (let i = 0; i < 3; i += 1) {
    if (parts[i] !== floor[i]) return parts[i] < floor[i];
  }
  return false;
}

function escape(name) {
  return name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** Versions of `name` a pnpm-lock.yaml resolves (package keys, snapshot keys, snapshot deps). */
export function pnpmLockVersions(text, name) {
  const n = escape(name);
  const out = [];
  for (const m of text.matchAll(new RegExp(`^ {2}'?${n}@(\\d+\\.\\d+\\.\\d+)[(':]`, "gm"))) out.push(m[1]);
  for (const m of text.matchAll(new RegExp(`^ {6}'?${n}'?: (\\d+\\.\\d+\\.\\d+)`, "gm"))) out.push(m[1]);
  return out;
}

function vulnerable(name, versions) {
  return versions.filter((v) => below(v, FLOORS[name]));
}

for (const name of Object.keys(FLOORS)) {
  test(`pnpm-lock.yaml resolves ${name} ${FLOORS[name].join(".")} or later`, () => {
    const versions = pnpmLockVersions(readFileSync(join(REPO, "pnpm-lock.yaml"), "utf8"), name);
    assert.ok(versions.length >= 2, `pnpm-lock.yaml no longer resolves ${name}; update this test`);
    assert.deepEqual(vulnerable(name, versions), [], versions.join(", "));
  });
}

test("pnpm-workspace.yaml keeps the body-parser, fast-uri, ip-address and qs floors", () => {
  const text = readFileSync(join(REPO, "pnpm-workspace.yaml"), "utf8");
  for (const [name, floor] of Object.entries(FLOORS)) {
    const v = escape(floor.join("."));
    assert.match(text, new RegExp(`^ {2}'?${escape(name)}@<${v}'?: \\^${v}$`, "m"), name);
  }
});

test("negative: the checks reject the old versions", () => {
  const pnpm = [
    "packages:",
    "",
    "  body-parser@2.3.0:",
    "    resolution: {}",
    "",
    "  qs@6.15.3:",
    "    resolution: {}",
    "",
    "snapshots:",
    "",
    "  body-parser@2.3.0:",
    "    dependencies:",
    "      qs: 6.15.3",
    "",
    "  ajv@8.20.0:",
    "    dependencies:",
    "      fast-uri: 3.1.3",
    "",
    "  express-rate-limit@8.5.1(express@5.2.1):",
    "    dependencies:",
    "      ip-address: 10.2.0",
    "",
  ].join("\n");
  assert.deepEqual(vulnerable("body-parser", pnpmLockVersions(pnpm, "body-parser")), ["2.3.0", "2.3.0"]);
  assert.deepEqual(vulnerable("qs", pnpmLockVersions(pnpm, "qs")), ["6.15.3", "6.15.3"]);
  assert.deepEqual(vulnerable("fast-uri", pnpmLockVersions(pnpm, "fast-uri")), ["3.1.3"]);
  assert.deepEqual(vulnerable("ip-address", pnpmLockVersions(pnpm, "ip-address")), ["10.2.0"]);
  assert.deepEqual(vulnerable("body-parser", ["2.4.0", "2.4.1", "3.0.0"]), []);
  assert.deepEqual(vulnerable("fast-uri", ["3.1.8", "3.1.9", "3.2.0"]), ["3.1.8"]);
  assert.deepEqual(vulnerable("ip-address", ["10.7.3", "10.7.4", "10.7.6"]), ["10.7.3"]);
  assert.deepEqual(vulnerable("qs", ["6.16.0", "6.16.1", "6.17.1"]), ["6.16.0"]);
  assert.throws(() => below("6.16", FLOORS.qs), /not a plain semver/);
});
