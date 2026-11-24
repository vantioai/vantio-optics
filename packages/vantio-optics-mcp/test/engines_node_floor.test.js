/**
 * Node floor for @vantio/optics-mcp (VAN-306). Mirror of vantio-open-core's
 * packages/vantio-gate-mcp/test/engines_node_floor.test.js, for the one
 * lockfile and one MCP package in this repository.
 *
 * @modelcontextprotocol/sdk pulls in @hono/node-server, and node-server 2.x
 * declares `engines.node >=20`. The manifest's `engines.node` floor must be at
 * least the floor node-server declares in pnpm-lock.yaml.
 *
 * Reads files only; no network.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const DEP = "@hono/node-server";
const MANIFEST = "packages/vantio-optics-mcp/package.json";

/** Lowest Node version a `>=X`, `>=X.Y` or `>=X.Y.Z` range allows, as [major, minor, patch]. */
export function rangeFloor(range) {
  const m = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(typeof range === "string" ? range.trim() : "");
  if (!m) throw new Error(`not a plain >= range: ${range}`);
  return [m[1], m[2] ?? "0", m[3] ?? "0"].map((n) => Number.parseInt(n, 10));
}

/** True when floor `a` is lower than floor `b`. */
export function lower(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

/** `engines.node` of every `name@x.y.z` entry in the `packages:` section of a pnpm-lock.yaml. */
export function pnpmLockEngines(text, name) {
  const n = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const out = [];
  for (const m of text.matchAll(new RegExp(`^ {2}'?${n}@\\d+\\.\\d+\\.\\d+'?:\\n((?: {4}.*\\n)*)`, "gm"))) {
    const engines = /^ {4}engines: \{node: '([^']+)'\}$/m.exec(m[1]);
    out.push(engines ? engines[1] : undefined);
  }
  return out;
}

test(`pnpm-lock.yaml records ${DEP} with a plain engines.node floor`, () => {
  const ranges = pnpmLockEngines(readFileSync(join(REPO, "pnpm-lock.yaml"), "utf8"), DEP);
  assert.ok(ranges.length > 0, `pnpm-lock.yaml no longer resolves ${DEP}; update this test`);
  for (const range of ranges) assert.doesNotThrow(() => rangeFloor(range), String(range));
});

test(`${MANIFEST} engines.node is at least what ${DEP} needs`, () => {
  const own = JSON.parse(readFileSync(join(REPO, MANIFEST), "utf8")).engines?.node;
  const floor = rangeFloor(own);
  for (const range of pnpmLockEngines(readFileSync(join(REPO, "pnpm-lock.yaml"), "utf8"), DEP)) {
    assert.ok(!lower(floor, rangeFloor(range)), `${MANIFEST} says ${own}, but pnpm-lock.yaml has ${DEP} needing ${range}`);
  }
});

test("negative: a floor below the dependency's is caught, and odd ranges are refused", () => {
  assert.equal(lower(rangeFloor(">=18.3.0"), rangeFloor(">=20")), true);
  assert.equal(lower(rangeFloor(">=19.9.9"), rangeFloor(">=20")), true);
  assert.equal(lower(rangeFloor(">=20"), rangeFloor(">=20.1")), true);
  assert.equal(lower(rangeFloor(">=20"), rangeFloor(">=20")), false);
  assert.equal(lower(rangeFloor(">=20.0.0"), rangeFloor(">= 20")), false);
  assert.equal(lower(rangeFloor(">=22"), rangeFloor(">=20")), false);
  assert.deepEqual(rangeFloor(">= 18"), [18, 0, 0]);
  assert.throws(() => rangeFloor("^20.19.0 || >=22.12.0"), /not a plain >= range/);
  assert.throws(() => rangeFloor("20"), /not a plain >= range/);
  assert.throws(() => rangeFloor(undefined), /not a plain >= range/);

  const pnpm = [
    "packages:",
    "",
    "  '@hono/node-server@2.1.5':",
    "    resolution: {integrity: sha512-x}",
    "    engines: {node: '>=20'}",
    "    peerDependencies:",
    "      hono: ^4.13.16",
    "",
    "  '@hono/node-server@9.9.9':",
    "    resolution: {integrity: sha512-y}",
    "",
    "  hono@4.13.19:",
    "    resolution: {integrity: sha512-z}",
    "    engines: {node: '>=16.9.0'}",
    "",
    "snapshots:",
    "",
    "  '@hono/node-server@2.1.5(hono@4.13.19)':",
    "    dependencies:",
    "      hono: 4.13.19",
    "",
  ].join("\n");
  assert.deepEqual(pnpmLockEngines(pnpm, DEP), [">=20", undefined]);
  assert.throws(() => rangeFloor(pnpmLockEngines(pnpm, DEP)[1]), /not a plain >= range/);
  assert.equal(lower(rangeFloor(">=18.3.0"), rangeFloor(pnpmLockEngines(pnpm, DEP)[0])), true);
});
