"""VAN-387 items 1, 4 and 5 for the Python SDK.

1. Processes of one `vantio run` merge into the same run log instead of
   replacing each other's calls.
4. Concurrent top-level shield() calls each write their own run log.
5. A call from another asyncio task is recorded while one task awaits httpx.
"""
from __future__ import annotations

import asyncio
import http.client
import json
import os
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from vantio import _http_observe, shield

try:
    import httpx
except ImportError:  # pragma: no cover - CI installs httpx
    httpx = None  # type: ignore[assignment]

SDK_ROOT = Path(__file__).resolve().parents[1]


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        if self.path.startswith("/slow"):
            time.sleep(0.5)
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *_args: object) -> None:
        return


class _Env(unittest.TestCase):
    def setUp(self) -> None:
        self.home = tempfile.mkdtemp()
        self._saved = {k: os.environ.get(k) for k in ("VANTIO_HOME", "VANTIO_EXTRA_LLM_HOSTS", "VANTIO_RUN_ID", "VANTIO_TELEMETRY_DISABLED")}
        os.environ["VANTIO_HOME"] = self.home
        os.environ["VANTIO_EXTRA_LLM_HOSTS"] = "127.0.0.1"
        os.environ["VANTIO_TELEMETRY_DISABLED"] = "1"
        os.environ.pop("VANTIO_RUN_ID", None)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.port = self.server.server_address[1]
        self.url = f"http://127.0.0.1:{self.port}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def runs(self) -> dict[str, dict]:
        out = {}
        folder = Path(self.home) / "runs"
        if not folder.is_dir():
            return out
        for path in folder.glob("*.json"):
            out[path.stem] = json.loads(path.read_text(encoding="utf-8"))
        return out


@unittest.skipIf(httpx is None, "httpx not installed")
class ConcurrentShieldTests(_Env):
    def test_gather_of_two_shields_writes_two_run_logs(self) -> None:
        async def agent(name: str, path: str) -> None:
            async with shield(trace_id=name):
                async with httpx.AsyncClient() as client:
                    await client.get(self.url + path)

        async def main() -> None:
            await asyncio.gather(agent("agentA", "/slow"), agent("agentB", "/fast"))

        asyncio.run(main())
        runs = self.runs()
        self.assertEqual(sorted(runs), ["agentA", "agentB"])
        self.assertEqual([c["path"] for c in runs["agentA"]["calls"]], ["/slow"])
        self.assertEqual([c["path"] for c in runs["agentB"]["calls"]], ["/fast"])
        self.assertEqual(runs["agentB"]["summary"]["total_calls"], 1)
        journal = Path(self.home) / "live.jsonl"
        if journal.is_file():
            traces = {json.loads(line).get("trace_id") for line in journal.read_text(encoding="utf-8").splitlines() if line.strip()}
            self.assertNotIn("agentA", traces - {"agentA", "agentB"})
            self.assertTrue(traces <= {"agentA", "agentB"}, traces)

    def test_a_nested_shield_still_joins_the_outer_run_log(self) -> None:
        async def main() -> None:
            async with shield(trace_id="outer"):
                async with shield(trace_id="inner"):
                    async with httpx.AsyncClient() as client:
                        await client.get(self.url + "/fast")

        asyncio.run(main())
        runs = self.runs()
        self.assertEqual(sorted(runs), ["outer"])
        self.assertEqual(len(runs["outer"]["calls"]), 1)

    def test_decorated_shields_in_gather_each_get_their_trace(self) -> None:
        @shield(trace_id="decoA")
        async def first() -> None:
            async with httpx.AsyncClient() as client:
                await client.get(self.url + "/slow")

        @shield(trace_id="decoB")
        async def second() -> None:
            async with httpx.AsyncClient() as client:
                await client.get(self.url + "/fast")

        async def main() -> None:
            await asyncio.gather(first(), second())

        asyncio.run(main())
        self.assertEqual(sorted(self.runs()), ["decoA", "decoB"])
        self.assertEqual(_http_observe._depth, 0)
        self.assertEqual(_http_observe._sessions, {})


@unittest.skipIf(httpx is None, "httpx not installed")
class AcrossAwaitTests(_Env):
    def test_other_task_calls_are_recorded_while_httpx_awaits(self) -> None:
        async def slow() -> None:
            async with httpx.AsyncClient() as client:
                await client.get(self.url + "/slow")

        async def other() -> None:
            await asyncio.sleep(0.15)
            conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
            conn.request("GET", "/fast")
            conn.getresponse().read()
            conn.close()
            _reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
            writer.close()

        async def main() -> None:
            async with shield(trace_id="await-gap"):
                await asyncio.gather(slow(), other())

        asyncio.run(main())
        calls = self.runs()["await-gap"]["calls"]
        mediations = sorted(c["mediation"] for c in calls)
        self.assertEqual(mediations, ["python_http_client", "python_httpx", "python_socket"])

    def test_httpx_own_connect_is_still_not_recorded_twice(self) -> None:
        async def main() -> None:
            async with shield(trace_id="no-double"):
                async with httpx.AsyncClient() as client:
                    await client.get(self.url + "/fast")

        asyncio.run(main())
        calls = self.runs()["no-double"]["calls"]
        self.assertEqual([c["mediation"] for c in calls], ["python_httpx"])


