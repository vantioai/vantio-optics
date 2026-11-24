# VAN-408: coverage, destinations and export use the time on MCP records

Branch `engineering/van-408-optics-cli-coverage-destinations-and`, from vantio-optics `main` at `8bee543`. Mirror: vantio-open-core PR on the same branch name, from `1beaf36`. CLI source only. Nothing tagged or published.

## Finding

Found in the Nov 24 review. Every record in `mcp-observations.jsonl` has an `at` time, but `observationFromMcp()` in `packages/vantio-cli/bin/optics-features.cjs` set `time: null`.

Reproduced on `main` with one MCP record written a minute earlier:

- `vantio destinations --since=24h` printed "No new destination", and still wrote the tool to `seen-destinations.json`. A later `vantio destinations` (all time) printed "No new destination" too, so the first-use flag was lost.
- `vantio coverage --since=24h --json` left the record out and reported `undated_excluded: 1`.

`collectObservations()` also counted every MCP record outside the window as undated, even one with a time.

## What changed

- `observationFromMcp()` takes `time` from `at`.
- An MCP record outside the window is counted as undated only when it has no time, as for run-log calls.

`export` now sends MCP events with their time instead of 0, and sorts them in time order.

## Tests

`packages/vantio-cli/test/mcp-record-time.test.js` (5):

- `destinations --since=24h` flags a tool first used a minute ago, and a second run does not flag it again;
- `coverage --since=24h` keeps a recent MCP record and reports `undated_excluded: 0`;
- an MCP record 40 days old stays outside a 24 h window and is not counted as undated;
- an old MCP record is not flagged by `destinations --since=24h` (negative case);
- an MCP record with no time is still counted as undated (negative case).

Mutation check: with `optics-features.cjs` back on `main`, the first three fail and the two negative cases pass.

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
| `pnpm --filter @vantio/cli run test` | 0 | 184 pass, 0 fail |
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
| `pnpm --filter @vantio/cli run test` | 0 | 184 pass, 0 fail |
| `pnpm --filter @vantio/optics-mcp run lint` | 0 |  |
| `pnpm --filter @vantio/optics-mcp test` | 0 | 5 pass, 0 fail |
| Python 3.10 `-m unittest discover -s tests -t .` (in `packages/vantio-agent-sdk-py`) | 1 | 128 run, FAILED (failures=1, skipped=2) (fails: `test_wheel_and_sdist_runtime_sources_match`) |
| Python 3.11, same suite | 1 | 128 run, FAILED (failures=1, skipped=2) (fails: `test_wheel_and_sdist_runtime_sources_match`) |
| Python 3.12, same suite | 1 | 128 run, FAILED (failures=1, skipped=2) (fails: `test_wheel_and_sdist_runtime_sources_match`) |
| `node scripts/release/ws11/verify.mjs --emit` | 0 |  |
| `git status --porcelain` the same before and after `--emit` | 0 |  |

## Gaps

- CI did not run: the org billing lock (VAN-129).
- An `at` value that is not a date is kept as text and falls outside every window except `all`.
- Ships only at the next CLI release, with Zach's go.
