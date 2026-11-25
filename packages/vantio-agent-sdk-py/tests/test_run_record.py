"""VAN-458: a running program keeps a run record, replaced by the final record at exit."""

from __future__ import annotations

import json
import os
import tempfile
import threading
import time
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from vantio import _http_observe as obs


class _Handler(BaseHTTPRequestHandler):
    def _reply(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    do_GET = do_POST = _reply

    def log_message(self, *_args: object) -> None:
        return


def _wait(fn, what: str, timeout: float = 10.0):
    end = time.monotonic() + timeout
    while True:
        value = fn()
        if value:
            return value
        if time.monotonic() > end:
            raise AssertionError(f"timed out waiting for {what}")
        time.sleep(0.02)


class RunRecordTests(unittest.TestCase):
    KEYS = (
        "VANTIO_HOME",
        "VANTIO_EXTRA_LLM_HOSTS",
        "VANTIO_RUN_RECORD_INTERVAL_MS",
        "VANTIO_RUN_RECORD_OWNER_PID",
        "VANTIO_API_KEY",
        "VANTIO_INGEST_URL",
    )

    def setUp(self) -> None:
        self.home = tempfile.mkdtemp()
        self._saved = {k: os.environ.get(k) for k in self.KEYS}
        os.environ["VANTIO_HOME"] = self.home
        os.environ["VANTIO_EXTRA_LLM_HOSTS"] = "127.0.0.1"
        os.environ["VANTIO_RUN_RECORD_INTERVAL_MS"] = "1000"
        os.environ.pop("VANTIO_RUN_RECORD_OWNER_PID", None)
        os.environ.pop("VANTIO_API_KEY", None)
        os.environ.pop("VANTIO_INGEST_URL", None)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.runs = Path(self.home) / "runs"

    def tearDown(self) -> None:
        while obs._depth > 0:
            obs.uninstall()
        self.server.shutdown()
        self.server.server_close()
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def _post(self, path: str) -> None:
        req = urllib.request.Request(self.base + path, data=b"{}")
        urllib.request.urlopen(req, timeout=3).read()

    def _record(self, trace: str):
        path = self.runs / f"{trace}.json"
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def test_running_record_then_final_record(self) -> None:
        obs.install("rr-1")
        obs.start_running_record()
        self._post("/v1/a")
        # A new destination is written at once, well before the 1 s interval
        # could fire twice. The record is marked running.
        seen = _wait(lambda: (lambda r: r if r and r.get("calls") else None)(self._record("rr-1")), "a running record")
        self.assertEqual(seen["run_state"], "running")
        self.assertEqual(seen["update_interval_ms"], 1000)
        self.assertEqual(seen["calls"][0]["method"], "POST")
        self.assertEqual(seen["vantio_run_log"], "1")
        raw = (self.runs / "rr-1.json").read_text(encoding="utf-8")
        self.assertNotIn("authorization", raw.lower())
        # More calls show up on the next update while the program still runs.
        self._post("/v1/b")
        self._post("/v1/c")
        _wait(lambda: len((self._record("rr-1") or {}).get("calls", [])) >= 3, "the periodic update")
        self.assertEqual(self._record("rr-1")["run_state"], "running")
        obs.uninstall()
        final = self._record("rr-1")
        self.assertNotIn("run_state", final)
        self.assertNotIn("update_interval_ms", final)
        self.assertEqual(len(final["calls"]), 3)
        self.assertEqual([p.name for p in self.runs.iterdir()], ["rr-1.json"], "no temp file is left")

    def test_nothing_overwrites_the_final_record(self) -> None:
        obs.install("rr-2")
        obs.start_running_record()
        self._post("/v1/a")
        obs.uninstall()
        final = self._record("rr-2")
        self.assertNotIn("run_state", final)
        # A late timer or thread must not bring run_state back.
        obs._write_running()
        self.assertNotIn("run_state", self._record("rr-2"))

    def test_negative_interval_off_writes_only_the_final_record(self) -> None:
        os.environ["VANTIO_RUN_RECORD_INTERVAL_MS"] = "off"
        obs.install("rr-3")
        obs.start_running_record()
        self._post("/v1/a")
        self._post("/v1/b")
        self.assertIsNone(self._record("rr-3"), "no running record when the interval is off")
        obs.uninstall()
        self.assertNotIn("run_state", self._record("rr-3"))

    def test_negative_child_of_a_run_leaves_the_parents_record_alone(self) -> None:
        os.environ["VANTIO_RUN_RECORD_OWNER_PID"] = str(os.getpid() + 1)
        obs.install("rr-4")
        obs.start_running_record()
        self._post("/v1/a")
        self.assertIsNone(self._record("rr-4"))
        obs.uninstall()
        self.assertIsNotNone(self._record("rr-4"), "the final record is still written")

    def test_shield_style_install_has_no_running_record(self) -> None:
        obs.install("rr-5")
        self._post("/v1/a")
        self.assertIsNone(self._record("rr-5"))
        obs.uninstall()

    def test_interval_rule(self) -> None:
        f = lambda v: obs._run_record_interval_ms("" if v is None else v)
        self.assertEqual(f(None), 5000)
        self.assertEqual(f(""), 5000)
        self.assertEqual(f("2500"), 2500)
        self.assertEqual(f("10"), 1000)
        self.assertEqual(f("0"), 0)
        self.assertEqual(f("off"), 0)
        self.assertEqual(f("OFF"), 0)
        self.assertEqual(f("fast"), 5000)
        self.assertEqual(f("-5"), 5000)
        self.assertEqual(f("99999999999"), 3600000)

    def test_a_reader_never_sees_half_a_record(self) -> None:
        obs.install("rr-6")
        obs._calls.extend({"hostname": "127.0.0.1", "action": "OBSERVED", "mediation": "python_urllib",
                           "ts": "2026-01-01T00:00:00+00:00", "path": "/x" * 200} for _ in range(400))
        obs._run_interval_ms = 1000
        stop = threading.Event()

        def writer() -> None:
            while not stop.is_set():
                obs._write_run_log(running=True)

        thread = threading.Thread(target=writer)
        thread.start()
        try:
            _wait(lambda: self._record("rr-6"), "the first write")
            bad = reads = 0
            end = time.monotonic() + 1.5
            path = self.runs / "rr-6.json"
            while time.monotonic() < end:
                try:
                    json.loads(path.read_text(encoding="utf-8"))
                    reads += 1
                except ValueError:
                    bad += 1
            self.assertEqual(bad, 0, f"{bad} of {reads + bad} reads failed to parse")
            self.assertGreater(reads, 50)
        finally:
            stop.set()
            thread.join()
        obs.uninstall()


if __name__ == "__main__":
    unittest.main()
