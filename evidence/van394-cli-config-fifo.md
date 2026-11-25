# VAN-394: a curl -K / wget -i FIFO no longer blocks the program

Branch `engineering/van-394-optics-curl-k-wget-i-pointing-at-a-fifo`, from vantio-optics `main` at `8bee543`. Mirror: vantio-open-core PR on the same branch name. CLI and Python SDK source. Nothing tagged or published.

## Finding

Found by an independent review (fresh session) and reproduced here.

To find the URL, the wrappers read the file the child curl or wget was about to read, before the child started:
- Python: `_url_from_curl_config` used a plain `open()`, and `_urls_from_list_file` a plain `os.open()`.
- Node: `urlFromCurlConfig` used `readFileSync`.

When that file is a FIFO, the read blocks until a writer appears. A program that spawns curl and then writes the config never gets past the spawn. In Node, even timers stop. With a writer running, the wrapper drained the config (which can hold a secret header) before curl saw it. Node's wget list reader already had a `stat` check.

## What changed

- New `_read_regular_file` (Python) and `readRegularFile` (Node). Each opens with `O_NONBLOCK | O_NOCTTY`, checks `fstat` for a regular file, and reads up to a cap (64 KiB). Anything else returns nothing, and the child reads it as usual. Checking the opened fd, not a `stat` of the path, closes the swap window.
- All three readers use it.
- When the config is not a regular file, the host is unknown, so the call is not recorded. That's the same as a config the wrapper can't read.
- New tests:
  - `packages/vantio-cli/test/cli-config-fifo.test.js` (2): curl `-K <fifo>` and wget `-i <fifo>` under the interceptor. Spawn returns in under 1 s, the child fetches the URL from the FIFO, and the run file is still written.
  - `packages/vantio-agent-sdk-py/tests/test_van394_cli_config_fifo.py` (5): regular files still parse; a FIFO is skipped in under 1 s; `/dev/zero` is skipped; the cap holds; and `Popen(["curl","-K",fifo])` under `shield()` returns and curl reads the config itself.

## Commands

| Command | rc | Result |
| --- | --- | --- |
| New Node tests | 0 | 2 pass. On `main`'s interceptor the curl test is killed by the 10 s watchdog (wget passes, since it already had a `stat` check) |
| New Python tests | 0 | 5 pass. With the regular-file check and `O_NONBLOCK` removed, the run blocks until the 30 s timeout |
| Every `ci.yml` JavaScript step, one at a time | 0 each | CLI tests 181 pass, 1 skipped, 0 fail |
| Python SDK suite on 3.10 / 3.11 / 3.12 | 0 | 133 OK, 2 skipped each |
| AGENTS.md secret scan | 0 | no pattern matched |

## Gaps

- A curl run whose only URL is in a FIFO config is not recorded. The wrapper can't know the host without reading what belongs to the child.
- CI did not run: the org billing lock (VAN-129). The drift check compares these packages with open-core `main`, so this and the mirror go together.
- Ships only at the next release, with Zach's go.

## 2026-11-25: fixes after the independent review of `24c5580`

The review blocked `24c5580` with four findings. This section covers the one commit on top of `24c5580` that answers them. Commands ran on that commit's tree (Node 22.23.5, pnpm 11.13.0, Linux).

### What changed

1. **Stat before open (High).** `readRegularFile` (Node) and `_read_regular_file` (Python) now `stat` the path first and open it only when it is a regular file. A FIFO, device, socket or directory is never opened. The non-blocking open and `fstat` stay as the second check; if the opened fd is not a regular file it is closed without a read. `/dev/stdin`, `/dev/fd/N` and `/proc/self/fd/N` are never statted or opened: in the parent they name the parent's descriptors, not the child's.
2. **Call recorded without a URL (Medium).** When no URL is known and a `-K` / `-i` file was skipped as a FIFO, device, socket or `/dev/stdin`, one call is recorded with `hostname: null` and `path: null`. No new field: readers already show a missing host as `unknown`. It adds no spend, is not counted under any watched host, and holds nothing from the file. Node's `summary.hosts` now lists `unknown` for such a call (Python already did).
3. **Tests (Low).** `/dev/stdin` tests in both runtimes. Writer-first FIFO tests in both runtimes.
4. **Cap (Low).** A curl `-K` config is read up to 1 MiB (was 64 KiB at `24c5580`, whole file on `main`). A wget `-i` list is read up to 64 KiB, as on `main`. Both limits have tests.

