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
