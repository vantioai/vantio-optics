# VAN-347 (optics part): the retired product name

Branch `ccr-van347-retired-name`, from `main` at `8bee543`. Draft pull request (public repository).

Public docs wording. It needs council review, Kate and Zach before it ships.

## What changed

- `docs/observe-only.md`: the three-line note about the retired product and the old MCP package is removed.
- `docs/products/optics/CHANGELOG-GUIDE.md`: the paragraph about the retired product under "Words that changed" is removed.
- `docs/products/optics/llms-full.txt`: rebuilt from its source pages. The file is an exact concatenation of the manual pages under fixed `FILE:` banners. On `main` the rebuild reproduces the file byte for byte; on this branch the only difference is the removed paragraph.
- `scripts/check_retired_name.mjs` and `test/retired-name.test.js` (12 tests): fail if the retired product name returns to those three files. Ordinary English "gate" and names such as COST-GATE do not match. A per-file allow-list holds text kept on purpose; it is empty here.
- `package.json` `test` and `.github/workflows/ci.yml` run the new test.

Nothing under `packages/` or `extensions/` changed (`git diff --stat origin/main -- packages extensions` is empty).

## Commands

| Command | rc | Result |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | done |
| `pnpm lint` | 0 | ok |
| `pnpm test` | 1 | stopped in `@vantio/cli`: 144 pass, 1 fail, timeouts in `interceptor.cjs (integration)` and `live destination, follow, proc, and grpc` under host load. No file that suite reads changed. See the rerun below |
| `pnpm --filter @vantio/cli run test` (rerun) | 1 | 147 pass, 2 fail: the same two suites timed out again plus `enforce opt-in withholds the tool call` (load average about 25). The failing set changed between runs; no file these tests read changed |
| `pnpm --filter @vantio/optics-mcp run test` | 0 | 8 pass |
| `pnpm --filter @vantio/agent-sdk run test` | 0 | 42 pass |
| `node --test test/agent-docs.test.js test/open-core-drift-workflow.test.js test/retired-name.test.js` | 0 | 17 pass (12 new) |
| `pnpm build` | 0 | ok |
| `pnpm test:python` (with the CI job's pip packages in a venv) | 0 | 128 tests OK (2 skipped) |
| Secret scan from `AGENTS.md` | 0 | no pattern matched |
| `python3 scripts/check_open_core_drift.py <open-core main 1beaf36>` | 1 | `packages/vantio-optics-mcp/src/server.js` differs. Same result on `main` (rc 1); this branch changes no package file |
| `node scripts/check_retired_name.mjs` | 0 | files=3 hits=0 |
| Same check on the three files from `main` | 1 | 5 hits |

## Tests

New behaviour: the check passes on this checkout. Negative cases: the capitalised word, the prefixed name in three spellings and the component names in three spellings each fail with `FAIL path:line: pattern`; a missing listed file exits 2. Kept cases: ordinary English and COST-GATE pass; an allowed identifier passes in its own file and fails in another; other text on an allowed line still fails.

## Mutations

| Mutation | Caught by |
| --- | --- |
| M1 prefixed pattern made case-sensitive | two of the prefixed-name tests |
| M2 allow-list ignored | `an allowed identifier passes only in its own file` |
| M3 capitalised pattern made case-insensitive | four tests, including `ordinary English and COST-GATE pass` |
| M4 missing file skipped silently | `a missing cleaned file cannot run` |
| M5 allow-list applied to every file | `an allowed identifier passes only in its own file` |

No VM run. Nothing deployed or published.

## Gap list

- Package files on the issue's list were not changed: the Python SDK changelog, test and module, the CLI interceptor and its test, and the two MCP tests. Package code must stay byte-identical to open-core during the freeze, and those packages are sealed there. Needs a reseal: Zach's call.
- The two MCP tests on the list assert that the retired product name is absent from the MCP output. They are guards and stay.
- The old MCP package's npm listing and metadata are not touched (rule 3).
