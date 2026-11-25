# VAN-393: Python MCP awareness leaves other child input alone, and enforce covers communicate()

Branch `engineering/van-393-optics-python-mcp-awareness-changes`, from vantio-optics `main` at `8bee543`. Mirror: vantio-open-core PR on the same branch name. CLI package: the Python wrap, a test and the README. Nothing tagged or published.

## Finding

Found by an independent review (fresh session) and reproduced here.

1. `python-wrap/mcp_awareness.py` replaced `stdin.write` on every `Popen(stdin=PIPE)`. It held all data until a newline and ran one `node` check per line before forwarding it, so every child process was affected, not only MCP servers. `cat` got nothing for a write with no newline, and 200 lines took 8.29 s.
2. `--mcp-enforce` was bypassed by `communicate()` and `subprocess.run(input=...)`, which write with `os.write`, and also by direct `os.write` and `asyncio`.

## What changed

- **New `_Gate`, per child.**
  - A line whose first non-blank byte is not `{` is forwarded byte for byte as it arrives.
  - A `{` line is held until its newline. If it isn't JSON-RPC (no `"jsonrpc"`), it's forwarded without a check.
  - A JSON-RPC line, in observe mode, is forwarded first and then checked (log only).
  - In enforce mode, a JSON-RPC line is checked first, and a blocked line is withheld, with the fixed error put on the child's stdout as before.
- `writelines` is wrapped too.
- **`_AwarePopen.communicate()`** filters its input through the same gate. Withheld lines' errors are put in front of the returned stdout. The inner write is not filtered twice.
- **README:** says what `--mcp-enforce` covers in Python, and what it doesn't (`os.write` on the pipe, `asyncio` children). It also says that without the SDK, MCP awareness still checks JSON-RPC lines. **Public copy: needs council review, Kate's wording, and Zach's go.**
- **New `test/python-mcp-awareness-stdin.test.js` (3):**
  - `cat` echoes a partial write at once.
  - 200 lines in under 1 s.
  - A text-mode `communicate()` and `run(input=)` with JSON-looking non-RPC lines echo unchanged.
  - Enforce withholds the frame (and keeps the surrounding lines) via `run(input=)`, text `communicate()` and `writelines()`, with no canary in the log.
  - Observe still logs a `communicate()` frame, and the child gets it.

## Commands

| Command | rc | Result |
| --- | --- | --- |
| New tests | 0 | 3 pass. On `main`'s wrap all 3 fail |
| Existing `test/mcp-awareness-pack.test.js` | 0 | 4 pass, including the Python observe and enforce test |
| The review's repro scripts under `vantio run` | | partial-line echo `b'hello'`; 200 lines in 0.00 s; enforce withholds `run(input=)`, `communicate` and `writelines`; `os.write` still passes (documented) |
| Every `ci.yml` JavaScript step, one at a time | 0 each | CLI tests 182 pass, 1 skipped, 0 fail |
| Root tests, `llms-full.txt` check, AGENTS.md secret scan | 0 | |

## Gaps

- Not covered, and now said in the README: bytes written with `os.write` on the pipe, and children started with `asyncio` (so probably the official MCP Python stdio client, not confirmed). Covering those needs a different hook, such as a stdio relay.
- In observe mode, a JSON-RPC line still costs one `node` check after it's forwarded.
- CI did not run: the org billing lock (VAN-129). The drift check compares `packages/vantio-cli` with open-core `main`, so this and the mirror go together.
- Ships only at the next CLI release, with Zach's go.

## Follow-up, Nov 24: a held line is bounded at 256 KiB

Review note on `ef8bb03`: a stdin line that starts with `{` was held until its newline with no size limit (a `cat` child got none of a 301 KB line until `close()`). The Node library stops at `MAX_FRAME` (256 KiB).

Change, in `bin/python-wrap/mcp_awareness.py` only:

- The gate holds at most 256 KiB of a `{` line.
- Observe: past the bound it forwards what it held and the rest of the line as it arrives, and logs one `oversize` gap.
- Enforce: past the bound it keeps nothing, withholds the line up to its newline (or `close()`), and answers with the fixed error.

| Command | rc | Result |
| --- | --- | --- |
| `node --test test/python-mcp-awareness-stdin.test.js` | 0 | 5 pass (2 new) |
| The 2 new tests on `ef8bb03`'s wrap | 1 | both fail: the child had 0 bytes before the newline; the gate held 300 067 bytes |
| Every `ci.yml` JavaScript step, one at a time | 0 each | CLI 185 tests, 184 pass, 1 skipped, 0 fail; optics-mcp 8 pass; agent-sdk 42 pass; lint, typecheck and build rc 0 |

Negative case in the new tests: a `{` line just under the bound reaches the child unchanged and logs no gap.

Gaps:

- In enforce mode a line over 256 KiB that starts with `{` is withheld even when the child is not an MCP server. That is the same rule the Node side uses. The README does not say it yet; that wording is Kate's.
- VAN-406 (the HTTP side) is not decided. This follows the Node stdio rule, not a new one.
- CI did not run: the org billing lock (VAN-129). Local runs stand in for it.
