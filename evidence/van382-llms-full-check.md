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
