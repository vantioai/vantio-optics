/**
 * The MCP handshake reports this package's own version (VAN-310).
 *
 * Clients and logs read `serverInfo.version` from `initialize` to tell which
 * build a user runs. It used to be a hard-coded "0.1.0" while the package was
 * 0.1.2. The server now reads it from package.json, and this test checks the
 * handshake through a real SDK client.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createOpticsMcpServer } from "../src/server.js";

const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const SOURCE = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

/** Throw unless a handshake's serverInfo names this package at its package.json version. */
export function assertHandshakeMatches(serverInfo, pkg) {
  assert.equal(serverInfo?.name, "vantio-optics", "serverInfo.name");
  assert.equal(serverInfo?.version, pkg.version, `handshake says ${serverInfo?.version}, package.json says ${pkg.version}`);
}

/** Semver string literals given as `version:` in a source file. */
export function hardCodedVersions(source) {
  return [...source.matchAll(/\bversion:\s*["'`](\d+\.\d+\.\d+[^"'`]*)["'`]/g)].map((m) => m[1]);
}

test("the initialize handshake reports the package.json version", async () => {
  const server = createOpticsMcpServer();
  const client = new Client({ name: "optics-mcp-version-test", version: "0.0.0" });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    assertHandshakeMatches(client.getServerVersion(), PKG);
  } finally {
    await client.close();
  }
});

test("src/server.js does not hard-code a version string", () => {
  assert.deepEqual(hardCodedVersions(SOURCE), []);
});

test("negative: a mismatched or missing version fails", () => {
  assert.throws(() => assertHandshakeMatches({ name: "vantio-optics", version: "0.1.0" }, { version: "0.1.2" }), /0\.1\.0.*0\.1\.2/);
  assert.throws(() => assertHandshakeMatches({ name: "vantio-optics" }, { version: "0.1.2" }));
  assert.throws(() => assertHandshakeMatches({ name: "vantio-gate", version: "0.1.2" }, { version: "0.1.2" }));
  assert.throws(() => assertHandshakeMatches(undefined, { version: "0.1.2" }));
  assert.doesNotThrow(() => assertHandshakeMatches({ name: "vantio-optics", version: "0.1.2" }, { version: "0.1.2" }));
  assert.deepEqual(hardCodedVersions('new McpServer({\n  name: "vantio-optics",\n  version: "0.1.0",\n});'), ["0.1.0"]);
  assert.deepEqual(hardCodedVersions("new McpServer({ name: 'x', version: '1.2.3-rc.1' })"), ["1.2.3-rc.1"]);
  assert.deepEqual(hardCodedVersions("new McpServer({ name: 'x', version: PACKAGE_VERSION })"), []);
  assert.deepEqual(hardCodedVersions("cli_version: log.cli_version,"), []);
});
