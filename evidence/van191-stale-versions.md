# Stale versions in Optics docs and the drift script (VAN-191)

Branch `engineering/van-191-claude-optics-publishing-docs-and-drift`, from `main` at `23218b4`. Docs, a code comment, and a docs guard test. No package code changed. No VM run. No workflow dispatch. Nothing sealed, tagged or published.

## Finding

- `scripts/check_open_core_drift.py` header said open-core publishes `@vantio/cli` 0.3.26.
- `docs/publishing.md` said the PyPI workflow publishes sealed 3.1.1, the tree is 3.1.2, and "not a copy of 0.3.24 or 3.1.1".
- `docs/products/optics/NODE-GUIDE.md` said `coverage`, `destinations` and `export` are not in published 0.3.27.
- `docs/products/optics/INSTALLATION.md` named PyPI 3.1.1, tree 3.1.2, pin `==3.1.1`, and "Published CLI 0.3.24 and Python 3.1.1".

## Facts checked on 2026-11-20 (read-only)

| Check | Result |
| --- | --- |
| `npm view @vantio/cli version` / `@vantio/agent-sdk` / `@vantio/optics-mcp` | 0.3.27 / 0.2.4 / 0.1.2 |
| PyPI JSON `vantio-agent-sdk` | latest 3.1.2 |
| `pip install --dry-run --no-deps vantio-agent-sdk` | resolves 3.1.2 |
| npm `dist.shasum` for 0.3.27 vs sha1 of open-core `artifacts/sealed/vantio-cli-0.3.27.tgz` | equal (`907ff2e5…`) |
| PyPI sha256 for the 3.1.2 wheel vs open-core sealed 3.1.2 wheel | equal (`872517cb…`) |
| `case "coverage"`, `"destinations"`, `"export"` in the 0.3.27 tarball's `bin/vantio.js` | present (lines 1769–1775) |
| 3.1.2 wheel `vantio/__init__.py` | `__version__ = "3.1.2"` |
| 3.1.2 wheel `_telemetry.py` | off unless `VANTIO_TELEMETRY=1` |
| 3.1.2 wheel `_http_observe.py` vs this tree | differ (line 678); this tree equals the sealed 3.1.3 wheel |
| Tree versions | CLI 0.3.27, agent-sdk 0.2.4, optics-mcp 0.1.2, Python 3.1.3 |
| open-core `SEALED-RELEASE-PINS.json` | Python 3.1.3 `SEALED_BYTES_RECORDED_NOT_PUBLISHED`, `custody_tag_created: false` |

## What changed

- Drift script header: 0.3.27 and 3.1.2 are on the registries, and open-core's sealed 3.1.3 is not published.
- `docs/publishing.md`: registry table dated 2026-11-20, tree Python 3.1.3; "not a copy of 0.3.27 or 3.1.2"; the PyPI workflow is set up for sealed 3.1.3 and an uncreated custody tag; step 5 says not to republish 3.1.2 or earlier and not to publish 3.1.3 from here.
- `NODE-GUIDE.md`: the three commands are in published 0.3.27.
- `INSTALLATION.md`: PyPI 3.1.2, tree 3.1.3, pin `==3.1.2`, telemetry line names CLI 0.3.27 and Python 3.1.2.
- New `test/docs-versions.test.js`, added to the root `test` script: the `publishing.md` "This tree" column and the `INSTALLATION.md` "Source in this commit" rows must equal the package files.

## Commands and results

| Command | rc | Result |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | ok |
| base docs + new test: `node --test test/docs-versions.test.js` | 1 | 2 of 4 fail (both docs files stale) |
| head: same | 0 | 4 pass |
| `pnpm test` | 0 | CLI 179 pass, 1 skipped; optics-mcp 5; agent-sdk 42; root 9 |
| `pnpm test:python` (Python 3.12 with requests, httpx, aiohttp, urllib3) | 0 | 128 OK, 2 skipped (pycurl) |
| `pnpm lint` | 0 | pass |
| `pnpm build` | 0 | pass |
| secret-scan command from `AGENTS.md` | 0 | no pattern matched |
| `python3 scripts/check_open_core_drift.py <open-core main archive>` | 0 | package code matches |

## Mutation checks

| Mutation | Caught by |
| --- | --- |
| `mismatches` never reports | `a stale docs version is reported` |
| Table parser reads the Latest column | `publishing.md table names the versions in this tree`, `a stale docs version is reported` |
| A `##` heading does not reset the package | `a Source row under a later heading is not credited to the previous package` |
| `publishing.md` tree row back to 3.1.2 | `publishing.md table names the versions in this tree` |
| Restored | 4 pass |

## Gaps

- Public wording: needs council and Kate.
- Not fixed here (same kind of drift, more public copy): `docs/products/optics/README.md` line 16 (says `pip install` gives 3.1.1), `docs/products/optics/TELEMETRY.md` lines 40 and 56 (call 3.1.1 current).
- `vantio-app` `app/docs/page.tsx` troubleshooting paragraph (VAN-191 comment) is another repo; not touched.
- The CLI usage string omitting `run --audit` (VAN-191 comment) is sealed CLI code; not touched.
- The test checks two docs tables only, not prose.

## llms-full.txt regenerated (VAN-382)

`docs/products/optics/llms-full.txt` copies the manual pages, and this branch changed pages without updating the copy. It was rebuilt with `node scripts/check_llms_full.mjs --write` from vantio-optics #30 (VAN-382). Only llms-full.txt changed, and only on the page lines this branch already changed. With #30's check copied in, it exits 0 on this head (it exited 1 before). Secret scan rc 0. CI is blocked by the billing lock (VAN-129).

## Follow-up on 2026-11-24

