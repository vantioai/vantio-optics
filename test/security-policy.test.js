// VAN-169: SECURITY.md is the same disclosure policy as vantio-open-core's.
// open-core is private, so its text is pinned here by sha256 and checked
// line by line. A new commitment (a response time, a bug bounty) fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policyPath = path.join(repoRoot, "SECURITY.md");

// sha256 of vantio-open-core main:SECURITY.md, last changed in cfd3839 (read 2026-11-21).
export const OPEN_CORE_POLICY_SHA256 = "e505f07b97b892bf0b1224489535f88728a94a2bb145a2160dae6bb9937560f2";

const PROMISES = [
  /\bbug bounty\b/i,
  /\bbounty\b/i,
  /\breward\b/i,
  /\bSLA\b/,
  /\bwithin \d+\s*(hours?|days?|business days?)\b/i,
  /\bwe will (respond|reply|fix|patch)\b/i,
  /\bguarantee/i,
];

export function policyProblems(text) {
  const problems = [];
  if (createHash("sha256").update(text).digest("hex") !== OPEN_CORE_POLICY_SHA256) {
    problems.push("SECURITY.md is not open-core's policy text");
  }
  if (!/\*\*security@vantio\.ai\*\*/.test(text)) {
    problems.push("reports do not go to security@vantio.ai");
  }
  if (!/Phantom Engine[^\n]*private\. Send those reports to security@vantio\.ai/.test(text)) {
    problems.push("Phantom Engine reports are not sent to security@vantio.ai");
  }
  if (!/We do not promise a response time\./.test(text)) {
    problems.push("the no-response-time line is missing");
  }
  for (const promise of PROMISES) {
    if (promise.test(text)) {
      problems.push(`SECURITY.md makes a commitment: ${promise}`);
    }
  }
  return problems;
}

const policy = readFileSync(policyPath, "utf8");

test("SECURITY.md is open-core's disclosure policy", () => {
  assert.deepEqual(policyProblems(policy), []);
});

test("a changed line is caught", () => {
  const changed = policy.replace("Send those reports to security@vantio.ai as well.", "Do not report those here.");
  assert.notEqual(changed, policy);
  assert.deepEqual(policyProblems(changed), [
    "SECURITY.md is not open-core's policy text",
    "Phantom Engine reports are not sent to security@vantio.ai",
  ]);
});

test("an invented response time or bounty is caught", () => {
  for (const extra of ["We reply within 2 business days.", "We run a bug bounty.", "We will fix every report."]) {
    const problems = policyProblems(`${policy}\n${extra}\n`);
    assert.ok(problems.includes("SECURITY.md is not open-core's policy text"), extra);
    assert.ok(problems.some((p) => p.startsWith("SECURITY.md makes a commitment")), extra);
  }
});

test("the old Optics wording, which sent Phantom Engine reports nowhere, fails", () => {
  const old = [
    "# Security Policy",
    "",
    "Report a suspected vulnerability in Vantio Optics here:",
    "",
    "- Email **security@vantio.ai** (preferred)",
    "- Or open a private GitHub Security Advisory on this repository, if that is enabled",
    "",
    "Do not open a public issue for an unfixed vulnerability. Do not attach secrets, customer data, prompts, or completions.",
    "",
    "We acknowledge reports when we can. We do not promise a response time.",
    "",
    "Phantom Engine source is private. Do not use this repository to disclose or contribute enforcement issues for Linux systems. The product page is [vantio.ai/phantom-engine](https://vantio.ai/phantom-engine).",
    "",
  ].join("\n");
  assert.deepEqual(policyProblems(old), [
    "SECURITY.md is not open-core's policy text",
    "Phantom Engine reports are not sent to security@vantio.ai",
  ]);
});
