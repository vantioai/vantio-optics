# VAN-415: prove and tail pick only a run log as the most recent run

Branch `engineering/van-415-optics-cli-prove-and-tail-pick-a-json`, from vantio-optics `main` at `8bee543`. Mirror: vantio-open-core PR on the same branch name, from `1beaf36`. CLI source only. Nothing tagged or published.

## Finding

Found in the Nov 24 review. `findMostRecentRun()` in `packages/vantio-cli/bin/vantio.js` picked the newest `.json` file in `~/.vantio/runs` without checking `vantio_run_log`. `prove --list`, `search`, `discover` and `coverage` already skip a file that is not a run log.

Reproduced on `main` with one demo run and a newer `notes.json` (`{"hello":"not a run"}`):

- `vantio prove --format=md` printed "Using most recent run log: ~/.vantio/runs/notes.json" and an empty proof (0 calls), exit 0.
- `vantio tail` exited 1: "not a Vantio run log: …/notes.json".
- `vantio prove --run=notes --format=md` printed an empty proof, exit 0, while `vantio tail --run=notes` refused the file.

## What changed

- `findMostRecentRun()` skips a parsed JSON file whose `vantio_run_log` is not `"1"`. A file that does not parse is handled as before (VAN-404 asks Zach about those).
- `vantio prove` refuses a file it picked from the runs folder (the latest, or `--run`) when it is not a run log: "vantio prove: not a Vantio run log: <path>", exit 1, the same as `tail`. An explicit `--from` file is read as before.

## Tests

`packages/vantio-cli/test/latest-run-only-run-logs.test.js` (5): `prove` and `tail` with no `--run` use the newest run log when a newer non-run JSON file exists; `prove --run` refuses a non-run file as `tail --run` does; `prove --run` on a run log still works (negative case); `prove --from` on the same non-run file still works (negative case).

Mutation check: with `vantio.js` back on `main`, the first three fail and the two negative cases pass.

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
- `prove --from` still makes a proof from any JSON object. Left as is because the operator named the file.
- Ships only at the next CLI release, with Zach's go.
