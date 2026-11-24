# VAN-395: hostile run files

Branch `engineering/van-395-optics-hostile-run-files-script`, from vantio-optics `main` at `8bee543`. Mirror: vantio-open-core PR on the same branch name. Package source only. Nothing tagged or published.

## Finding

Filed from an independent review and reproduced here before the fix:

- `vantio prove` with `summary.total_calls` set to `"<img src=x onerror=alert(1)>"` wrote that tag live into the HTML proof twice.
- The Markdown proof (CLI and `optics_prove`) put hostnames into code spans and cells without escaping. A backtick or pipe broke out.
- `mkfifo ~/.vantio/runs/fifo.json`: `vantio prove --list` and `vantio discover` hung (killed by `timeout 5`, rc 124).
- `ln -s /dev/zero ~/.vantio/runs/zero.json`: `vantio prove --list` and the MCP readers aborted with `std::bad_alloc` (rc 134).
- `"calls":[null]` in one file made `discoverLocal` throw for every run. `"calls":{}` made `optics_get_run` throw.
- The proof file was written 0644 and through a symlink at the target.
- The editor extension made a new output channel on every command run.

## What changed

- `optics-features.cjs`: new `readRecordFile(path, options)`. It opens with `O_NONBLOCK` (and `O_NOFOLLOW` for run files), refuses anything that is not a regular file, and reads at most `buffer.constants.MAX_STRING_LENGTH` bytes. That cap is the longest string Node can hold, so no file that could be read before is refused. Run-folder readers (`coverage`, `destinations`, `export`, `recordWrappedRun`, MCP observations) use it.
- An operator-named path (`prove --from`, `--allowlist`) may still be a symlink or a pipe. It is still read only up to the cap.
- `vantio.js`: run readers use the same reader. A bad run file still fails the command with exit 1, as before (existing tests), but with "is not a regular file" or "is a symbolic link" instead of a hang or an abort.
- `vantio.js`: the HTML proof escapes every field. The Markdown proof escapes every field: plain text keeps its code span; anything with a backtick, pipe or backslash is backslash-escaped text.
- `vantio.js`: the proof is written with `O_NOFOLLOW` and mode 0600, and `fchmod` 0600 when the file already existed.
- `optics-mcp/src/runs.js`: readers skip a FIFO, a device, a symlink or an unreadable file. Calls that are not objects are dropped. `proveMarkdown` escapes every field.
- `optics-mcp/src/server.js`: `optics_get_run` keeps only object calls and an object summary. Paths under the home folder are shown from `~`. A tool that throws returns a fixed message instead of the JavaScript error text.
- `extensions/vantio-optics/extension.js`: one output channel per title, disposed with the extension.

## Commands

Run on the working tree of this commit (base `8bee543`). Node 22, pnpm 11.13.0.

| Command | rc | Result |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | |
| `pnpm --filter @vantio/cli run lint` | 0 | |
| `pnpm --filter @vantio/optics-mcp run lint` | 0 | |
| `pnpm --filter @vantio/agent-sdk run typecheck` | 0 | |
| `pnpm --filter @vantio/agent-sdk run typecheck:test` | 0 | |
| `pnpm --filter @vantio/cli run test` | 0 | 189 pass (main 179) |
| `pnpm --filter @vantio/optics-mcp run test` | 0 | 15 pass (main 8) |
| `pnpm --filter @vantio/agent-sdk run test` | 0 | 42 pass |
| `pnpm --filter @vantio/agent-sdk run build` | 0 | |
| `node --test test/*.test.js` | 0 | 7 pass (main 5) |
| Python SDK suite on 3.10, 3.11, 3.12 | 0 | 128 OK, 2 skipped each |
| AGENTS.md secret scan | 0 | no pattern matched |
| `check_open_core_drift.py` against the open-core mirror branch | 1 | only `packages/vantio-optics-mcp/src/server.js` (VAN-310, already on main) |

Mutation check: with the five source files put back to `main`, the new tests fail: CLI 7 of 10, MCP 6 of 7, extension 1 of 2. The tests that still pass are the negative cases (plain values keep code spans, an explicit `--from` symlink and pipe still work, a path outside home is unchanged, separate commands get separate channels).

## Gaps

- CI did not run: the org billing lock.
- Not tested on Windows or macOS. `O_NOFOLLOW` and `O_NONBLOCK` fall back to 0 where Node lacks them; the `lstat` check still refuses a symlink.
- The CLI still stops on the first bad run file (existing, tested behaviour). The MCP server skips it. Whether the CLI should skip too is an owner question.
- The extension test uses a fake `vscode` module. It was not run inside VS Code.
- `vantio prove --from` still follows a symlink by design.
- Ships only at the next CLI and optics-mcp releases, with Zach's go.

