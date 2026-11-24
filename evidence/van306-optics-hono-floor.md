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

## Round 2: Node floor raised to 20

Base for this round: this branch's first commit `e564508`. Mirror of open-core #426's second commit. No VM run. No workflow dispatch. Nothing tagged or published.

### Finding

`pnpm-lock.yaml` has `@hono/node-server` 2.1.5, which records `engines: {node: '>=20'}`. `@vantio/optics-mcp` still said `engines.node >=18.3.0`, a Node version its own dependency refuses.

### What changed

- `packages/vantio-optics-mcp/package.json`: `engines.node` `>=18.3.0` → `>=20`, the same as open-core #426. Version stays 0.1.2. This is user-facing for the next MCP release, so it needs council review.
- `pnpm-lock.yaml` is unchanged; `pnpm install --frozen-lockfile` passes.
- New `packages/vantio-optics-mcp/test/engines_node_floor.test.js`: the manifest's `engines.node` floor must be at least the floor `@hono/node-server` declares in `pnpm-lock.yaml`. Only plain `>=X[.Y[.Z]]` ranges are accepted. Negative cases cover a lower floor, odd ranges, a lock entry with no `engines`, and the lock parser. It runs in CI through `pnpm --filter @vantio/optics-mcp run test`.

### Commands

Node 22.23.5, pnpm 11.13.0, Python 3.12.3 venv with requests 2.34.2, httpx 0.28.1, aiohttp 3.14.5, urllib3 2.8.0, build 1.6.1. Base is `e564508` on this host, same commands.

| Command | rc (this round) | rc (`e564508`) | Result |
| --- | --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | 0 | |
| `pnpm lint` | 0 | 0 | |
| `pnpm test` | 0 | 0 | 240 pass, 1 skipped (base 237; 3 new) |
| `pnpm test:python` | 0 | 0 | 128 tests OK, 2 skipped |
| `pnpm build` | 0 | 0 | |
| AGENTS.md secret scan | 0 | 0 | no pattern matched |
| `python3 scripts/check_open_core_drift.py <open-core #426 round 2>` | 0 | | "Package code matches" |
| `python3 scripts/check_open_core_drift.py <open-core 974f2ed>` | 1 | 0 | differs only in `packages/vantio-optics-mcp/package.json`, so this round and #426's round 2 go together |
| New `engines_node_floor.test.js` on base manifest | | 1 | 1 of 3 fails |
| New `engines_node_floor.test.js` on this round | 0 | | 3 pass |

### Mutation checks

| Mutation | Caught by |
| --- | --- |
| manifest to `>=19.9` | "engines.node is at least what @hono/node-server needs" |
| manifest to `^20.0.0` | same test (range refused) |
| `lower()` always false | negative test |
| pnpm lock parser finds nothing | "pnpm-lock.yaml records @hono/node-server" and negative test |
| `rangeFloor` takes the first number of any range | negative test |
| Restored | 3 pass |

## Round 3: @hono/node-server floor 2.1.6, rebased onto main

Base for this round: vantio-optics `main` at `8bee543` (VAN-310 landed as #25). Commit `62af68b`. No VM run. No workflow dispatch. Nothing tagged or published.

### Finding

`pnpm audit --prod` on round 2 listed two moderate `@hono/node-server` advisories: GHSA-qv5m-9pm6-hqp3 (new) and GHSA-jpvv-r467-5p4w, whose affected range now runs to 2.1.5. The lock resolved 2.1.5.

### What changed

- `pnpm-workspace.yaml`: override `'@hono/node-server@<2.1.6': ^2.1.6` (was `<2.1.3`). The lock now resolves 2.1.11.
- `advisory_pins_hono.test.js`: the floor is 2.1.6, and the negative case now expects 2.1.5 to count as vulnerable.
- Rebased onto `main` `8bee543`. No conflicts.

### Commands

Node 22.23.5, pnpm 11.13.0, Python 3.12.3 venv, same as round 2. Base is `main` `8bee543` on this host, same commands.

| Command | rc (this round) | rc (`8bee543`) | Result |
| --- | --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | 0 | |
| `pnpm lint` | 0 | 0 | |
| `pnpm test` | 0 | 0 | 243 pass, 1 skipped, 0 fail (base 234, 1 skipped) |
| `pnpm test:python` | 0 | 0 | OK, 2 skipped |
| `pnpm build` | 0 | 0 | |
| AGENTS.md secret scan | 0 | 0 | no pattern matched |
| `pnpm audit --prod` | 1 | 1 | 2 high left: body-parser (VAN-308 part 1, #23) and zod (VAN-308 part 2, #24). No `@hono/node-server` advisory. |
| `python3 scripts/check_open_core_drift.py <open-core #426 7bda66a>` | 1 | 1 (vs open-core `main`) | differs only in `packages/vantio-optics-mcp/src/server.js`, which is VAN-310: already on optics `main`, waiting on open-core #429 |

### Mutation checks

| Mutation | Result |
| --- | --- |
| Lock back to `@hono/node-server` 2.1.5 | 1 fail |
| Override back to `<2.1.3` | 1 fail |
| Restored | pass |

## Gaps

- The open-core drift check in CI skips without `OPEN_CORE_READ_TOKEN`, so a green drift job there is not a comparison. The drift results above came from local open-core checkouts.
- Dependabot alerts may be off for this repository (VAN-231), so this was checked against the advisory ranges, not GitHub's alert view.
- zod 3.25.76 and body-parser 2.3.0 still have open advisories here: VAN-308 (#23, #24, stacked on this PR).
- Raising `engines.node` to `>=20` is user-facing for the next MCP release. It needs council review and Zach's release go; any release note or README line about it also needs Kate. No README, doc or changelog was changed here. Not tested on Node 18 or 20; all runs used Node 22.23.5, as CI does.
- open-core #426 still floors `@hono/node-server` at 2.1.3. Its lock resolves 2.1.9, so it is not affected today, but a lock refresh could go back to 2.1.3–2.1.5. Raising it to 2.1.6 there costs new CI runs on open-core #426, #427 and #428, so it is left for the next push to #426. The drift check does not compare `pnpm-workspace.yaml` or tests, so this does not show as drift.
- The drift check against open-core flags `src/server.js` until open-core #429 (VAN-310) lands. That drift is already on optics `main`, not from this PR.