class RunLogMergeTests(_Env):
    def _write(self, trace: str, path: str, run_id: str | None) -> None:
        if run_id is None:
            os.environ.pop("VANTIO_RUN_ID", None)
        else:
            os.environ["VANTIO_RUN_ID"] = run_id
        call = {"hostname": "127.0.0.1", "path": path, "mediation": "python_urllib", "status": 200, "ok": True}
        _http_observe._write_run_log(trace, [call], time.time())

    def test_same_run_id_merges_calls(self) -> None:
        self._write("t1", "/child", "run-1")
        self._write("t1", "/parent", "run-1")
        log = self.runs()["t1"]
        self.assertEqual([c["path"] for c in log["calls"]], ["/child", "/parent"])
        self.assertEqual(log["summary"]["total_calls"], 2)
        self.assertEqual(log["run_id"], "run-1")

    def test_other_or_missing_run_id_replaces(self) -> None:
        self._write("t2", "/old", "run-1")
        self._write("t2", "/new", "run-2")
        self.assertEqual([c["path"] for c in self.runs()["t2"]["calls"]], ["/new"])
        self._write("t3", "/old", None)
        self._write("t3", "/new", None)
        log = self.runs()["t3"]
        self.assertEqual([c["path"] for c in log["calls"]], ["/new"])
        self.assertNotIn("run_id", log)

    def test_merge_keeps_node_summary_fields_true(self) -> None:
        folder = Path(self.home) / "runs"
        folder.mkdir(parents=True, exist_ok=True)
        node_log = {
            "vantio_run_log": "1",
            "trace_id": "t4",
            "run_id": "run-4",
            "pid": 1,
            "started_at": "2000-01-01T00:00:00+00:00",
            "calls": [{"hostname": "api.openai.com", "bytes": 5, "ok": False, "error": "x"}],
            "summary": {"total_calls": 1, "total_bytes": 5, "errors": 1, "hosts": ["api.openai.com"], "by_host": {"api.openai.com": {"calls": 1, "bytes": 5, "errors": 1}}},
        }
        (folder / "t4.json").write_text(json.dumps(node_log), encoding="utf-8")
        self._write("t4", "/py", "run-4")
        log = self.runs()["t4"]
        self.assertEqual(log["pid"], 1, "the process that started first keeps the identity")
        self.assertEqual(log["summary"]["total_calls"], 2)
        self.assertEqual(log["summary"]["errors"], 1)
        self.assertEqual(log["summary"]["total_bytes"], 5)
        self.assertEqual(log["summary"]["hosts"], ["127.0.0.1", "api.openai.com"])
        self.assertEqual(log["summary"]["by_host"]["127.0.0.1"], {"calls": 1, "bytes": 0, "errors": 0})
        self.assertEqual(log["summary"]["by_host"]["api.openai.com"]["calls"], 1)

    @unittest.skipIf(os.name == "nt", "POSIX file modes and FIFOs")
    def test_file_is_owner_only_and_a_fifo_is_not_waited_on(self) -> None:
        self._write("t5", "/a", "run-5")
        path = Path(self.home) / "runs" / "t5.json"
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        path.unlink()
        os.mkfifo(path)
        started = time.monotonic()
        self._write("t5", "/b", "run-5")
        self.assertLess(time.monotonic() - started, 5)
        self.assertTrue(path.is_file(), "the FIFO is replaced by the run log")
        self.assertEqual([c["path"] for c in self.runs()["t5"]["calls"]], ["/b"])
        self.assertFalse(any(p.name.endswith((".lock", ".tmp")) for p in path.parent.iterdir()))

    def test_parent_and_child_processes_of_one_run_keep_both_calls(self) -> None:
        os.environ["VANTIO_RUN_ID"] = "run-proc"
        child = (
            "import urllib.request, sys; from vantio._process_wrap import install_process_wrap; "
            "install_process_wrap(); urllib.request.urlopen(sys.argv[1]).read()"
        )
        parent = (
            "import subprocess, sys, urllib.request; from vantio._process_wrap import install_process_wrap; "
            "install_process_wrap(); urllib.request.urlopen(sys.argv[1] + '/parent').read(); "
            "subprocess.run([sys.executable, '-c', sys.argv[2], sys.argv[1] + '/child'], check=True)"
        )
        env = dict(os.environ, VANTIO_TRACE_ID="proc-trace", PYTHONPATH=str(SDK_ROOT))
        result = subprocess.run([sys.executable, "-c", parent, self.url, child], env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        paths = sorted(c["path"] for c in self.runs()["proc-trace"]["calls"])
        self.assertEqual(paths, ["/child", "/parent"])


if __name__ == "__main__":
    unittest.main()
