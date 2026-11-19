"""urllib calls are recorded with the method urllib sends (VAN-85).

urlopen(Request(url, data=..., method="POST")) was recorded as GET because the
hook read only the data argument. The method now comes from the Request.
"""
from __future__ import annotations

import json
import os
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from vantio import shield
from vantio._http_observe import _urllib_method

from .mock_server import MockServer

BODY = b'{"prompt": "van85-secret-prompt"}'


class UrllibMethodUnitTests(unittest.TestCase):
    def test_method_follows_the_request(self) -> None:
        req = urllib.request.Request
        cases = [
            ((req("http://h/v1/chat", data=BODY, method="POST"), None), "POST"),
            ((req("http://h/v1/chat", data=BODY), None), "POST"),
            ((req("http://h/v1/chat"), BODY), "POST"),
            ((req("http://h/v1/chat", method="PUT"), None), "PUT"),
            ((req("http://h/v1/chat", method="delete"), BODY), "DELETE"),
            ((req("http://h/v1/chat"), None), "GET"),
            (("http://h/v1/chat", None), "GET"),
            (("http://h/v1/chat", BODY), "POST"),
        ]
        for args, want in cases:
            with self.subTest(want=want, args=args):
                self.assertEqual(_urllib_method(*args), want)

    def test_negative_the_old_rule_disagrees(self) -> None:
        # The rule the hook used before: POST only when the data argument is set.
        def old(_url: object, data: object) -> str:
            return "POST" if data is not None else "GET"

        r = urllib.request.Request("http://h/v1/chat", data=BODY, method="POST")
        self.assertEqual(old(r, None), "GET")
        self.assertNotEqual(old(r, None), _urllib_method(r, None))

    def test_a_subclass_get_method_is_honoured(self) -> None:
        class Head(urllib.request.Request):
            def get_method(self) -> str:
                return "HEAD"

        self.assertEqual(_urllib_method(Head("http://h/x"), None), "HEAD")

    def test_a_broken_get_method_falls_back(self) -> None:
        class Broken(urllib.request.Request):
            def get_method(self) -> str:
                raise RuntimeError("boom")

        self.assertEqual(_urllib_method(Broken("http://h/x"), None), "GET")
        self.assertEqual(_urllib_method(Broken("http://h/x", data=BODY), None), "POST")


class UrllibMethodRecordedTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._home = tempfile.mkdtemp()
        self._saved = {
            key: os.environ.get(key)
            for key in ("VANTIO_HOME", "VANTIO_EXTRA_LLM_HOSTS", "VANTIO_API_KEY", "VANTIO_INGEST_URL")
        }
        os.environ["VANTIO_HOME"] = self._home
        os.environ["VANTIO_EXTRA_LLM_HOSTS"] = "127.0.0.1"
        os.environ.pop("VANTIO_API_KEY", None)
        os.environ.pop("VANTIO_INGEST_URL", None)

    def tearDown(self) -> None:
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def _calls(self, trace_id: str) -> list[dict]:
        path = Path(self._home) / "runs" / f"{trace_id}.json"
        self.assertTrue(path.is_file(), trace_id)
        text = path.read_text(encoding="utf-8")
        # The body is still never stored.
        self.assertNotIn("van85-secret-prompt", text)
        data = json.loads(text)
        return [c for c in data["calls"] if c.get("mediation") == "python_urllib"]

    async def _one(self, trace: str, call) -> dict:  # type: ignore[no-untyped-def]
        with MockServer() as server:
            server.respond_with(200, {"ok": True})
            async with shield(trace_id=trace):
                call(server.url + "/v1/chat")
        calls = self._calls(trace)
        self.assertEqual(len(calls), 1, calls)
        self.assertEqual(calls[0]["status"], 200)
        return calls[0]

    async def test_urlopen_request_with_method_post(self) -> None:
        call = await self._one(
            "van85-explicit-post",
            lambda url: urllib.request.urlopen(
                urllib.request.Request(url, data=BODY, method="POST"), timeout=2
            ),
        )
        self.assertEqual(call["method"], "POST")

    async def test_urlopen_request_with_data_and_no_method(self) -> None:
        call = await self._one(
            "van85-implicit-post",
            lambda url: urllib.request.urlopen(urllib.request.Request(url, data=BODY), timeout=2),
        )
        self.assertEqual(call["method"], "POST")

    async def test_plain_get_stays_get(self) -> None:
        call = await self._one("van85-get", lambda url: urllib.request.urlopen(url, timeout=2))
        self.assertEqual(call["method"], "GET")
        call = await self._one(
            "van85-get-request",
            lambda url: urllib.request.urlopen(urllib.request.Request(url), timeout=2),
        )
        self.assertEqual(call["method"], "GET")

    async def test_opener_request_with_method_post(self) -> None:
        opener = urllib.request.build_opener()
        call = await self._one(
            "van85-opener-post",
            lambda url: opener.open(urllib.request.Request(url, data=BODY, method="POST"), timeout=2),
        )
        self.assertEqual(call["method"], "POST")

    async def test_error_path_records_the_request_method(self) -> None:
        # The mock server has no PUT handler, so it answers 501 and urllib
        # raises HTTPError: the exception path records the method too.
        trace = "van85-put-error"
        with MockServer() as server:
            with self.assertRaises(urllib.error.HTTPError):
                async with shield(trace_id=trace):
                    urllib.request.urlopen(
                        urllib.request.Request(server.url + "/v1/chat", data=BODY, method="PUT"), timeout=2
                    )
        calls = self._calls(trace)
        self.assertEqual(len(calls), 1, calls)
        self.assertEqual(calls[0]["method"], "PUT")
        self.assertEqual(calls[0]["status"], 501)


if __name__ == "__main__":
    unittest.main()