### New and changed tests

Node, `packages/vantio-cli/test/cli-config-fifo.test.js` (12 tests; 3 to 12 use a stand-in `curl` / `wget` on `PATH`, no network):

| # | Test | On `24c5580` | On `main` `8bee543` |
| --- | --- | --- | --- |
| 1 | curl -K \<fifo\> does not block the parent (now expects one call with no host) | fail | fail |
| 2 | wget -i \<fifo\> does not block the parent (same) | fail | fail |
| 3 | curl -K \<fifo\> with a writer already waiting | fail: writer SIGPIPE, child hung | fail: child hung |
| 4 | wget -i \<fifo\> with a writer already waiting | fail: writer SIGPIPE, child hung | fail, only on the missing call record |
| 5 | curl -K /dev/stdin | fail, only on the missing call record | fail: the child did not get stdin |
| 6 | wget -i /dev/stdin | fail, only on the missing call record | fail, only on the missing call record |
| 7 | a regular file is still recorded with its host | pass | pass |
| 8 | no call for a file with no URL, a missing file or a directory | pass | pass |
| 9 | a URL to a host that is not watched records nothing | pass | pass |
| 10 | a URL after 200 KiB of a curl config is recorded | fail | pass |
| 11 | a URL after 1 MiB of a curl config is not recorded | pass | fail |
| 12 | a wget list is read up to 64 KiB | pass | pass |

Tests 7, 8, 9 and 12 are negative cases for behavior that did not change, so they pass on the old code. Test 10 passes on `main` because `main` read the whole config. Test 11 passes on `24c5580` because its cap was lower.

Python, `packages/vantio-agent-sdk-py/tests/test_van394_cli_config_fifo.py` (20 tests). On `24c5580`, 12 of the 20 fail:

- Fail for the behavior: `test_curl_k_fifo_with_a_writer_already_waiting` and `test_wget_i_fifo_with_a_writer_already_waiting` (`BrokenPipeError` in the writer), `test_curl_k_dev_stdin_is_left_to_the_child`, `test_wget_i_dev_stdin_is_left_to_the_child` and `test_popen_curl_k_fifo_returns_and_the_child_reads_it` (no run file), `test_a_fifo_is_never_opened`, `test_a_symlink_to_a_fifo_is_never_opened`, `test_dev_stdin_is_never_opened_or_statted` (the path was opened), `test_a_device_and_a_socket_are_never_opened` (the socket open raised), `test_a_curl_config_is_read_up_to_1_mib`.
- Fail only because the helper has a new argument: `test_skipped_special_files_are_reported`, `test_a_directory_and_a_missing_file_are_not_marked_skipped`.
- Pass on `24c5580`: four older helper tests (`test_a_regular_file_is_read`, `test_a_fifo_is_skipped_at_once`, `test_a_device_is_skipped`, `test_the_cap_is_kept`), `test_a_path_swapped_to_a_fifo_after_the_stat_is_closed_without_a_read` (the `fstat` check was already there), `test_a_wget_list_is_read_up_to_64_kib`, `test_a_regular_file_is_still_recorded_with_its_host`, `test_no_call_for_a_file_with_no_url_a_missing_file_or_a_directory` (negative cases).
- On `main` the file does not import (`_read_regular_file` is not there).

### Commands

| Command | rc | Result |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | |
| `pnpm --filter @vantio/cli run lint` | 0 | |
| `pnpm --filter @vantio/optics-mcp run lint` | 0 | |
| `pnpm --filter @vantio/agent-sdk run typecheck` | 0 | |
| `pnpm --filter @vantio/agent-sdk run typecheck:test` | 0 | |
| `pnpm --filter @vantio/cli run test` | 0 | 192 tests: 191 pass, 1 skipped, 0 fail |
| `pnpm --filter @vantio/optics-mcp run test` | 0 | 8 pass |
| `pnpm --filter @vantio/agent-sdk run test` | 0 | 42 pass |
| `pnpm --filter @vantio/agent-sdk run build` | 0 | |
| `python -m unittest discover -s tests -t . -v` on 3.10.20, 3.11.18, 3.12.3 (venvs with requests, httpx, aiohttp, urllib3, build) | 0 each | 148 tests, OK, 2 skipped each |
| Same on 3.13.18 | 0 | 148 tests, OK, 2 skipped |
| Same on system 3.10, 3.11, 3.12 without the optional clients | 0 each | 148 tests, OK, 17 skipped each |
| `node --test test/cli-config-fifo.test.js` with `interceptor.cjs` from `24c5580` | 1 | 5 pass, 7 fail (table above) |
| Same with `interceptor.cjs` from `8bee543` | 1 | 5 pass, 7 fail (table above) |
| `python3 -m unittest tests.test_van394_cli_config_fifo` with `_http_observe.py` from `24c5580` | 1 | 20 tests: 8 failures, 4 errors |
| Same with `_http_observe.py` from `8bee543` | 1 | import error |
| AGENTS.md secret scan | 0 | no pattern matched |

