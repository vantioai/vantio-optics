# SECURITY.md mirrors open-core's disclosure policy (VAN-169)

Branch `engineering/van-169-securitymd-disclosure-policy-in-the`, from vantio-optics `main` at `8bee543`. No VM run. No workflow dispatch. Nothing tagged, published or deployed.

## Finding

vantio-optics already had a `SECURITY.md`, but its text was not open-core's policy. The last line told reporters not to use this repository for Phantom Engine issues and did not say where to send them. Open-core's policy sends those reports to security@vantio.ai as well.

The org `.github` repository was not reachable from this session (the session cannot attach a repository whose name starts with a dot), so no org-level default was drafted. That part of VAN-169 is still open.

## What changed

- `SECURITY.md`: now byte-identical to vantio-open-core `main:SECURITY.md` (last changed there in `cfd3839`; sha256 `e505f07b97b892bf0b1224489535f88728a94a2bb145a2160dae6bb9937560f2`). Reports go to security@vantio.ai, or a private GitHub Security Advisory where enabled. It keeps "We do not promise a response time." It adds no response time and no bug bounty.
- New `test/security-policy.test.js`: pins that sha256, checks the security@ address, the Phantom Engine routing line and the no-response-time line, and fails on wording that promises a response time, a fix or a bounty. Added to the root `pnpm test` script.

## Commands

Node 22.23.5, pnpm 11.13.0, Python 3.13.

| Command | rc | Result |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | |
| `pnpm lint` | 0 | |
| `node --test test/agent-docs.test.js test/open-core-drift-workflow.test.js test/security-policy.test.js` | 0 | 9 pass, 0 fail (4 new) |
| `pnpm --filter @vantio/optics-mcp run test` | 0 | 8 pass |
| `pnpm --filter @vantio/agent-sdk run test` | 0 | 42 pass |
| `pnpm --filter @vantio/cli run test` | 1 | Fails on this host on `main` too, with the same kind of failure. The failing subtests are network and timing ones (`PAID_MODE ... blocked_hosts`, `http2`, telemetry) and change from run to run: three runs gave 1, 1 and 2 failing top-level tests. This change touches no CLI file. |
| `pnpm test` | 1 | Stops at the CLI test above, so the later commands were run one by one (rows above). |
| `pnpm test:python` | 0 | 128 tests OK, 10 skipped |
| `pnpm build` | 0 | |
| AGENTS.md secret scan | 0 | no pattern matched |

## Mutations (each restored after)

| Mutation in `SECURITY.md` | Caught by |
| --- | --- |
| M1: Phantom Engine line changed to "Do not use this repository for those." | `SECURITY.md is open-core's disclosure policy`, `a changed line is caught` |
| M2: "We respond within 3 business days." | same two tests |
| M3: mailbox changed to another address | same two tests |
| M4: heading case changed (`Security Policy`) | `SECURITY.md is open-core's disclosure policy` |

## Gaps

- The org `.github` default `SECURITY.md` is not drafted: that repository was not reachable here.
- Closed on Nov 22 (see below): CI now runs the root `test/` files.
- The hash pins open-core's text as read on 2026-11-21. If open-core's policy changes, this test fails until the two are brought back in line, which is the point.
- Whether security@vantio.ai exists and is monitored is VAN-149. This PR stays a draft until then.
- Public-facing wording: needs council review and Kate's sign-off, and Zach's go to merge.

## Follow-up, Nov 22: CI runs the root tests

The builder pre-review noted that `ci.yml` ran package tests only, so a later
pull request could change `SECURITY.md` and CI would stay green.

- `ci.yml`, job `lint-and-test-js`: new last step `Test repository checks`,
  `node --test test/*.test.js`. No `if`, no `continue-on-error`, no secret,
  no new action. It runs the three existing root test files.
- `test/security-policy.test.js`: two new tests. The JS job must have that
  step, unconditional and without `continue-on-error`. Negative cases: the
  step removed, `continue-on-error: true`, and an `if:` are each reported.

| Command | rc | Result |
| --- | --- | --- |
| `node --test test/*.test.js` | 0 | 11 pass, 0 fail (2 new) |
| `python3 -c "import yaml; yaml.safe_load(...)"` on `ci.yml` | 0 | parses |
| AGENTS.md secret scan | 0 | no pattern matched |

| Mutation (restored after) | Caught by |
| --- | --- |
| Step removed from `ci.yml` | both new tests |
| `continue-on-error: true` on the step | both new tests |
| Step runs `test/agent-docs.test.js` only | both new tests |
| `if: false` on the step | both new tests |
| Checker ignores `continue-on-error` | the negative test |

The package suites are unchanged by this commit; this pull request's CI runs
them.
