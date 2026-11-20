# zod 3 to zod 4 in optics-mcp (VAN-308, part 2)

Branch `engineering/van-308-open-core-and-optics-transitive-npm-zod`, stacked on vantio-optics #23 (VAN-308 part 1, head `7dc8751`). Mirror of the open-core VAN-308 part 2 PR. No VM run. No workflow dispatch. Nothing tagged or published.

**This is a major-version dependency change to a published package** (`@vantio/optics-mcp`; open-core also moves `@vantio/gate-mcp`). It needs council review and ships only with Zach's release go. The package version is unchanged here.

## Finding

zod 3.25.76 in `pnpm-lock.yaml` has GHSA-mrhx-c7xc-m3w5 (high). The only fixed release is zod 4.6.6. `@modelcontextprotocol/sdk` 1.32.1, locked here, declares `zod: "^3.25 || ^4.0"` as a dependency and a required peer, and `zod-to-json-schema` 3.25.2 peers on `zod ^3.25.28 || ^4`. So the SDK accepts zod 4.

## What changed

- `packages/vantio-optics-mcp/package.json`: `zod` `^3.25.0` → `^4.6.6`, the same as open-core. Version stays 0.1.2. optics-mcp's source needed no change (it uses no `z.record`).
- `pnpm-lock.yaml` (`pnpm install`): zod 3.25.76 → 4.6.7; the SDK and zod-to-json-schema snapshots now peer on zod 4.6.7. Nothing else moved.
- New `packages/vantio-optics-mcp/test/zod_schemas.test.js`, byte-identical to open-core's: a real SDK client over the in-memory transport checks `tools/list`, accepts valid arguments, rejects bad ones at the right path, and checks the running zod is 4.6.6 or later. Apart from the version check it passes on zod 3 too.
- New `packages/vantio-optics-mcp/test/advisory_pins_zod.test.js`: zod 4.6.6 or later in `pnpm-lock.yaml`, the manifest asks for `^4.6.6` or later, and the server uses no one-argument `z.record`. Negative cases.

## What a client sees differently

Every accept/reject decision is the same as on zod 3. `tools/list` input schemas no longer say `"additionalProperties": false` (unknown keys are still dropped), and validation error wording changes, for example `Number must be less than or equal to 100 at limit` → `Too big: expected number to be <=100 at limit`. The open-core evidence lists every difference seen.

## Commands

Node 22.23.5, pnpm 11.13.0, Python 3.12.3 venv with requests 2.34.2, httpx 0.28.1, aiohttp 3.14.5, urllib3 2.8.0, build 1.6.1. Base is `7dc8751` on this host, same commands.

| Command | rc (this branch) | rc (base) | Result |
| --- | --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | 0 | zod 4.6.7 |
| `pnpm lint` | 0 | 0 | |
| `pnpm test` | 0 | 0 | 254 pass, 1 skipped (base 246; 8 new) |
| `pnpm test:python` | 0 | 0 | 128 tests OK, 2 skipped |
| `pnpm build` | 0 | 0 | |
| AGENTS.md secret scan | 0 | 0 | no pattern matched |
| `python3 scripts/check_open_core_drift.py <open-core VAN-308 part 2 branch>` | 0 | | "Package code matches" |
| `python3 scripts/check_open_core_drift.py <open-core #427, zod 3>` | 1 | | differs only in `packages/vantio-optics-mcp/package.json`, so the two part 2 PRs go together |
| New `advisory_pins_zod.test.js` on base manifest and lock | | 1 | 2 of 4 fail |
| New `zod_schemas.test.js` on base (zod 3) | | 1 | only "runs on zod 4.6.6 or later" fails (1 of 4) |
| New tests on this branch | 0 | | 4 + 4 pass |

Also checked, not committed: the optics-mcp server starts over stdio with the SDK client on zod 4.6.7 and lists its 6 tools.

## Mutation checks

Each mutation was made in place, run, and restored from a copy.

| Mutation | Caught by |
| --- | --- |
| manifest to `^4.0.0` | "package.json asks for zod 4.6.6 or later" |
| `pnpm-lock.yaml` importer zod back to 3.25.76 | "pnpm-lock.yaml resolves zod 4.6.6 or later" |
| src: a one-argument `z.record` added | "src uses the two-argument z.record form" |
| src: `limit` max 1000 | schema test (tools/list and negative) |
| src: `since_days` max 900 | schema test (tools/list and negative) |
| test: zod floor lowered to 3.25.0 | negative test |
| test: one-argument detector counts nested commas | negative test (after adding the nested-object case; the first run missed it) |
| Restored | 8 pass |

## Gaps

- Major-version dependency change to a published package: council review and Zach's release go before any MCP release. A changelog or release note is public text and needs Kate. No README, doc or changelog was changed.
- Merge order: this PR's base is #23 (on #22). The open-core part 2 PR must be on open-core `main` before this one, or the drift check fails on `package.json`.
- The open-core drift check in CI skips without `OPEN_CORE_READ_TOKEN`. The drift results above came from local open-core checkouts.
- No MCP host (Claude Desktop, Cursor, etc.) was run against the new schemas. Runs used Node 22 only.
