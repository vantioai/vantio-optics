# VAN-386: stale seen.lock, and MCP awareness on event streams

Branch `engineering/van-386-optics-cli-mcp-awareness-breaks-cancel`, from vantio-optics `main` at `8bee543`. Mirror: vantio-open-core PR on the same branch name. CLI and Python SDK source. Nothing tagged or published.

## Finding

Found by an independent review (fresh session) and reproduced here.

1. **The seen-host lock never recovers.** It is a bare `mkdir`, and a process killed while holding it leaves it behind. After that, every in-scope call waited the full 2 s, spinning the CPU. In Node it was tried twice per call, so about 4 s per fetch, with the event loop blocked. Python waited about 2 s per call. Before this change: `times 4047,4005` ms for two fetches.
2. **MCP awareness held event streams open.** It cloned every `text/event-stream` response and read the clone to the end. A tee keeps the source open until both branches finish, so the caller's `reader.cancel()` never finished, and the server kept streaming until the process exited.

## What changed

- **Node** (`optics-features.cjs`) and **Python** (`_http_observe.py`):
  - A lock older than 10 s is taken over. It is renamed aside first, put back if it turns out to be fresh, then removed.
  - The wait between tries sleeps 5 ms instead of spinning.
  - A live (fresh) lock is still never taken.
- **Awareness** (`mcp-awareness-register.js`):
  - An event-stream response is not cloned. It writes a `GAP` record with reason `stream_not_inspected`.
  - A JSON response whose declared `content-length` is over the 256 KiB cap writes `oversize` without cloning.
  - Other JSON responses are inspected as before.
- **Tests:**
  - `packages/vantio-cli/test/seen-lock-sse.test.js` (3): a stale lock is taken over (two fetches under 1.5 s, lock released, destination recorded); a fresh lock is left in place and the call still completes; with awareness loaded the way `vantio run node` loads it, `cancel()` finishes in under 1 s, the server sees the close after under 20 events, and the gap record is written.
  - `packages/vantio-agent-sdk-py/tests/test_van386_seen_lock.py` (3): the same stale and fresh cases, plus the helper.

## Commands

Node 22.23.5, pnpm 11.13.0, strace installed. Python 3.10.x, 3.11 and 3.12 venvs with CI's packages.

| Command | rc | Result |
| --- | --- | --- |
| New Node tests | 0 | 3 pass. On `main`'s code: 2 fail (`times 4047,4005`; cancel never finished) |
| New Python tests | 0 | 3 pass. On `main`'s code, with a stub helper: 2 fail |
| Every `ci.yml` JavaScript step, one at a time | 0 each | CLI tests 182 pass, 1 skipped, 0 fail |
| Python SDK suite on 3.10 / 3.11 / 3.12 | 0 | 131 OK, 2 skipped each |
| AGENTS.md secret scan | 0 | no pattern matched |

## Gaps

- **Behaviour change for awareness:** a server's event-stream reply over HTTP is no longer inspected. It is recorded as a gap instead. Inspecting it without holding the stream needs a non-tee reader and is a separate change. Requests and stdio are inspected as before.
- **Takeover race:** if a process takes over a stale lock at the same moment another one does, both may briefly hold it. Moving the lock aside first, and putting a fresh one back, narrows this. The worst case is one lost update to `seen-destinations.json`, so a destination shows as new once more.
- CI did not run: the org billing lock (VAN-129). The drift check compares these packages with open-core `main`, so this and the mirror go together.
- Ships only at the next release, with Zach's go.
