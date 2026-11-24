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
