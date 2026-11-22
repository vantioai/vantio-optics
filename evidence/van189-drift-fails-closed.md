# VAN-189: the open-core drift check fails when it cannot compare

Branch `engineering/van-189-claude-optics-open-core-drift-check`, from
`main` at `8bee543`.

## Finding

`.github/workflows/open-core-drift.yml` skipped the open-core checkout and
the compare when `OPEN_CORE_READ_TOKEN` was empty, logged a notice, and
passed. Run 44620410569 went green in 4 seconds without comparing anything.
`docs/publishing.md` says the workflow fails on drift.

## Change

- The token step now prints an `::error::` and exits 1 when the secret is
  empty. Only the presence is checked; the value is never printed. The
  checkout and compare steps keep their gates.
- The header comment says a missing token fails the job.
- `test/open-core-drift-workflow.test.js` checks that the missing-token
  branch exits 1 and reports an error. A new negative test feeds it the old
  notice-only step and expects both problems.

No secret was added and no repository setting changed. Until Zach adds the
token (VAN-78), this workflow fails on every pull request and push to
`main`. That is the decided behaviour.

## Commands

| Command | rc | Result |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | done |
| `pnpm test` | 1 | stops in `@vantio/cli`: 2 failed, 26 cancelled (strace network tests: `Node net.connect / tls.connect`, `Node-spawned curl`, `Node-spawned wget`; the run timed them out). This diff does not touch `packages/`. The later commands in the chain were run one by one below |
| `pnpm --filter @vantio/optics-mcp run test` | 0 | 8 pass |
| `pnpm --filter @vantio/agent-sdk run test` | 0 | 42 pass |
| `node --test test/agent-docs.test.js test/open-core-drift-workflow.test.js` | 0 | 6 pass (3 drift workflow tests) |
| `pnpm lint` | 0 | ok |
| `pnpm build` | 0 | ok |
| `pnpm test:python` | 0 | OK (10 skipped) |
| secret-scan command from `AGENTS.md` | 0 | no pattern matched |
| `python3 -c "import yaml; yaml.safe_load(...)"` on the workflow | 0 | parses |

## Mutations

| Mutation | Result |
| --- | --- |
| Remove `exit 1` from the missing-token branch | `drift workflow reads private open-core with a token and fails without it` fails |
| `::error::` back to `::notice::` | the same test fails |

No VM run. No workflow dispatch.

## Gaps

1. The workflow itself only runs on GitHub. Locally the YAML parses and the
   text test passes; the failing run on this pull request is the live check.
2. The drift job fails on every pull request until the token exists. CI on
   this repository is therefore not all green until VAN-78 is done.
3. The `@vantio/cli` strace tests did not finish on this loaded host. That
   package is not changed here.

## Pre-review follow-up (Nov 22)

The builder pre-review on the issue raised two points.

- Low: with `exit 1`, the `present == 'true'` gates on the checkout and
  compare steps are a second guard. The header comment now says so, so
  nobody drops the `exit 1` thinking the gates cover it. Comment only; no
  step changed.
- Medium: fork and Dependabot pull requests get no repository secrets, so
  this job stays red on them after VAN-78. No option was marked
  recommended, so the fail-closed one stands (red on those PRs). No code
  change. Zach can redirect.

| Command | rc | Result |
| --- | --- | --- |
| `node --test test/agent-docs.test.js test/open-core-drift-workflow.test.js` | 0 | 6 pass |
| `python3 -c "import yaml; yaml.safe_load(...)"` on the workflow | 0 | parses |
| secret-scan command from `AGENTS.md` | 0 | no pattern matched |

The rest of the suite runs in this pull request's CI.
