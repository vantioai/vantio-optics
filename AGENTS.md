# Agents

Operating guide for Cursor cloud agents in this repository. Product behavior stays in `docs/`. Contributor rules stay in [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Publishing stays in [docs/publishing.md](docs/publishing.md).

## Repo map

| Path | Role |
| --- | --- |
| `packages/vantio-cli` | `@vantio/cli`. `node --test`. CLI tests spawn `strace`. |
| `packages/vantio-agent-sdk` | `@vantio/agent-sdk`. Typecheck and TypeScript tests. |
| `packages/vantio-agent-sdk-py` | Python package `vantio-agent-sdk`. Outside the pnpm workspace. |
| `packages/vantio-optics-mcp` | `@vantio/optics-mcp`. |
| `extensions/vantio-optics` | Editor extension. Its `package.json` has no `test` script. |
| `examples/adapters` | Adapter examples. Not listed in `pnpm-workspace.yaml`. |
| `docs/` | Product, privacy, and publishing docs. |
| `scripts/check_open_core_drift.py` | Comparison run by `.github/workflows/open-core-drift.yml`. |
| `.github/workflows/ci.yml` | Install, lint, typecheck, test, and build. |
| `.github/workflows/publish.yml` | `workflow_dispatch` only. Upload jobs are disabled. |
| `.github/workflows/open-core-drift.yml` | Drift check on pull requests and pushes to `main`. |
| `.cursor/rules/` | Agent rules: workflow, tests, evidence, safety, claims. |

Root `package.json` pins `packageManager` to pnpm `11.13.0` and `engines.node` to `>=22`. The pnpm workspace is the three packages in `pnpm-workspace.yaml`.

Read `docs/publishing.md` before editing `packages/` or `extensions/vantio-optics`. The drift script compares those trees with another checkout.

## Commands

Verified in this repository. The run log is [evidence/cloud-agent-standard.md](evidence/cloud-agent-standard.md).

Install JavaScript dependencies:

```bash
pnpm install --frozen-lockfile
```

JavaScript tests. `strace` must be on `PATH`.

```bash
pnpm test
```

Python dependencies from the CI test job, then Python tests:

```bash
python3 -m pip install --disable-pip-version-check requests httpx aiohttp urllib3 build
pnpm test:python
```

`pnpm test:python` runs `python3 -m unittest discover -s packages/vantio-agent-sdk-py/tests -t packages/vantio-agent-sdk-py -v`.

Typecheck. There is no root `typecheck` script. CI runs these two. There is no Python typecheck script.

```bash
pnpm --filter @vantio/agent-sdk run typecheck
pnpm --filter @vantio/agent-sdk run typecheck:test
```

Lint. Root `lint` also runs the two typecheck scripts.

```bash
pnpm lint
```

Build. CI runs this after the tests.

```bash
pnpm build
```

Secret scan. This repository has no secret-scan package and no secret-scan CI job. The command is a filename-only `git grep` plus a tracked-name check. It exits 0 when nothing matches. On a match it prints filenames and exits 1. It does not print matching lines.

```bash
if git grep -lEI 'AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-ant-api|sk-proj-' -- . ':!pnpm-lock.yaml'; then
  echo "secret-scan: pattern matched" >&2
  exit 1
fi
tracked=$(git ls-files '*.pem' '.env' '.env.*' '*.key')
if [ -n "$tracked" ]; then
  printf '%s\n' "$tracked" >&2
  echo "secret-scan: tracked secret-like filenames" >&2
  exit 1
fi
echo "secret-scan: no pattern matched"
```

## Definition of done

- One scope. The diff is small enough to review in one pass.
- The pull request is a draft and stays a draft. Leave `main` unpushed. Leave the pull request unmerged.
- Run the existing test commands in this file before adding tests.
- Add tests for every change, including a negative case. Show the commands and results in the evidence file.
- `evidence/<name>.md` records the commands, return codes, git shas, and a gap list of what only a lab host or a human can prove.
- The secret-scan command exits 0.
- Keep secrets, keys, tokens, and customer data out of code, logs, prompts, and pull request text.
- Skip live payments, tags, publishes, deploys, workflow dispatches, and cloud runs.
- State only what a test or log from that run proves. List policy questions for owners.

`CONTRIBUTING.md` still applies: no TypeScript `any`, no prompts or completions in telemetry, no `package-lock.json` or `yarn.lock`, and no kernel or eBPF material. `SECURITY.md` remains the vulnerability report path.
