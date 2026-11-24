# VAN-407 (public copy): record docs note for remote_addresses

Branch `engineering/van-407-optics-cli-vantio-run-writes-one-node-or-copy`, from vantio-optics `main` at `8bee543`. Docs only. **Public copy: needs council review, Kate's wording, and Zach's go.** Nothing tagged or published.

## What changed

A "Roadmap" section in `docs/products/optics/RECORD-REFERENCE.md`, and the same text at the same place in `llms-full.txt`, for the per-call `remote_addresses` field from the VAN-407 code PR (#50). The field is in source only, so the section says it is not in a published release.

## Commands

Run on the working tree of this commit. Drift is checked against open-core `main` (`1beaf36`), because this branch has no package change and no mirror.

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
| `node --test test/*.test.js` | 0 | 5 pass, 0 fail |
| `node scripts/check_llms_full.mjs` | absent |  |
| Python 3.10 `-m unittest discover -s packages/vantio-agent-sdk-py/tests -t packages/vantio-agent-sdk-py` | 0 | 128 run, OK (skipped=2) |
| Python 3.11, same suite | 0 | 128 run, OK (skipped=2) |
| Python 3.12, same suite | 0 | 128 run, OK (skipped=2) |
| secret scan (`git grep` patterns from the repo rules) | 0 |  |
| `llms-full.txt` against the manual pages | 0 |  |
| `python3 scripts/check_open_core_drift.py <open-core mirror worktree>` | 1 | (only `packages/vantio-optics-mcp/src/server.js`, the known VAN-310 drift) |

## Gaps

- CI did not run: the org billing lock (VAN-129).
- Wording waits on Kate. Merge only after #50.
