# VAN-387 item 1: a child Node process's calls survive the parent's exit

Branch `engineering/van-387-optics-run-records-that-are-wrong-child-node`, from vantio-optics `main` at `8bee543`. Mirror: vantio-open-core PR on the same branch name. CLI source only. Nothing tagged or published. Part of VAN-387; items 2 and 3 are in #34, items 4 and 5 (Python) are in a separate PR.

## Finding

Reproduced on `main`: under `vantio run node parent.js`, the parent `execFileSync`s a child that fetches an in-scope host (`127.0.0.1` via `VANTIO_EXTRA_LLM_HOSTS`). The child prints "LLM calls: 1", but the run log ends with `calls: []`. Every process inherits `VANTIO_TRACE_ID` and writes `<trace>.json` at exit with `writeFileSync`, so the parent, exiting last, erased the child's call.

## What changed

- `vantio run` sets `VANTIO_RUN_ID` (a new random id, or the inherited one) for the process tree.
- `interceptor.cjs`: at exit, under a short `<trace>.json.lock` (create-exclusive, 2 s wait, taken over after 10 s), a process reads the existing log and merges into it only when it has the same trace id and the same run id. The process that started first keeps the run identity (`pid`, `program`, `started_at`, ...). The summary is recomputed from the merged calls. The write goes to `<trace>.json.<pid>.tmp` and is renamed into place. The existing log is read with `O_NONBLOCK | O_NOFOLLOW` and only if it is a regular file.
- Without a run id (the interceptor loaded without `vantio run`) the file is replaced as before. A log from another run with the same trace id is replaced, not merged.
- A single-process run writes the same fields as before, plus `run_id`.
- `vantio tail --follow` now watches the runs folder for the log's name, because a log replaced by rename would leave a file watch on the old copy.

## Commands

Run on the working tree of this commit (base `8bee543`). Node 22, pnpm 11.13.0.

| Command | rc | Result |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | |
| CLI lint, optics-mcp lint, SDK typecheck, typecheck:test | 0 | |
| `pnpm --filter @vantio/cli run test` | 0 | 184 pass (main 179) |
| `pnpm --filter @vantio/optics-mcp run test` | 0 | 8 pass |
| `pnpm --filter @vantio/agent-sdk run test` | 0 | 42 pass |
| `pnpm --filter @vantio/agent-sdk run build` | 0 | |
| `node --test test/*.test.js` | 0 | 5 pass |
| Python SDK suite on 3.10, 3.11, 3.12 | 0 | 128 OK, 2 skipped each |
| AGENTS.md secret scan | 0 | no pattern matched |
| Drift check against the open-core mirror branch | 1 | only `packages/vantio-optics-mcp/src/server.js` (VAN-310, already on main) |

New tests (`packages/vantio-cli/test/run-log-merge.test.js`, 5): a child's call survives the parent; four children that exit together keep 4 calls; a second `vantio run` with the same `VANTIO_TRACE_ID` replaces the first run's log; without `vantio run` the file is replaced as before; `tail --follow` sees a log replaced by rename twice.

Mutation check: with `interceptor.cjs` and `vantio.js` back on `main`, the first two tests fail (0 calls instead of 1 and 4). With only the tail change reverted, the tail test fails on the second rename. The other two pass on both (negative cases).

## Gaps

- CI did not run: the org billing lock.
- `recordWrappedRun` (the `/proc` socket rows `vantio run` adds after the child exits) still writes without the lock. It runs after the root child exits, so only a detached grandchild still running then can race it.
- When a Python process of the same run wrote first, Python-only summary fields (`opticsStatus`, `applicationStatus`, labels) are kept from that write and not recomputed by Node. The Python PR for items 4 and 5 recomputes Node's fields on its side.
- The lock is best effort: after 2 s a writer goes on without it so the agent's exit is never held up.
- Ships only at the next CLI release, with Zach's go.

## Follow-up commit (Nov 24 review)

Base: vantio-optics `c6465d1`, vantio-open-core `0d36a0a` (the previous heads of this branch).

**Finding.** The wrapper's own run log write, `recordWrappedRun()` in `optics-features.cjs`, did not take `<trace>.json.lock`. It reads the log, adds `/proc` socket rows and the process tree, and writes it back. A child that is still running when the wrapper writes merges under the lock in parallel, so either side could lose the other's update. It also wrote no `run_id`, so when the first program left no log (for example it was killed), a child that exited later could not merge into the wrapper's log and replaced it. Reproduced with a test writer that holds the lock for 600 ms and then adds a call: on `c6465d1` the wrapper wrote at once, and the writer's later rename dropped the socket row.

**Change.**

- `recordWrappedRun()` takes the same lock as the interceptor and the Python SDK: `<path>.lock` with `O_EXCL`, a lock older than 10 s is taken over, and after 2 s it goes on without it.
- It writes through `<path>.<pid>.tmp` and a rename, as the interceptor does.
- `vantio run` passes its run id, and the wrapper's log gets `run_id` when the earlier log had none. An earlier log keeps its own.

**Tests** (`run-log-lock-wrapper.test.js`, 4): the wrapper waits for a writer that holds the lock and keeps both its calls and the socket row; a lock older than 10 s is taken over at once; a fresh log carries the run id; an earlier log keeps its own run id, program and calls (negative case).

Mutation check: with `optics-features.cjs` and `vantio.js` back on `c6465d1`, the first three fail and the negative case passes.

Run on the working tree of this commit:

**vantio-optics**

| Command | rc | Result |
| --- | --- | --- |
| `corepack pnpm install --frozen-lockfile` | 0 |  |
| `pnpm --filter @vantio/cli run lint` | 0 |  |
| `pnpm --filter @vantio/optics-mcp run lint` | 0 |  |
| `pnpm --filter @vantio/agent-sdk run typecheck` | 0 |  |
| `pnpm --filter @vantio/agent-sdk run typecheck:test` | 0 |  |
| `pnpm --filter @vantio/cli run test` | 0 | 188 pass, 0 fail |
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
| `pnpm --filter @vantio/cli run test` | 0 | 188 pass, 0 fail |
| `pnpm --filter @vantio/optics-mcp run lint` | 0 |  |
| `pnpm --filter @vantio/optics-mcp test` | 0 | 5 pass, 0 fail |
| Python 3.10 `-m unittest discover -s tests -t .` (in `packages/vantio-agent-sdk-py`) | 1 | 128 run, FAILED (failures=1, skipped=2) (fails: `test_wheel_and_sdist_runtime_sources_match`) |
| Python 3.11, same suite | 1 | 128 run, FAILED (failures=1, skipped=2) (fails: `test_wheel_and_sdist_runtime_sources_match`) |
| Python 3.12, same suite | 1 | 128 run, FAILED (failures=1, skipped=2) (fails: `test_wheel_and_sdist_runtime_sources_match`) |
| `node scripts/release/ws11/verify.mjs --emit` | 0 |  |
| `git status --porcelain` the same before and after `--emit` | 0 |  |

### Gaps

- CI did not run: the org billing lock (VAN-129).
- Two processes that both find a stale lock can both take it over. This needs a lock left from a crash and a race in the same 10 ms.
- Ships only at the next CLI release, with Zach's go.
