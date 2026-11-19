"""urllib calls record the HTTP method urllib actually sends."""

from __future__ import annotations

import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from vantio import shield


class _Handler(BaseHTTPRequestHandler):
    def _reply(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)
        # Echo the method the server saw, so the test can compare.
        body = self.command.encode()
        self.send_response(404 if self.path.startswith("/missing") else 200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = _reply

    def log_message(self, *_args: object) -> None:
        return


class UrllibMethodTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._home = tempfile.mkdtemp()
        keys = ("VANTIO_HOME", "VANTIO_EXTRA_LLM_HOSTS", "VANTIO_API_KEY", "VANTIO_INGEST_URL")
        self._saved = {k: os.environ.get(k) for k in keys}
        os.environ["VANTIO_HOME"] = self._home
        os.environ["VANTIO_EXTRA_LLM_HOSTS"] = "127.0.0.1"
        os.environ.pop("VANTIO_API_KEY", None)
        os.environ.pop("VANTIO_INGEST_URL", None)
        self._server = HTTPServer(("127.0.0.1", 0), _Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        self._base = f"http://127.0.0.1:{self._server.server_address[1]}"

    def tearDown(self) -> None:
        self._server.shutdown()
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def _calls(self, trace: str) -> dict[str, dict]:
        log = json.loads((Path(self._home) / "runs" / f"{trace}.json").read_text(encoding="utf-8"))
        return {c.get("path"): c for c in log["calls"] if c.get("hostname") == "127.0.0.1"}

    async def test_urlopen_records_the_method_urllib_sends(self) -> None:
        b = self._base
        sent: dict[str, str] = {}
        async with shield(trace_id="urllib-method"):
            cases = {
                "/req-post": urllib.request.Request(f"{b}/req-post", data=b"{}", method="POST"),
                "/req-data": urllib.request.Request(f"{b}/req-data", data=b"{}"),
                "/req-put": urllib.request.Request(f"{b}/req-put", data=b"{}", method="PUT"),
                "/req-delete": urllib.request.Request(f"{b}/req-delete", method="DELETE"),
                "/req-get": urllib.request.Request(f"{b}/req-get"),
                # Negative: an explicit GET with a body is still a GET.
                "/req-get-body": urllib.request.Request(f"{b}/req-get-body", data=b"{}", method="GET"),
            }
            for path, req in cases.items():
                sent[path] = urllib.request.urlopen(req, timeout=2).read().decode()
            sent["/str-data"] = urllib.request.urlopen(f"{b}/str-data", data=b"{}", timeout=2).read().decode()
            # Negative: a plain URL with no data stays GET.
            sent["/str-get"] = urllib.request.urlopen(f"{b}/str-get", timeout=2).read().decode()
            # data passed to urlopen alongside a Request is sent, so it is a POST.
            sent["/req-plus-data"] = urllib.request.urlopen(
                urllib.request.Request(f"{b}/req-plus-data"), data=b"{}", timeout=2
            ).read().decode()

        calls = self._calls("urllib-method")
        expected = {
            "/req-post": "POST",
            "/req-data": "POST",
            "/req-put": "PUT",
            "/req-delete": "DELETE",
            "/req-get": "GET",
            "/req-get-body": "GET",
            "/str-data": "POST",
            "/str-get": "GET",
            "/req-plus-data": "POST",
        }
        for path, method in expected.items():
            with self.subTest(path=path):
                self.assertEqual(sent[path], method, "server saw a different method than expected")
                self.assertIn(path, calls)
                self.assertEqual(calls[path].get("method"), method)

    async def test_opener_open_and_http_error_keep_the_method(self) -> None:
        b = self._base
        opener = urllib.request.build_opener()
        async with shield(trace_id="urllib-opener"):
            opener.open(urllib.request.Request(f"{b}/opener-patch", data=b"{}", method="PATCH"), timeout=2).read()
            opener.open(urllib.request.Request(f"{b}/opener-data", data=b"{}"), timeout=2).read()
            with self.assertRaises(urllib.error.HTTPError):
                urllib.request.urlopen(
                    urllib.request.Request(f"{b}/missing", data=b"{}", method="PUT"), timeout=2
                )
        calls = self._calls("urllib-opener")
        self.assertEqual(calls["/opener-patch"]["method"], "PATCH")
        self.assertEqual(calls["/opener-data"]["method"], "POST")
        self.assertEqual(calls["/missing"]["method"], "PUT")
        self.assertEqual(calls["/missing"]["status"], 404)


if __name__ == "__main__":
    unittest.main()
