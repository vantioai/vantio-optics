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
