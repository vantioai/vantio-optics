# VAN-400: a full trace id picks its run even when it starts another id

Branch `engineering/van-400-optics-cli-run-and-diff-cant-pick-a-run`, from vantio-optics `main` at `8bee543`. Mirror: vantio-open-core PR on the same branch name. CLI source only. Nothing tagged or published.

## Finding

Found in this review and reproduced on `main` with run files `0xabc.json` and `0xabcd.json`: `vantio prove --run=0xabc` and `vantio diff 0xabc 0xabcd` exit 1 with "'0xabc' matches 2 runs. Use a longer prefix". The full id can't be made longer.

## What changed

- `findRunByPrefix` in `packages/vantio-cli/bin/vantio.js`: a file named exactly `<id>.json` wins. Otherwise the old substring match and its "use a longer prefix" message stay.

## Commands

Run on the working tree of this commit (base `8bee543`). Node 22, pnpm 11.13.0.

| Command | rc | Result |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | |
| CLI lint, optics-mcp lint, SDK typecheck, typecheck:test | 0 | |
| `pnpm --filter @vantio/cli run test` | 0 | 181 pass (main 179) |
| `pnpm --filter @vantio/optics-mcp run test` | 0 | 8 pass |
| `pnpm --filter @vantio/agent-sdk run test` | 0 | 42 pass |
| `pnpm --filter @vantio/agent-sdk run build` | 0 | |
| `node --test test/*.test.js` | 0 | 5 pass |
| Python SDK suite on 3.10, 3.11, 3.12 | 0 | 128 OK, 2 skipped each |
| AGENTS.md secret scan | 0 | no pattern matched |
| Drift check against the open-core mirror branch | 1 | only `packages/vantio-optics-mcp/src/server.js` (VAN-310, already on main) |

New tests (`packages/vantio-cli/test/run-exact-match.test.js`, 2): `prove`, `search`, `tail` and `diff` pick `0xabc` by its full id; `0xab` still asks for a longer prefix, and `0xabcd` still works.

Mutation check: with `vantio.js` back on `main`, the first test fails; the second (negative case) passes on both.

## Gaps

- CI did not run: the org billing lock.
- Matching is still a substring, not a prefix, as before. The help text says "prefix".
- Ships only at the next CLI release, with Zach's go.
