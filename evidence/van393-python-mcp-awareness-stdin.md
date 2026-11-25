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
- **README:** says what `--mcp-enforce` covers in Python, and what it doesn't (`os.write` on the pipe, `asyncio` children). It also says that without the SDK, MCP awareness still checks JSON-RPC lines. **Public copy: needs the COO's sign-off and the owner's go.**
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
- Ships only at the next CLI release, with the owner's go.

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

- In enforce mode a line over 256 KiB that starts with `{` is withheld even when the child is not an MCP server. That is the same rule the Node side uses. The README does not say it yet; that wording is the COO's.
- VAN-406 (the HTTP side) is not decided. This follows the Node stdio rule, not a new one.
- CI did not run: the org billing lock (VAN-129). Local runs stand in for it.

## Follow-up, Nov 25 (UTC): fixes after the independent review of `2806c7a`

The review (newest "Independent review (fresh session)" comment on VAN-393) blocked `2806c7a`. This section covers its findings 1 to 4, 6, 8 and 9. Finding 5 (README wording) is listed for the COO. Finding 7 is old behavior and is left as a gap.

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
- **README:** one sentence edited because it was no longer true (`[` lines are checked now, and observe holds nothing). Old: "Only lines that start with `{` are held and checked; other child input passes through unchanged." New: "Only lines that start with `{` or `[` are checked, and `--mcp-enforce` holds them until checked; other child input passes through unchanged." **Public copy: needs the COO's sign-off.**

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
- **Finding 5, README, needs the COO's sign-off.** Not rewritten beyond the one sentence above. See the VAN-393 comment for each sentence and a suggested replacement.
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

README (`packages/vantio-cli/README.md`, the `--mcp-enforce` paragraph). **Public copy: needs the COO's sign-off.** The same edits were made by hand in the open-core copy.

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

## Follow-up 3, Nov 25 (UTC): fixes after the independent review of `7b2daba`

The independent review of `7b2daba` (vantio-optics) and `9a3d76c` (vantio-open-core) failed. This section covers its findings 1, 2, 3, 5 and 6, the README (4, 7, 10) and the evidence wording (11). Findings 7, 8 and 9 are not changed and are in the gap list. All runs below are on the working tree on top of `7b2daba`, before the commit. The pull request body names the commit.

Change, in `bin/python-wrap/mcp_awareness.py`:

- **Finding 1 (enforce failed open).** `_ask` now returns `allow` only for the answer `mcp-awareness-frame.js` gives for a line it lets through: exit code 0, a JSON object with `"error": null`, and a `records` list with at least one observation record, each with an ALLOW or LOG decision. (At `f2b3269` WOULD_BLOCK also counted as allow. That was wrong and is fixed in Follow-up 4: only an observe-mode helper says WOULD_BLOCK, and enforce now refuses it.) Enforce forwards a checked line only on `allow`. A helper block (exit 0 and an error string) keeps the helper's own reason. Everything else is withheld with `"finding":"helper_failed"`: no `node`, a `node` that does not start (bad `NODE_OPTIONS`), a non-zero exit, a timeout, empty output, `{}`, `{"records":[],"error":null}`, a helper that cannot load its imports. In observe a failed helper only means no log record; the child's bytes are not touched.
- **Finding 2 (a CR hid frames).** A line now ends at a newline or at a lone CR, in both modes. Each part between CRs is classified and checked like a line. The CR stays where it was in what the child gets. When a withheld line ended at a CR and a newline comes next (CRLF), that newline is withheld with it, as before. Observe records the frames after a CR and changes no bytes.
- **Finding 3 (key case).** `jsonrpc` and `method` keys are matched without regard to case (`str.casefold`), at any batch depth. `{"JSONRPC":"2.0","Method":"tools/call"}` goes to the helper again and enforce withholds it (`server_unlisted`), as on `main`.
- **Finding 6 (helper not stopped).** On a timeout, or any other error while waiting, the helper is killed and reaped. On POSIX it runs in its own process group, and the whole group is killed, so a wrapper script and what it started both stop. The timeout is still 5 s per line.
- **Finding 5 (wording only).** The module docstring and the `_Gate` docstring now say: the helper runs after the bytes are handed over, except that with 64 lines or 1 MiB waiting on a buffered pipe it runs at once, and the child may not have received those bytes yet. Behavior is not changed.

