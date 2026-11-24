"""VAN-387: http.client records a failed call as failed and times it to the response."""

from __future__ import annotations

import http.client
import json
import os
import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path

from vantio import shield


def _server(mode: str) -> tuple[socket.socket, int]:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen(5)

    def run() -> None:
        while True:
            try:
                conn, _ = sock.accept()
            except OSError:
                return
            conn.recv(65536)
            if mode == "close":
                conn.close()
            elif mode == "slow":
                time.sleep(0.6)
                conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
                conn.close()
            else:
                conn.sendall(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n")
                conn.close()

    threading.Thread(target=run, daemon=True).start()
    return sock, sock.getsockname()[1]


class HttpClientRecordTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._home = tempfile.mkdtemp()
        self._saved = {k: os.environ.get(k) for k in ("VANTIO_HOME", "VANTIO_EXTRA_LLM_HOSTS")}
        os.environ["VANTIO_HOME"] = self._home
        os.environ["VANTIO_EXTRA_LLM_HOSTS"] = "127.0.0.1"
        self._socks: list[socket.socket] = []

    def tearDown(self) -> None:
        for s in self._socks:
            s.close()
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def _port(self, mode: str) -> int:
        sock, port = _server(mode)
        self._socks.append(sock)
        return port

    def _calls(self, trace: str) -> dict:
        data = json.loads((Path(self._home) / "runs" / f"{trace}.json").read_text(encoding="utf-8"))
        return {c["path"]: c for c in data["calls"] if c["mediation"] == "python_http_client"}

    async def test_a_dropped_connection_is_recorded_as_failed(self) -> None:
        port = self._port("close")
        async with shield(trace_id="van387-hc-close"):
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
            conn.request("POST", "/v1/chat?api_key=SECRET", body=b"{}")
            with self.assertRaises(http.client.RemoteDisconnected):
                conn.getresponse()
        call = self._calls("van387-hc-close")["/v1/chat"]
        self.assertIs(call["ok"], False)
        self.assertIsNone(call.get("status"))
        self.assertEqual(call["error"], "network_error")
        self.assertEqual(call["error_class"], "RemoteDisconnected")
        text = (Path(self._home) / "runs" / "van387-hc-close.json").read_text(encoding="utf-8")
        self.assertNotIn("SECRET", text)

    async def test_duration_runs_to_the_response(self) -> None:
        port = self._port("slow")
        async with shield(trace_id="van387-hc-slow"):
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            conn.request("GET", "/v1/slow")
            conn.getresponse().read()
        call = self._calls("van387-hc-slow")["/v1/slow"]
        self.assertEqual(call["status"], 200)
        self.assertIs(call["ok"], True)
        self.assertGreaterEqual(call["duration_ms"], 500)

    async def test_an_http_error_status_is_still_recorded_from_the_response(self) -> None:
        port = self._port("503")
        async with shield(trace_id="van387-hc-503"):
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
            conn.request("GET", "/v1/busy")
            conn.getresponse().read()
        call = self._calls("van387-hc-503")["/v1/busy"]
        self.assertEqual(call["status"], 503)
        self.assertIs(call["ok"], False)
        self.assertIsNone(call.get("error"))


if __name__ == "__main__":
    unittest.main()
