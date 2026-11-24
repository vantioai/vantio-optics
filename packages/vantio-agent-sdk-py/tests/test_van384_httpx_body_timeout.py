"""VAN-384: shield() must not break httpx streaming bodies or urllib timeouts."""

from __future__ import annotations

import io
import json
import os
import socket
import tempfile
import threading
import time
import unittest
import urllib.request
from pathlib import Path

from vantio import shield
from vantio._http_observe import _httpx_body

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    import httpx
except ImportError:  # pragma: no cover - CI installs httpx
    httpx = None  # type: ignore[assignment]


class _BodyServer:
    """Reads Content-Length and chunked bodies, answers 200, keeps each body."""

    def __enter__(self) -> "_BodyServer":
        bodies: list = []

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self) -> None:  # noqa: N802 - http.server API
                if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
                    data = b""
                    while True:
                        size = int(self.rfile.readline().strip().split(b";")[0], 16)
                        if size == 0:
                            self.rfile.readline()
                            break
                        data += self.rfile.read(size)
                        self.rfile.readline()
                else:
                    data = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                bodies.append(data)
                self.send_response(200)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, *_args: object) -> None:
                return

        self.bodies = bodies
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}/v1/upload"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *exc: object) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


class _EnvMixin:
    def _env(self, scoped: bool) -> None:
        self._home = tempfile.mkdtemp()
        self._saved = {k: os.environ.get(k) for k in ("VANTIO_HOME", "VANTIO_EXTRA_LLM_HOSTS")}
        os.environ["VANTIO_HOME"] = self._home
        if scoped:
            os.environ["VANTIO_EXTRA_LLM_HOSTS"] = "127.0.0.1"
        else:
            os.environ.pop("VANTIO_EXTRA_LLM_HOSTS", None)

    def _restore(self) -> None:
        for key, value in getattr(self, "_saved", {}).items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def _calls(self, trace: str) -> list:
        data = json.loads((Path(self._home) / "runs" / f"{trace}.json").read_text(encoding="utf-8"))
        return data["calls"]


@unittest.skipIf(httpx is None, "httpx is not installed")
class HttpxStreamingBodyTests(_EnvMixin, unittest.IsolatedAsyncioTestCase):
    def tearDown(self) -> None:
        self._restore()

    async def _post_all(self, url: str) -> list[int]:
        def gen():
            yield b"hello "
            yield b"world"

        async def agen():
            yield b"hello"

        out = []
        with httpx.Client(timeout=5) as client:
            out.append(client.post(url, content=gen()).status_code)
            out.append(client.post(url, files={"f": ("a.txt", io.BytesIO(b"abc"))}).status_code)
            out.append(client.post(url, content=b"plain").status_code)
        async with httpx.AsyncClient(timeout=5) as client:
            out.append((await client.post(url, content=agen())).status_code)
            out.append((await client.post(url, files={"f": ("a.txt", io.BytesIO(b"abc"))})).status_code)
        return out

    async def test_streaming_bodies_to_a_host_out_of_scope_still_send(self) -> None:
        self._env(scoped=False)
        with _BodyServer() as server:
            async with shield(trace_id="van384-out"):
                statuses = await self._post_all(server.url)
        self.assertEqual(statuses, [200] * 5)
        self.assertEqual(server.bodies[0], b"hello world")
        self.assertEqual(server.bodies[1].count(b"abc"), 1)
        self.assertEqual(server.bodies[2], b"plain")
        self.assertEqual(server.bodies[3], b"hello")

    async def test_streaming_bodies_to_a_host_in_scope_send_and_are_recorded(self) -> None:
        self._env(scoped=True)
        with _BodyServer() as server:
            async with shield(trace_id="van384-in"):
                statuses = await self._post_all(server.url)
        self.assertEqual(statuses, [200] * 5)
        self.assertEqual(server.bodies[0], b"hello world")
        calls = self._calls("van384-in")
        self.assertEqual(len(calls), 5)
        self.assertTrue(all(c["mediation"] == "python_httpx" for c in calls))
        self.assertTrue(all(c["status"] == 200 for c in calls))

    def test_body_helper_returns_none_for_a_streaming_request(self) -> None:
        def gen():
            yield b"x"

        streaming = httpx.Request("POST", "http://127.0.0.1/", content=gen())
        with self.assertRaises(httpx.RequestNotRead):
            streaming.content  # what the old getattr() call hit
        self.assertIsNone(_httpx_body(streaming))
        self.assertEqual(_httpx_body(httpx.Request("POST", "http://127.0.0.1/", content=b"abc")), b"abc")


class _SilentServer:
    """Accepts connections and never answers."""

    def __enter__(self) -> "_SilentServer":
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(8)
        self.port = self.sock.getsockname()[1]
        self.held: list = []
        self._stop = False

        def accept() -> None:
            while not self._stop:
                try:
                    conn, _ = self.sock.accept()
                except OSError:
                    return
                self.held.append(conn)

        threading.Thread(target=accept, daemon=True).start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._stop = True
        for conn in self.held:
            conn.close()
        self.sock.close()


class UrlopenTimeoutTests(_EnvMixin, unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._old_default = socket.getdefaulttimeout()

    def tearDown(self) -> None:
        socket.setdefaulttimeout(self._old_default)
        self._restore()

    def _time_urlopen(self, url: str, **kwargs: object) -> tuple[str, float]:
        result: list = []

        def call() -> None:
            t0 = time.monotonic()
            try:
                urllib.request.urlopen(url, **kwargs)
                result.append(("returned", time.monotonic() - t0))
            except Exception as exc:  # noqa: BLE001 - the type is what we check
                result.append((type(exc).__name__, time.monotonic() - t0))

        worker = threading.Thread(target=call, daemon=True)
        worker.start()
        worker.join(8)
        return result[0] if result else ("still blocked", 8.0)

    async def _check_default_timeout(self, scoped: bool) -> None:
        self._env(scoped=scoped)
        socket.setdefaulttimeout(0.5)
        with _SilentServer() as srv:
            async with shield(trace_id="van384-timeout"):
                kind, took = self._time_urlopen(f"http://127.0.0.1:{srv.port}/v1/x")
        self.assertIn(kind, ("TimeoutError", "timeout", "URLError"))
        self.assertLess(took, 4.0)

    async def test_default_timeout_applies_to_a_host_out_of_scope(self) -> None:
        await self._check_default_timeout(scoped=False)

    async def test_default_timeout_applies_to_a_host_in_scope(self) -> None:
        await self._check_default_timeout(scoped=True)

    async def test_an_explicit_timeout_still_wins_over_the_default(self) -> None:
        self._env(scoped=True)
        socket.setdefaulttimeout(30)
        with _SilentServer() as srv:
            async with shield(trace_id="van384-explicit"):
                kind, took = self._time_urlopen(f"http://127.0.0.1:{srv.port}/v1/x", timeout=0.4)
        self.assertNotEqual(kind, "still blocked")
        self.assertLess(took, 4.0)

    def test_wrapper_default_is_the_stdlib_sentinel(self) -> None:
        import inspect

        from vantio import _http_observe

        default = inspect.signature(_http_observe._observe_urlopen).parameters["timeout"].default
        self.assertIs(default, socket._GLOBAL_DEFAULT_TIMEOUT)
        self.assertIs(
            inspect.signature(_http_observe._orig_urlopen).parameters["timeout"].default,
            socket._GLOBAL_DEFAULT_TIMEOUT,
        )


if __name__ == "__main__":
    unittest.main()
