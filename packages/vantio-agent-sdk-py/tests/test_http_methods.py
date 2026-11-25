"""VAN-458: every hooked client records the HTTP method it sent, over HTTPS.

The stand-in server is local (127.0.0.1) with a throwaway certificate that the
test makes with the openssl command. The server records the method it saw, and
the run log must carry the same method. A POST stored as GET fails here.
"""

from __future__ import annotations

import asyncio
import http.client
import json
import os
import shutil
import ssl
import subprocess
import tempfile
import threading
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from vantio import shield

METHODS = ("GET", "POST", "PUT")


def _optional(name: str):
    try:
        return __import__(name)
    except ImportError:
        return None


requests = _optional("requests")
httpx = _optional("httpx")
urllib3 = _optional("urllib3")
aiohttp = _optional("aiohttp")


class _Handler(BaseHTTPRequestHandler):
    seen: list[tuple[str, str]] = []

    def _reply(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)
        type(self).seen.append((self.command, self.path))
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = _reply

    def log_message(self, *_args: object) -> None:
        return


@unittest.skipUnless(shutil.which("openssl"), "openssl is needed for the throwaway certificate")
class HttpsMethodTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.dir = tempfile.mkdtemp()
        self.home = os.path.join(self.dir, "home")
        cert = os.path.join(self.dir, "c.pem")
        key = os.path.join(self.dir, "k.pem")
        subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
             "-days", "2", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"],
            check=True, capture_output=True,
        )
        self.cert = cert
        self.ctx = ssl.create_default_context(cafile=cert)
        keys = ("VANTIO_HOME", "VANTIO_EXTRA_LLM_HOSTS", "VANTIO_API_KEY", "VANTIO_INGEST_URL",
                "REQUESTS_CA_BUNDLE", "SSL_CERT_FILE", "VANTIO_RUN_RECORD_INTERVAL_MS")
        self._saved = {k: os.environ.get(k) for k in keys}
        os.environ["VANTIO_HOME"] = self.home
        os.environ["VANTIO_EXTRA_LLM_HOSTS"] = "127.0.0.1"
        os.environ["REQUESTS_CA_BUNDLE"] = cert
        os.environ["SSL_CERT_FILE"] = cert
        os.environ.pop("VANTIO_API_KEY", None)
        os.environ.pop("VANTIO_INGEST_URL", None)
        _Handler.seen = []
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        server_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        server_ctx.load_cert_chain(cert, key)
        self.server.socket = server_ctx.wrap_socket(self.server.socket, server_side=True)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.port = self.server.server_address[1]
        self.base = f"https://127.0.0.1:{self.port}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        shutil.rmtree(self.dir, ignore_errors=True)

    def _recorded(self, trace: str) -> dict[str, str | None]:
        log = json.loads((Path(self.home) / "runs" / f"{trace}.json").read_text(encoding="utf-8"))
        return {c.get("path"): c.get("method") for c in log["calls"] if c.get("path")}

    def _check(self, trace: str, client: str, tag: str) -> None:
        recorded = self._recorded(trace)
        sent = {path: method for method, path in _Handler.seen}
        for method in METHODS:
            path = f"/{method}-{tag}"
            with self.subTest(client=client, method=method):
                self.assertEqual(sent.get(path), method, "the server saw a different method")
                self.assertEqual(recorded.get(path), method)

    @staticmethod
    def _body(method: str):
        return None if method == "GET" else b"{}"

    async def test_http_client(self) -> None:
        async with shield(trace_id="m-hc"):
            for m in METHODS:
                conn = http.client.HTTPSConnection("127.0.0.1", self.port, context=self.ctx)
                conn.request(m, f"/{m}-hc", body=self._body(m))
                conn.getresponse().read()
                conn.close()
        self._check("m-hc", "http.client", "hc")

    async def test_urllib(self) -> None:
        async with shield(trace_id="m-ul"):
            for m in METHODS:
                req = urllib.request.Request(f"{self.base}/{m}-ul", data=self._body(m), method=m)
                urllib.request.urlopen(req, context=self.ctx, timeout=3).read()
        self._check("m-ul", "urllib", "ul")

    async def test_urllib_data_argument_and_get_method_override(self) -> None:
        class Patch(urllib.request.Request):
            def get_method(self) -> str:
                return "PATCH"

        async with shield(trace_id="m-ul2"):
            urllib.request.urlopen(f"{self.base}/POST-str", data=b"{}", context=self.ctx, timeout=3).read()
            urllib.request.urlopen(Patch(f"{self.base}/PATCH-sub", data=b"{}"), context=self.ctx, timeout=3).read()
            # Negative: no body and no method stays GET.
            urllib.request.urlopen(f"{self.base}/GET-plain", context=self.ctx, timeout=3).read()
        recorded = self._recorded("m-ul2")
        self.assertEqual(recorded["/POST-str"], "POST")
        self.assertEqual(recorded["/PATCH-sub"], "PATCH", "a get_method() override is what urllib sends")
        self.assertEqual(recorded["/GET-plain"], "GET")

    @unittest.skipIf(requests is None, "requests is not installed")
    async def test_requests(self) -> None:
        async with shield(trace_id="m-rq"):
            for m in METHODS:
                requests.request(m, f"{self.base}/{m}-rq", data=self._body(m), timeout=3).content
        self._check("m-rq", "requests", "rq")

    @unittest.skipIf(httpx is None, "httpx is not installed")
    async def test_httpx_sync_and_async(self) -> None:
        async with shield(trace_id="m-hx"):
            for m in METHODS:
                httpx.request(m, f"{self.base}/{m}-hx", content=self._body(m), verify=self.ctx, timeout=3).content
            async with httpx.AsyncClient(verify=self.ctx, timeout=3) as client:
                for m in METHODS:
                    await client.request(m, f"{self.base}/{m}-hxa", content=self._body(m))
        self._check("m-hx", "httpx", "hx")
        self._check("m-hx", "httpx async", "hxa")

    @unittest.skipIf(urllib3 is None, "urllib3 is not installed")
    async def test_urllib3(self) -> None:
        async with shield(trace_id="m-u3"):
            pool = urllib3.PoolManager(ca_certs=self.cert)
            for m in METHODS:
                pool.request(m, f"{self.base}/{m}-u3", body=self._body(m), timeout=3).data
        self._check("m-u3", "urllib3", "u3")

    @unittest.skipIf(aiohttp is None, "aiohttp is not installed")
    async def test_aiohttp(self) -> None:
        async with shield(trace_id="m-ah"):
            async with aiohttp.ClientSession() as session:
                for m in METHODS:
                    async with session.request(m, f"{self.base}/{m}-ah", data=self._body(m), ssl=self.ctx) as resp:
                        await resp.read()
        self._check("m-ah", "aiohttp", "ah")


if __name__ == "__main__":
    unittest.main()
