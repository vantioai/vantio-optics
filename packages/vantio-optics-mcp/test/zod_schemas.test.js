/**
 * Tool input schemas of @vantio/optics-mcp, seen through a real MCP client
 * (VAN-308, zod 4).
 *
 * server.test.js calls tool handlers directly, which skips argument
 * validation. These connect an SDK client over the in-memory transport, so
 * `tools/list` and `tools/call` go through the zod schemas the way a user's
 * client does. The checks hold on zod 3 and zod 4 alike: only the JSON shape
 * and error wording differ between them, and those are not asserted.
 * VANTIO_HOME points at an empty temporary directory, so no real runs are read.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createOpticsMcpServer } from "../src/server.js";

const ZOD_FLOOR = [4, 6, 6];
let home;
let savedHome;

before(() => {
  savedHome = process.env.VANTIO_HOME;
  home = mkdtempSync(join(tmpdir(), "optics-mcp-schema-"));
  process.env.VANTIO_HOME = home;
});

after(() => {
  if (savedHome === undefined) delete process.env.VANTIO_HOME;
  else process.env.VANTIO_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

async function connect() {
  const server = createOpticsMcpServer();
  const client = new Client({ name: "optics-mcp-schema-test", version: "0.0.0" });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, close: () => client.close() };
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  return { isError: result.isError === true, text: result.content?.[0]?.text ?? "" };
}

/** Assert a tools/call result is an argument validation error at `path`. */
export function assertRejected(result, path) {
  assert.equal(result.isError, true, `expected a validation error, got: ${result.text.slice(0, 200)}`);
  assert.match(result.text, /Input validation error/);
  assert.match(result.text, new RegExp(`at ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
}

test("the server runs on zod 4.6.6 or later", () => {
  const version = createRequire(import.meta.url)("zod/package.json").version;
  const parts = version.split(".").map((n) => Number.parseInt(n, 10));
  const low = parts.findIndex((n, i) => n !== ZOD_FLOOR[i]);
  assert.ok(low === -1 || parts[low] > ZOD_FLOOR[low], `zod ${version}`);
});

test("tools/list advertises the optics tool inputs", async () => {
  const { client, close } = await connect();
  try {
    const tools = Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t.inputSchema]));
    assert.deepEqual(Object.keys(tools).sort(), [
      "optics_discover_local",
      "optics_explain",
      "optics_get_run",
      "optics_list_runs",
      "optics_prove",
      "optics_upgrade_path",
    ]);
    for (const schema of Object.values(tools)) {
      assert.equal(schema.type, "object");
      assert.equal(schema.required, undefined, "every optics tool argument is optional");
    }
    const limit = tools.optics_list_runs.properties.limit;
    assert.equal(limit.type, "integer");
    assert.equal(limit.minimum, 1);
    assert.equal(limit.maximum, 100);
    assert.match(limit.description, /Max runs/);
    const days = tools.optics_discover_local.properties.since_days;
    assert.equal(days.type, "integer");
    assert.equal(days.minimum, 1);
    assert.equal(days.maximum, 90);
    assert.equal(tools.optics_get_run.properties.trace_id.type, "string");
    assert.equal(tools.optics_prove.properties.trace_id.type, "string");
    assert.equal(tools.optics_explain.properties.include_latest_run.type, "boolean");
    assert.deepEqual(tools.optics_upgrade_path.properties ?? {}, {});
  } finally {
    await close();
  }
});

test("tools/call accepts valid arguments", async () => {
  const { client, close } = await connect();
  try {
    for (const args of [{}, { limit: 1 }, { limit: 100 }]) {
      const listed = await call(client, "optics_list_runs", args);
      assert.equal(listed.isError, false, listed.text);
      assert.equal(JSON.parse(listed.text).count, 0);
    }
    const explained = await call(client, "optics_explain", { include_latest_run: false });
    assert.equal(explained.isError, false, explained.text);
  } finally {
    await close();
  }
});

test("negative: tools/call rejects bad arguments before the handler runs", async () => {
  const { client, close } = await connect();
  try {
    assertRejected(await call(client, "optics_list_runs", { limit: 0 }), "limit");
    assertRejected(await call(client, "optics_list_runs", { limit: 101 }), "limit");
    assertRejected(await call(client, "optics_list_runs", { limit: 1.5 }), "limit");
    assertRejected(await call(client, "optics_list_runs", { limit: "5" }), "limit");
    assertRejected(await call(client, "optics_discover_local", { since_days: 91 }), "since_days");
    assertRejected(await call(client, "optics_get_run", { trace_id: 7 }), "trace_id");
    assertRejected(await call(client, "optics_explain", { include_latest_run: "yes" }), "include_latest_run");
  } finally {
    await close();
  }
  assert.throws(() => assertRejected({ isError: false, text: "{}" }, "limit"));
  assert.throws(() => assertRejected({ isError: true, text: "Input validation error: ... at trace_id" }, "limit"));
});
