# VAN-399: MCP awareness no longer records children that are not MCP servers

Branch `engineering/van-399-optics-cli-mcp-awareness-records-any`, from vantio-optics `main` at `8bee543`. Mirror: vantio-open-core PR on the same branch name. CLI source only. Nothing tagged or published.

## Finding

Found in this review and reproduced on `main` under `vantio run node` (awareness is on by default, observe mode):

- A child that prints three JSON log lines wrote 3 records to `~/.vantio/mcp-observations.jsonl`, and `vantio coverage --json` listed three `mcp (tool name not retained)` rows, `outside_authority`.
- 300 KB written to `cat`'s stdin with no newline wrote a `GAP` / `oversize` record for `cat`.
- A `cat` of a 400 KB file with stdout piped wrote a `GAP` / `oversize` record in the `server_to_client` direction.

`runtime.observeBuffer` returns a `LOG server_unlisted` record for any JSON object line, JSON-RPC or not, and observe mode treated every spawned child as an MCP server.

## What changed

- `packages/vantio-cli/bin/mcp-awareness-register.js`, observe path only: a child's stdio records are written only after the workload has sent that child a line that looks like JSON-RPC (the same `looksLikeJsonRpc` check the HTTP path uses). An MCP client always opens with `initialize`, so a real server is still recorded from its first frame. Bytes are still forwarded unchanged.
- Enforce mode (`--mcp-enforce`) is unchanged.

## Commands

Run on the working tree of this commit (base `8bee543`). Node 22, pnpm 11.13.0.

| Command | rc | Result |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | |
| CLI lint, optics-mcp lint, SDK typecheck, typecheck:test | 0 | |
| `pnpm --filter @vantio/cli run test` | 0 | 182 pass (main 179) |
| `pnpm --filter @vantio/optics-mcp run test` | 0 | 8 pass |
| `pnpm --filter @vantio/agent-sdk run test` | 0 | 42 pass |
| `pnpm --filter @vantio/agent-sdk run build` | 0 | |
| `node --test test/*.test.js` | 0 | 5 pass |
| Python SDK suite on 3.10, 3.11, 3.12 | 0 | 128 OK, 2 skipped each |
| AGENTS.md secret scan | 0 | no pattern matched |
| Drift check against the open-core mirror branch | 1 | only `packages/vantio-optics-mcp/src/server.js` (VAN-310, already on main) |

New tests (`packages/vantio-cli/test/mcp-awareness-non-mcp.test.js`, 3): JSON log lines from a child write no record and no coverage row; large output and large input without a newline write no gap; a real JSON-RPC exchange is still recorded in both directions.

Mutation check: with the register back on `main`, the first two tests fail; the exchange test (negative case) passes on both.

## Gaps

- CI did not run: the org billing lock.
- A server-to-client frame that arrives before the client's first frame is not recorded. The MCP spec has the client speak first.
- An MCP server driven by `os`-level writes to the pipe, not `child.stdin.write`, is not seen in observe mode (as before).
- Ships only at the next CLI release, with Zach's go.
