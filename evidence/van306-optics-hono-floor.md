# hono to 4.13.19 and the MCP SDK floor in optics (VAN-306)

Branch `engineering/van-306-mcp-packages-hononode-server-ghsa-rmxm`, from vantio-optics `main` at `23218b4`. Mirror of vantio-open-core #426 (stacked on #423, VAN-188). Dependency change only. No VM run. No workflow dispatch. Nothing tagged or published.

## Finding

`pnpm-lock.yaml` resolved **hono 4.13.13**, below 4.13.16 (GHSA-46wx-v44x-9hh2, GHSA-4h7h-rv7c-7m2v, GHSA-4m76-xfj5-7975, GHSA-h7mg-cq63-vhpq, GHSA-3gg2-335m-rxc6). hono reaches `@vantio/optics-mcp` only through `@modelcontextprotocol/sdk`. The lock already had SDK 1.32.1 and `@hono/node-server` 2.1.5, both above their floors.

## What changed

- `pnpm-workspace.yaml`: overrides `hono@<4.13.16: ^4.13.16` and `'@hono/node-server@<2.1.3': ^2.1.3`, the same floors as open-core.
- `pnpm-lock.yaml` (`pnpm install --lockfile-only`): hono 4.13.13 → 4.13.19, the same version open-core locks. SDK stays 1.32.1 and node-server stays 2.1.5. Nothing else moved.
- `packages/vantio-optics-mcp/package.json`: `@modelcontextprotocol/sdk` `^1.29.0` → `^1.32.0`, byte-identical to open-core #426 after the drift script's link normalization. Version stays 0.1.2. Nothing is published.
- New `packages/vantio-optics-mcp/test/advisory_pins_hono.test.js`: the open-core floor test cut down to this repository's one lockfile and one MCP package. It checks hono 4.13.16, node-server 2.1.3 and SDK 1.32.0 in `pnpm-lock.yaml`, the manifest's SDK range, and the two overrides, with negative cases. It runs in CI through `pnpm --filter @vantio/optics-mcp run test`.

## Commands

Node 22.23.5, pnpm 11.13.0, Python 3.12 venv with requests 2.34.2, httpx 0.28.1, aiohttp 3.14.5, urllib3 2.8.0, build 1.6.1. Base is `main` `23218b4` on this host, same commands.

| Command | rc (this branch) | rc (base) | Result |
| --- | --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | 0 | hono 4.13.19 |
| `pnpm lint` | 0 | 0 | |
| `pnpm test` | 0 | 0 | 237 pass, 1 skipped (base 231, 1 skipped; 6 new) |
| `pnpm test:python` | 0 | 0 | 128 tests OK, 2 skipped |
| `pnpm build` | 0 | 0 | |
| AGENTS.md secret scan | 0 | 0 | no pattern matched |
| `python3 scripts/check_open_core_drift.py <open-core at #426 974f2ed>` | 0 | | "Package code matches" |
| `python3 scripts/check_open_core_drift.py <open-core at #423 a956c17>` | 1 | 0 | differs only in `packages/vantio-optics-mcp/package.json`, so this PR and #426 go together |
| New floor test on base files | | 1 | 3 of 6 fail (hono lock, manifest range, overrides) |
| New floor test on this branch | 0 | | 6 pass |

Also checked, not committed: the optics-mcp server starts over stdio with SDK 1.32.1 and hono 4.13.19 and lists its 6 tools.

## Mutation checks

Run on a copy of the files the floor test reads.

| Mutation | Caught by |
| --- | --- |
| `pnpm-lock.yaml` back to `main` (hono 4.13.13) | "pnpm-lock.yaml resolves hono 4.13.16 or later" |
| manifest back to `^1.29.0` | "packages/vantio-optics-mcp/package.json asks for @modelcontextprotocol/sdk 1.32.0 or later" |
| hono override lowered to 4.13.13 | "pnpm-workspace.yaml keeps the hono and @hono/node-server floors" |
| hono floor lowered to 4.13.0 in the test | negative test |
| pnpm parser skips snapshot dependencies | negative test |
| Restored | 6 pass |

## Gaps

- The open-core drift check in CI skips without `OPEN_CORE_READ_TOKEN`, so a green drift job there is not a comparison. The drift result above came from a local open-core checkout at #426.
- Dependabot alerts may be off for this repository (VAN-231), so this was checked against the advisory ranges, not GitHub's alert view.
- zod 3.25.76 and body-parser 2.3.0 still have open advisories here: VAN-308.
- `@hono/node-server` 2.x requires Node 20 or later; `@vantio/optics-mcp` still says `engines.node >=18.3.0`. Owner question, same as open-core #426.
- The optics-mcp server reports version `0.1.0` in its handshake while the package is 0.1.2. Not changed here.
