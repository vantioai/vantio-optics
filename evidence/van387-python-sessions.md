# VAN-387 items 4 and 5, and item 1 for Python: run records under concurrent shield(), across await, and across processes

Branch `engineering/van-387-optics-run-records-that-are-wrong-python`, from vantio-optics `main` at `8bee543`. Mirror: vantio-open-core PR on the same branch name. Python SDK source only. Nothing tagged or published. Part of VAN-387; item 1 for Node is #40, items 2 and 3 are #34.

## Finding

Reproduced on `main` with a local server and `VANTIO_EXTRA_LLM_HOSTS=127.0.0.1`:

- Item 4: `asyncio.gather(agent("agentA"), agent("agentB"))`, each `async with shield(trace_id=...)` and one httpx call, wrote only `agentA.json`, holding both calls. `install()` kept the first trace id for the whole process.
- Item 5: inside one `shield()`, while a task awaited an httpx call, another task's `http.client` request and `asyncio.open_connection` were not recorded (1 call recorded instead of 3). `_http_orig_async` raised a thread-local depth that stayed raised across the `await`.
- Item 1 for Python: under `vantio run python parent.py`, a parent and a child that each made one call left only the parent's call. Both write `<trace>.json` with `open(path, "w")`.

## What changed

- `install(trace_id)` returns a token; `uninstall(token)` ends that session. Each session keeps its own calls and writes its own run log when its last user exits. A `shield()` with no session active in its context starts a new session; a nested `shield()`, or a `shield()` under `vantio run python`, joins the active one, as before. `sdk.py` passes the token. `uninstall()` with no token ends the first session (the process wrap).
- `_http_orig_async` marks only the task's own context (the `ContextVar`), not the thread-local depth. Sync paths still use both.
- The live journal row carries the session's trace id.
- `_write_run_log` takes the same `<trace>.json.lock` as the Node interceptor (#40), merges into an existing log with the same trace id and `run_id` (from `VANTIO_RUN_ID`, set by `vantio run` in #40), keeps the first process's identity, recomputes the summary (including Node's fields when present), writes `<trace>.json.<pid>.tmp` with mode 0600 and `O_NOFOLLOW`, and renames it into place. The existing log is read only if it is a regular file (`O_NONBLOCK | O_NOFOLLOW`). Without a run id the file is replaced, as before.

## Commands

Run on the working tree of this commit (base `8bee543`). Node 22, pnpm 11.13.0.

| Command | rc | Result |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | |
| CLI lint, optics-mcp lint, SDK typecheck, typecheck:test | 0 | |
| `pnpm --filter @vantio/cli run test` | 0 | 179 pass |
| `pnpm --filter @vantio/optics-mcp run test` | 0 | 8 pass |
| `pnpm --filter @vantio/agent-sdk run test` | 0 | 42 pass |
| `pnpm --filter @vantio/agent-sdk run build` | 0 | |
| `node --test test/*.test.js` | 0 | 5 pass |
| Python SDK suite on 3.10, 3.11, 3.12 | 0 | 138 OK, 2 skipped each (main 128) |
| AGENTS.md secret scan | 0 | no pattern matched |
| Drift check against the open-core mirror branch | 1 | only `packages/vantio-optics-mcp/src/server.js` (VAN-310, already on main) |

New tests (`tests/test_van387_sessions.py`, 10): two concurrent `async with shield()` get two run logs with their own calls; two concurrent `@shield` functions do too, and all sessions close; a nested `shield()` still joins the outer log; another task's `http.client` and socket calls are recorded while httpx awaits; httpx's own connect is still not recorded twice; same run id merges; another or no run id replaces; a merge keeps Node's summary fields true and the first process's identity; the file is 0600 and a FIFO at the path is replaced without a hang; a parent and a child process of one run keep both calls.

Mutation check: with `_http_observe.py` and `sdk.py` back on `main`, 8 of the 10 fail (4 failures, 4 errors; the merge tests error because the old `_write_run_log` takes no arguments). The two that pass are the negative cases (nested shield joins; no double record).

## Gaps

- CI did not run: the org billing lock.
- A call from a thread started inside a `shield()` has no context, so it goes to the first session, as before.
- The merge only happens when `VANTIO_RUN_ID` is set, which needs #40's `vantio run`. Without #40 this behaves as before.
- Ships only at the next SDK release, with Zach's go.