### The reviewer's writer-first repro

`mkfifo f`; start a writer (`sh -c 'printf "$CFG" > f'` in Node, a thread in Python under `shield()`); 150 ms later spawn the stand-in `curl -K f` or `wget -i f`; 3 s limit. Pass = the child got every byte and the writer ended without SIGPIPE / EPIPE.

| Case | This commit | `24c5580` |
| --- | --- | --- |
| Node `curl -K` | 25/25 | 0/5 |
| Node `wget -i` | 25/25 | 0/5 |
| Python `curl -K` | 25/25 | 0/5 |
| Python `wget -i` | 25/25 | 0/5 |

### Gaps

- Limits: a URL after the first 1 MiB of a curl `-K` config, or after the first 64 KiB of a wget / httpie / aria2c `-i` list, is not recorded.
- Between the `stat` and the open, a path can still be swapped for a FIFO with a waiting writer. The `fstat` check then stops the read, but that open has already let the writer through. Python has a test for the second check (with `os.stat` patched); Node has none, because the helper is not exported.
- The no-host call is recorded without a scope check, since the host is unknown. It is recorded even if the skipped file turns out to hold no URL or a host that is not watched. This was a policy question for the owners. It is answered in the next section (owner decision: option A).
- `curl -K -` and `wget -i -` with stdin as a pipe are unchanged: not recorded.
- The writer-first and `/dev/stdin` tests use a stand-in `curl` / `wget`. Real curl and wget are covered only by the two late-writer tests.
- Linux only. Not run: macOS, Windows, the drift check, `ws11/verify.mjs`.
- GitHub CI did not run (billing lock, VAN-129).

## 2026-11-25: owner decision, option A

The policy question from the section above is answered. Owner decision: option A. A call with no known host is still recorded, but it is left out of the LLM call count and the byte totals. The decision is on VAN-394 as a relayed comment; the owner has not yet confirmed it there.

One commit on top of `820cf0f`.

### Before (confirmed on `820cf0f`)

Stand-in `curl` on `PATH`, `curl -K /dev/null -d <5,000 bytes>`:

- Node: the run summary printed `LLM calls: 1`, `Hosts: unknown`, `Total bytes: 5,000`. The run file had `total_calls: 1`, `total_bytes: 5000` and an `unknown` row in `by_host` and `by_provider`.
- Python: the run file had `total_calls: 1` and `hosts: ["unknown"]`.

### What changed

- Node, `bin/interceptor.cjs`: the record stays in `calls` with its own size. `summary.total_calls`, `total_bytes`, `hosts`, `providers`, `errors`, `by_host` and `by_provider` leave it out. New field `summary.calls_without_host`. The `run_summary` JSON event does the same.
- Node, `bin/vantio.js`: `vantio discover` leaves a call with no host out of the host rows and the totals. `--json` has a new field `calls_without_host`.
- Python, `vantio/_http_observe.py`: `summary.total_calls` and `summary.hosts` leave it out. New field `summary.calls_without_host`. The Python summary has no byte total.
- `vantio prove` reads `summary.total_calls` and `summary.total_bytes`, so it follows. Its call table still lists the record.

### Wording that a user sees (needs sign-off before release)

| Where | Old | New |
| --- | --- | --- |
| Run summary, a run with a no-host call | `LLM calls:    1` / `Hosts:        unknown` / `Total bytes:  5,000` | `LLM calls:    0` / `Hosts:        none` / `Total bytes:  unknown` |
| Run summary, new line, only when the count is above 0 | (none) | `Calls with no known host: 1 (not counted above)` |
| `vantio discover`, row for calls with no host | a row named `unknown` with its calls and bytes | no row |
| `vantio discover`, new line, only when the count is above 0 | (none) | `Calls with no known host: 1 (not counted above)` |

