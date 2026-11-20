/**
 * Advisory floor for zod (4.6.6) in @vantio/optics-mcp (VAN-308). Mirror of
 * vantio-open-core's packages/vantio-gate-mcp/test/advisory_pins_zod.test.js,
 * for the one lockfile and one MCP package in this repository.
 *
 * zod before 4.6.6: GHSA-mrhx-c7xc-m3w5. There is no fixed zod 3 release, so
 * the package moved from `zod ^3.25.0` to `^4.6.6`.
 * @modelcontextprotocol/sdk 1.32 accepts it (`zod: ^3.25 || ^4.0`).
 *
 * pnpm-lock.yaml must resolve the floor or later, the manifest must ask for
 * it, and the server may not use the one-argument `z.record(value)` form,
 * which zod 4 keeps only as an untyped v3-compat shim.
 * Reads files only; no network.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const DIR = "packages/vantio-optics-mcp";
const FLOOR = [4, 6, 6];

function below(version, floor = FLOOR) {
  const parts = version.split(".").map((n) => Number.parseInt(n, 10));
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n))) {
    throw new Error(`not a plain semver: ${version}`);
  }
  for (let i = 0; i < 3; i += 1) {
    if (parts[i] !== floor[i]) return parts[i] < floor[i];
  }
  return false;
}

/**
 * Versions of zod a pnpm-lock.yaml resolves: package and snapshot keys,
 * snapshot dependencies, importer versions, and peer suffixes like `(zod@x)`.
 */
export function pnpmLockZod(text) {
  const out = [];
  for (const m of text.matchAll(/^ {2}'?zod@(\d+\.\d+\.\d+)[(':]/gm)) out.push(m[1]);
  for (const m of text.matchAll(/^ {6}zod: (\d+\.\d+\.\d+)/gm)) out.push(m[1]);
  for (const m of text.matchAll(/^ {6}zod:\n {8}specifier: .*\n {8}version: (\d+\.\d+\.\d+)/gm)) out.push(m[1]);
  for (const m of text.matchAll(/\(zod@(\d+\.\d+\.\d+)\)/g)) out.push(m[1]);
  return out;
}

/** Lowest version a caret range allows. Only `^x.y.z` is accepted. */
export function caretFloor(spec) {
  const m = /^\^(\d+\.\d+\.\d+)$/.exec(spec ?? "");
  if (!m) throw new Error(`not a plain caret range: ${spec}`);
  return m[1];
}

/** Calls of the one-argument `z.record(...)` form in a source file. */
export function oneArgRecords(source) {
  const out = [];
  for (const m of source.matchAll(/\bz\.record\(/g)) {
    let depth = 1;
    let commas = 0;
    let i = m.index + m[0].length;
    for (; i < source.length && depth > 0; i += 1) {
      const c = source[i];
      if (c === "(" || c === "[" || c === "{") depth += 1;
      else if (c === ")" || c === "]" || c === "}") depth -= 1;
      else if (c === "," && depth === 1) commas += 1;
    }
    if (commas === 0) out.push(source.slice(m.index, i));
  }
  return out;
}

test(`pnpm-lock.yaml resolves zod ${FLOOR.join(".")} or later`, () => {
  const versions = pnpmLockZod(readFileSync(join(REPO, "pnpm-lock.yaml"), "utf8"));
  assert.ok(versions.length >= 4, `pnpm-lock.yaml no longer resolves zod; update this test`);
  assert.deepEqual(versions.filter((v) => below(v)), [], versions.join(", "));
});

test(`${DIR}/package.json asks for zod ${FLOOR.join(".")} or later`, () => {
  const spec = JSON.parse(readFileSync(join(REPO, DIR, "package.json"), "utf8")).dependencies?.zod;
  assert.equal(below(caretFloor(spec)), false, `zod ${spec}`);
});

test(`${DIR}/src uses the two-argument z.record form`, () => {
  assert.deepEqual(oneArgRecords(readFileSync(join(REPO, DIR, "src/server.js"), "utf8")), []);
});

test("negative: the checks reject zod 3, old ranges and the one-argument record", () => {
  const pnpm = [
    "importers:",
    "",
    "  packages/vantio-optics-mcp:",
    "    dependencies:",
    "      zod:",
    "        specifier: ^3.25.0",
    "        version: 3.25.76",
    "",
    "packages:",
    "",
    "  zod-to-json-schema@3.25.2:",
    "    resolution: {}",
    "",
    "  zod@3.25.76:",
    "    resolution: {}",
    "",
    "snapshots:",
    "",
    "  '@modelcontextprotocol/sdk@1.32.1(zod@3.25.76)':",
    "    dependencies:",
    "      zod: 3.25.76",
    "      zod-to-json-schema: 3.25.2(zod@3.25.76)",
    "",
  ].join("\n");
  assert.deepEqual(pnpmLockZod(pnpm).filter((v) => below(v)), ["3.25.76", "3.25.76", "3.25.76", "3.25.76", "3.25.76"]);
  assert.equal(below(caretFloor("^3.25.0")), true);
  assert.equal(below(caretFloor("^4.0.0")), true);
  assert.equal(below(caretFloor("^4.6.6")), false);
  assert.equal(below("4.6.7"), false);
  assert.equal(below("5.0.0"), false);
  assert.throws(() => caretFloor("^3.25 || ^4.0"), /not a plain caret range/);
  assert.throws(() => caretFloor(undefined), /not a plain caret range/);
  assert.deepEqual(oneArgRecords("p: z.record(z.unknown()).describe('x'),"), ["z.record(z.unknown())"]);
  assert.deepEqual(oneArgRecords("p: z.record(z.object({ a: z.string(), b: z.number() })),"), [
    "z.record(z.object({ a: z.string(), b: z.number() }))",
  ]);
  assert.deepEqual(oneArgRecords("p: z.record(z.string(), z.unknown()),"), []);
  assert.deepEqual(oneArgRecords("p: z.record(\n  z.string(),\n  z.array(z.number()),\n),"), []);
});
