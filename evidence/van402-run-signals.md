# VAN-402: a stop signal sent to `vantio run` reaches the program

Branch `engineering/van-402-optics-cli-sigterm-to-vantio-run-kills`, from vantio-optics `main` at `8bee543`. Mirror: vantio-open-core PR on the same branch name. CLI source only. Nothing tagged or published.

## Finding

Found in this review and reproduced on `main`: `vantio run node child.js`, where the child writes a flag file on SIGTERM. After `kill -TERM <vantio pid>` the wrapper was gone, the child was still running, and the flag file was never written. `vantio run` installed no signal handlers, so Node's default handler ended the wrapper first. The same happened for SIGINT, SIGHUP or SIGQUIT sent to the wrapper alone.

## What changed

- `runCommand` in `packages/vantio-cli/bin/vantio.js`, on POSIX only: SIGTERM to the wrapper is forwarded to the child. SIGINT, SIGHUP and SIGQUIT do not end the wrapper; the terminal already sends them to the whole process group, so forwarding would deliver them twice. The wrapper then waits for the child and exits with its code, or re-raises the child's signal as before.
- The handlers are removed when the child exits or fails to start, before the existing `process.kill(process.pid, signal)`.

## Commands

Run on the working tree of this commit (base `8bee543`). Node 22, pnpm 11.13.0.

| Command | rc | Result |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | |
| CLI lint, optics-mcp lint, SDK typecheck, typecheck:test | 0 | |
| `pnpm --filter @vantio/cli run test` | 0 | 183 pass (main 179) |
| `pnpm --filter @vantio/optics-mcp run test` | 0 | 8 pass |
| `pnpm --filter @vantio/agent-sdk run test` | 0 | 42 pass |
| `pnpm --filter @vantio/agent-sdk run build` | 0 | |
| `node --test test/*.test.js` | 0 | 5 pass |
| Python SDK suite on 3.10, 3.11, 3.12 | 0 | 128 OK, 2 skipped each |
| AGENTS.md secret scan | 0 | no pattern matched |
| Drift check against the open-core mirror branch | 1 | only `packages/vantio-optics-mcp/src/server.js` (VAN-310, already on main) |

New tests (`packages/vantio-cli/test/run-signals.test.js`, 4): SIGTERM reaches a child that traps it and the wrapper exits 0; a child that dies of SIGTERM ends the wrapper with SIGTERM; SIGINT to the wrapper alone leaves both running until the child exits; a normal exit code 7 passes through.

Mutation check: with `vantio.js` back on `main`, the first three fail; the exit-code test (negative case) passes on both.

## Gaps

- CI did not run: the org billing lock.
- Windows is unchanged (no handlers there).
- Ctrl+C in a terminal still reaches the child once, from the terminal, as before. A SIGINT sent to the wrapper alone is not forwarded.
- Ships only at the next CLI release, with Zach's go.

## Follow-up commit (Nov 24 review)

Base: vantio-optics `f016a01`, vantio-open-core `e017739` (the previous heads of this branch).

**Finding.** With this branch, SIGINT, SIGHUP or SIGQUIT sent to the wrapper alone (`kill -INT`, a supervisor, a parent process that calls `child.kill("SIGINT")`) was ignored. The wrapper stayed up and the program never got the signal, so the stop request was lost. Reproduced on `f016a01`: both the wrapper and the program were still running 3 s after SIGINT or SIGHUP. On `main` the wrapper at least exited.

**Change.** SIGINT, SIGHUP and SIGQUIT are forwarded to the program unless the wrapper is in the foreground process group of its terminal. In that case the terminal already sent the signal to the whole group, so it is not sent twice. On Linux this reads `/proc/self/stat` (pgrp and tpgid). Elsewhere a terminal on stdin, stdout or stderr counts as the terminal. The helper is `signalFromTerminal()` in `packages/vantio-cli/bin/optics-proc.cjs`. SIGTERM is unchanged.

**Tests** (`packages/vantio-cli/test/run-signals.test.js`, now 10). The wrapper is started in its own session, so no terminal is involved:

- SIGINT, SIGHUP and SIGQUIT sent to the wrapper alone reach a program that traps them, and the wrapper waits for it and exits 0.
- A program that dies of a forwarded SIGINT ends the wrapper with SIGINT.
- `inTerminalForeground()` is true only when tpgid equals pgrp, also for a program name with spaces and parentheses.
- `signalFromTerminal()` reads the stat file under a given proc root.
- The earlier test "SIGINT to the wrapper alone does not end it before the program" is replaced: that behaviour was the bug.

Waits are bounded, so a wrapper that never exits fails the test instead of hanging the run.

Mutation check: with `vantio.js` and `optics-proc.cjs` back on `f016a01`, the 4 forwarding tests fail and the 3 helper tests fail (the helper does not exist there). The SIGTERM tests and the exit-code test (negative cases) pass on both.

Run on the working tree of this commit:

**vantio-optics**

| Command | rc | Result |
| --- | --- | --- |
| `corepack pnpm install --frozen-lockfile` | 0 |  |
| `pnpm --filter @vantio/cli run lint` | 0 |  |
| `pnpm --filter @vantio/optics-mcp run lint` | 0 |  |
| `pnpm --filter @vantio/agent-sdk run typecheck` | 0 |  |
| `pnpm --filter @vantio/agent-sdk run typecheck:test` | 0 |  |
| `pnpm --filter @vantio/cli run test` | 0 | 189 pass, 0 fail |
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
| `pnpm --filter @vantio/cli run test` | 0 | 189 pass, 0 fail |
| `pnpm --filter @vantio/optics-mcp run lint` | 0 |  |
| `pnpm --filter @vantio/optics-mcp test` | 0 | 5 pass, 0 fail |
| Python 3.10 `-m unittest discover -s tests -t .` (in `packages/vantio-agent-sdk-py`) | 1 | 128 run, FAILED (failures=1, skipped=2) (fails: `test_wheel_and_sdist_runtime_sources_match`) |
| Python 3.11, same suite | 1 | 128 run, FAILED (failures=1, skipped=2) (fails: `test_wheel_and_sdist_runtime_sources_match`) |
| Python 3.12, same suite | 1 | 128 run, FAILED (failures=1, skipped=2) (fails: `test_wheel_and_sdist_runtime_sources_match`) |
| `node scripts/release/ws11/verify.mjs --emit` | 0 |  |
| `git status --porcelain` the same before and after `--emit` | 0 |  |
| `git diff --quiet -- scripts/release/ws11 release` after `--emit` | 0 |  |

### Gaps

- CI did not run: the org billing lock (VAN-129).
- A SIGINT sent with `kill` from another shell while the wrapper is in the terminal's foreground group is not forwarded, because it looks like a terminal signal. The program then keeps running, as on `f016a01`.
- A terminal hangup can reach the program twice when the session has already lost its terminal by the time the wrapper reads `/proc`.
- Not tested on macOS. Windows is unchanged.
- Ships only at the next CLI release, with Zach's go.
