# VAN-403: text from a run file reaches the terminal without control characters

Branch `engineering/van-403-optics-cli-tail-search-discover-and-diff`, from vantio-optics `main` at `8bee543`. Mirror: vantio-open-core PR on the same branch name. CLI source only. Nothing tagged or published.

## Finding

Found in this review and reproduced on `main`: a run file whose hostname and path hold escape sequences (`\u001b]0;...\u0007`, `\u001b[2J`, `\u001b[31m`) put the ESC byte on stdout in `vantio tail`, `search` and `discover`. A path with `\r\n` started a fake output line. Interceptor-written URLs can't carry these bytes, so it takes a run file from elsewhere (the VAN-395 trust boundary).

## What changed

- `packages/vantio-cli/bin/vantio.js`: a `term()` helper replaces C0 and C1 control characters with `?`. Every table cell (`col()`) uses it, and so do the trace ids, hosts and counts that `tail`, `diff`, `prove` and the "matches N runs" list print directly.
- `prove --format=md` to stdout replaces control characters other than its own line breaks and tabs. `--json` already escapes them.

## Commands

Run on the working tree of this commit (base `8bee543`). Node 22, pnpm 11.13.0.

| Command | rc | Result |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | |
| CLI lint, optics-mcp lint, SDK typecheck, typecheck:test | 0 | |
| `pnpm --filter @vantio/cli run test` | 0 | 181 pass (main 179) |
| `pnpm --filter @vantio/optics-mcp run test` | 0 | 8 pass |
| `pnpm --filter @vantio/agent-sdk run test` | 0 | 42 pass |
| `pnpm --filter @vantio/agent-sdk run build` | 0 | |
| `node --test test/*.test.js` | 0 | 5 pass |
| Python SDK suite on 3.10, 3.11, 3.12 | 0 | 128 OK, 2 skipped each |
| AGENTS.md secret scan | 0 | no pattern matched |
| Drift check against the open-core mirror branch | 1 | only `packages/vantio-optics-mcp/src/server.js` (VAN-310, already on main) |

New tests (`packages/vantio-cli/test/terminal-control-chars.test.js`, 2): `tail`, `search`, `discover`, `prove --list`, `diff` and `prove --format=md` print no control character and no injected line for a hostile run file; ordinary values print unchanged.

Mutation check: with `vantio.js` back on `main`, the hostile-file test fails; the ordinary-values test (negative case) passes on both.

## Gaps

- CI did not run: the org billing lock.
- `coverage`, `destinations` and `export` text output were not changed here; they already pass fields through `cleanToken`. Not re-tested for control characters.
- Ships only at the next CLI release, with Zach's go.
