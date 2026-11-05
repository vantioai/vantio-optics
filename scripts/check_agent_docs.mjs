#!/usr/bin/env node
/**
 * Offline checker: AGENTS.md repo map paths, AGENTS.md command references,
 * and path-like backtick references in .cursor/rules must exist on disk.
 */
import fs from "node:fs";
import path from "node:path";

const REPO_MAP_HEADING = "## Repo map";
const COMMANDS_HEADING = "## Commands";

/** @param {string} agentsMd */
export function extractRepoMapPaths(agentsMd) {
  const start = agentsMd.indexOf(REPO_MAP_HEADING);
  const end = agentsMd.indexOf(COMMANDS_HEADING, start === -1 ? 0 : start);
  if (start === -1) {
    return [];
  }
  const section = end === -1 ? agentsMd.slice(start) : agentsMd.slice(start, end);
  const paths = [];
  const rowRe = /^\| `([^`]+)` \|/gm;
  for (const match of section.matchAll(rowRe)) {
    paths.push(match[1].trim());
  }
  return paths;
}

/** @param {string} agentsMd */
export function extractAgentsCommandRefs(agentsMd) {
  const start = agentsMd.indexOf(COMMANDS_HEADING);
  if (start === -1) {
    return { rootScripts: [], filterRuns: [], paths: [] };
  }
  let section = agentsMd.slice(start);
  const secretIdx = section.indexOf("Secret scan.");
  if (secretIdx !== -1) {
    section = section.slice(0, secretIdx);
  }

  const rootScripts = new Set();
  const filterRuns = [];
  const paths = new Set();

  for (const line of section.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("pnpm ") && !trimmed.includes("--filter")) {
      const m = trimmed.match(/^pnpm ([a-zA-Z0-9:_-]+)/);
      if (m) {
        rootScripts.add(m[1]);
      }
    }
    const filterRe =
      /pnpm --filter (@[\w/-]+) run ([a-zA-Z0-9:_-]+)/g;
    for (const m of trimmed.matchAll(filterRe)) {
      filterRuns.push({ filter: m[1], script: m[2] });
    }
    const discoverRe =
      /python3 -m unittest discover -s ([^\s]+) -t ([^\s]+)/;
    const dm = trimmed.match(discoverRe);
    if (dm) {
      paths.add(dm[1]);
      paths.add(dm[2]);
    }
  }

  return {
    rootScripts: [...rootScripts],
    filterRuns,
    paths: [...paths],
  };
}

/** @param {string} content */
export function extractRulesPathRefs(content) {
  const refs = [];
  const re = /`([^`\n]+)`/g;
  for (const match of content.matchAll(re)) {
    const value = match[1].trim();
    if (!looksLikeRepoPath(value)) {
      continue;
    }
    refs.push(value);
  }
  return refs;
}

/** @param {string} value */
function looksLikeRepoPath(value) {
  if (value.includes("/") || value.startsWith(".")) {
    return true;
  }
  if (/\.(md|mdc|yml|yaml|json|py|js|cjs|mjs|ts|txt|pem|sh)$/i.test(value)) {
    return true;
  }
  return false;
}

/** @param {string} repoRoot @param {string} rel */
function pathExists(repoRoot, rel) {
  const normalized = rel.replace(/\/+$/, "");
  const abs = path.join(repoRoot, normalized);
  try {
    fs.accessSync(abs);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} repoRoot */
function loadRootScripts(repoRoot) {
  const pkgPath = path.join(repoRoot, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  return pkg.scripts ?? {};
}

/** @param {string} repoRoot @param {string} filterName */
function loadFilteredPackageScripts(repoRoot, filterName) {
  const workspaceFile = path.join(repoRoot, "pnpm-workspace.yaml");
  const workspaceText = fs.readFileSync(workspaceFile, "utf8");
  const pkgDirs = [...workspaceText.matchAll(/^\s*-\s*['"]?([^'"\n]+)['"]?\s*$/gm)].map(
    (m) => m[1],
  );
  for (const dir of pkgDirs) {
    const pkgPath = path.join(repoRoot, dir, "package.json");
    if (!fs.existsSync(pkgPath)) {
      continue;
    }
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    if (pkg.name === filterName) {
      return pkg.scripts ?? {};
    }
  }
  return null;
}

/**
 * @param {string} repoRoot
 * @param {{ agentsMd?: string, rulesContents?: Record<string, string> }} [overrides]
 */
export function checkAgentDocs(repoRoot, overrides = {}) {
  const errors = [];
  const agentsPath = path.join(repoRoot, "AGENTS.md");
  const agentsMd =
    overrides.agentsMd ?? fs.readFileSync(agentsPath, "utf8");

  for (const rel of extractRepoMapPaths(agentsMd)) {
    if (!pathExists(repoRoot, rel)) {
      errors.push(`repo map: missing path ${rel}`);
    }
  }

  const cmdRefs = extractAgentsCommandRefs(agentsMd);
  const rootScripts = loadRootScripts(repoRoot);
  for (const name of cmdRefs.rootScripts) {
    if (name === "install") {
      continue;
    }
    if (!(name in rootScripts)) {
      errors.push(`commands: root package.json has no script "${name}"`);
    }
  }
  for (const { filter, script } of cmdRefs.filterRuns) {
    const scripts = loadFilteredPackageScripts(repoRoot, filter);
    if (scripts === null) {
      errors.push(`commands: no workspace package named ${filter}`);
    } else if (!(script in scripts)) {
      errors.push(`commands: ${filter} has no script "${script}"`);
    }
  }
  for (const rel of cmdRefs.paths) {
    if (!pathExists(repoRoot, rel)) {
      errors.push(`commands: missing path ${rel}`);
    }
  }

  let rulesContents = overrides.rulesContents;
  if (!rulesContents) {
    rulesContents = {};
    const rulesDir = path.join(repoRoot, ".cursor", "rules");
    for (const name of fs.readdirSync(rulesDir)) {
      if (!name.endsWith(".mdc")) {
        continue;
      }
      rulesContents[name] = fs.readFileSync(path.join(rulesDir, name), "utf8");
    }
  }

  for (const [file, content] of Object.entries(rulesContents)) {
    for (const rel of extractRulesPathRefs(content)) {
      if (!pathExists(repoRoot, rel)) {
        errors.push(`${file}: missing path ${rel}`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
