# Floors for body-parser, fast-uri, ip-address and qs in optics (VAN-308, part 1)

Branch `engineering/van-308-open-core-and-optics-transitive-npm`, stacked on vantio-optics #22 (VAN-306, head `1086338`). Mirror of the open-core VAN-308 part 1 PR. Dependency change only. No VM run. No workflow dispatch. Nothing tagged or published. zod is not in this change (VAN-308 part 2).

## Finding

`pnpm-lock.yaml` resolved **body-parser 2.3.0**, below the 2.4.0 fix for GHSA-27r3-jxmh-p828 (high). It reaches `@vantio/optics-mcp` through `@modelcontextprotocol/sdk` and express. fast-uri (3.1.9), ip-address (10.7.4) and qs (6.16.1) were already at their floors here, but had no override to keep them there.

## What changed

- `pnpm-workspace.yaml`: the same four floor overrides as open-core, `body-parser@<2.4.0: ^2.4.0`, `fast-uri@<3.1.9: ^3.1.9`, `ip-address@<10.7.4: ^10.7.4`, `qs@<6.16.1: ^6.16.1`.
- `pnpm-lock.yaml` (`pnpm install --lockfile-only`): body-parser 2.3.0 → 2.4.0. Its new needs (content-type 2.1.0, qs 6.16.1) were already locked. Nothing else moved.
- New `packages/vantio-optics-mcp/test/advisory_pins_transitive.test.js`: the open-core floor test for this repository's one lockfile. It checks the four floors in `pnpm-lock.yaml` and the four overrides, with negative cases. It runs in CI through `pnpm --filter @vantio/optics-mcp run test`.
- No package code changed, so the drift check is unaffected.

## Commands

Node 22.23.5, pnpm 11.13.0, Python 3.12.3 venv with requests 2.34.2, httpx 0.28.1, aiohttp 3.14.5, urllib3 2.8.0, build 1.6.1. Base is `1086338` on this host, same commands.

| Command | rc (this branch) | rc (base) | Result |
| --- | --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | 0 | body-parser 2.4.0 |
| `pnpm lint` | 0 | 0 | |
| `pnpm test` | 0 | 0 | 246 pass, 1 skipped (base 240; 6 new) |
| `pnpm test:python` | 0 | 0 | 128 tests OK, 2 skipped |
| `pnpm build` | 0 | 0 | |
| AGENTS.md secret scan | 0 | 0 | no pattern matched |
| `python3 scripts/check_open_core_drift.py <open-core VAN-308 part 1 branch>` | 0 | | "Package code matches" |
| New floor test on base lock and workspace file | | 1 | 2 of 6 fail (body-parser lock, overrides) |
| New floor test on this branch | 0 | | 6 pass |

Also checked, not committed: the optics-mcp server starts over stdio with the SDK client and lists its 6 tools.

## Mutation checks

Each mutation was made in place, run, and restored from a copy.

| Mutation | Caught by |
| --- | --- |
| body-parser override removed | "pnpm-workspace.yaml keeps the ... floors" |
| `pnpm-lock.yaml` snapshot dep body-parser back to 2.3.0 | "pnpm-lock.yaml resolves body-parser 2.4.0 or later" |
| qs floor lowered to 6.15.3 in the test | workspace test and negative test |
| pnpm parser skips snapshot dependencies | negative test |
| version compare looks at the major only | negative test |
| Restored | 6 pass |

## Rebase onto #22 round 3

Rebased onto #22 at `6417dca` (`@hono/node-server` floor 2.1.6, on `main` `8bee543`). The only conflict was `pnpm-lock.yaml`; it was regenerated with `pnpm install`. Against the old head, the lock differs only in `@hono/node-server` 2.1.5 → 2.1.11. Nothing in this PR's own change moved. No VM run. No workflow dispatch.

| Command | rc | Result |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | |
| `pnpm lint` | 0 | |
| `pnpm test` | 0 | 249 pass, 1 skipped, 0 fail (#22 round 3: 243) |
| `pnpm test:python` | 0 | OK, 2 skipped |
| `pnpm build` | 0 | |
| AGENTS.md secret scan | 0 | no pattern matched |
| `pnpm audit --prod` | 1 | 1 high left: zod (VAN-308 part 2, #24). body-parser is gone. |

## Gaps

- zod 3.25.76 (GHSA-mrhx-c7xc-m3w5, fixed only in zod 4) is not in this change. It is VAN-308 part 2.
- Merge order: this PR's base is optics #22, so #22 merges first (and #22 waits for open-core #423 and #426). No package code changed here, so the drift check does not depend on the open-core VAN-308 PR.
- The open-core drift check in CI skips without `OPEN_CORE_READ_TOKEN`. The drift result above came from a local open-core checkout.
- Dependabot alerts may be off for this repository (VAN-231), so this was checked against the advisory ranges, not GitHub's alert view.
- Runs used Node 22 only.
