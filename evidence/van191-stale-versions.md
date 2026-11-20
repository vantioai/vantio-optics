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
