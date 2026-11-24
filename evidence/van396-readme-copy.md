# VAN-396: README copy for reportAnomaly, report_anomaly and fetchPolicy (draft)

Branch `engineering/van-396-optics-node-sdk-readme-describes-a-copy`, from vantio-optics `main` at `8bee543`. Mirror: vantio-open-core PR on the same branch name (open-core's README is the one npm and PyPI show). Public copy: needs council review, Kate's wording, and Zach's go. Nothing published.

## What the READMEs said, and what the code does

| README | Said | Code on `main` |
| --- | --- | --- |
| `vantio-agent-sdk` `fetchPolicy` | GETs `/api/v1/config`, fails open, the SDK applies the policy locally | No request. Warns and returns `DEFAULT_POLICY` with `enforce` and `redact_pii` false (`src/index.ts`, `fetchPolicy`) |
| `vantio-agent-sdk` `reportAnomaly` | Requires `VANTIO_CLOUD_INGEST=true` and `VANTIO_API_KEY` | Needs an ingest URL (option or `VANTIO_INGEST_URL`); the env URL also needs `VANTIO_CLOUD_INGEST`; without a key it sends the identity `"unknown"` |
| `vantio-agent-sdk-py` `fetch_policy` | Fetches the policy from `GET /api/v1/config` and fails open | No request. Writes a warning and returns the default `VantioPolicy` |
| `vantio-agent-sdk-py` `report_anomaly` | No-op unless `VANTIO_CLOUD_INGEST=true` | Also needs an ingest URL and a key; `VANTIO_INGEST_URL` has no default for it |

The new plain-http rule is described as it is in the code PR for VAN-396 (vantio-optics #38).

Left alone: the `redactPII` / `redact_pii` sections (owner decision pending in VAN-388), and the JSDoc on `VantioPolicy` in `src/index.ts`, which still says enforcement runs locally (noted on VAN-396 for a follow-up).

## Commands

| Command | rc | Result |
| --- | --- | --- |
| AGENTS.md secret scan | 0 | no pattern matched |
| `node --test test/*.test.js` | 0 | 5 pass |
| Drift check against the open-core copy branch | 1 | only `packages/vantio-optics-mcp/src/server.js` (VAN-310); READMEs are allowed to differ |

No code changed, so the package suites were not re-run for this PR.

## Gaps

- The wording is a draft for Kate. The plain-http sentence is true only once the code PR (#38) merges.
