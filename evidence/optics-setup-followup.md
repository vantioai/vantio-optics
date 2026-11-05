# Optics setup follow-up evidence

Branch: `cursor/optics-setup-followup-ac75`  
Head SHA: `896f4d23d48c934834429855c4cb0cb7a97151d4`  
Base (main at start): `9925bf14a7d7666ef1ae7c86e779cab3f05b72f8`

Environment: Cloud agent VM, Node `v22.23.4`, pnpm `11.13.0` via corepack, Python `3.12.3`.

## Commands and return codes

| Command | Exit code |
| --- | ---: |
| `bash .cursor/cloud-install.sh` | 0 |
| `python3 -m json.tool .cursor/environment.json` | 0 |
| `pnpm lint` | 0 |
| `pnpm build` | 0 |
| `pnpm test` (includes `node --test test/agent-docs.test.js`) | 0 |
| `pnpm test:python` | 0 |
| AGENTS.md secret-scan snippet (git grep + tracked-name check) | 0 |

## Docs test scope

- `scripts/check_agent_docs.mjs` validates repo-map paths and command references in `AGENTS.md`, plus path-like backtick references in `.cursor/rules/*.mdc`.
- `test/agent-docs.test.js` runs the checker on the real tree and includes a negative case with an in-memory repo map row pointing at a missing path.

## Secret scan policy

No change to the AGENTS.md secret-scan command or patterns in this follow-up.

### Gaps (scan policy — not changed here)

- The scan is documented in `AGENTS.md` only; CI does not run it (also stated in `AGENTS.md`).
- Filename-only `git grep -l` avoids leaking matches but does not scan untracked or ignored files.
- The regex list is fixed; formats not in the pattern are not detected.
- Tracked-name check covers `*.pem`, `.env`, `.env.*`, and `*.key` only.

## Gap list (human or lab only)

- Whether a Cursor **environment build** succeeds from `.cursor/environment.json` on Cursor infrastructure (this run exercised `cloud-install.sh` directly on the agent VM, not a published build snapshot).
- Whether `strace`-dependent CLI tests behave the same on macOS or distros without `strace`.
- Full Python matrix (`3.10`, `3.11`, `3.12`) as in `.github/workflows/ci.yml`; this run used the host `python3` only.
- Open-core drift (`scripts/check_open_core_drift.py`) requires a second checkout of the comparison repository.
- Publishing, tags, deploys, and `workflow_dispatch` on `.github/workflows/publish.yml` remain owner-controlled policy.
- Whether every path mentioned outside the repo map (for example links in the `AGENTS.md` intro) should be in scope for the docs checker — product owners decide.
