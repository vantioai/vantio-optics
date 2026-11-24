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
