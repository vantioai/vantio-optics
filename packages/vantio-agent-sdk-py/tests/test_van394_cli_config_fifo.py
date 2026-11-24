"""VAN-394: a curl -K config or wget -i list that is a FIFO must not block shield()."""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import threading
import time
import unittest

from vantio import shield
from vantio._http_observe import _read_regular_file, _url_from_curl_config, _urls_from_list_file


class ReadRegularFileTests(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.mkdtemp()

    def test_a_regular_file_is_read(self) -> None:
        path = os.path.join(self.dir, "cfg")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write('url = "https://api.example.test/v1"\n')
        self.assertEqual(_url_from_curl_config(path), "https://api.example.test/v1")
        list_path = os.path.join(self.dir, "list")
        with open(list_path, "w", encoding="utf-8") as fh:
            fh.write("https://a.example.test/x\n# note\nhttps://b.example.test/y\n")
        self.assertEqual(
            _urls_from_list_file(list_path),
            ["https://a.example.test/x", "https://b.example.test/y"],
        )

    def test_a_fifo_is_skipped_at_once(self) -> None:
        fifo = os.path.join(self.dir, "fifo")
        os.mkfifo(fifo)
        t0 = time.monotonic()
        self.assertIsNone(_read_regular_file(fifo, 1024))
        self.assertIsNone(_url_from_curl_config(fifo))
        self.assertEqual(_urls_from_list_file(fifo), [])
        self.assertLess(time.monotonic() - t0, 1.0)

    def test_a_device_is_skipped(self) -> None:
        self.assertIsNone(_read_regular_file("/dev/zero", 1024))

    def test_the_cap_is_kept(self) -> None:
        path = os.path.join(self.dir, "big")
        with open(path, "wb") as fh:
            fh.write(b"x" * 5000)
        self.assertEqual(len(_read_regular_file(path, 100) or b""), 100)


@unittest.skipIf(shutil.which("curl") is None, "curl is not installed")
class CurlFifoUnderShieldTests(unittest.IsolatedAsyncioTestCase):
    async def test_popen_curl_k_fifo_returns_and_the_child_reads_it(self) -> None:
        home = tempfile.mkdtemp()
        saved = {k: os.environ.get(k) for k in ("VANTIO_HOME", "VANTIO_EXTRA_LLM_HOSTS")}
        os.environ["VANTIO_HOME"] = home
        os.environ["VANTIO_EXTRA_LLM_HOSTS"] = "127.0.0.1"
        fifo = os.path.join(tempfile.mkdtemp(), "cfg")
        os.mkfifo(fifo)
        result: dict = {}
        try:
            async with shield(trace_id="van394-curl"):
                def spawn() -> None:
                    t0 = time.monotonic()
                    proc = subprocess.Popen(
                        ["curl", "-sS", "-o", os.devnull, "-K", fifo],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )
                    result["spawn_s"] = time.monotonic() - t0
                    with open(fifo, "w", encoding="utf-8") as fh:
                        fh.write('url = "http://127.0.0.1:9/"\n')
                    result["rc"] = proc.wait(timeout=10)

                worker = threading.Thread(target=spawn, daemon=True)
                worker.start()
                worker.join(8)
                self.assertFalse(worker.is_alive(), "Popen or the config write blocked")
        finally:
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
        self.assertLess(result["spawn_s"], 1.0)
        # curl read the config itself and tried port 9 (connection refused = 7).
        self.assertEqual(result["rc"], 7)


if __name__ == "__main__":
    unittest.main()
