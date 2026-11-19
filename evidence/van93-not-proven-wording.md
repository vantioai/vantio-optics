# VAN-93: NOT_PROVEN-safe wording for Phantom Engine mentions

Branch `ccr-van93-not-proven-wording`, from `origin/main`.

## Sweep

`git grep -niE` over `*.md`, `*.json`, `*.yml` for blocks / enforces /
prevents / stops / denies / kills / enforcement / runtime protection.
Lines that only say Optics does not block, or that point enforcement at
Phantom Engine without describing it ("Enforcement is Phantom Engine"), were
left alone.

| File | Line | Found | Action |
|---|---|---|---|
| README.md | 55 | "Phantom Engine is enforcement and runtime protection for Linux systems you enroll." | Changed in this PR |
| docs/products/optics/SUPPORTED-PATHS.md | 5 | "Phantom Engine is the product that enforces on enrolled Linux systems." | Changed in this PR |
| docs/products/optics/USER-MANUAL.md | 7 | "Phantom Engine is the separate product that enforces." | Changed in this PR |
| packages/vantio-agent-sdk/README.md | 5 | "Phantom Engine … enforces rules on the wrapped path and provides runtime protection on enrolled Linux" | Changed in this PR (council V210). Ships in the npm package only at the next publish, which needs Zach's go |
| packages/vantio-agent-sdk-py/README.md | 5 | "Phantom Engine is runtime protection on enrolled Linux" | Changed in this PR (council V210). Ships in the PyPI package only at the next publish, which needs Zach's go |
| packages/vantio-agent-sdk/README.md | 72 | "the SDK applies it locally" (application-path policy) | No change proposed: describes SDK code, not kernel enforcement |

## Runs

| Command | Exit |
|---|---|
| `node --test test/agent-docs.test.js` | 0 (3 pass) |
| `node scripts/check_agent_docs.mjs` | 0 |

## Gaps

- Public copy: Quinn (council), Kate (wording) and Zach (go) sign off before
  anything merges or publishes.
- `live_enforcement` stays NOT_PROVEN.
