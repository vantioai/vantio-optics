import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkAgentDocs,
  extractRepoMapPaths,
} from "../scripts/check_agent_docs.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("AGENTS.md repo map and .cursor/rules paths and commands exist", () => {
  const result = checkAgentDocs(repoRoot);
  assert.equal(
    result.ok,
    true,
    result.errors.length ? result.errors.join("\n") : undefined,
  );
});

test("checker fails when repo map references a missing path", () => {
  const agentsMd = `# Agents\n\n${"## Repo map\n\n| Path | Role |\n| --- | --- |\n| `this/path/does/not/exist` | fake |\n\n## Commands\n"}`;
  const result = checkAgentDocs(repoRoot, { agentsMd, rulesContents: {} });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /missing path this\/path\/does\/not\/exist/);
});

test("extractRepoMapPaths ignores content after Commands", () => {
  const md = "## Repo map\n| `docs/` | docs |\n## Commands\n| `fake/` | ignore |\n";
  assert.deepEqual(extractRepoMapPaths(md), ["docs/"]);
});