Tests in `test/python-mcp-awareness-stdin.test.js` (5 new; 22 in the file). Child `cat`.

| Finding | Test | Negative case |
| --- | --- | --- |
| 1 | --mcp-enforce withholds a frame when the helper gives no usable answer; a real allow answer still passes | plain JSON passes with a broken `node`; a real block keeps its own reason; a real allow (policy `default: allow`, a `ping`) reaches the child unchanged; observe bytes are identical for every broken helper |
| 1 | --mcp-enforce withholds a frame when the helper cannot load its library | the unchanged CLI blocks the same frame with the helper's own reason; observe bytes are identical |
| 2 | --mcp-enforce checks a frame after a lone CR like a line of its own; other bytes keep their CR | CR-separated text, progress-style text, CRLF plain JSON reach the child byte for byte and `node` is not started; observe bytes identical, frames after a CR are logged |
| 3 | a line with JSONRPC or Method keys in another case goes to the helper, also inside a batch; --mcp-enforce withholds it | `Methods`, `JSON_RPC`, a nested `Method`, `ID`/`Params` pass and `node` is not started |
| 6 | a helper that hangs is stopped after the timeout and no helper process is left running | a helper that answers in time is used as before (its own block reason, under 4 s) |

One old test changed: the N1 test listed `{"Method":1,"JSONRPC":"2.0"}` as a line that passes without starting `node`. Finding 3 reverses that, so the line was taken out of that negative list.

Each new test fails on `7b2daba`'s gate. Shown with a scratch copy under `/tmp` (the package's `bin/`, `test/` and `package.json`, with `7b2daba`'s `mcp_awareness.py`); the worktree was not touched. Failure text, in test order: "empty: the frame reached the child", "the frame reached the child", "x_cr_frame: a frame reached the child", "both_upper reached the child", "enforce: helper processes still running 2 !== 0".

Commands, from the repository root unless said. Python 3.13.18, Node 22.23.5. One pass after all fixes.

| Command | rc | Result |
| --- | --- | --- |
| `pnpm --filter @vantio/cli run lint` | 0 | |
| `pnpm --filter @vantio/cli run test` | 0 | 202 tests, 201 pass, 1 skipped, 0 fail |
| `pnpm --filter @vantio/optics-mcp run test` | 0 | 8 pass |
| `pnpm --filter @vantio/agent-sdk run test` | 0 | 42 pass |
| `pnpm run test:python` | 0 | 128 tests OK, 2 skipped |
| `node --test test/*.test.js` | 0 | 5 pass |
| `node --test test/python-mcp-awareness-stdin.test.js` (in `packages/vantio-cli`) | 0 | 22 pass |
| The same file in the vantio-open-core worktree | 0 | 22 pass. No other suite was run there |
| The same file in the scratch copy with `7b2daba`'s gate | 1 | the 17 old tests pass, all 5 new tests fail |
| AGENTS.md secret scan, vantio-optics | 0 | no pattern matched |
| The same scan command in the vantio-open-core worktree | 1 | 8 files matched, none of them in this change (the 4 changed files have 0 matches). vantio-open-core's own AGENTS.md has no secret-scan command |
| The review's repro scripts, each under `timeout`, with its control | 0 each | see below |