A run with no such call prints the same text as before. No README or changelog text changed.

### Tests

Node, `packages/vantio-cli/test/cli-config-fifo.test.js`, now 17 tests. Python, `packages/vantio-agent-sdk-py/tests/test_van394_cli_config_fifo.py`, now 22 tests.

| Test | On `820cf0f` |
| --- | --- |
| Node 13: a call with no known host is kept, and left out of the call count and the byte totals | fail |
| Node 14: a run with only a no-host call shows zero LLM calls and the no-host count | fail |
| Node 15 (negative): a call to a known host is still counted with its bytes, and no no-host line is printed | fail, only on the new `calls_without_host` field |
| Node 16: vantio discover leaves a no-host call out of the rows and totals, and counts it on its own line | fail |
| Node 17 (negative): vantio discover still counts a known-host call with its bytes, and prints no no-host line | fail, only on the new `calls_without_host` field |
| Node 1 to 6 (shared check now expects an empty host list, zero counts and `calls_without_host: 1`) | fail |
| Node 7 to 12 | pass (unchanged behavior) |
| Python `test_a_call_with_no_known_host_is_kept_and_left_out_of_the_call_count` | fail |
| Python `test_a_call_to_a_known_host_is_still_counted_with_its_bytes` (negative) | error, only on the new `calls_without_host` field |
| Python: the two writer-first tests and the two `/dev/stdin` tests (shared check changed the same way) | fail |
| Python: the other 16 | pass |

The old-code runs used a scratch copy of `820cf0f` under `/tmp` with the two new test files put in.

### Commands

Node 22.23.5, pnpm 11.13.0, Python 3.13.18, Linux. Run on this commit's tree.

| Command | rc | Result |
| --- | --- | --- |
| `pnpm --filter @vantio/cli run lint` | 0 | |
| `pnpm --filter @vantio/cli run test` | 0 | 197 tests: 196 pass, 1 skipped, 0 fail |
| `pnpm run test:python` | 0 | 150 tests, OK, 2 skipped |
| `node --test test/*.test.js` (repository root) | 0 | 5 pass |
| `node --test test/cli-config-fifo.test.js` on the scratch copy of `820cf0f` | 1 | 17 tests: 6 pass, 11 fail |
| `python3 -m unittest tests.test_van394_cli_config_fifo` on the scratch copy of `820cf0f` | 1 | 22 tests: 5 failures, 1 error |
| AGENTS.md secret scan | 0 | no pattern matched |

### Gaps

- The no-host call is still recorded without a scope check. That was part of the same question; option A keeps the record.
- Other readers were not changed: `vantio diff`, `search`, `tail`, `coverage`, `destinations`, `export`, and the `optics_discover_local` tool in `packages/vantio-optics-mcp` (`src/runs.js` still groups such calls under `unknown`). `vantio diff` counts from `calls` for a log with no `summary.by_host`, which includes Python run logs (corrected; see the next section).
- `vantio prove` shows the lower totals but has no line for the no-host count.
- A run log written before this commit keeps its old `summary`. `vantio discover` reads `calls`, so it treats old logs the new way.
- `vantio discover --host` still prints the no-host line when the count is above 0.
- The new wording has no sign-off yet.
- Not run for this commit: the optics-mcp and agent-sdk packages (not touched), Python 3.10, 3.11 and 3.12, macOS, Windows, the drift check, the 25-run writer-first repro.
- GitHub CI did not run (billing lock, VAN-129).

## 2026-11-25: review round 3 (findings 1 to 5)

A fresh review failed `ff58e31` with six findings. This section covers the one commit on top of `ff58e31` that answers findings 1 to 5. Finding 6 is left for a follow-up and stays in the gap list.

### What changed, by finding

