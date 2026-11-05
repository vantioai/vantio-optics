# Evidence: cloud agent operating guide

Install, tests, typecheck, lint, and build ran on commit `854d968e6f015e85bbd5c0fb1b75fe4613b0b5dc` (`origin/main` at the time of the run). The documentation in this change was not in that commit. After those files were in the worktree, the secret scan below ran against the same parent commit. `git status --short` before the documentation files existed was empty (return code 0).

## Host

| Command | Return code | Output |
| --- | --- | --- |
| `node -v` | 0 | `v22.23.4` |
| `pnpm -v` | 0 | `11.13.0` |
| `python3 --version` | 0 | `Python 3.12.3` |
| `strace -V` | 0 | `strace -- version 6.8` |

`strace` was not installed. `sudo apt-get install -y strace` exited 0, then `strace -V` printed the line above. CLI tests spawn `strace`.

## Commands

| Command | Return code | Result |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | Lockfile install finished. |
| `python3 -m pip install --disable-pip-version-check requests httpx aiohttp urllib3 build` | 0 | Install finished. `urllib3` was already present. |
| `pnpm test` | 0 | `@vantio/cli`: 175 tests, 175 pass, 0 fail, 0 skipped. `@vantio/optics-mcp`: 5 tests, 5 pass, 0 fail, 0 skipped. `@vantio/agent-sdk`: 42 tests, 42 pass, 0 fail, 0 skipped. |
| `pnpm test:python` | 0 | `Ran 126 tests in 43.576s` then `OK (skipped=2)`. |
| `pnpm --filter @vantio/agent-sdk run typecheck` | 0 | `tsc -p tsconfig.json --noEmit` |
| `pnpm --filter @vantio/agent-sdk run typecheck:test` | 0 | `tsc -p tsconfig.test.json` |
| `pnpm lint` | 0 | CLI `node --check`, MCP `node --check`, and both typecheck scripts. |
| `pnpm build` | 0 | `@vantio/agent-sdk` build script. |
| Secret scan command in `AGENTS.md` | 0 | `secret-scan: no pattern matched` |

The two skipped Python tests printed `skipped 'pycurl is not installed'` and `skipped 'pycurl is not installed; its success path stores no HTTP status'`.

## Shas

- `854d968e6f015e85bbd5c0fb1b75fe4613b0b5dc` — parent commit. Install, tests, typecheck, lint, build, and the secret scan ran from that parent.
- `362cb715aee5efa5534000c667f5d9718c80d635` — commit that added the guide, rules, and the first copy of this file. Recording that hash is a later commit. The pull request head is that later commit.

## Gap list

This run does not prove:

- Python 3.10 or Python 3.11. `.github/workflows/ci.yml` lists both. This host ran Python 3.12.3 only.
- The two skipped Python tests. `pycurl` is not installed. The CI install step does not install `pycurl` either. This run did not execute those tests.
- `scripts/check_open_core_drift.py`. It needs a second checkout. This diff does not touch `packages/` or `extensions/vantio-optics`.
- GitHub Actions. No workflow was dispatched.
- `extensions/vantio-optics` and `examples/adapters`. Root scripts do not test them, and this run did not execute them.
- A machine without `strace`.
- Any secret scanner other than the `git grep` command in `AGENTS.md`. No scanner package or secret-scan job is configured here.
- An automated test for these documentation files, including a negative case. This change does not add one.

## Policy questions for owners

- Should a documentation-only rules change add an automated test with a negative case?
- Is the `git grep` command in `AGENTS.md` the secret scan to keep, or should a later change add a scanner outside this diff?
- Should a future change add `.cursor/environment.json`? This repository has none, and this change does not add one.
