/**
 * Advisory floors for hono (4.13.16), @hono/node-server (2.1.6) and
 * @modelcontextprotocol/sdk (1.32.0). Mirror of vantio-open-core's
 * packages/vantio-gate-mcp/test/advisory_pins_hono.test.js (VAN-188,
 * VAN-306), for the one lockfile and one MCP package in this repository.
 *
 * hono before 4.13.16: GHSA-46wx-v44x-9hh2, GHSA-4h7h-rv7c-7m2v,
 * GHSA-4m76-xfj5-7975, GHSA-h7mg-cq63-vhpq, GHSA-3gg2-335m-rxc6 and older.
 * @hono/node-server before 2.1.6: GHSA-rmxm-3fg6-px4f, GHSA-jpvv-r467-5p4w
 * (its range now reaches 2.1.5), GHSA-qv5m-9pm6-hqp3 and older.
 * Both reach this package through @modelcontextprotocol/sdk, so Dependabot
 * cannot update them. @hono/node-server 2.x needs the SDK at 1.30 or later,
 * and the SDK itself is fixed in 1.32.0 (GHSA-46jr-4wx8-v453,
 * GHSA-22jm-h49p-29qw, GHSA-6qxp-vccf-f47h, GHSA-f897-62hf-6gxq,
 * GHSA-rvq5-wwqv-78pq, GHSA-6prh-2h8m-c8cw).
 *
 * pnpm-lock.yaml must resolve the floor or later.
 * Reads files only; no network.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const FLOORS = { hono: [4, 13, 16], "@hono/node-server": [2, 1, 6], "@modelcontextprotocol/sdk": [1, 32, 0] };
const SDK = "@modelcontextprotocol/sdk";
const MANIFEST = "packages/vantio-optics-mcp/package.json";

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

/** Lowest version a caret range allows. Only `^x.y.z` is accepted. */
export function caretFloor(spec) {
  const m = /^\^(\d+\.\d+\.\d+)$/.exec(spec ?? "");
  if (!m) throw new Error(`not a plain caret range: ${spec}`);
  return m[1];
}

for (const name of Object.keys(FLOORS)) {
  test(`pnpm-lock.yaml resolves ${name} ${FLOORS[name].join(".")} or later`, () => {
    const versions = pnpmLockVersions(readFileSync(join(REPO, "pnpm-lock.yaml"), "utf8"), name);
    assert.ok(versions.length >= 2, `pnpm-lock.yaml no longer resolves ${name}; update this test`);
    assert.deepEqual(vulnerable(name, versions), [], versions.join(", "));
  });
}

test(`${MANIFEST} asks for ${SDK} ${FLOORS[SDK].join(".")} or later`, () => {
  const spec = JSON.parse(readFileSync(join(REPO, MANIFEST), "utf8")).dependencies?.[SDK];
  assert.deepEqual(vulnerable(SDK, [caretFloor(spec)]), [], `${MANIFEST}: ${spec}`);
});

test("pnpm-workspace.yaml keeps the hono and @hono/node-server floors", () => {
  const text = readFileSync(join(REPO, "pnpm-workspace.yaml"), "utf8");
  assert.match(text, /^ {2}hono@<4\.13\.16: \^4\.13\.16$/m);
  assert.match(text, /^ {2}'@hono\/node-server@<2\.1\.6': \^2\.1\.6$/m);
});

test("negative: the checks reject the old versions", () => {
  const pnpm = [
    "packages:",
    "",
    "  '@hono/node-server@1.19.14':",
    "    resolution: {}",
    "",
    "  hono@4.13.13:",
    "    resolution: {}",
    "",
    "snapshots:",
    "",
    "  '@hono/node-server@1.19.14(hono@4.13.13)':",
    "    dependencies:",
    "      hono: 4.13.13",
    "",
    "  '@modelcontextprotocol/sdk@1.29.0':",
    "    dependencies:",
    "      '@hono/node-server': 1.19.14(hono@4.13.13)",
    "      hono: 4.13.13",
    "",
  ].join("\n");
  assert.deepEqual(vulnerable("hono", pnpmLockVersions(pnpm, "hono")), ["4.13.13", "4.13.13", "4.13.13"]);
  assert.deepEqual(vulnerable("@hono/node-server", pnpmLockVersions(pnpm, "@hono/node-server")), ["1.19.14", "1.19.14", "1.19.14"]);
  assert.deepEqual(vulnerable(SDK, pnpmLockVersions(pnpm, SDK)), ["1.29.0"]);
  assert.deepEqual(vulnerable("hono", ["4.13.16", "4.13.19", "5.0.0"]), []);
  assert.deepEqual(vulnerable("@hono/node-server", ["1.19.19", "2.1.2", "2.1.5", "2.1.6", "2.1.11"]), ["1.19.19", "2.1.2", "2.1.5"]);
  assert.deepEqual(vulnerable(SDK, ["1.31.0", "1.32.0", "1.32.1"]), ["1.31.0"]);
  assert.deepEqual(vulnerable(SDK, [caretFloor("^1.29.0")]), ["1.29.0"]);
  assert.deepEqual(vulnerable(SDK, [caretFloor("^1.32.0")]), []);
  assert.throws(() => caretFloor("~1.32.0"), /not a plain caret range/);
  assert.throws(() => caretFloor(">=1.32.0"), /not a plain caret range/);
  assert.throws(() => caretFloor(undefined), /not a plain caret range/);
  assert.throws(() => below("4.13", FLOORS.hono), /not a plain semver/);
});
