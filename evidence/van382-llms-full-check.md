# VAN-382: llms-full.txt check and repository tests in CI

Branch `engineering/van-382-optics-llms-fulltxt-drifts-from-the`, from vantio-optics `main` at `8bee543`. No VM run. No workflow dispatch. Nothing tagged or published.

## Finding

`docs/products/optics/llms-full.txt` is a hand-kept copy of the 17 manual pages. Nothing checked it. On `main` it matches. Three open PRs change a page and leave the copy behind:

| PR | First differing line in llms-full.txt | What the copy still says |
| --- | --- | --- |
| #19 (VAN-93) | 153 | "Phantom Engine is the separate product that enforces" |
| #20 (VAN-191) | 407 | old Python version pins |
| #16 | 155 | old install versions |

`ci.yml` ran only package tests. `test/agent-docs.test.js` and `test/open-core-drift-workflow.test.js` ran only in local `pnpm test`.

## What changed

- New `scripts/check_llms_full.mjs`. It rebuilds llms-full.txt from the pages, in the order the file lists them. It fails when the file differs, when a listed page is missing, when a page is listed twice, when a section name is a path, or when a `.md` page is not listed. `--write` rewrites the file, and refuses while a page is missing or unlisted.
- New `test/llms-full.test.js`: 9 tests (the repository matches; every page is listed; a changed page; a missing page; an unlisted page; a path name; no sections; a duplicate; the command exits 1 on drift and `--write` fixes it).
- `package.json` `test` runs it. `ci.yml` gets a "Repository tests" step that runs all three root tests.
- `AGENTS.md`: repo-map row and the rebuild command.
- No page and no package changed.

## Commands

Node 22.23.5, pnpm 11.13.0, Python 3.12.3. strace installed.

| Command | rc | Result |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | |
| Each `ci.yml` JavaScript step, one at a time (2 lints, 2 typechecks, 3 test suites, build) | 0 each | |
| New CI step: `node --test test/agent-docs.test.js test/open-core-drift-workflow.test.js test/llms-full.test.js` | 0 | 14 pass |
| `pnpm test` | 0 | 243 pass, 1 skipped, 0 fail |
| `pnpm test:python` | 0 | |
| AGENTS.md secret scan | 0 | no pattern matched |
| `ci.yml` YAML parse | 0 | |
| `node scripts/check_llms_full.mjs` on `main` | 0 | matches |
| Same, with this script, on #19 / #20 / #16 heads | 1 / 1 / 1 | lines 153 / 407 / 155 |
| Python rebuild of `main`'s llms-full.txt by the same rule | | byte-identical |

## Mutation checks

| Mutation | Result |
| --- | --- |
| Drift never reported | 2 fail |
| Unlisted page not reported | 1 fail |
| Missing page not reported | 1 fail |
| Path-name check removed | 1 fail |
| Duplicate check removed | 1 fail |
| Restored | 9 pass |

## Gaps

- CI did not run: every job is refused with "account is locked due to a billing issue" (VAN-129). The results above are local.
- #28 (VAN-347) also adds a CI step after the build step and edits the `test` line in `package.json`. Whichever lands second needs a one-line rebase. Its own test can join the new "Repository tests" step then.
- #16, #19 and #20 each need `node scripts/check_llms_full.mjs --write` on their branch. That is done on those PRs separately, not here.
- `llms.txt` (the short index) is not checked; it lists links, not page text.

## Follow-up commit (Nov 24 review)

Base: vantio-optics `a95b9c3` (the previous head of this branch). No open-core mirror: no package source changes.

**Finding.** The new CI step and `pnpm test` name the root test files one by one. Open draft PR #37 (VAN-395) adds `test/extension-output.test.js`. On a merge of both, that test is in the tree, but neither CI nor `pnpm test` runs it. Checked on a scratch merge of all open PRs: `test/` holds four files and the step names three.

**Change.** `.github/workflows/ci.yml` and the root `package.json` `test` script run `node --test test/*.test.js`, so a new root test runs without editing either file.

**Tests.** `test/root-tests-run.test.js` (3): the CI step is `node --test test/*.test.js`; `pnpm test` ends with the same command; the glob finds the existing root tests. With `ci.yml` and `package.json` back on `a95b9c3`, the first two fail and the third passes.

Run on the working tree of this commit (drift against open-core `main` `1beaf36`):

**vantio-optics**

| Command | rc | Result |
| --- | --- | --- |
| `corepack pnpm install --frozen-lockfile` | 0 |  |
| `pnpm --filter @vantio/cli run lint` | 0 |  |
| `pnpm --filter @vantio/optics-mcp run lint` | 0 |  |
| `pnpm --filter @vantio/agent-sdk run typecheck` | 0 |  |
| `pnpm --filter @vantio/agent-sdk run typecheck:test` | 0 |  |
| `pnpm --filter @vantio/cli run test` | 0 | 179 pass, 0 fail |
| `pnpm --filter @vantio/optics-mcp run test` | 0 | 8 pass, 0 fail |
| `pnpm --filter @vantio/agent-sdk run test` | 0 | 42 pass, 0 fail |
| `pnpm --filter @vantio/agent-sdk run build` | 0 |  |
| `node --test test/*.test.js` | 0 | 17 pass, 0 fail |
| `node scripts/check_llms_full.mjs` | 0 |  |
| Python 3.10 `-m unittest discover -s packages/vantio-agent-sdk-py/tests -t packages/vantio-agent-sdk-py` | 0 | 128 run, OK (skipped=2) |
| Python 3.11, same suite | 0 | 128 run, OK (skipped=2) |
| Python 3.12, same suite | 0 | 128 run, OK (skipped=2) |
| secret scan (`git grep` patterns from the repo rules) | 0 |  |
| `llms-full.txt` against the manual pages | 0 |  |
| `python3 scripts/check_open_core_drift.py <open-core mirror worktree>` | 1 | (only `packages/vantio-optics-mcp/src/server.js`, the known VAN-310 drift) |

### Gaps

- CI did not run: the org billing lock (VAN-129). The workflow change is checked by the test above, not by a CI run.
