# VAN-387 (part 1): undici dispatch and http.client record what really happened

Branch `engineering/van-387-optics-run-records-that-are-wrong-child`, from vantio-optics `main` at `8bee543`. Mirror: vantio-open-core PR on the same branch name. CLI and Python SDK source. Nothing tagged or published.

This covers items 2 and 3 of VAN-387. Items 1 (child process overwrite), 4 (concurrent `shield()` trace ids) and 5 (calls hidden across `await`) are not in this change.

## Finding

Found by an independent review (fresh session) and reproduced here.

- **undici dispatch.** `pool.stream`, `pipeline`, `connect` and raw `dispatch` always recorded `ok: true, status: null, duration_ms: 0`. A 500 counted as a success and was left out of the error summary.
- **http.client.**
  - The record was written at send time with `ok=True`, and `getresponse` only filled in the status. A server that closed without replying gave the user `RemoteDisconnected`, but the record stayed `ok: True, error: None`.
  - Duration was measured to the end of the send, so a 1.5 s call was recorded as 0 ms.

## What changed

- **`interceptor.cjs`:**
  - The dispatch record is kept, and the handler's `onHeaders` / `onUpgrade` / `onComplete` / `onError` fill in status, ok (200–399, the same rule as `undici.request` and `node:http`), content type, bytes, duration and error.
  - The handler is changed in place, as `attachTunnelHandler` already does.
  - A recording error never changes the request.
- **`_http_observe.py` `getresponse`:**
  - On an exception, the pending record gets `ok=False`, the error class, failure kind, `error="network_error"` and the duration.
  - On a response, the duration runs to the response headers.
- **New tests:**
  - `packages/vantio-cli/test/undici-dispatch-status.test.js`: 500 / 200 / 418 via stream and pipeline, a slow raw dispatch (duration at least 250 ms), and a refused connection (`ok: false`, `ECONNREFUSED`).
  - `packages/vantio-agent-sdk-py/tests/test_van387_http_client.py` (3): a dropped connection is `ok: false` and the secret stays out of the file; duration covers the wait; a 503 is still recorded from the response (negative control).

## Commands

| Command | rc | Result |
| --- | --- | --- |
| New Node test | 0 | pass; on `main`'s interceptor: fails |
| New Python tests | 0 | 3 pass; on `main`'s SDK: 2 fail (the 503 control passes on both) |
| Every `ci.yml` JavaScript step, one at a time | 0 each | CLI tests 180 pass, 1 skipped, 0 fail |
| Python SDK suite on 3.10 / 3.11 / 3.12 | 0 | 131 OK, 2 skipped each |
| AGENTS.md secret scan | 0 | no pattern matched |
| The review's repro script, on this branch | | dropped call `ok: False, error: network_error`; slow call 1500 ms (was `ok: True` and 0 ms) |

## Gaps

- CI did not run: the org billing lock (VAN-129). The drift check compares these packages with open-core `main`, so this and the mirror go together.
- Not covered: pycurl `perform` (pycurl isn't installed here), and VAN-387 items 1, 4 and 5.
- Ships only at the next release, with Zach's go.
