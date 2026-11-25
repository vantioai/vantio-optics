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

## Follow-up, Nov 25 (UTC): fixes after the independent review of `2806c7a`

The review (newest "Independent review (fresh session)" comment on VAN-393) blocked `2806c7a`. This section covers its findings 1 to 4, 6, 8 and 9. Finding 5 (README wording) is listed for Kate. Finding 7 is old behavior and is left as a gap.

Change, in `bin/python-wrap/mcp_awareness.py`:

- **Observe never holds or rewrites child input.** The wrapped `write` hands the caller's own data to the pipe first, then the gate reads a copy to find JSON-RPC lines for the log. `communicate()` passes its input on unchanged.
- **Enforce holds only a line whose first non-blank byte is `{` or `[`**, from that byte to its newline, at most 256 KiB with the newline. Blanks before it are forwarded as they arrive and are not kept.
- **Finding 1.** `communicate()` checks whatever the gate still holds, then its input, then the tail, before stdin closes. `close()` always does the same. In enforce the error for a withheld tail is put in front of the returned stdout.
- **Finding 2.** Space, tab, CR, newline, vertical tab and form feed at the start of a line go to the child at once. The gate keeps at most 2 bytes there (a possible multi-byte blank such as a BOM).
- **Finding 3.** The bound is counted with the newline. A line of 262144 bytes is a normal line. At 262145 the line is oversize, and its own newline ends it, so the next line is checked as usual.
- **Finding 4.** The held line is parsed as JSON in Python. An object with a `jsonrpc` key (escaped or not) or an array that holds one goes to the Node helper. In enforce a line that starts with `{` or `[` and does not parse goes to the helper too. The helper decides everything sent to it. JSON without a `jsonrpc` key passes without starting `node`. A BOM, form feed or other blank that JavaScript's `trimStart` removes no longer hides a frame.
- **Finding 6.** Observe sends the caller's own text. Enforce decodes with an incremental UTF-8 decoder, so no write to a text pipe ends inside a character.
- **Finding 8.** The injected error is kept on the process until a `communicate()` call returns, so a timeout and retry still gets it.
- **Finding 9.** A `str` written to a binary pipe, or bytes written to a text pipe, raises `TypeError`.
- **README:** one sentence edited because it was no longer true (`[` lines are checked now, and observe holds nothing). Old: "Only lines that start with `{` are held and checked; other child input passes through unchanged." New: "Only lines that start with `{` or `[` are checked, and `--mcp-enforce` holds them until checked; other child input passes through unchanged." **Public copy: needs Kate.**

New tests in `test/python-mcp-awareness-stdin.test.js` (7). Each runs under plain `vantio run` and under `--mcp-enforce` unless said, child `cat`:

| Finding | Test | Negative case |
| --- | --- | --- |
| 1 | bytes written before communicate() with no input are not lost (observe), and are checked (enforce) | enforce: `{"a":1}` and a blank tail still reach the child |
| 2 | leading blanks reach the child at once and are never kept; a frame after blanks is still checked | a frame after blanks is withheld in enforce |
| 3 | a `{` line of 256 KiB minus 1 to plus 3 bytes never costs the next line | enforce: at 262143 and 262144 bytes plain JSON is unchanged |
| 4 | --mcp-enforce checks an escaped jsonrpc key, a batch, a frame after a BOM or form feed, and a line that does not parse | plain JSON objects and arrays pass in both modes, 200 lines in under 2 s, no log record |
| 6 | a text-mode line over the bound is not cut inside a multi-byte character | multi-byte text under the bound is unchanged in enforce |
| 8 | --mcp-enforce: the error survives a communicate() timeout and retry (enforce only) | no error when nothing was withheld |
| 9 | a str written to a binary pipe raises TypeError, as in plain Python | the right type is written and counted |

Commands, from the repository root unless said. Python 3.13.18, Node 22.23.5.

