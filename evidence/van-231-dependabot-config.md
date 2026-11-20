# Dependabot config for vantio-optics (VAN-231, part)

Ran on 2026-11-20 in a cloud container, on a tree whose parent is `origin/main` at the time of the run (sha in the PR). The commit that contains this file is the change. No workflow dispatch, no publish.

## Finding

No `.github/dependabot.yml` and no `renovate.json`, so no version-update PRs were opened.

## What changed

New `.github/dependabot.yml`, weekly, at most 5 open PRs per ecosystem:

| Ecosystem | Directory | Group |
| --- | --- | --- |
| npm | `/` (pnpm workspace) | minor and patch in one PR |
| github-actions | `/` | all actions in one PR |

No pip entry: `packages/vantio-agent-sdk-py/pyproject.toml` declares no install dependencies. No workflow, secret or permission changed.

## Checks

`/tmp/le-tools/dependabot_check.py` is a throwaway offline check written for this lane (not committed). It is not GitHub's own validation.

| Command | rc | Result |
| --- | --- | --- |
| `python3 dependabot_check.py .` | 0 | 0 findings |
| npm directory set to `/packages/nope` | 1 | does not exist |
| npm directory set to `/docs` | 1 | no npm manifest |
| empty `patterns` in the actions group | 1 | group has no patterns |
| `pnpm install --frozen-lockfile` | 0 | |
| `pnpm lint` | 0 | |
| `pnpm test` | 0 | all node test files pass, 0 fail |
| `pnpm test:python` | 0 | 128 tests OK, 10 skipped |
| AGENTS.md secret scan | 0 | `secret-scan: no pattern matched` |

## Gaps

- GitHub validates the file only after it is on the default branch; results show in the Dependabot tab.
- `pnpm build` and the two typecheck scripts were run only through `pnpm lint` (which runs both typechecks); `pnpm build` was not run. No code changed.
- Other repos in VAN-231 get their own PRs.
