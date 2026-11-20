# optics-mcp handshake version from package.json (VAN-310)

Branch `engineering/van-310-optics-mcp-mcp-handshake-reports-version`, from vantio-optics `main` at `23218b4`. Mirror of the open-core VAN-310 PR: `src/server.js` and the new test are byte-identical to open-core's. No VM run. No workflow dispatch. Nothing tagged or published.

## Finding

`packages/vantio-optics-mcp/src/server.js` passed a hard-coded `version: "0.1.0"` to `McpServer`, so the MCP handshake said 0.1.0 while the package is 0.1.2.

## What changed

- `packages/vantio-optics-mcp/src/server.js`: reads `version` from the package's own `package.json` and passes it to `McpServer`. The version number itself is unchanged.
- New `packages/vantio-optics-mcp/test/server_version.test.js`: a real SDK client checks the handshake equals the `package.json` version, and that `src/server.js` has no hard-coded version string. Negative cases for a mismatched, missing or wrong-name fixture and for the detector. It runs in CI through `pnpm --filter @vantio/optics-mcp run test`.

## Commands

Node 22.23.5, pnpm 11.13.0, Python 3.12.3 venv with requests 2.34.2, httpx 0.28.1, aiohttp 3.14.5, urllib3 2.8.0, build 1.6.1. Base is `main` `23218b4` on this host, same commands.

| Command | rc (this branch) | rc (main) | Result |
| --- | --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | 0 | |
| `pnpm lint` | 0 | 0 | |
| `pnpm test` | 0 | 0 | 234 pass, 1 skipped (main 231; 3 new) |
| `pnpm test:python` | 0 | 0 | 128 tests OK, 2 skipped |
| `pnpm build` | 0 | 0 | |
| AGENTS.md secret scan | 0 | 0 | no pattern matched |
| `python3 scripts/check_open_core_drift.py <open-core VAN-310 branch>` | 0 | | "Package code matches" |
| `python3 scripts/check_open_core_drift.py <open-core main 1242a74>` | 1 | 0 | differs only in `packages/vantio-optics-mcp/src/server.js`, so the two PRs go together |
| New `server_version.test.js` on `main`'s `src/server.js` | | 1 | 2 of 3 fail |
| New `server_version.test.js` on this branch | 0 | | 3 pass |

Mutation checks: the same five as the open-core evidence (`evidence/van310-optics-mcp-handshake-version.md` there), run on the identical file; each was caught.

## Gaps

- Merge order: the open-core VAN-310 PR first, then this one, or the drift check fails on `src/server.js`.
- The open-core drift check in CI skips without `OPEN_CORE_READ_TOKEN`. The drift results above came from local open-core checkouts.
- The fix ships with the next optics-mcp release, which needs Zach's go. A release note is public text and needs Kate.
- No MCP host was run. Runs used Node 22 only.
