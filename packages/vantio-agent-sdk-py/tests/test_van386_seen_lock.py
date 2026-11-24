"""VAN-386: a stale seen.lock is taken over; a fresh one is left alone."""

from __future__ import annotations

import os
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

from vantio import shield
from vantio._http_observe import _take_stale_seen_lock

from .mock_server import MockServer


class SeenLockTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._home = tempfile.mkdtemp()
        self._saved = {k: os.environ.get(k) for k in ("VANTIO_HOME", "VANTIO_EXTRA_LLM_HOSTS")}
        os.environ["VANTIO_HOME"] = self._home
        os.environ["VANTIO_EXTRA_LLM_HOSTS"] = "127.0.0.1"
        self.lock = Path(self._home) / "seen.lock"

    def tearDown(self) -> None:
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    async def _timed_calls(self, n: int) -> list[float]:
        times = []
        with MockServer() as server:
            server.respond_with(200, {"ok": True})
            async with shield(trace_id="van386-lock"):
                for _ in range(n):
                    t0 = time.monotonic()
                    urllib.request.urlopen(server.url, timeout=5).read()
                    times.append(time.monotonic() - t0)
        return times

    async def test_a_stale_lock_is_taken_over(self) -> None:
        self.lock.mkdir()
        old = time.time() - 60
        os.utime(self.lock, (old, old))
        times = await self._timed_calls(2)
        self.assertTrue(all(t < 1.0 for t in times), times)
        self.assertFalse(self.lock.exists())
        self.assertEqual([p for p in os.listdir(self._home) if p.startswith("seen.lock")], [])
        self.assertIn("127.0.0.1", (Path(self._home) / "seen-destinations.json").read_text(encoding="utf-8"))

    async def test_a_fresh_lock_is_left_alone(self) -> None:
        self.lock.mkdir()
        times = await self._timed_calls(1)
        self.assertEqual(len(times), 1)  # the call itself still completes
        self.assertTrue(self.lock.exists())

    def test_helper(self) -> None:
        self.assertTrue(_take_stale_seen_lock(str(self.lock)))  # missing: retry
        self.lock.mkdir()
        self.assertFalse(_take_stale_seen_lock(str(self.lock)))  # fresh: wait
        old = time.time() - 60
        os.utime(self.lock, (old, old))
        self.assertTrue(_take_stale_seen_lock(str(self.lock)))  # stale: taken
        self.assertFalse(self.lock.exists())


if __name__ == "__main__":
    unittest.main()