| Command | rc | Result |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | |
| `pnpm --filter @vantio/cli run lint` | 0 | |
| `pnpm --filter @vantio/cli run test` | 0 | 192 tests, 191 pass, 1 skipped, 0 fail |
| `pnpm --filter @vantio/optics-mcp run test` | 0 | 8 pass |
| `pnpm --filter @vantio/agent-sdk run test` | 0 | 42 pass |
| `node --test test/agent-docs.test.js test/open-core-drift-workflow.test.js` | 0 | 5 pass |
| `pnpm run test:python` | 0 | 128 tests OK, 2 skipped |
| `node --test test/python-mcp-awareness-stdin.test.js` (in `packages/vantio-cli`) | 0 | 12 pass |
| The same file with `2806c7a`'s `mcp_awareness.py` put back | 1 | the 5 old tests pass, all 7 new tests fail. File restored after |
| AGENTS.md secret scan | 0 | no pattern matched |
| The review's repro shapes as throwaway scripts, under `timeout`: plain `python3`, `vantio run python3`, `vantio run --mcp-enforce python3` | 0 each | Observe output is the same as plain `python3` for every probe (`diff` empty). Enforce: see below |

Probe results in enforce: a frame with no newline then `communicate()` returns the error and no frame; a lone space, CR, newline and 1,000,000 spaces reach the child at once; `after` and `last` survive at 262143 to 262147 bytes; the escaped key, batch, BOM, form feed and no-break space frames are withheld; `{"a":1}`, `[1,2,3]`, `[]` pass. A second script (1.5 MB of random bytes in random chunks, a mixed corpus written whole, one byte at a time, in random chunks and with `bufsize=0`, `print(file=)`, `json.dump`, `with p.stdin`, `io.TextIOWrapper`, `memoryview`, latin-1 text pipes, `BrokenPipeError`): observe output is the same as plain `python3`; in enforce the child's bytes are the same however the input is chunked. No log file held the canary.

Gaps:

- **Finding 7, not changed (old behavior, also on `main`).** After a withheld frame on `stdin.write`, the error only shows through `stdout.read()` called after the write, or through `communicate()`. `readline()`, `read1()`, iteration and `os.read` do not get it.
- **Finding 5, README, needs Kate.** Not rewritten beyond the one sentence above. See the VAN-393 comment for each sentence and a suggested replacement.
- Enforce now withholds, from any child, a line that starts with `{` or `[` and is not valid JSON (for example a shell line `{ echo hi; }`, a Python dict repr, or the first line of pretty-printed JSON). The helper answers `malformed_json`. This is the fail-closed rule asked for after the review. At `2806c7a` such a line passed unless it held the text `"jsonrpc"`. The README does not say it.
- In enforce a `{` or `[` line with no newline is still held until its newline, `close()`, `communicate()` or 256 KiB.
- An object with a `method` key and no `jsonrpc` key is not sent to the helper in either mode.
- Enforce does not check a frame that follows a non-blank byte on its line. Seen in the probes: a broken UTF-8 byte (`0xC2`, `0xFF`), a NUL, or `xxx` before the frame. `main` withheld the first kind (any line that is not valid UTF-8) and passed the other two.
- `{`, a newline, then the rest of a frame: enforce withholds the `{` line and the rest reaches the child.
- Still not covered in enforce (seen in a probe): `os.write` on the pipe, `stdin.buffer.write` on a text pipe, `stdin.raw.write`, a file object on a duplicate of the descriptor. `asyncio` children were not run here.
- In enforce each checked line costs one `node` start. In observe each JSON-RPC line costs one after it is forwarded.
- Not run: the official MCP Python client against a real MCP server, macOS, Windows, other Python versions, threads writing to one pipe, non-blocking pipes. Memory was read from the gate's buffer lengths, not measured on the process.
- CI did not run: the org billing lock (VAN-129). Local runs stand in for it.

## Follow-up 2, Nov 25 (UTC): fixes after the independent review of `20db6af`

The review (newest "Independent review (fresh session)" comment on VAN-393) passed `20db6af` with notes N1 to N9. The owner asked for N1 ("Fix the method key") and the other recommended fixes. This section covers N1, N3, N5, N6, N8 and the README (N9). N2 stays as it is by owner decision (keep strict). N4 and N7 are gaps. All runs below are on the working tree on top of `20db6af`, before the commit.

Change, in `bin/python-wrap/mcp_awareness.py`:

- **N1.** An object with a `method` key and no `jsonrpc` key goes to the Node helper like a JSON-RPC line, in both modes. So does an array that holds one, at any depth. `--mcp-enforce` withholds a `tools/call` without the key (the helper answers `server_unlisted` with the request id). An object with neither key passes without starting `node`.
- **N6.** In enforce, up to 4 bytes of broken UTF-8 right before a `{` or `[` are held with the line and the whole line goes to the helper, which answers `invalid_utf8`. An array is searched at any depth (the limit of 8 is gone), so a frame in a batch nested 10 deep goes to the helper, which answers `batch_rejected`. A line whose broken bytes are followed by anything else passes as before.
- **N3.** Observe now runs the helper only after the bytes are handed over: after a write to an unbuffered or line-buffered pipe, after `flush()`, after `close()` and after `communicate()`. Lines wait in a queue of at most 64 lines or 1 MiB; when it is full the helper runs at once. The docstrings say this.
- **N5.** When enforce withholds a frame on `stdin.write` and stdout is not a pipe, stderr gets the same line as the `communicate()` path: `mcp frame withheld (stdout not captured)`.
- **N8.** `writelines()` on a closed stdin raises Python's own `ValueError` text (the unwrapped `writelines([])` is called first).

New tests in `test/python-mcp-awareness-stdin.test.js` (5; 17 in the file). Child `cat` unless said.

| Note | Test | Negative case |
| --- | --- | --- |
| N1 | an object with a method key and no jsonrpc key goes to the helper, also inside a batch; --mcp-enforce withholds it | objects with neither key pass in both modes and `node` is not started |
| N6 | --mcp-enforce withholds a frame after a broken UTF-8 byte and a batch nested 10 deep; binary lines still pass | binary lines (JPEG-like header, `0xFF` text, `©`, `é{x`, bytes 128 to 255, a nested number array) are unchanged in both modes and `node` is not started |
| N3 | observe: the child gets a JSON-RPC line before the helper runs (flush, unbuffered write, close, communicate) | plain lines and plain JSON do not start `node` |
| N5 | --mcp-enforce: a frame withheld on stdin.write prints the notice when stdout is not a pipe | no notice when nothing is withheld, and none in observe |
| N8 | writelines() on a closed stdin raises ValueError with plain Python's text | an open stdin is written as before |

How "node was not started" is shown: the test agent puts its own `node` first on `PATH`. That script appends one line to a file each time it starts, then runs the real `node`. The test reads the line count before and after the negative lines; the difference is 0. For the positive lines the count is 3 (N1). The N3 test uses the same script with a 2 s wait: the child's first byte arrives in under 1.5 s and the call returns after 1.9 s or more.

Commands, from the repository root unless said. Python 3.13.18, Node 22.23.5.

| Command | rc | Result |
| --- | --- | --- |
| `pnpm --filter @vantio/cli run lint` | 0 | |
| `pnpm --filter @vantio/cli run test` | 0 | 197 tests, 196 pass, 1 skipped, 0 fail |
| `pnpm --filter @vantio/optics-mcp run test` | 0 | 8 pass |
| `pnpm --filter @vantio/agent-sdk run test` | 0 | 42 pass |
| `pnpm run test:python` | 0 | 128 tests OK, 2 skipped |
| `node --test test/*.test.js` | 0 | 5 pass |
| `node --test test/python-mcp-awareness-stdin.test.js` (in `packages/vantio-cli`) | 0 | 17 pass |
| The same file with `20db6af`'s `mcp_awareness.py` put back | 1 | the 12 old tests pass, all 5 new tests fail. File restored after |
| AGENTS.md secret scan | 0 | no pattern matched |
| N1 and N6 repro script under `timeout 120`: plain `python3`, `vantio run python3`, `vantio run --mcp-enforce python3` | 0 each | see below |
| 1.5 MB identity script under `timeout 120`: plain `python3`, `vantio run python3` | 0 each | see below |
| README claim script under `timeout 120`, `vantio run --mcp-enforce python3` | 0 | see below |

Probe results:

- N1 and N6 repros, each through `stdin.write` and through `run(input=)`. Observe: output is the same as plain `python3` (`diff` empty). Enforce: the object without a `jsonrpc` key is withheld (`server_unlisted`), the same object in a batch is withheld (`batch_rejected`), the frame after `0xC2`, `0xFF` and `0xE2 0x80` is withheld (`invalid_utf8`), the batch nested 10 deep is withheld (`batch_rejected`). An object with neither key, a binary line `FF D8 FF E0 {x}`, and a frame after `xxx` or a NUL reach the child unchanged.
- 1.5 MB of random bytes with frames, `{`, `[`, BOM, `0xC2`, `0xFF{` and method-only objects mixed in, written in random chunks with random flushes, `bufsize` -1, 0 and 16, and once through `communicate()`. The child's stdout was read on a second thread. Observe: the sha256 of the child's bytes equals the input's in all four runs, and the output file is the same as plain `python3` (`diff` empty), write return values included.
- Enforce, a 12.8 KB mixed document written whole, one byte at a time and in random chunks: the child's bytes are the same in all three and the same through `run(input=)`. No log line held the canary. One line shape reached the child with its frame: broken bytes, then blanks, then more broken bytes, then the frame (see gaps).
- README claims in enforce: `os.write`, `stdin.buffer.write` on a text pipe, `stdin.raw.write`, a second file object on a duplicate of the descriptor, `type(p.stdin).write(p.stdin, frame)` and an `asyncio` child each reached the child. `stdin.write` and `writelines` were withheld. `{ echo hi; }` and a 300 KB valid JSON line were withheld from `cat`; `{"a":1}` reached it. `{"a":1}` with no newline: 0 bytes after 1.5 s, 7 bytes after `close()`.

README (`packages/vantio-cli/README.md`, the `--mcp-enforce` paragraph). **Public copy: needs Kate.** The same edits were made by hand in the open-core copy.

1. Old: "It does not see bytes written straight to the pipe with `os.write`, or children started with `asyncio`."
   New: "It does not see bytes that skip those calls: `os.write` on the pipe, `stdin.buffer.write`, `stdin.raw.write`, a second file object on the same descriptor, the unwrapped `write` called through the class, or children started with `asyncio`."
2. Old: "Only lines that start with `{` or `[` are checked, and `--mcp-enforce` holds them until checked; other child input passes through unchanged."
   New: "Only lines that start with `{` or `[`, after any blanks or broken UTF-8 bytes, are checked, and `--mcp-enforce` holds them until checked; other child input passes through unchanged."
3. Added after sentence 2: "With `--mcp-enforce`, a line that starts with `{` or `[` is held until its newline, `close()` or 256 KiB, and is withheld from any child, MCP server or not, when it is not valid JSON or is longer than 256 KiB. For example, the shell line `{ echo hi; }` is withheld."
4. Old: "The path does not add a proxy process."
   New: "The path does not add a proxy process. Python starts a short-lived `node` helper for each line it checks."

Gaps:

- **N2, not changed (owner decision: keep strict).** In enforce a line that starts with `{` or `[` and is not valid JSON, or is over 256 KiB, is withheld from every child. The README now says so.
- **N4, not changed.** Observe still parses a copy of each `{` or `[` line and copies the written data. Cost was not measured again.
- **N7, not changed.** `{`, a newline, then the rest of a frame: enforce withholds the `{` line and the rest reaches the child.
- **Finding 7 of the first review, not changed.** After a withheld frame on `stdin.write`, the error shows only through `stdout.read()` or `communicate()`.
- New with N6: in enforce, 1 to 4 bytes that are not ASCII and not yet a whole character are held at the start of a line until the next byte arrives or stdin closes (before, at most 2 bytes of a possible wide blank). A lone `0xFF` written and flushed waits for the next byte. Nothing is changed or lost.
- Enforce still does not check a frame that follows other bytes on its line: `xxx`, a NUL, more than 4 broken bytes, or broken bytes followed by a blank. `main` withheld any line that is not valid UTF-8.
- N1 makes enforce withhold, from any child, a JSON object line with a `method` key when the helper blocks it (for `cat`: `server_unlisted`). Before, such a line without a `jsonrpc` key passed.
- N3: the helper still runs inside the caller's `write`, `flush()`, `close()` or `communicate()` call, after the bytes are handed over, so the caller still waits for it. On a buffered pipe a line is logged at the next `flush()`, `close()` or `communicate()`; a program that never calls one of them after the write gets no log record for that line unless the queue fills. With 64 queued lines the helper runs before the write returns.
- N5: the notice is printed once per withheld frame on `stdin.write`.
- `asyncio` children and the paths in README sentence 1 are still not covered. The official MCP Python client, macOS, Windows, other Python versions and non-blocking pipes were not run.
- CI did not run: the org billing lock (VAN-129). Local runs stand in for it.
