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

## Follow-up commit (Nov 24 review)

Base: vantio-optics `bea979a`, vantio-open-core `04f662a` (the previous heads of this branch).

**Finding.** The gap above was real. `cleanToken()` only refuses `\r` and `\n`, so ESC and other control bytes from a run file still reached the terminal in `vantio coverage`, `vantio destinations`, and the "New destination" line that `tail --follow` and `vantio run` print. Reproduced on `bea979a` with a run file whose hostname and program hold escape sequences: `coverage` printed 3 ESC bytes and `destinations --dry-run` printed 2.

**Change.** `packages/vantio-cli/bin/optics-features.cjs`: a `termText()` helper, the same rule as `term()` in `vantio.js`, for every record field that `formatCoverageText()`, `formatDestinationText()` and `formatLiveAlert()` print. JSON output is unchanged.

**Tests** (`terminal-control-chars.test.js`, now 3): `coverage` and `destinations --dry-run` join the hostile-file command list, the fixture gets a hostile `program`, `formatLiveAlert()` is checked with control characters and with plain values, and the plain-values test also checks the `coverage` and `destinations` lines.

Mutation check: with `optics-features.cjs` back on `bea979a`, the hostile-file test and the live-line test fail; the plain-values test (negative case) passes on both.

Run on the working tree of this commit:

**vantio-optics**

| Command | rc | Result |
| --- | --- | --- |
| `corepack pnpm install --frozen-lockfile` | 0 |  |
| `pnpm --filter @vantio/cli run lint` | 0 |  |
| `pnpm --filter @vantio/optics-mcp run lint` | 0 |  |
| `pnpm --filter @vantio/agent-sdk run typecheck` | 0 |  |
| `pnpm --filter @vantio/agent-sdk run typecheck:test` | 0 |  |
| `pnpm --filter @vantio/cli run test` | 0 | 182 pass, 0 fail |
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
| `pnpm --filter @vantio/cli run test` | 0 | 182 pass, 0 fail |
| `pnpm --filter @vantio/optics-mcp run lint` | 0 |  |
| `pnpm --filter @vantio/optics-mcp test` | 0 | 5 pass, 0 fail |
| Python 3.10 `-m unittest discover -s tests -t .` (in `packages/vantio-agent-sdk-py`) | 1 | 128 run, FAILED (failures=1, skipped=2) (fails: `test_wheel_and_sdist_runtime_sources_match`) |
| Python 3.11, same suite | 1 | 128 run, FAILED (failures=1, skipped=2) (fails: `test_wheel_and_sdist_runtime_sources_match`) |
| Python 3.12, same suite | 1 | 128 run, FAILED (failures=1, skipped=2) (fails: `test_wheel_and_sdist_runtime_sources_match`) |
| `node scripts/release/ws11/verify.mjs --emit` | 0 |  |
| `git status --porcelain` the same before and after `--emit` | 0 |  |

### Gaps

- CI did not run: the org billing lock (VAN-129).
- `export` writes JSON lines and syslog, which escape control characters. Not changed.
- Bidirectional-text characters (such as U+202E) are not control characters and are printed as they are.
- Ships only at the next CLI release, with Zach's go.
