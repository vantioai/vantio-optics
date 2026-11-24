# VAN-407: vantio run writes a call recorded by name only once

Branch `engineering/van-407-optics-cli-vantio-run-writes-one-node-or`, from vantio-optics `main` at `8bee543`. Mirror: vantio-open-core PR on the same branch name, from `1beaf36`. CLI and Python SDK source. Nothing tagged or published.

## Finding

Found in the Nov 24 review. On Linux, `vantio run` reads `/proc` while the program runs. When the program exits, `recordWrappedRun()` adds a `proc_socket` call for each socket destination that is not already in the run file. A socket's destination is a name only when `/etc/hosts` lists its IP, otherwise it is the raw IP. The interceptor (Node) and the SDK (Python) record an in-scope call by host name, so the same call was written again under its IP.

Reproduced on `main`, with a host that resolves to the machine's non-loopback address 192.0.2.2 and is not in `/etc/hosts`:

- Node, one POST with `http.request`: the CLI printed "LLM calls: 1". The run file had 2 calls, `llm.example.test` (status 200) and `192.0.2.2` (`proc_socket`). `summary.total_calls` was 2 and `summary.hosts` listed both, but `summary.by_host` had only the name. `vantio tail` printed both rows.
- Python 3.12 with this SDK, one `urllib` POST under `vantio run`: 2 calls, `llm.example.test` (`python_urllib`) and `192.0.2.2` (`proc_socket`).

## What changed

- Node (`interceptor.cjs`): the existing `net.Socket.prototype.connect` wrapper notes, for a connection to an in-scope host name, the socket's remote address and port once it connects. Each call to that host gets `remote_addresses`, such as `[{"address": "192.0.2.2", "port": 443}]`. At most 64 addresses per host and 256 hosts.
- Python (`_http_observe.py`): `socket.getaddrinfo` is wrapped while observing. For an in-scope host it notes the addresses and ports DNS returned. Each call to that host gets `remote_addresses` in the run file. Same caps. The wrapper is removed when observing ends.
- `optics-proc.cjs`: each sampled socket keeps its IP, and `canonicalIp()` gives one spelling for an address (IPv6 as eight groups, IPv4-mapped IPv6 as dotted IPv4).
- `optics-features.cjs`: `recordWrappedRun()` skips a socket whose IP and port appear in a recorded call's `remote_addresses`. Every other socket is still added, including another port on the same IP.

A call with no known address has no `remote_addresses` key. The record docs get a "Roadmap" note in a separate public-copy PR.

## Tests

- `packages/vantio-cli/test/run-socket-dedupe.test.js` (4): `canonicalIp()` spellings, including a `/proc/net/tcp6` row; `recordWrappedRun()` skips the listed socket and still adds another port and another IP (negative case); end to end, `vantio run node` with a call to a name that resolves to this machine's non-loopback IP writes one call with `remote_addresses`; end to end, a socket to a host that is not in scope is still a `proc_socket` row (negative case). The two end-to-end tests skip when the machine has no non-loopback IPv4 address or is not Linux.
- `packages/vantio-agent-sdk-py/tests/test_van407_remote_addresses.py` (3): a named call lists the address DNS gave; a host that is not in scope is not listed; `socket.getaddrinfo` is put back when the shield ends.

Mutation check: with the four source files back on `main`, three Node tests fail and the out-of-scope test (negative case) passes; the three Python tests fail or error (the helpers do not exist on `main`).

## Commands

Run on the working tree of this commit. Node 22.23.5, pnpm 11.13.0.

**vantio-optics**

| Command | rc | Result |
| --- | --- | --- |
| `corepack pnpm install --frozen-lockfile` | 0 |  |
| `pnpm --filter @vantio/cli run lint` | 0 |  |
| `pnpm --filter @vantio/optics-mcp run lint` | 0 |  |
| `pnpm --filter @vantio/agent-sdk run typecheck` | 0 |  |
| `pnpm --filter @vantio/agent-sdk run typecheck:test` | 0 |  |
| `pnpm --filter @vantio/cli run test` | 0 | 183 pass, 0 fail |
| `pnpm --filter @vantio/optics-mcp run test` | 0 | 8 pass, 0 fail |
| `pnpm --filter @vantio/agent-sdk run test` | 0 | 42 pass, 0 fail |
| `pnpm --filter @vantio/agent-sdk run build` | 0 |  |
| `node --test test/*.test.js` | 0 | 5 pass, 0 fail |
| `node scripts/check_llms_full.mjs` | absent |  |
| Python 3.10 `-m unittest discover -s packages/vantio-agent-sdk-py/tests -t packages/vantio-agent-sdk-py` | 0 | 131 run, OK (skipped=2) |
| Python 3.11, same suite | 0 | 131 run, OK (skipped=2) |
| Python 3.12, same suite | 0 | 131 run, OK (skipped=2) |
| secret scan (`git grep` patterns from the repo rules) | 0 |  |
| `llms-full.txt` against the manual pages | 0 |  |
| `python3 scripts/check_open_core_drift.py <open-core mirror worktree>` | 1 | (only `packages/vantio-optics-mcp/src/server.js`, the known VAN-310 drift) |

**vantio-open-core mirror**

| Command | rc | Result |
| --- | --- | --- |
| `corepack pnpm install --frozen-lockfile` | 0 |  |
| `pnpm --filter @vantio/cli run lint` | 0 |  |
| `pnpm --filter @vantio/cli run test` | 0 | 183 pass, 0 fail |
| `pnpm --filter @vantio/optics-mcp run lint` | 0 |  |
| `pnpm --filter @vantio/optics-mcp test` | 0 | 5 pass, 0 fail |
| Python 3.10 `-m unittest discover -s tests -t .` (in `packages/vantio-agent-sdk-py`) | 1 | 131 run, FAILED (failures=1, skipped=2) (fails: `test_wheel_and_sdist_runtime_sources_match`) |
| Python 3.11, same suite | 1 | 131 run, FAILED (failures=1, skipped=2) (fails: `test_wheel_and_sdist_runtime_sources_match`) |
| Python 3.12, same suite | 1 | 131 run, FAILED (failures=1, skipped=2) (fails: `test_wheel_and_sdist_runtime_sources_match`) |
| `node scripts/release/ws11/verify.mjs --emit` | 0 |  |
| `git status --porcelain` the same before and after `--emit` | 0 |  |

## Gaps

- CI did not run: the org billing lock (VAN-129).
- Python records DNS answers, not the connected socket. A client that resolves names without `socket.getaddrinfo` (for example aiodns) is not covered and still gets the extra row.
- Not tested with IPv6 (this machine has none).
- Ships only at the next CLI and SDK releases, with Zach's go.
