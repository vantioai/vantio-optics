# VAN-384: httpx streaming bodies and the urllib default timeout under shield()

Branch `engineering/van-384-optics-python-sdk-shield-breaks-httpx`, from vantio-optics `main` at `8bee543`. Mirror: vantio-open-core PR on the same branch name. Python SDK source only. Nothing tagged or published. The version stays 3.1.3.

## Finding

Found by an independent review (fresh session) and reproduced here. Both apply to every host, not only the hosts Optics watches.

1. `_observe_sync` and `_observe_async` read `getattr(request, "content", None)`. For a streaming body (a generator, an async iterator, or a multipart file), httpx raises `RequestNotRead`, and `getattr`'s default doesn't catch it. So `client.post(url, content=gen())` and `files=...` raised inside `shield()` and returned 200 outside it.
2. `_observe_urlopen` defaulted `timeout=None`. The stdlib default is `socket._GLOBAL_DEFAULT_TIMEOUT`. `None` turns off `socket.setdefaulttimeout`: with a 1 s default and a server that never answers, unwrapped urlopen raised after 1.0 s, but inside `shield()` it was still blocked after 6 s.

## What changed

- New `_httpx_body(request)`: returns `request.content`, or `None` when httpx raises. The body is only used for its length in `_decide`, so a stream counts as unknown length. It is not read or consumed.
- `_observe_urlopen(..., timeout=socket._GLOBAL_DEFAULT_TIMEOUT, ...)`. A timeout the caller passes, including `None`, is still passed through as given.
- New `tests/test_van384_httpx_body_timeout.py` (7 tests). It uses a local server that reads both Content-Length and chunked bodies.
  - Streaming, multipart and plain bodies to a host out of scope, sync and async: all 200, and the server gets the bytes.
  - The same to a host in scope: all 200, and 5 calls recorded with status 200.
  - The helper: `None` for a stream, the bytes for a plain body. The test first shows `.content` raising.
  - Default timeout 0.5 s against a silent server, out of scope and in scope: times out in under 4 s.
  - Negative case: with a 30 s default and an explicit `timeout=0.4`, the explicit value wins.
  - The wrapper's default is the same sentinel as the stdlib `urlopen`.

## Commands

| Command | rc | Result |
| --- | --- | --- |
| New tests, 8 runs in a row (Python 3.12) | 0 | 7 pass every run |
| `python -m unittest discover -s tests -t .` on Python 3.10, 3.11, 3.12 (requests, httpx, aiohttp, urllib3, build installed, as in CI) | 0 | 135 tests OK, 2 skipped each (main: 128) |
| Revert the httpx fix only | 1 | 2 errors (`RequestNotRead`) |
| Revert the timeout fix only | 1 | 3 failures |
| AGENTS.md secret scan | 0 | no pattern matched |

The original repro scripts were re-run on this branch: both cases pass.

## Gaps

- CI did not run: the org billing lock (VAN-129).
- The drift check compares `packages/vantio-agent-sdk-py` with open-core `main`, so this and the open-core mirror go together.
- Not tested: pycurl, and real provider SDKs (OpenAI file upload). The test uses httpx directly.
- Ships only at the next SDK release, with Zach's go.