Base: `main` at `8bee543`. Before this follow-up the branch head was `3ad0f4f`; `main` was merged in as `ca9b5ad`. The commands below ran on the tree of the commit that adds this section (its parent is `ca9b5ad`). This section replaces the README.md and TELEMETRY.md lines in the gap list above.

### What changed

- `docs/products/optics/README.md`: the Python row says a fresh install is 3.1.2 and this tree is 3.1.3 (was 3.1.1 and 3.1.2). Two more 3.1.1 cites in the next paragraph are 3.1.2. Numbers only, plus the check date on the row.
- `docs/products/optics/TELEMETRY.md`: "current release" and the "Published Python" heading and sentence say 3.1.2 (was 3.1.1). Numbers only.
- `docs/products/optics/VERSION-METADATA.json`: `source_tree` Python is 3.1.3 (was 3.1.2).
- `docs/products/optics/llms-full.txt`: rebuilt from the pages.
- `scripts/check_open_core_drift.py` header: names no version number now. It points to the table in `docs/publishing.md`.
- `test/docs-versions.test.js`: 7 new tests. Tree versions in the manual README table and in `VERSION-METADATA.json` must equal the package files. Published versions in `publishing.md`, `INSTALLATION.md`, the manual README table and `TELEMETRY.md` must equal `VERSION-METADATA.json`. The drift script header must name no version number. Two of the new tests are negative cases.

No package code changed. No package version changed. Nothing published, tagged or dispatched.

### Facts checked on 2026-11-24 (read-only)

| Check | Result |
| --- | --- |
| `npm view @vantio/cli version dist-tags` | 0.3.27, latest 0.3.27 |
| PyPI JSON `vantio-agent-sdk` | latest 3.1.2 |
| Tree: `packages/*/package.json`, `pyproject.toml` | CLI 0.3.27, agent-sdk 0.2.4, optics-mcp 0.1.2, Python 3.1.3 |
| 3.1.2 wheel from PyPI: `vantio/__init__.py` | `__version__ = "3.1.2"` |
| `cmp` 3.1.2 wheel `vantio/_telemetry.py` with this tree | rc 0, same |
| `cmp` 3.1.2 wheel `vantio/_http_observe.py` with this tree | rc 1, differ at line 678 |
| open-core `main` (`1beaf36`) `pypi-publish.yml` | names 3.1.3 and `custody-py-3.1.3` |

### Commands and results

Node v22.23.5, pnpm 11.13.0, Python 3.13.18.

| Command | rc | Result |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | ok |
| new test file on the files of `main` (`8bee543`): `node --test test/docs-versions.test.js` | 1 | 7 of 11 fail, 4 pass |
| same on this tree | 0 | 11 pass |
| `pnpm --filter @vantio/cli run lint` | 0 | pass |
| `pnpm --filter @vantio/optics-mcp run lint` | 0 | pass |
| `pnpm --filter @vantio/agent-sdk run typecheck` | 0 | pass |
| `pnpm --filter @vantio/agent-sdk run typecheck:test` | 0 | pass |
| `pnpm --filter @vantio/cli run test` | 0 | 179 pass, 1 skipped |
| `pnpm --filter @vantio/optics-mcp run test` | 0 | 8 pass |
| `pnpm --filter @vantio/agent-sdk run test` | 0 | 42 pass |
| `pnpm --filter @vantio/agent-sdk run build` | 0 | pass |
| `node --test test/agent-docs.test.js test/open-core-drift-workflow.test.js test/docs-versions.test.js` | 0 | 16 pass |
| `python3 -m unittest discover -s tests -t . -v` in `packages/vantio-agent-sdk-py` | 0 | 128 run, OK, 2 skipped |
| `node scripts/check_llms_full.mjs` (script borrowed from #30, not committed) before the rebuild | 1 | differs at line 28 |
| same after `--write` | 0 | matches the pages |
| secret-scan command from `AGENTS.md` | 0 | no pattern matched |
| `python3 scripts/check_open_core_drift.py <open-core main 1beaf36>` on this tree | 1 | one file differs: `packages/vantio-optics-mcp/src/server.js` |
| same on `main` (`8bee543`) | 1 | the same one file |

### Gaps

- GitHub CI did not run: org billing lock (VAN-129). All results are local.
- The drift check exits 1 on `main` and on this branch for `packages/vantio-optics-mcp/src/server.js`. This branch does not touch that file.
- Python tests ran on 3.13 only. CI names 3.10, 3.11 and 3.12.
- `ci.yml` does not run the root tests, so the new test runs only under `pnpm test`. #30 (VAN-382) adds the root tests to CI.
- No open-core pull request. `docs/publishing.md` and `scripts/check_open_core_drift.py` are not in open-core. Its `docs/products/optics/` is an older copy (CLI 0.3.24, Python 3.0.14) with different bytes, and its root `README.md` cites PyPI 3.1.1. Not touched.
- Still stale here, not fixed, because the fix is a wording change in public copy: pages that say this tree is Python 3.1.2 or equals the registry (`AI-GUIDE.md`, `QUICKSTART.md`, `USER-MANUAL.md`, `KNOWN-LIMITATIONS.md`, `PYTHON-GUIDE.md`, `llms.txt`, `UPGRADE-ROLLBACK-UNINSTALL.md`, `TROUBLESHOOTING.md` line 11) and `CONTRIBUTING.md` line 8. The test does not read these.
- Published versions are not read from the registries by the test. It checks that the docs agree with `VERSION-METADATA.json`, which a person updates.
- Earlier wording changes on this branch (`publishing.md`, `NODE-GUIDE.md`, `INSTALLATION.md`) are public docs and still need the owners' sign-off.
- `vantio-app` troubleshooting paragraph and the CLI usage string (earlier VAN-191 comments): not touched.
