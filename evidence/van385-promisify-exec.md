# VAN-385: promisify(exec/execFile) under the interceptor

Branch `engineering/van-385-optics-cli-under-vantio-run-node`, from vantio-optics `main` at `8bee543`. Mirror: vantio-open-core PR on the same branch name. CLI source only. Nothing tagged or published.

## Finding

Found by an independent review (fresh session) and reproduced here.

- `interceptor.cjs` replaces `child_process.exec` and `execFile`. The replacements had no `util.promisify.custom`, and the saved originals were `.bind()` copies, which don't have it either. Under `vantio run node`, `await util.promisify(cp.exec)("echo hi")` returned the string `"hi\n"` instead of `{ stdout, stderr }`, for every command.
- Found while fixing it: one `exec("curl ...")` was recorded **twice**. The exec wrapper recorded it, then Node's `exec` ran `sh -c` through the exported (wrapped) `execFile`, which recorded it again.

Count of records for one curl run, before → after:

| Call | Before | After |
| --- | --- | --- |
| `exec` | 2 | 1 |
| `promisify(exec)` | 2, wrong shape | 1 |
| `promisify(execFile)` | 1, wrong shape | 1 |
| `execFile`, `spawn`, `execSync`, `execFileSync`, `spawnSync` | 1 | 1 |

- Also removed: when the original threw synchronously, the old `catch` called it a second time.

## What changed

- `exec` and `execFile` wrappers: observe, then call the original once. Observation errors are swallowed, as before.
- Both keep Node's own `promisify.custom`, wrapped so the command is observed first.
- While `exec` (or its promisified form) is running, the `execFile` wrapper does not record again.
- New `test/promisify-exec.test.js` (4 tests):
  - The same output with and without the interceptor: shapes, error code and `err.stdout`, the `.child` on the promise, and the callback form.
  - The `promisify.custom` symbols exist.
  - A synchronous throw reaches the caller in the same way.
  - Each of 8 call styles records a curl run exactly once, and the server sees 8 hits.

## Commands

Node 22.23.5, pnpm 11.13.0, strace and curl installed.

| Command | rc | Result |
| --- | --- | --- |
| New test file | 0 | 4 pass |
| New test file on `main`'s interceptor | 1 | 3 of 4 fail |
| Mutations: depth guard off / execFile custom off / exec custom off / custom without observe | 1 each | 1 / 3 / 3 / 1 fail |
| Every `ci.yml` JavaScript step, one at a time | 0 each | CLI tests 183 pass, 1 skipped, 0 fail |
| AGENTS.md secret scan | 0 | no pattern matched |

## Gaps

- CI did not run: the org billing lock (VAN-129).
- The drift check compares `packages/vantio-cli` with open-core `main`, so this and the open-core mirror go together.
- `spawn` and `spawnSync` keep the old "call again in catch" shape. They have no promisify form, and this change doesn't touch them.
- Ships only at the next CLI release, with Zach's go.
