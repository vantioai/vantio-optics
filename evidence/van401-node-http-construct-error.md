# VAN-401: a node:http request that throws while it is created is an error record

Branch `engineering/van-401-optics-cli-a-nodehttp-request-that`, from vantio-optics `main` at `8bee543`. Mirror: vantio-open-core PR on the same branch name. CLI source only. Nothing tagged or published.

## Finding

Found in this review and reproduced on `main`: `https.request({ hostname: "api.openai.com", headers: { "bad header": "x" } })` throws `ERR_INVALID_HTTP_TOKEN` to the caller, but the run file keeps a call with `ok: true`, `status: null`, and `summary.errors` is 0. The wrapper's catch also called the original `request` a second time: an option getter was read twice under the interceptor and once without it.

## What changed

- `wrapLaunch` in `packages/vantio-cli/bin/interceptor.cjs`: when creating the request throws, the record gets `ok: false` and the error code, and the error goes to the caller.
- `http.request`, `http.get` and `new http.ClientRequest` (and the `https` ones) fall back to the original only when the wrapper failed before calling it. An error from the original reaches the caller once.

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

New tests (`packages/vantio-cli/test/node-http-construct-error.test.js`, 2): for `request`, `get` and `new ClientRequest` with a bad header, the caller sees the same error code and the same number of option reads as plain Node, and the run file has 3 `ok: false` calls with `ERR_INVALID_HTTP_TOKEN` and `summary.errors` 3; a normal request is still recorded with status 200.

Mutation check: with `interceptor.cjs` back on `main`, the first test fails; the second (negative case) passes on both.

## Gaps

- CI did not run: the org billing lock.
- Ships only at the next CLI release, with Zach's go.