1. **A known host with no scheme dropped out of the totals.** `curl -K /dev/null -d abc host/path` was recorded with no host. curl reads an argument with no scheme as `host[:port][/path]` over http, so the parsers now do the same.
   - Node `bin/interceptor.cjs`: `isSchemelessUrl`, `httpUrlFromToken`, `curlOptionTakesNextArg`, `curlDefaultScheme`; used in `parseCurlArgv`, `urlFromCurlConfig` and `urlsFromListFile`.
   - Python `vantio/_http_observe.py`: `_is_schemeless_url`, `_http_url_from_token`, `_curl_option_takes_next_arg`, `_curl_default_scheme`; used in `_parse_curl_argv`, `_url_from_curl_config` and `_urls_from_list_file`.
   - The normal scope check then applies. A watched host is recorded and counted. A host that is not watched records nothing, as with `https://`.
   - A value of a curl option is never read as a URL (`-o name`, `-H name`, `--proxy name`, `-sSo name` and the rest of curl's options that take a value). A URL with a scheme still wins over one without, as before.
   - `--url name` and `--proto-default https` are honored. Names that curl reads as another protocol (`ftp.`, `dict.`, `ldap.`, `imap.`, `smtp.`, `pop3.`) are not taken.
   - This also records `curl host/path` with no `-K`, which recorded nothing before.
2. **`vantio prove` heading.** The call log heading now counts the rows. A line under the table names the no-host count. Same in the MCP prove (`packages/vantio-optics-mcp/src/runs.js`).
3. **Other readers.**
   - MCP `optics_discover_local`: no `unknown` row, not in `host_count`, new field `calls_without_host`. MCP `optics_list_runs` fallback totals leave no-host calls out.
   - `vantio diff`: the fallback that counts from `calls` (used for a log with no `by_host`, such as a Python run log) leaves no-host calls out.
   - `vantio coverage`: a no-host call is still listed in `connections`, but it gets no destination row and is not in `counts.connections`. New field `counts.calls_without_host` and one text line.
   - `vantio destinations` already skipped these calls. `search`, `tail` and `export` list single calls and still list the row; their counts are row counts, so they were left as they are.
4. **Run status.** The `run_summary` event, `vantio prove` and the Python run file now take the status from the counted calls. A no-host-only run is `NOT_OBSERVED` with 0 calls, as `discover` says.
5. **Wording.** A no-host-only run prints `Total bytes:  0`. `vantio discover --host <x>` prints no no-host line, and its `--json` leaves the field out.

Correction to the section above: it said `vantio diff` counts `calls` only for a log with no `summary`. That was wrong. It counts `calls` for any log with no `summary.by_host`, which includes every Python run log. This commit fixes that path.

### Wording that a user sees (needs sign-off before release)

Old is `ff58e31`.

| Where | Old | New |
| --- | --- | --- |
| Run summary, a run with only a no-host call | `Total bytes:  unknown` | `Total bytes:  0` |
| `vantio prove` (md and html), heading | `Call log (1 call)` over 2 rows (the count was the summary total) | `Call log (2 calls)` (the count is the rows) |
| `vantio prove` (md and html), new line under the table, only when the count is above 0 | (none) | `Calls with no known host: 1 (listed above, not counted in the summary)` |
| `vantio prove`, a no-host-only log, status cells | `Successful` | `Not observed` |
| MCP prove, heading | `## Calls` | `## Calls (2)` |
| MCP prove, new line under the table, only when the count is above 0 | (none) | `Calls with no known host: 1 (listed above, not counted in the summary)` |
| `vantio coverage`, a no-host call | a destination row named `unknown` under "Outside authority", and counted in `Connections seen` | no row, not in `Connections seen` |
| `vantio coverage`, new line, only when the count is above 0 | (none) | `Calls with no known host: 1 (not counted above)` |
| `vantio diff`, a Python run log with a no-host call | `+ unknown  (1 call(s))` | (no line) |
| `vantio discover --host <x>` | `Calls with no known host: 1 (not counted above)` | (no line) |

No README or changelog text changed.

### Tests

Node `test/cli-config-fifo.test.js` has 32 tests (15 new). Python `tests/test_van394_cli_config_fifo.py` has 28 (6 new). `packages/vantio-optics-mcp/test/runs.test.js` has 3 (2 new). Old-code runs used a scratch copy of `ff58e31` under `/tmp` with the three test files put in.

| Test | On `ff58e31` |
| --- | --- |
| Node 14 (now also expects `Total bytes: 0`) | fail |
| Node 18: no scheme, watched host, `-K /dev/null`: counted with its host and bytes | fail |
| Node 19: no scheme, watched host, no `-K`: recorded | fail |
| Node 20 (negative): an option value that looks like a host is not recorded as a call | pass (old code never read such a value as a URL) |
| Node 21 (negative): no scheme, host not watched: nothing recorded | pass (old code recorded nothing either) |
| Node 22: no scheme in a curl config or a wget list | fail |
| Node 23: no-host-only run reports `NOT_OBSERVED` with zero calls | fail |
| Node 24 (negative): a run with a known-host call still reports `SUCCESS` | pass (unchanged behavior) |
| Node 25, 26: prove heading, rows, line and status | fail |
| Node 27 (negative): prove with known-host calls only | fail, only on the new `calls_without_host` field |
| Node 28: diff, Python log, no `unknown` host | fail |
| Node 29 (negative): diff still reports a new known host | fail (the old code also added `unknown`) |
| Node 30: coverage, no row and its own count | fail |
| Node 31 (negative): coverage with known-host calls only | fail, only on the new field |
| Node 32: `discover --host` prints no no-host line | fail |
| MCP 2: discover, list and prove | fail |
| MCP 3 (negative): known-host call still counted | fail, only on the new field and the new heading |
| Python: no scheme with `-K /dev/null`; no scheme without `-K`; no scheme in a config or list | fail, error, error |
| Python: the four no-host tests (shared check now expects `NOT_OBSERVED`) | fail |
| Python (negative): option value; host not watched; known-host run still `SUCCESS` | pass (unchanged behavior) |

Six negative tests pass on the old code because they guard behavior that must not change.

### Commands

Node 22.23.5, pnpm 11.13.0, Python 3.13.18, Linux. Run on this commit's source tree.

| Command | rc | Result |
| --- | --- | --- |
| `pnpm --filter @vantio/cli run lint` | 0 | |
| `pnpm --filter @vantio/cli run test` | 0 | 212 tests: 211 pass, 1 skipped, 0 fail |
| `pnpm --filter @vantio/optics-mcp run lint` | 0 | |
| `pnpm --filter @vantio/optics-mcp run test` | 0 | 10 pass |
| `pnpm --filter @vantio/agent-sdk run test` | 0 | 42 pass |
| `pnpm run test:python` | 0 | 156 tests, OK, 2 skipped |
| `node --test test/*.test.js` (repository root) | 0 | 5 pass |
| `node --test test/cli-config-fifo.test.js` on the scratch copy of `ff58e31` | 1 | 32 tests: 19 pass, 13 fail |
| `node --test test/runs.test.js` (optics-mcp) on the scratch copy | 1 | 3 tests: 1 pass, 2 fail |
| `python3 -m unittest tests.test_van394_cli_config_fifo` on the scratch copy | 1 | 28 tests: 5 failures, 2 errors |
| AGENTS.md secret scan | 0 | no pattern matched |

### FIFO shapes, re-run

Stand-in `curl -K` and `wget -i` with a FIFO (no writer), a symlink to it, a unix socket and `/dev/stdin`, in Node and under `shield()` in Python. 8 spawns per runtime. Every spawn returned in 7 ms or less. Each runtime recorded 8 calls with no host, `total_calls: 0`, `calls_without_host: 8`. Python's status was `NOT_OBSERVED`.

### Gaps

- From the review, finding 6, not in this commit: a URL past the first 1 MiB of a `-K` file is not recorded; `curl -K -` on a pipe is not recorded; `//dev/stdin` slips past the path check.
- No-scheme URLs are read on curl's command line, in a curl config and in `-i` lists only. On the command line of wget, httpie and aria2c they are still not read: those tools have their own option rules (wget takes shortened long options; httpie mixes in method words and `key=value` items), and a value table for them was not built here.
- The curl option table is a fixed list. An option that is not in it and takes a value could have that value read as a URL. It is then recorded only if the value is the name of a watched host. curl versions that accept shortened long options are not handled.
- Not handled for no-scheme URLs: `user:password@host`, a `proto-default` line inside a config file, and more than one URL on a curl command line (the first one is used, as before).
- A no-scheme call is recorded as http on port 80 unless `--proto-default https` is given. The scope check gets that port.
- A run log written before option A keeps its old `summary` and `by_host`. Readers that use those fields show the old numbers for it.
- `vantio coverage --json` still lists a no-host call in `connections`, with destination `unknown`. `counts.connections` is lower than that list by `counts.calls_without_host`.
- `vantio tail --json` `total_calls` is the row count, as before.
- The anonymous opt-in usage ping still sends the count of all recorded calls.
- The new wording has no sign-off yet.
- Not run for this commit: Python 3.10, 3.11 and 3.12, macOS, Windows, the drift check, the 25-run writer-first repro (the writer-first tests in both suites pass).
- GitHub CI did not run (billing lock, VAN-129).
