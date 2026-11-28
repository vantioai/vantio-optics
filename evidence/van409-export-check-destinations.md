# VAN-409: vantio export checks every destination before it reads or sends

Branch `engineering/van-409-optics-cli-vantio-export-checks-a`, from vantio-optics `main` at `8bee543`. Mirror: vantio-open-core PR on the same branch name, from `1beaf36`. CLI source only. Nothing tagged or published.

## Finding

Found in the Nov 24 review. `vantio export` checked each destination URL inside `deliverExport()`, right before sending to it.

Reproduced on `main`:

- `vantio export --follow --otlp=http://192.0.2.10:4318` started, and after the first live event printed "otlp refuses plaintext to a remote host. Retrying in 250ms", then 500, 1000 and 2000 ms, and kept retrying.
- `vantio export --otlp-grpc=grpc://127.0.0.1:<port> --otlp=http://192.0.2.10:4318` sent 3 gRPC requests to the local collector, then exited 1. No seen-destination file was written, so the next run sends that batch again.

## What changed

`checkExportSinks()` in `packages/vantio-cli/bin/optics-features.cjs` checks `--otlp`, `--webhook` (http/https, no credentials, plain http only to loopback), `--otlp-grpc` and `--syslog` before anything is read or sent. `exportCommand()` calls it for one-shot, `--follow` and `--dry-run`, and exits 1 with the same message as before. `deliverExport()` keeps its own checks.

A `--dry-run` with a refused URL now exits 1 instead of printing the event count.

## Tests

`packages/vantio-cli/test/export-sinks-check.test.js` (6):

- `--follow` with a refused OTLP URL exits 1 at once, without "Following live events" or "Retrying";
- `--follow` with a refused gRPC URL exits 1 at once;
- a one-shot export with a valid gRPC collector and a refused OTLP URL sends nothing to the collector;
- valid loopback OTLP still receives traces, metrics and logs (negative case);
- `--follow` with a valid URL keeps running until stopped (negative case);
- `checkExportSinks()` names the destination it refuses.

Mutation check: with `optics-features.cjs` back on `main`, four fail and the two negative cases pass.

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
- A URL that is accepted but cannot be reached is still retried by `--follow`, as before. That is the intended retry.
- Ships only at the next CLI release, with Zach's go.
