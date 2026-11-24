"""VAN-407: a call recorded by host name lists the socket addresses DNS gave
for that host, so `vantio run` does not add the same socket again by IP."""

import _socket
import json
import os
import shutil
import socket
import tempfile
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

from vantio import shield
from vantio import _http_observe

from .mock_server import MockServer


class RemoteAddressesTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.home = tempfile.mkdtemp()
        self._saved = {k: os.environ.get(k) for k in ("VANTIO_HOME", "VANTIO_EXTRA_LLM_HOSTS")}
        os.environ["VANTIO_HOME"] = self.home
        os.environ["VANTIO_EXTRA_LLM_HOSTS"] = "llm.example.test"

    def tearDown(self) -> None:
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        shutil.rmtree(self.home, ignore_errors=True)

    def _log(self, trace: str) -> dict:
        return json.loads((Path(self.home) / "runs" / f"{trace}.json").read_text(encoding="utf-8"))

    async def test_a_named_call_lists_the_address_dns_gave(self) -> None:
        real = _socket.getaddrinfo

        def resolve(host, port, *args, **kwargs):  # type: ignore[no-untyped-def]
            return real("127.0.0.1" if host == "llm.example.test" else host, port, *args, **kwargs)

        with MockServer() as server:
            port = int(server.url.rsplit(":", 1)[1])
            with mock.patch.object(_socket, "getaddrinfo", side_effect=resolve):
                async with shield(trace_id="py-van407"):
                    urllib.request.urlopen(f"http://llm.example.test:{port}/v1/chat", timeout=5).read()
        calls = self._log("py-van407")["calls"]
        self.assertEqual([c["hostname"] for c in calls], ["llm.example.test"])
        self.assertEqual(calls[0]["remote_addresses"], [{"address": "127.0.0.1", "port": port}])

    async def test_a_host_that_is_not_in_scope_is_not_listed(self) -> None:
        async with shield(trace_id="py-van407-out"):
            socket.getaddrinfo("localhost", 80)
            self.assertEqual(_http_observe._remote_addresses_for("localhost"), [])

    async def test_getaddrinfo_is_put_back_when_the_shield_ends(self) -> None:
        before = socket.getaddrinfo
        async with shield(trace_id="py-van407-restore"):
            self.assertIsNot(socket.getaddrinfo, before)
        self.assertIs(socket.getaddrinfo, before)


if __name__ == "__main__":
    unittest.main()
