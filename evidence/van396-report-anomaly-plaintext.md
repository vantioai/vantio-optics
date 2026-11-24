# VAN-396: reportAnomaly / report_anomaly never send the key over plain http to another machine

Branch `engineering/van-396-optics-node-sdk-readme-describes-a`, from vantio-optics `main` at `8bee543`. Mirror: vantio-open-core PR on the same branch name. Package source only. Nothing tagged or published. This is the code part of VAN-396; the README part is a separate draft PR because it is public copy.

## Finding

Reproduced before the fix with a listener on this machine's non-loopback address (`192.0.2.2`, a test address in the sandbox):

- Node: `reportAnomaly(event, { ingestUrl: "http://192.0.2.2:18396" })` with `VANTIO_API_KEY` set sent the POST, and the `x-vantio-identity` header carried the key.
- Python: `report_anomaly(..., ingest_url="http://192.0.2.2:18396", api_key=...)` with `VANTIO_CLOUD_INGEST=1` did the same.

`vantio export` already refuses this case (`assertExportUrl` in `optics-features.cjs`). The SDKs did not.

## What changed

- `packages/vantio-agent-sdk/src/index.ts`: a private `ingestUrlProblem(url)` with the `vantio export` rule: http or https only, no credentials in the URL, plain http only to `localhost`, `127.0.0.1` or `::1`. `reportAnomaly` warns and returns when it fails. Nothing new is exported.
- `packages/vantio-agent-sdk-py/vantio/sdk.py`: the same rule in `_ingest_url_problem`; `report_anomaly` warns and returns.
- Tests: `packages/vantio-agent-sdk/test/report-anomaly-transport.test.ts` (6, with `fetch` replaced so nothing leaves the test) and `ReportAnomalyTransportTests` in `packages/vantio-agent-sdk-py/tests/test_sdk.py` (3, with `urlopen` replaced). They cover remote plain http (IP, name, upper-case scheme), env-derived URLs, credentials, `file:`, a bad URL, and the negative cases: https to a remote host and plain http to the three loopback names still send.

## Commands

Run on the working tree of this commit (base `8bee543`). Node 22, pnpm 11.13.0.

| Command | rc | Result |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | |
| CLI lint, optics-mcp lint, SDK typecheck, typecheck:test | 0 | |
| `pnpm --filter @vantio/cli run test` | 0 | 179 pass |
| `pnpm --filter @vantio/optics-mcp run test` | 0 | 8 pass |
| `pnpm --filter @vantio/agent-sdk run test` | 0 | 48 pass (main 42) |
| `pnpm --filter @vantio/agent-sdk run build` | 0 | |
| `node --test test/*.test.js` | 0 | 5 pass |
| Python SDK suite on 3.10, 3.11, 3.12 | 0 | 131 OK, 2 skipped each (main 128) |
| AGENTS.md secret scan | 0 | no pattern matched |
| Drift check against the open-core mirror branch | 1 | only `packages/vantio-optics-mcp/src/server.js` (VAN-310, already on main) |

Mutation check: with both source files back on `main`, the Node test file fails 5 of 6 and the Python class fails 2 of 3. The tests that still pass are the negative cases.

## Gaps

- CI did not run: the org billing lock.
- `localhost` is trusted by name, as in `vantio export`. A hosts file that maps it elsewhere is not checked.
- The README part of VAN-396 is a separate draft PR (public copy).
- Ships only at the next SDK releases, with Zach's go.

## Follow-up commit (Nov 24 review)

Base: vantio-optics `ea12714`, vantio-open-core `5638b60` (the previous heads of this branch).

**Finding.** The URL check covers only the URL the caller configured. Both SDKs then followed a redirect and sent the identity header, which holds `VANTIO_API_KEY`, to the new URL. That URL can be another host or plain http. Reproduced on `ea12714`: an ingest server on 127.0.0.1 answered 307 (Node) or 302 (Python) with a `Location` on another port, and the second server received `x-vantio-identity: vk_test_redirect_canary` in both SDKs.

**Change.**

- Node (`packages/vantio-agent-sdk/src/index.ts`): the ingest `fetch` uses `redirect: "error"`, so a redirect is a failed request and the existing non-fatal warning is printed.
- Python (`packages/vantio-agent-sdk-py/vantio/sdk.py`): the request goes through `_open_ingest()`, an opener whose redirect handler raises `HTTPError` instead of following. The existing non-fatal warning is printed.

**Tests.**

- Node, `report-anomaly-transport.test.ts`: a 307 to another origin is not followed and the second server sees no request; a plain 200 is still sent once with the header (negative case).
- Python, `test_sdk.py` `ReportAnomalyRedirectTests`: a 302 is not followed and the second server sees no request; a plain 200 is still sent once with the header (negative case).
- The earlier transport tests now patch `vantio.sdk._open_ingest` instead of `urllib.request.urlopen`.

Mutation check: with `index.ts` and `sdk.py` back on `ea12714`, both redirect tests fail and both plain-200 tests pass. On the old Python code the earlier transport tests error, because `_open_ingest` does not exist there.

Run on the working tree of this commit:

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
| `pnpm --filter @vantio/agent-sdk run test` | 0 | 50 pass, 0 fail |
| `pnpm --filter @vantio/agent-sdk run build` | 0 |  |
| `node --test test/*.test.js` | 0 | 5 pass, 0 fail |
| `node scripts/check_llms_full.mjs` | absent |  |
| Python 3.10 `-m unittest discover -s packages/vantio-agent-sdk-py/tests -t packages/vantio-agent-sdk-py` | 0 | 133 run, OK (skipped=2) |
| Python 3.11, same suite | 0 | 133 run, OK (skipped=2) |
| Python 3.12, same suite | 0 | 133 run, OK (skipped=2) |
| secret scan (`git grep` patterns from the repo rules) | 0 |  |
| `llms-full.txt` against the manual pages | 0 |  |
| `python3 scripts/check_open_core_drift.py <open-core mirror worktree>` | 1 | (only `packages/vantio-optics-mcp/src/server.js`, the known VAN-310 drift) |

**vantio-open-core mirror**

| Command | rc | Result |
| --- | --- | --- |
| `corepack pnpm install --frozen-lockfile` | 0 |  |
| `pnpm --filter @vantio/cli run lint` | 0 |  |
| `pnpm --filter @vantio/cli run test` | 0 | 179 pass, 0 fail |
| `pnpm --filter @vantio/optics-mcp run lint` | 0 |  |
| `pnpm --filter @vantio/optics-mcp test` | 0 | 5 pass, 0 fail |
| Python 3.10 `-m unittest discover -s tests -t .` (in `packages/vantio-agent-sdk-py`) | 1 | 133 run, FAILED (failures=1, skipped=2) (fails: `test_wheel_and_sdist_runtime_sources_match`) |
| Python 3.11, same suite | 1 | 133 run, FAILED (failures=1, skipped=2) (fails: `test_wheel_and_sdist_runtime_sources_match`) |
| Python 3.12, same suite | 1 | 133 run, FAILED (failures=1, skipped=2) (fails: `test_wheel_and_sdist_runtime_sources_match`) |
| `node scripts/release/ws11/verify.mjs --emit` | 0 |  |
| `git status --porcelain` the same before and after `--emit` | 0 |  |

### Gaps

- CI did not run: the org billing lock (VAN-129).
- A redirect that the ingest server really needs now fails. Nothing in this repository sends one.
- Ships only at the next SDK releases, with Zach's go.
