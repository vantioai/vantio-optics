# VAN-405: an MCP request sent with fetch is checked wherever its "jsonrpc" key is

Branch `engineering/van-405-optics-cli-an-mcp-request-sent-with`, from vantio-optics `main` at `8bee543`. Mirror: vantio-open-core PR on the same branch name, from `1beaf36`. CLI source only. Nothing tagged or published.

## Finding

Found in the Nov 24 review. `looksLikeJsonRpc()` in `packages/vantio-cli/bin/mcp-awareness-register.js` decides whether a `fetch` body is an MCP message. It looked for `"jsonrpc":` in the first 256 bytes only. The MCP TypeScript SDK writes a request as `{"method":..., "params":{...}, "jsonrpc":"2.0", "id":N}` (checked in `@modelcontextprotocol/sdk` 1.32.1, `shared/protocol.js`), so a request with larger params was not treated as MCP. A JSON-RPC batch (an array) never was.

Reproduced on `main`: an agent under `vantio run --mcp-enforce` posts a `tools/call` in the SDK's field order to an unlisted MCP server. With a 10-byte argument it is withheld (`server_unlisted`) and recorded. With a 400-byte argument it is forwarded and nothing is recorded.

## What changed

`looksLikeJsonRpc()` now:

- returns false at once when the body does not contain `"jsonrpc"` (no parse for ordinary bodies);
- parses the body and returns true for an object with a top-level `jsonrpc` key, or a batch holding one;
- for a body that does not parse, keeps the old rule (`{` first and `"jsonrpc":` in the first 256 bytes), so a malformed message still reaches the policy.

A prompt that only mentions `"jsonrpc"` inside its text is not an MCP message. A batch now reaches the policy, which already answers it with GAP `batch_rejected` (so `--mcp-enforce` withholds it, as on stdio). Bodies over 256 KiB are unchanged (VAN-406 asks Zach).

## Tests

`packages/vantio-cli/test/mcp-fetch-detect.test.js` (6), each an agent under `vantio run`:

- a short request is withheld under `--mcp-enforce` (negative case, unchanged);
- a request whose `jsonrpc` key is past byte 256 is withheld and recorded;
- the same request in observe mode is sent and both directions are recorded;
- a batch reaches the policy and is withheld with `batch_rejected`;
- an LLM request that mentions `{"jsonrpc": ...}` in a message is sent, with no record (negative case);
- a text body that is not JSON is sent, with no record (negative case).

Mutation check: with `mcp-awareness-register.js` back on `main`, the three new cases fail and the three negative cases pass.

## Commands

Run on the working tree of this commit. Node 22.23.5, pnpm 11.13.0.

**vantio-optics**

| Command | rc | Result |
| --- | --- | --- |
| `corepack pnpm install --frozen-lockfile` | 0 |  |
| `pnpm --filter @vantio/cli run lint` | 0 |  |
| `pnpm --filter @vantio/optics-mcp run lint` | 0 |  |
| `pnpm --filter @vantio/agent-sdk run typecheck` | 0 |  |
| `pnpm --filter @vantio/agent-sdk run typecheck:test` | 0 |  |
| `pnpm --filter @vantio/cli run test` | 0 | 185 pass, 0 fail |
| `pnpm --filter @vantio/optics-mcp run test` | 0 | 8 pass, 0 fail |
| `pnpm --filter @vantio/agent-sdk run test` | 0 | 42 pass, 0 fail |
| `pnpm --filter @vantio/agent-sdk run build` | 0 |  |
| `node --test test/*.test.js` | 0 | 5 pass, 0 fail |
| `node scripts/check_llms_full.mjs` | absent |  |
| Python 3.10 `-m unittest discover -s packages/vantio-agent-sdk-py/tests -t packages/vantio-agent-sdk-py` | 0 | 128 run, OK (skipped=2) |
| Python 3.11, same suite | 0 | 128 run, OK (skipped=2) |
| Python 3.12, same suite | 0 | 128 run, OK (skipped=2) |
| secret scan (`git grep` patterns from the repo rules) | 0 |  |
| `llms-full.txt` against the manual pages | 0 |  |
| `python3 scripts/check_open_core_drift.py <open-core mirror worktree>` | 1 | (only `packages/vantio-optics-mcp/src/server.js`, the known VAN-310 drift) |

**vantio-open-core mirror**

| Command | rc | Result |
| --- | --- | --- |
| `corepack pnpm install --frozen-lockfile` | 0 |  |
| `pnpm --filter @vantio/cli run lint` | 0 |  |
| `pnpm --filter @vantio/cli run test` | 0 | 185 pass, 0 fail |
| `pnpm --filter @vantio/optics-mcp run lint` | 0 |  |
| `pnpm --filter @vantio/optics-mcp test` | 0 | 5 pass, 0 fail |
| Python 3.10 `-m unittest discover -s tests -t .` (in `packages/vantio-agent-sdk-py`) | 1 | 128 run, FAILED (failures=1, skipped=2) (fails: `test_wheel_and_sdist_runtime_sources_match`) |
| Python 3.11, same suite | 1 | 128 run, FAILED (failures=1, skipped=2) (fails: `test_wheel_and_sdist_runtime_sources_match`) |
| Python 3.12, same suite | 1 | 128 run, FAILED (failures=1, skipped=2) (fails: `test_wheel_and_sdist_runtime_sources_match`) |
| `node scripts/release/ws11/verify.mjs --emit` | 0 |  |
| `git status --porcelain` the same before and after `--emit` | 0 |  |

## Gaps

- CI did not run: the org billing lock (VAN-129).
- Bodies over 256 KiB, streams, `Blob`, `FormData` and `fetch(new Request(...))` are still not checked. VAN-406 asks Zach whether `--mcp-enforce` should withhold those.
- Open draft PR #42 (VAN-399) uses `looksLikeJsonRpc()` for stdio lines and gets this fix when both are merged. Checked on the combined merge, not on #42 alone.
- Ships only at the next CLI release, with Zach's go.