Repro results (the review's scripts, not committed):

- **Finding 1.** `enf_basic.py` in enforce with a fake `node` that prints nothing, prints `{}`, prints garbage and exits 3, or sleeps 30 s; with no `node` on `PATH`; and with a CLI copy whose helper throws on import: the frame is withheld on `stdin.write` and on `run(input=)`, answer `helper_failed`. `enf_nodeopts.py` (a `NODE_OPTIONS` flag this `node` rejects): withheld, `helper_failed`. Controls with the real `node`: withheld, `server_unlisted`.
- **Finding 2.** `mcpcr/client.py cr` (a real MCP Python server, three frames after `x` and CRs) in enforce: the tool did not run. Controls: the same client with newlines in enforce, the tool did not run; the CR client in observe and under plain `python3`, the tool ran. `main_cr.py`: `x_cr` withheld.
- **Finding 3.** `enf_go.py` (a Go line reader with `encoding/json`): both lines are withheld (`server_unlisted`); no `DISPATCH` line. In observe both lines reach the reader. `main_cr.py`: `Method` withheld.
- **Finding 6.** After the slow fake `node` runs (enforce and observe), `pgrep` finds no `sleep 30` process. The new test measures 4.5 s or more for the one frame it sends.
- **Observe identity (`obs_identity.py`).** The sha256 of the child's bytes equals the input's in every mode: binary corpus (1.5 MB, 6 modes: `bufsize` 0, 1, -1, 16, `writelines`, `communicate`) and text corpus (1.2 MB, 160 frames, 10 modes: the same plus text pipes, `print(file=)`, text `writelines` and `communicate`). Run with the real helper, a helper that exits 1 with no output, one that prints garbage and exits 3, one that prints `{}`, no `node` on `PATH`, and the helper that throws on import (text corpus). With the slow helper: the binary corpus (6 modes), and a 40 KB cut of the text corpus (6 frames, 10 modes); the full text corpus would take hours at 5 s a frame and was not run.
- **Shapes that held before, run again in enforce** (`enf_shapes.py` by `stdin.write`, one byte at a time, and `run(input=)`; `enf_more.py`; a key-order script): withheld for any key order, duplicate keys (`duplicate_key`), escaped `method` and `jsonrpc`, a BOM, a no-break space or a vertical tab before `{`, one-byte writes, frames of 262143, 262144 and 262145 bytes, two frames on one line (`malformed_json`), a frame with no newline then `close()`, nested batches (`batch_rejected`), `writelines`, `print(file=)`, `bufsize` 0, 1, -1 and 16 on binary and text pipes, `communicate()` and `run(input=)`. In observe every shape reaches the child.
- **README claims** (`readme_probe.py` and a second script that counts `node` starts): plain JSON of 262143 bytes plus a newline is unchanged; 262144 bytes plus a newline, plus a CR, or with no line end and then `close()`, is withheld (`oversize`). `{"a":1}` with no line end: 0 bytes at the child after 1 s; all 7 after `close()` or `communicate()`; 8 after a newline or a CR. `node` starts: 0 for plain JSON and text; 1 for a frame, a `Method` object, a batch, a line past the bound; 1 for a line that does not parse in enforce; in observe 0 for such a line, or 1 when it holds the text `"jsonrpc"`. With `python3 -I`, `-S` or `-E` the frame reaches the child in enforce.

README (`packages/vantio-cli/README.md`, the `--mcp-enforce` paragraph). **Public copy: needs the COO's sign-off. Not approved.** The same edits are in the open-core copy.

1. Old: "Only lines that start with `{` or `[`, after any blanks or broken UTF-8 bytes, are checked, and `--mcp-enforce` holds them until checked; other child input passes through unchanged."
   New: "Only lines that start with `{` or `[` are checked, and `--mcp-enforce` holds them until checked; other child input passes through unchanged. Before the `{` or `[` a line may have white space (the characters JavaScript's `trimStart` removes, a byte-order mark included), or up to 4 bytes of broken UTF-8 directly before it. A lone carriage return ends a line as a newline does, so each part between carriage returns is checked as a line of its own."
2. Old: "With `--mcp-enforce`, a line that starts with `{` or `[` is held until its newline, `close()` or 256 KiB, and is withheld from any child, MCP server or not, when it is not valid JSON or is longer than 256 KiB. For example, the shell line `{ echo hi; }` is withheld."
   New: "With `--mcp-enforce`, such a line is held until its line end, `close()`, `communicate()` or 262,144 bytes (256 KiB), whichever comes first. It is withheld from any child, MCP server or not, when it is not valid JSON or when it reaches 262,144 bytes before its line end: 262,143 bytes and a newline pass, 262,144 bytes and a newline are withheld. A line that needs the `node` check is also withheld when that check cannot run or gives no usable answer, for example when `node` is missing, does not start, fails or times out. For example, the shell line `{ echo hi; }` is withheld, and so is a progress bar redrawn with carriage returns, such as `[====>   ] 50%` after a carriage return."
3. Old: "`VANTIO_MCP_AWARENESS=off` does not load it."
   New: "The Python wrapper is not active when Python is started with `-I`, `-S` or `-E`, or when it cannot attach to a child process; in those cases nothing is checked. `VANTIO_MCP_AWARENESS=off` does not load it."
4. Old: "Python starts a short-lived `node` helper for each line it checks."
   New: "Python starts a short-lived `node` helper only for a line that looks like JSON-RPC (a JSON object with a `jsonrpc` or `method` key in any letter case, or an array that holds one), for a line past the size bound, and for a line that starts with `{` or `[` and is not valid JSON (with `--mcp-enforce`; without it, only when the line holds the text `"jsonrpc"`). A helper that has not answered after 5 seconds is stopped."

Gaps:

- **Finding 5 (N3), not changed.** At the queue cap (64 lines or 1 MiB) on a buffered pipe, observe runs the helper while the child has not yet received the bytes. The docstrings now say so.
- **Finding 7, not changed.** The wrapper does nothing when Python is started with `-I`, `-S` or `-E` (the README now says so), and when it cannot attach to a child. Seen: a `PathLike` program whose `__str__` raises gets no gate, and its frame reaches the child in enforce.
- **Finding 8, not changed.** In enforce, a write that the gate holds or withholds (a `{` part with no line end, a frame) returns a byte count on a closed stdin and on a child that has exited. Plain Python and observe raise `ValueError` or `BrokenPipeError`.
- **Finding 9, not changed.** A frame right after U+0085, `0x1E` or U+200B still reaches the child in enforce.
- **Node path, not changed here, needs a ticket.** `vantio run --mcp-enforce node` passes `x`, a CR, then a frame (seen with a `cat` child). `bin/mcp-awareness/parse.js` splits stdio lines on the newline byte only (`pullStdio`, line 376) and SSE lines on `/\r?\n/` (line 552).
- **Node library key case, not changed here, needs a ticket.** The library reads `method` in exact case only. With a policy `default: allow` for the server, a `tools/call` spelled `Method` gets an ALLOW answer and reaches the child through the Python gate, while the exact-case frame is blocked (`catalog_unknown`). With no policy both are withheld.
- **New with finding 2.** Enforce now also withholds, from any child, a part after a CR that starts with `{` or `[` and is not valid JSON. Seen: a progress bar (`[=====>    ] 50%` after a CR) and JSON pretty-printed with CR line ends. This follows the keep-strict rule (N2); whether it should is a question for the owner. A withheld CRLF line goes to the helper ending in the CR, without the newline.
- **New with finding 1.** With `--mcp-enforce`, if `node` cannot run in the agent's environment (for example the agent sets a `NODE_OPTIONS` flag that `node` rejects), every line that needs the check is withheld. In observe a failed helper leaves no log record and prints no notice.
- **New with finding 6.** The helper runs in its own session on POSIX. On Windows the code kills only the helper process itself; that path was not run. A hung helper still costs the caller 5 s per line, in both modes.
- Still true, probed again: after a withheld frame on `stdin.write` the error shows only through `stdout.read()` called after the write, or `communicate()`. `{`, a newline, then the rest of a frame: the `{` line is withheld and the rest reaches the child. Enforce does not check a frame that follows other bytes on its line (`xxx`, a NUL, more than 4 broken bytes, broken bytes then a blank); a CR between them and the frame now closes this. 1 to 4 non-ASCII bytes at the start of a line wait for the next byte in enforce. Enforce withholds a not-JSON `{` or `[` line and a line of 262,144 bytes or more from every child (N2), and a JSON object with a `method` key when the helper blocks it (N1). Observe still parses a copy of each `{` or `[` line (N4). The stderr notice is printed once per withheld frame (N5).
- Not covered in enforce: `os.write` on the pipe, `stdin.buffer.write`, `stdin.raw.write`, a second file object on the same descriptor, the unwrapped `write` called through the class, `asyncio` children. These were not run again in this pass.
- Not run: the official MCP Python client, macOS, Windows, other Python versions, threads writing to one pipe, non-blocking pipes.
- CI did not run: the org billing lock (VAN-129). Local runs stand in for it.

## Follow-up 4, Nov 25 (UTC): fixes after the independent review of `f2b3269`

The independent review of `f2b3269` (vantio-optics) and `20cc3d0` (vantio-open-core) confirmed the Follow-up 3 fixes and failed the heads on older defects in the same gate. This section covers its findings 1, 2, 3 and 7 in code and 4 in the README. Its notes 5 and 6 stay as gaps. All runs below are on the working tree on top of `f2b3269`, before the commit. The pull request body names the commit.

Change, in `bin/python-wrap/mcp_awareness.py`:

- **Finding 1 (enforce lost bytes on a short write).** Enforce no longer writes to the pipe from inside the line check. Bytes the gate has decided to forward go to an ordered queue (`outq`). `send()` hands the queue to the real write and removes exactly what the real write took: a short count, `None`, or `BlockingIOError.characters_written`. What is left is sent on the next `write`, `flush`, `close` or `communicate`. `close()` sends everything first; on a pipe that would block it waits with `select` until the pipe takes more.
  - The wrapped `write` takes all of the caller's data or none of it. It returns the caller's length when it took the data (forwarded, held, withheld, or queued). While older bytes are still waiting on a pipe that would block it takes nothing: an unbuffered pipe gets `None`, a buffered or text pipe gets `BlockingIOError` with 0 written. A caller that loops on short counts sends nothing twice.
  - Text mode: the string is first encoded with the pipe's own encoding and error setting. If that fails, `UnicodeEncodeError` is raised before any part of the write goes to the child, as in plain Python.
  - Observe is unchanged for the child: the caller's data goes to the real write and the real write's return value or exception goes back. The copy the gate reads is now cut to what the pipe took, so a short write is not logged twice.
- **Finding 2 (enforce failed open on an environment change).** The mode, the helper's environment (with the policy path, injection and rug-pull settings), the `node` path and the log directory are read once, in `_config()`, when the wrapper installs. The gate and the helper use that stored copy. `os.environ` is not read again.
  - The helper gets its mode from the stored copy, written as exactly `enforce` or `observe`.
  - In enforce a `WOULD_BLOCK` record is refused (`helper_failed`). `ALLOW` and `LOG` still forward.
  - Mode rule: missing, empty or `observe` (any case) is observe. Anything else is enforce, including `Enforce` and a typo. The banner prints the mode that is used.
- **Finding 3 (responses without a `jsonrpc` key).** An object with an `id` key and a `result` or `error` key (any case, any batch depth) goes to the helper, like an object with `jsonrpc` or `method`. An object with only one of them passes without starting `node`.
- **Finding 7 (threads).** Each gate has a lock. A write is classified and queued as a whole before another thread's write. In enforce the lock is held through the helper call and the send. In observe the lock covers the real write and the copy; the helper runs after the lock is released, also at the queue cap.
- **For the README (finding 4).** Numbers are no longer converted when a held line is read, so a JSON line with an integer of more than 4300 digits is plain JSON and passes. Before, Python refused to convert it and the line was withheld.

What code in the wrapped process can still do. These fixes cover a program that changes its environment for its own reasons (`load_dotenv(override=True)`, `os.environ.clear()`). They do not stop code that sets out to avoid the wrapper. An agent that can run arbitrary Python in the wrapped process can always send bytes to a child unchecked: `os.write` on the pipe, `stdin.buffer.write`, `stdin.raw.write`, a second file object on the descriptor, the unwrapped `write` through the class, an `asyncio` child, restoring `subprocess.Popen`, or changing this module's stored settings. It can also start Python with `-I`, `-S` or `-E`. The wrapper is a check on the wrapped calls, not a sandbox.

Tests in `test/python-mcp-awareness-stdin.test.js` (4 new, 1 extended; 26 in the file). Child `cat` unless said.

| Finding | Test | Negative case |
| --- | --- | --- |
| 1 | no forwarded byte is lost or sent twice when a write to the child is cut short | the frame in the middle of the same streams is still withheld; nothing is sent from a string that cannot be encoded; on a blocking pipe each write returns the caller's length in both modes; observe bytes identical |
| 2 | the mode, the policy file and node are fixed when Python starts; a later change to os.environ does not turn enforce off | the policy file named at the start still decides (a `ping` passes once that file allows it); observe stays observe when the mode is set to `enforce` later; missing, empty, `observe` and `Observe` are observe |
| 2 | (extended) --mcp-enforce withholds a frame when the helper gives no usable answer: new kind `would_block_record` | a real allow answer still passes |
| 3 | an object with an id and a result or an error goes to the helper, also inside a batch; --mcp-enforce withholds it | an `id` alone, a `result` alone, the two in different objects, look-alike keys, `NaN`, `Infinity` and a 5000-digit integer pass and `node` is not started |
| 7 | two threads writing to one child: a frame is checked on its own and every line arrives whole | observe: nothing withheld, each write arrives whole and in its thread's order |

Test harness change: the wrapper now finds `node` once, so the tests put their own `node` first on `PATH` before Python starts. That script runs `$HOME/fake-bin/node.impl` when an agent has written one, and the real `node` otherwise. `VANTIO_MCP_POLICY` is set at the start to a file in `$HOME` that an agent may write later. The old `bad_node_options` case is gone: `NODE_OPTIONS` set while the program runs no longer reaches the helper (the new test asserts that).

Each new test, and the extended one, fails on `f2b3269`'s gate. Shown with a scratch copy under `/tmp` (the package's `bin/`, `test/` and `package.json`, with `f2b3269`'s `mcp_awareness.py`); the worktree was not touched. 21 of 26 pass there. Failure text: "would_block_record: the frame reached the child", "enforce nonblocking_unbuffered: the child got 670080 bytes, wanted 800000", "enforce mode_set_to_observe: the frame reached the child", "result reached the child", "a frame written by a second thread during a large write reached the child".

Commands, from the repository root unless said. Python 3.13.18, Node 22.23.5. One pass after all fixes.

| Command | rc | Result |
| --- | --- | --- |
| `pnpm --filter @vantio/cli run lint` | 0 | |
| `pnpm --filter @vantio/cli run test` | 0 | 206 tests, 205 pass, 1 skipped, 0 fail |
| `pnpm --filter @vantio/optics-mcp run test` | 0 | 8 pass |
| `pnpm --filter @vantio/agent-sdk run test` | 0 | 42 pass |
| `pnpm run test:python` | 0 | 128 tests OK, 2 skipped |
| `node --test test/*.test.js` | 0 | 5 pass |
| `node --test test/python-mcp-awareness-stdin.test.js` (in `packages/vantio-cli`) | 0 | 26 pass |
| The same file in the vantio-open-core worktree | 0 | 26 pass. No other suite was run there |
| The same file in the scratch copy with `f2b3269`'s gate | 1 | 21 pass, 5 fail (the 4 new tests and the extended one) |
| AGENTS.md secret scan, vantio-optics | 0 | no pattern matched |
| The same scan command in the vantio-open-core worktree | 1 | 8 files matched, none of them in this change |
| The review's probes, each under `timeout`, with controls | 0 each | see below |

Probe results (the review's scripts, not committed; run as the review ran them, with the wrapper on `PYTHONPATH`):

- **`nonblock.py`** (non-blocking unbuffered pipe, 800,000 bytes): plain, observe and enforce all deliver 800,000 bytes, equal to the input. At `f2b3269` enforce delivered 625,680 in the review.
- **`shortwrite.py`** (a signal every 50 ms during a 1 MB write): plain, observe and enforce deliver 1,000,001 bytes, equal.
- **`encerr.py`**: plain, observe and enforce all print `UnicodeEncodeError 'retry\n'`.
- **`env_tamper.py`** in enforce: withheld in all four cases (baseline, mode set to `observe`, mode deleted, environment cleared). Control in observe: reached in all four.
- **`env_before.py`** in enforce: withheld in all three cases (baseline, mode missing, mode `Enforce`). Control in observe: reached.
- **`result_noversion.py`** in enforce: all three lines withheld. Control in observe: all three reach the child.
- **`fidelity.py`** (24 modes: binary and text; `bufsize` 0, 1, -1, 16; chunks of 1, mixed, 65536; `communicate`; `run(input=)`), seed 1. Observe gives the child identical bytes in all 24 with the real helper, a crashing helper, a garbage helper, a `{}` helper and no `node` (200,000 bytes each), and with the slow helper (60,000 bytes, 2 frames per stream). Enforce with a fake helper that always answers allow: identical in all 24 (200,000 bytes). Plain `python3`: identical in all 24. The probe picks its helper by changing `PATH` while it runs; that no longer has an effect, so `PATH` was set before the start instead.
- **`allowreal.py`** (enforce, real helper, policy `default: allow`, pings between CRs and blanks): exact for `bufsize` 0 with 1-byte and 7-byte writes, -1, 16, and `run(input=)`. The policy path was set before the start, for the same reason.
- **`classic.py`** in enforce: `NONE_REACHED`, 16 shapes, 146 checks.
- **`cr.py`** in enforce: every line marked with an expected child output says OK. `cr_ws_between_tokens` and `cr_inside_held_frame` still show the tail of a split frame at the child (note 6, a gap).
- **`keys.py`** in enforce: long-s `jsonrpc`, escaped `Method`, upper case, duplicate mixed case and the deep batch are withheld. Kelvin sign, full-width letters, dotless i, a trailing space and a `method` key only inside `params` reach the child, as in the review.
- **`fdleak.py`** (20 rounds; real helper in enforce and observe, crashing helper in enforce): the open descriptors are the same before and after, and no child process is left.
- **`sigint.py`** (slow helper, enforce and observe): `KeyboardInterrupt` arrives after 1.25 s, no helper process is left running, the two timed-out runs take 5.0 s each. Enforce: the frame does not reach the child. Observe: it does.
- **Earlier probes, run again under `vantio run`**: the helper-failure (fake `node` on `PATH` from the start, no `node`, the helper that throws on import), CR and Go key-case repros of Follow-up 3 give the same results. One differs by design: `enf_nodeopts.py` sets a bad `NODE_OPTIONS` while the program runs; the helper no longer sees it and gives its own answer (`server_unlisted`). The README probe gives the same byte bounds and `node` start counts as in Follow-up 3, and adds: `{"a":NaN}`, `[Infinity,-Infinity]` and an array with a 5000-digit integer reach the child unchanged; 10 spaces before a 262,143-byte line and a newline pass; one broken byte before the same line makes it oversize.
- **Responses and the helper.** With no policy the helper answers `server_unlisted` for a response, as for any frame. With a policy `default: allow` for the server it answers `unmatched_result` (BLOCK) for `{"jsonrpc":"2.0","id":1,"result":...}` and for the same line without `jsonrpc`. The helper is a new process for each line and cannot know the request the response belongs to. In observe the records are `LOG` and the bytes are unchanged. See the owner questions.

README (`packages/vantio-cli/README.md`, the `--mcp-enforce` paragraph), against the text at `f2b3269`. **Public copy: needs the COO's sign-off. Not approved.** The same edits are in the open-core copy. "Other child input passes through unchanged" is kept; the short-write probes above show it holds now.

1. Old: "It is withheld from any child, MCP server or not, when it is not valid JSON or when it reaches 262,144 bytes before its line end: 262,143 bytes and a newline pass, 262,144 bytes and a newline are withheld. A line that needs the `node` check is also withheld when that check cannot run or gives no usable answer, for example when `node` is missing, does not start, fails or times out."
   New: "The bytes are counted from the `{` or `[`: white space before it is not counted, broken UTF-8 bytes directly before it are. A line that reaches 262,144 bytes before its line end is withheld from any child, MCP server or not: 262,143 bytes and a newline pass, 262,144 bytes and a newline are withheld. A held line is first read with Python's `json` module, which also accepts `NaN`, `Infinity` and `-Infinity`. If it reads as JSON and does not look like JSON-RPC, it passes. If Python cannot read it, or it looks like JSON-RPC, it goes to the `node` check. It is then withheld from any child when that check blocks it, cannot parse it (the check does not accept `NaN` or `Infinity`), cannot run, or gives no usable answer, for example when `node` is missing, does not start, fails or times out."
2. Old: "Python starts a short-lived `node` helper only for a line that looks like JSON-RPC (a JSON object with a `jsonrpc` or `method` key in any letter case, or an array that holds one), for a line past the size bound, and for a line that starts with `{` or `[` and is not valid JSON (with `--mcp-enforce`; without it, only when the line holds the text `"jsonrpc"`)."
   New: "Python starts a short-lived `node` helper only for a line that looks like JSON-RPC (a JSON object with a `jsonrpc` or `method` key, or with an `id` key and a `result` or `error` key, in any letter case, or an array that holds one), for a line past the size bound, and for a line that starts with `{` or `[` and that Python's `json` module cannot read (with `--mcp-enforce`; without it, only when the line holds the text `"jsonrpc"`)."
3. Old: "`VANTIO_MCP_AWARENESS=off` does not load it."
   New: "The mode, the policy file (`VANTIO_MCP_POLICY`) and the `node` program are fixed when Python starts; changing `VANTIO_MCP_MODE`, `VANTIO_MCP_POLICY` or `PATH` inside the running program does not change them. `VANTIO_MCP_AWARENESS=off` does not load it."

Owner questions (not decided here):

1. **Responses from a Python client to a server.** Under `--mcp-enforce` every client-to-server response is withheld, also with an allow policy (`unmatched_result`). A Python client then cannot answer a server's own request (sampling, elicitation, roots). This was already so for responses with a `jsonrpc` key; finding 3 makes it the same without the key. Options: (A) keep it, and say so in the README; (B) change the Node library so a response to an allowed server passes when the helper has no session; (C) keep one helper per child alive so it can match responses to requests. Recommendation: A now, and a ticket for C. B gives up the check that A keeps.
2. **A mode value that cannot be read.** Now it means enforce. The launcher only ever writes `enforce` or `observe`, so this matters only when the wrapper is started without `vantio run`. Options: (A) keep; (B) treat it as observe, as the launcher's own check does. Recommendation: A.
3. **`close()` on a pipe that would block.** Enforce now waits until the child takes the queued bytes. If the child never reads, `close()` does not return. Options: (A) keep, nothing is lost; (B) raise `BlockingIOError` and drop the bytes, as a buffered writer in plain Python does. Recommendation: A.

Gaps:

- **Note 5, not changed.** A hung helper delays the caller by 5 s per line, in observe too.
- **Note 6, not changed.** A CR between JSON tokens splits a frame. The first part is withheld. The tail reaches the child; it is not a valid frame on its own.
- **New with finding 1.** In enforce the count `write` returns is all of the caller's data or nothing, not the pipe's own short count. A caller that reads the count as "bytes the child's pipe has taken" is told more than the pipe took; the rest is in the wrapper's queue (at most one write's data plus a held line). A text pipe set to non-blocking is not handled: the text layer reports no count, as in plain Python. If a signal handler raises during a write, the count is unknown, as in plain Python. If a buffered writer raises an error other than `BlockingIOError`, the bytes handed to it are treated as taken.
- **New with finding 2.** `NODE_OPTIONS`, `PATH`, `VANTIO_HOME` and the rest of the helper's environment are those from the start. A program that fixes its `PATH` after start to make `node` findable does not change which `node` the wrapper uses. The policy file's content is still read for each line; only its path is fixed.
- **New with finding 7.** In enforce other threads wait while one thread's line is checked or its write blocks (up to 5 s with a hung helper). The lock covers one `write` call. A frame that one thread sends in several writes can still be mixed with another thread's bytes, as in plain Python.
- **Finding 5 of the last review (N3), wording.** At the queue cap in observe the helper now runs after the write that reached the cap has handed its data to the pipe layer, still inside that write call. On a buffered pipe the child may not have the bytes yet.
- **Node library, VAN-455.** `{"ID":1,"Error":{...}}` with a policy `default: allow` gets an ALLOW answer and reaches the child (the library reads keys in exact case). Same cause as the `Method` case.
- Still true, probed again: the wrapper does nothing under `-I`, `-S`, `-E` or when it cannot attach (a `PathLike` program whose `__str__` raises). In enforce a held or withheld write returns a count on a closed stdin or a dead child. A frame right after U+0085, `0x1E` or U+200B, after `xxx`, a NUL, more than 4 broken bytes, or broken bytes then a blank reaches the child. `{`, a newline, then the rest of a frame: the rest reaches the child. After a withheld frame on `stdin.write` the error shows only through `stdout.read()` called after the write, or `communicate()`. Enforce withholds a line Python cannot read, a not-JSON part after a CR (owner decision: keep), and a line of 262,144 bytes or more, from every child.
- Not covered in enforce: `os.write` on the pipe, `stdin.buffer.write`, `stdin.raw.write`, a second file object on the same descriptor, the unwrapped `write` through the class, `asyncio` children. Not run again in this pass.
- Not run: the official MCP Python client, macOS, Windows (the `select` wait and the process-group kill are POSIX paths), other Python versions.
- CI did not run: the org billing lock (VAN-129). Local runs stand in for it.
