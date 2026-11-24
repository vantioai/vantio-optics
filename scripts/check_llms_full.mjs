#!/usr/bin/env node
/**
 * docs/products/optics/llms-full.txt is a copy of every page in
 * docs/products/optics/, for AI assistants (VAN-382). This rebuilds it from
 * the pages, in the order the file already lists them, and fails when the
 * file differs, when a listed page is missing, or when a page is not listed.
 *
 *   node scripts/check_llms_full.mjs           check, exit 1 on drift
 *   node scripts/check_llms_full.mjs --write   rewrite llms-full.txt
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MANUAL_DIR = path.join("docs", "products", "optics");
const SEP = "=".repeat(72);
const SECTION_RE = new RegExp(`^${SEP}\\nFILE: (.+)\\n${SEP}\\n`, "gm");

/** Page names listed in llms-full.txt, in file order. */
export function listedPages(text) {
  return [...text.matchAll(SECTION_RE)].map((m) => m[1].trim());
}

/**
 * @param {string} manualDir absolute path of docs/products/optics
 * @param {string} current current llms-full.txt text
 * @returns {{ ok: boolean, errors: string[], drift: boolean, expected: string | null }}
 */
export function buildLlmsFull(manualDir, current) {
  const errors = [];
  const first = current.indexOf(`${SEP}\nFILE: `);
  if (first === -1) {
    return { ok: false, errors: ["llms-full.txt has no FILE sections"], drift: false, expected: null };
  }
  const names = listedPages(current);
  const seen = new Set();
  let out = current.slice(0, first);
  names.forEach((name, i) => {
    if (seen.has(name)) errors.push(`${name} is listed twice`);
    seen.add(name);
    if (name.includes("/") || name.includes("\\") || name.startsWith(".")) {
      errors.push(`${name} is not a page name in ${MANUAL_DIR}`);
      return;
    }
    const page = path.join(manualDir, name);
    if (!fs.existsSync(page)) {
      errors.push(`${name} is listed but ${MANUAL_DIR}/${name} does not exist`);
      return;
    }
    let body = fs.readFileSync(page, "utf8");
    if (!body.endsWith("\n")) body += "\n";
    out += `${SEP}\nFILE: ${name}\n${SEP}\n\n${body}${i < names.length - 1 ? "\n" : ""}`;
  });
  for (const entry of fs.readdirSync(manualDir).sort()) {
    if (entry.endsWith(".md") && !seen.has(entry)) {
      errors.push(`${MANUAL_DIR}/${entry} is not in llms-full.txt`);
    }
  }
  const drift = errors.length === 0 && out !== current;
  if (drift) {
    const a = current.split("\n");
    const b = out.split("\n");
    let line = 0;
    while (line < a.length && a[line] === b[line]) line += 1;
    errors.push(
      `llms-full.txt differs from the pages it copies, first at line ${line + 1}. Run: node scripts/check_llms_full.mjs --write`,
    );
  }
  // `expected` is only usable when every listed page exists and every page is listed.
  return { ok: errors.length === 0, errors, drift, expected: errors.length && !drift ? null : out };
}

/** @param {string} repoRoot */
export function checkLlmsFull(repoRoot) {
  const manualDir = path.join(repoRoot, MANUAL_DIR);
  const file = path.join(manualDir, "llms-full.txt");
  return buildLlmsFull(manualDir, fs.readFileSync(file, "utf8"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const result = checkLlmsFull(repoRoot);
  if (process.argv.includes("--write")) {
    if (result.expected === null) {
      for (const e of result.errors) console.error(e);
      process.exit(1);
    }
    fs.writeFileSync(path.join(repoRoot, MANUAL_DIR, "llms-full.txt"), result.expected);
    console.log("llms-full.txt rebuilt from the pages");
    process.exit(0);
  }
  if (!result.ok) {
    for (const e of result.errors) console.error(e);
    process.exit(1);
  }
  console.log("llms-full.txt matches the pages");
}
