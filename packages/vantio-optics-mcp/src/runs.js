/**
 * Local Optics run-log helpers (read-only).
 * Mirrors ~/.vantio/runs written by `vantio run` / interceptor.
 */
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { constants as bufferConstants } from "node:buffer";
import { homedir } from "node:os";
import { join } from "node:path";

// Largest run file read. It is the longest string Node can hold.
const RUN_FILE_MAX_BYTES = bufferConstants.MAX_STRING_LENGTH;

function fileError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// Open only a regular file, never through a symlink. O_NONBLOCK keeps a FIFO
// from blocking the open; the type check then refuses it.
function readRunFile(path, maxBytes = RUN_FILE_MAX_BYTES) {
  const link = lstatSync(path);
  if (link.isSymbolicLink()) throw fileError("ELOOP", "is a symbolic link");
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK || 0) | (fsConstants.O_NOFOLLOW || 0);
  const fd = openSync(path, flags);
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw fileError("EFTYPE", "is not a regular file");
    if (info.size > maxBytes) throw fileError("EFBIG", `is larger than ${maxBytes} bytes`);
    const chunks = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(1 << 20, maxBytes - total + 1));
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      total += read;
      if (total > maxBytes) throw fileError("EFBIG", `is larger than ${maxBytes} bytes`);
      chunks.push(read === chunk.length ? chunk : chunk.subarray(0, read));
    }
    return { text: Buffer.concat(chunks, total).toString("utf8"), mtimeMs: info.mtimeMs };
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// The calls of a run, keeping only entries that are objects.
export function runCalls(log) {
  return Array.isArray(log?.calls) ? log.calls.filter(isRecord) : [];
}

// The summary of a run when it is an object, else an empty object.
export function runSummary(log) {
  return isRecord(log?.summary) ? log.summary : {};
}

// Read one run file. Returns null for anything that is not a readable run log.
function readRunLog(path) {
  try {
    const { text, mtimeMs } = readRunFile(path);
    const log = JSON.parse(text);
    if (!isRecord(log) || log.vantio_run_log !== "1") return null;
    return { log, mtimeMs };
  } catch {
    return null;
  }
}

// Markdown text: a line break becomes a space, and each mark that can start
// inline markup, an HTML tag, or a table cell is escaped. Every backslash is
// escaped too, so an escaped pipe can never be turned back into a cell edge.
export function mdText(value) {
  return String(value ?? "").replace(/[\r\n]+/g, " ").replace(/[\\`*_[\]<>|~&!]/g, (ch) => `\\${ch}`);
}

// A code span only for text that needs no escaping; anything else is escaped text.
export function mdCode(value) {
  const text = String(value ?? "").replace(/[\r\n]+/g, " ");
  if (text && text.trim() === text && /^[^`|\\]*$/.test(text)) return `\`${text}\``;
  return mdText(text);
}

export function runsDir(root = process.env.VANTIO_HOME || join(homedir(), ".vantio")) {
  return join(root, "runs");
}

export function listRunLogs(dir = runsDir()) {
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }

  const entries = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      const read = readRunLog(path);
      if (!read) continue;
      const { log } = read;
      const calls = runCalls(log);
      const summary = runSummary(log);
      entries.push({
        path,
        trace_id: log.trace_id || name.replace(/\.json$/, ""),
        pid: log.pid ?? null,
        machine: log.machine ?? null,
        started_at: log.started_at ?? null,
        generated_at: log.generated_at ?? null,
        duration_ms: log.duration_ms ?? null,
        total_calls: summary.total_calls ?? calls.length,
        total_bytes: summary.total_bytes ?? calls.reduce((a, c) => a + (c.bytes || 0), 0),
        hosts: Array.isArray(summary.hosts)
          ? summary.hosts
          : [...new Set(calls.map((c) => c.hostname).filter(Boolean))],
        mtime_ms: read.mtimeMs,
      });
    } catch {
      // skip corrupt
    }
  }

  entries.sort((a, b) => (b.mtime_ms || 0) - (a.mtime_ms || 0));
  return entries;
}

function loaded(entry) {
  const read = readRunLog(entry.path);
  if (!read) return { error: "unreadable", message: `Run '${entry.trace_id}' could not be read. Use optics_list_runs.` };
  return { log: read.log, path: entry.path };
}

export function loadRun(traceOrPrefix, dir = runsDir()) {
  const entries = listRunLogs(dir);
  if (!entries.length) return { error: "no_runs", message: "No Optics run logs in ~/.vantio/runs/. Run: vantio run <agent>" };

  if (!traceOrPrefix || traceOrPrefix === "latest") {
    return loaded(entries[0]);
  }

  const needle = String(traceOrPrefix).replace(/^0x/i, "").toLowerCase();
  const matches = entries.filter((e) =>
    String(e.trace_id).toLowerCase().replace(/^0x/, "").includes(needle),
  );
  if (!matches.length) {
    return {
      error: "not_found",
      message: `No run matching '${traceOrPrefix}'. Use optics_list_runs.`,
    };
  }
  if (matches.length > 1 && matches[0].trace_id !== traceOrPrefix) {
    const exact = matches.find((m) => m.trace_id === traceOrPrefix);
    if (!exact) {
      return {
        error: "ambiguous",
        message: `'${traceOrPrefix}' matches ${matches.length} runs. Pass a longer trace_id.`,
        candidates: matches.slice(0, 8).map((m) => m.trace_id),
      };
    }
    return loaded(exact);
  }
  return loaded(matches[0]);
}