## Follow-up commit (Nov 24 review)

Base: vantio-optics `2414371`, vantio-open-core `7cca2f9` (the previous heads of this branch).

**Findings.**

1. `writeOwnerOnly()` opened every `--out` path with `O_NOFOLLOW`. So `vantio prove --out=/dev/stdout`, `--out=/dev/fd/1` and a shell's `>(...)` (also `/dev/fd/N`) failed with ELOOP. They worked on `main`. Reproduced on `2414371`: `prove --out=/dev/stdout` exited 1 with "could not write /dev/stdout: ELOOP".
2. It called `fchmod(0600)` on whatever it opened, including a FIFO or a device. `sudo vantio prove --out=/dev/null` would change the mode of `/dev/null` for every user. Reproduced with a FIFO: its mode changed from 0644 to 0600.

**Change** (`packages/vantio-cli/bin/vantio.js`):

- `/dev/stdout`, `/dev/stderr`, `/dev/fd/N` and `/proc/self/fd/N` write to that descriptor of this process.
- Any other symlink is opened without `O_CREAT` or `O_TRUNC`, and written only when it is not a regular file. A symlink to a regular file is still refused, and that file is not touched.
- Only a regular file is made 0600.
- `writeAllSync()` writes the whole proof and waits briefly on EAGAIN, for a pipe that another process set to non-blocking.

**Tests** (`proof-out-target.test.js`, 6): `--out=/dev/stdout` and `--out=/dev/fd/1` write the proof to stdout; a symlink to `/dev/null` is followed; a named pipe keeps its mode 0644; a symlink to a regular file is still refused and the file keeps its content and mode (negative case); a regular `--out` file is still made 0600 (negative case). The 10 tests in `hostile-run-files.test.js` still pass. By hand, an 889 KB proof went to `/dev/stdout` through a slow pipe reader with rc 0.

Mutation check: with `vantio.js` back on `2414371`, four fail and the two negative cases pass.

Run on the working tree of this commit:

**vantio-optics**

| Command | rc | Result |
| --- | --- | --- |
| `corepack pnpm install --frozen-lockfile` | 0 |  |
| `pnpm --filter @vantio/cli run lint` | 0 |  |
| `pnpm --filter @vantio/optics-mcp run lint` | 0 |  |
| `pnpm --filter @vantio/agent-sdk run typecheck` | 0 |  |
| `pnpm --filter @vantio/agent-sdk run typecheck:test` | 0 |  |
| `pnpm --filter @vantio/cli run test` | 0 | 195 pass, 0 fail |
| `pnpm --filter @vantio/optics-mcp run test` | 0 | 15 pass, 0 fail |
| `pnpm --filter @vantio/agent-sdk run test` | 0 | 42 pass, 0 fail |
| `pnpm --filter @vantio/agent-sdk run build` | 0 |  |
| `node --test test/*.test.js` | 0 | 7 pass, 0 fail |
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
| `pnpm --filter @vantio/cli run test` | 0 | 195 pass, 0 fail |
| `pnpm --filter @vantio/optics-mcp run lint` | 0 |  |
| `pnpm --filter @vantio/optics-mcp test` | 0 | 12 pass, 0 fail |
| Python 3.10 `-m unittest discover -s tests -t .` (in `packages/vantio-agent-sdk-py`) | 1 | 128 run, FAILED (failures=1, skipped=2) (fails: `test_wheel_and_sdist_runtime_sources_match`) |
| Python 3.11, same suite | 1 | 128 run, FAILED (failures=1, skipped=2) (fails: `test_wheel_and_sdist_runtime_sources_match`) |
| Python 3.12, same suite | 1 | 128 run, FAILED (failures=1, skipped=2) (fails: `test_wheel_and_sdist_runtime_sources_match`) |
| `node scripts/release/ws11/verify.mjs --emit` | 0 |  |
| `git status --porcelain` the same before and after `--emit` | 0 |  |

### Gaps

- CI did not run: the org billing lock (VAN-129).
- Writing to `/dev/stdout` when stdout is a file opened with `>>` appends, as the shell set it up. Not tested.
- Not tested on macOS. Windows keeps the earlier path (no `/dev/fd`).
- Ships only at the next CLI release, with Zach's go.
