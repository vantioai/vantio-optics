#!/usr/bin/env node
/**
 * Offline check: the retired product name stays out of the files cleaned for
 * VAN-347. Only the files in CLEANED are read, as text.
 *
 *   node scripts/check_retired_name.mjs
 *
 * Three patterns count as the retired name:
 *   capitalised  the word with a capital G and nothing else capitalised
 *                (ordinary English "gate" and names such as COST-GATE do not
 *                match)
 *   prefixed     the company name followed by the word, any case, with a
 *                space, hyphen or underscore between them
 *   component    the word followed by "mcp" or "on-prem"/"onprem", any case
 *
 * ALLOW lists text kept on purpose in a given file. That text is cut from the
 * line before the patterns run, so anything else on the same line still
 * counts.
 *
 * Exit 0: every listed file was read and none has a hit. Exit 1: at least one
 * hit, each printed as `FAIL path:line: pattern`. Exit 2: no hit, and a listed
 * file is missing. Exit 2 is not a pass.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PATTERNS = [
  ["capitalised", /\bGate\b/],
  ["prefixed", /vantio[\s_-]*gate/i],
  ["component", /\bgate[\s_-]*(?:mcp|on-?prem)/i],
];

export const CLEANED = [
  "docs/observe-only.md",
  "docs/products/optics/CHANGELOG-GUIDE.md",
  "docs/products/optics/llms-full.txt",
];

/** Kept on purpose, per file. Nothing is kept in the files cleaned so far. */
export const ALLOW = {};

/**
 * @param {string} root
 * @param {{ cleaned?: string[], allow?: Record<string, string[]> }} [options]
 */
export function checkRetiredName(root, options = {}) {
  const cleaned = options.cleaned ?? CLEANED;
  const allow = options.allow ?? ALLOW;
  const hits = [];
  const problems = [];
  for (const relative of cleaned) {
    let text;
    try {
      text = fs.readFileSync(path.join(root, relative), "utf8");
    } catch {
      problems.push(`${relative}: missing`);
      continue;
    }
    const kept = allow[relative] ?? [];
    text.split(/\r?\n/).forEach((original, index) => {
      let line = original;
      for (const item of kept) {
        line = line.split(item).join("");
      }
      for (const [name, pattern] of PATTERNS) {
        if (pattern.test(line)) {
          hits.push(`${relative}:${index + 1}: ${name}`);
        }
      }
    });
  }
  return { files: cleaned.length, hits, problems };
}

/** @param {{ files: number, hits: string[], problems: string[] }} result */
export function report(result) {
  const lines = [
    `retired-name files=${result.files} hits=${result.hits.length} cannot_read=${result.problems.length}`,
    ...result.hits.map((hit) => `FAIL ${hit}`),
    ...result.problems.map((problem) => `cannot run: ${problem}`),
  ];
  const code = result.hits.length ? 1 : result.problems.length ? 2 : 0;
  return { code, text: lines.join("\n") };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { code, text } = report(checkRetiredName(root));
  console.log(text);
  process.exit(code);
}