export function proveMarkdown(log) {
  const calls = runCalls(log);
  const summary = runSummary(log);
  const totalCalls = summary.total_calls ?? calls.length;
  const totalBytes = summary.total_bytes ?? calls.reduce((a, c) => a + (c.bytes || 0), 0);
  const hosts = Array.isArray(summary.hosts)
    ? summary.hosts
    : [...new Set(calls.map((c) => c.hostname).filter(Boolean))];

  const providers = Array.isArray(summary.providers)
    ? summary.providers
    : [...new Set(calls.map((c) => c.provider).filter(Boolean))];

  const rows = calls
    .map((c, i) => {
      const act = String(c.action || "OBSERVED").toUpperCase();
      const mp = [c.method, c.path].filter(Boolean).join(" ") || "—";
      const cells = [c.hostname || "—", c.provider || "—", mp, c.status ?? "—", c.duration_ms ?? "—", act, c.bytes ?? "—", c.ts || "—"];
      return `| ${i + 1} | ${cells.map(mdText).join(" | ")} |`;
    })
    .join("\n");

  return [
    "# Vantio Optics — Run Proof",
    "",
    "**Plane:** Observe (Vantio Optics) · **Workflow:** Sight Loop",
    "",
    "> Developer egress data log — metadata only. No prompts or completions.",
    "",
    "## Run",
    "",
    `| Field | Value |`,
    `| --- | --- |`,
    `| Trace ID | ${mdCode(log.trace_id || "—")} |`,
    `| Machine | ${mdText(log.machine || "—")} |`,
    `| PID | ${mdText(log.pid ?? "—")} |`,
    `| Node | ${mdText(log.node_version || "—")} |`,
    `| Platform | ${mdText(log.platform || "—")} ${mdText(log.arch || "")} |`,
    `| Started | ${mdText(log.started_at || "—")} |`,
    `| Duration | ${mdText(log.duration_ms != null ? `${log.duration_ms} ms` : "—")} |`,
    `| CLI | ${mdText(log.cli_version || "—")} |`,
    `| Schema | ${mdText(log.schema_version ?? 1)} |`,
    "",
    "## Summary",
    "",
    `- Total calls: **${mdText(totalCalls)}**`,
    `- Total bytes: **${mdText(Number(totalBytes).toLocaleString())}**`,
    `- Hosts: ${hosts.length ? hosts.map(mdCode).join(", ") : "—"}`,
    `- Providers: ${providers.length ? providers.map(mdCode).join(", ") : "—"}`,
    `- Errors / non-OK: **${mdText(summary.errors ?? 0)}**`,
    "",
    "## Calls",
    "",
    "| # | Host | Provider | Method path | Status | Duration ms | Action | Bytes | Timestamp |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    rows || "| — | — | — | — | — | — | — | — | — |",
    "",
    "## Residual (honest)",
    "",
    "Optics fills your data log on the attach path. Ungoverned paths (curl, raw sockets, unwrapped processes) stay silent. Upgrade to **Vantio Phantom Engine** ($799/node/mo) for Observe, Enforce, and Control on enrolled Linux hosts. [Enterprise](https://vantio.ai/enterprise) adds governance for larger teams.",
    "",
    "https://vantio.ai/optics · https://vantio.ai/pricing",
    "",
  ].join("\n");
}

export function discoverLocal(sinceMs = 7 * 24 * 60 * 60 * 1000, dir = runsDir()) {
  const cutoff = Date.now() - sinceMs;
  const hostMap = new Map();

  for (const entry of listRunLogs(dir)) {
    if ((entry.mtime_ms || 0) < cutoff) continue;
    const read = readRunLog(entry.path);
    if (!read) continue;
    for (const c of runCalls(read.log)) {
      const host = typeof c.hostname === "string" && c.hostname ? c.hostname : "unknown";
      const row = hostMap.get(host) || {
        hostname: host,
        calls: 0,
        observed: 0,
        allowed: 0,
        blocked: 0,
        redacted: 0,
        bytes: 0,
        last_seen: null,
      };
      row.calls += 1;
      row.bytes += Number.isFinite(c.bytes) ? c.bytes : 0;
      const act = String(c.action || "OBSERVED").toUpperCase();
      if (act.includes("BLOCK")) row.blocked += 1;
      else if (act.includes("REDACT")) row.redacted += 1;
      else if (act.includes("ALLOW")) row.allowed += 1;
      else row.observed += 1;
      const ts = c.ts || entry.generated_at || entry.started_at;
      if (ts && (!row.last_seen || ts > row.last_seen)) row.last_seen = ts;
      hostMap.set(host, row);
    }
  }

  return [...hostMap.values()].sort((a, b) => b.calls - a.calls);
}

export const UPGRADE_PATH = {
  brand: "Vantio Optics",
  plane: "Observe",
  workflow: "Sight Loop",
  fence: "This MCP is read-only. It cannot block, redact, cap spend, or change policy.",
  next: [
    {
      brand: "Vantio Phantom Engine",
      sku: "$799 / enrolled Linux node / month",
      workflow: "Rogue Reconciliation",
      unlocks: "Observe, Enforce, and Control on enrolled Linux hosts in one purchase — Rogue Reconciliation (patent pending)",
      url: "https://vantio.ai/phantom",
    },
    {
      brand: "Enterprise",
      sku: "Talk to sales",
      workflow: "Governance + proof at scale",
      unlocks: "Governance, compliance controls, and dedicated support for larger teams",
      url: "https://vantio.ai/enterprise",
    },
  ],
  pricing: "https://vantio.ai/pricing",
};
