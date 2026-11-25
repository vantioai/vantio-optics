"""VAN-394: a curl -K config or wget -i list that is a FIFO must not block shield().

The wrapper never opens a FIFO, a device, a socket or /dev/stdin, and records
such a call with no host.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from unittest import mock

from vantio import shield
from vantio import _http_observe
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

    def _opened_paths(self, call) -> list:
        opened: list = []
        real_open = os.open

        def spy(path, *args, **kwargs):
            opened.append(path)
            return real_open(path, *args, **kwargs)

        with mock.patch.object(_http_observe.os, "open", spy):
            call()
        return opened

    def test_a_fifo_is_never_opened(self) -> None:
        fifo = os.path.join(self.dir, "fifo")
        os.mkfifo(fifo)
        opened = self._opened_paths(lambda: self.assertIsNone(_read_regular_file(fifo, 1024)))
        self.assertEqual(opened, [], "stat comes first; a FIFO is not opened")

    def test_a_symlink_to_a_fifo_is_never_opened(self) -> None:
        fifo = os.path.join(self.dir, "fifo")
        os.mkfifo(fifo)
        link = os.path.join(self.dir, "link")
        os.symlink(fifo, link)
        opened = self._opened_paths(lambda: self.assertIsNone(_read_regular_file(link, 1024)))
        self.assertEqual(opened, [])

    def test_a_device_and_a_socket_are_never_opened(self) -> None:
        sock_path = os.path.join(self.dir, "sock")
        server = socket.socket(socket.AF_UNIX)
        self.addCleanup(server.close)
        server.bind(sock_path)
        opened = self._opened_paths(
            lambda: [self.assertIsNone(_read_regular_file(p, 1024)) for p in ("/dev/zero", sock_path)]
        )
        self.assertEqual(opened, [])

    def test_dev_stdin_is_never_opened_or_statted(self) -> None:
        paths = ["/dev/stdin", "/dev/fd/0", "/proc/self/fd/0"]
        with mock.patch.object(_http_observe.os, "stat", side_effect=AssertionError("stat was called")):
            opened = self._opened_paths(lambda: [self.assertIsNone(_read_regular_file(p, 1024)) for p in paths])
        self.assertEqual(opened, [])

    def test_skipped_special_files_are_reported(self) -> None:
        fifo = os.path.join(self.dir, "fifo")
        os.mkfifo(fifo)
        skipped: list = []
        for path in (fifo, "/dev/zero", "/dev/stdin"):
            self.assertIsNone(_read_regular_file(path, 1024, skipped))
        self.assertIsNone(_url_from_curl_config(fifo, skipped))
        self.assertEqual(_urls_from_list_file(fifo, 0, None, skipped), [])
        self.assertEqual(skipped, [fifo, "/dev/zero", "/dev/stdin", fifo, fifo])

    def test_a_directory_and_a_missing_file_are_not_marked_skipped(self) -> None:
        skipped: list = []
        self.assertIsNone(_read_regular_file(self.dir, 1024, skipped))
        with self.assertRaises(FileNotFoundError):
            _read_regular_file(os.path.join(self.dir, "missing"), 1024, skipped)
        self.assertIsNone(_url_from_curl_config(os.path.join(self.dir, "missing"), skipped))
        self.assertEqual(skipped, [])

    def test_a_path_swapped_to_a_fifo_after_the_stat_is_closed_without_a_read(self) -> None:
        # Second check: the stat says "regular file", the opened fd is a FIFO.
        regular = os.path.join(self.dir, "regular")
        with open(regular, "w", encoding="utf-8") as fh:
            fh.write('url = "https://api.example.test/v1"\n')
        fifo = os.path.join(self.dir, "fifo")
        os.mkfifo(fifo)
        real_stat = os.stat
        with mock.patch.object(_http_observe.os, "stat", lambda p, *a, **k: real_stat(regular)), \
                mock.patch.object(_http_observe.os, "read", side_effect=AssertionError("read was called")):
            t0 = time.monotonic()
            self.assertIsNone(_read_regular_file(fifo, 1024))
        self.assertLess(time.monotonic() - t0, 1.0)

    def test_a_curl_config_is_read_up_to_1_mib(self) -> None:
        pad = b"# pad\n"
        late = b'url = "https://llm.example.test/v1/late"\n'
        inside = os.path.join(self.dir, "inside")
        with open(inside, "wb") as fh:
            fh.write(pad * (200 * 1024 // len(pad) + 1) + late)
        self.assertEqual(_url_from_curl_config(inside), "https://llm.example.test/v1/late")
        beyond = os.path.join(self.dir, "beyond")
        with open(beyond, "wb") as fh:
            fh.write(pad * (1024 * 1024 // len(pad) + 1) + late)
        self.assertIsNone(_url_from_curl_config(beyond))
        self.assertEqual(_http_observe._CLI_CONFIG_CAP, 1024 * 1024)

    def test_a_wget_list_is_read_up_to_64_kib(self) -> None:
        pad = b"# pad\n" * (64 * 1024 // 6 + 1)
        url = b"https://llm.example.test/v1/a\n"
        early = os.path.join(self.dir, "early")
        with open(early, "wb") as fh:
            fh.write(url + pad)
        self.assertEqual(_urls_from_list_file(early), ["https://llm.example.test/v1/a"])
        late = os.path.join(self.dir, "late")
        with open(late, "wb") as fh:
            fh.write(pad + url)
        self.assertEqual(_urls_from_list_file(late), [])


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
        # The call is recorded with no host and no URL.
        with open(os.path.join(home, "runs", "van394-curl.json"), encoding="utf-8") as fh:
            text = fh.read()
        calls = json.loads(text)["calls"]
        self.assertEqual([(c["hostname"], c["mediation"]) for c in calls], [(None, "python_curl")])
        self.assertNotIn("127.0.0.1", text)


_FAKE_TOOL = """#!/bin/sh
f=""
while [ $# -gt 0 ]; do
  case "$1" in -K|-i) f="$2"; shift ;; esac
  shift
done
exec cat "$f" > "$VAN394_OUT"
"""

_CURL_CONFIG = 'header = "Authorization: Bearer s3cret"\nurl = "https://llm.example.test/v1/x"\n'
_WGET_LIST = "https://llm.example.test/v1/x?k=s3cret\n"


def _release_fifo(fifo: str) -> None:
    """Let go of anything still blocked on the FIFO after a failed run."""
    for flag in (os.O_RDONLY, os.O_WRONLY):
        try:
            os.close(os.open(fifo, flag | os.O_NONBLOCK))
        except OSError:
            pass


class FakeToolUnderShieldTests(unittest.IsolatedAsyncioTestCase):
    """No network: curl and wget are stand-ins on PATH that save what they read."""

    def setUp(self) -> None:
        self.work = tempfile.mkdtemp()
        self.home = os.path.join(self.work, "home")
        os.mkdir(self.home)
        self.out = os.path.join(self.work, "child-read")
        bin_dir = os.path.join(self.work, "bin")
        os.mkdir(bin_dir)
        for name in ("curl", "wget"):
            path = os.path.join(bin_dir, name)
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(_FAKE_TOOL)
            os.chmod(path, 0o755)
        patch = mock.patch.dict(
            os.environ,
            {
                "VANTIO_HOME": self.home,
                "VANTIO_EXTRA_LLM_HOSTS": "llm.example.test",
                "PATH": bin_dir + os.pathsep + os.environ.get("PATH", ""),
                "VAN394_OUT": self.out,
            },
        )
        patch.start()
        self.addCleanup(patch.stop)

    async def _under_shield(self, trace: str, body) -> dict:
        """Run body in a thread under shield(); fail if it is not done in 15 s."""
        result: dict = {}
        async with shield(trace_id=trace):
            worker = threading.Thread(target=body, args=(result,), daemon=True)
            worker.start()
            worker.join(15)
            self.assertFalse(worker.is_alive(), "the spawn or the child blocked")
        return result

    def _run_file(self, trace: str) -> str:
        return os.path.join(self.home, "runs", f"{trace}.json")

    def _child_read(self) -> str:
        with open(self.out, encoding="utf-8") as fh:
            return fh.read()

    def _assert_one_call_without_host(self, trace: str, tool: str) -> None:
        self.assertTrue(os.path.exists(self._run_file(trace)), "the run file is written")
        with open(self._run_file(trace), encoding="utf-8") as fh:
            text = fh.read()
        log = json.loads(text)
        self.assertEqual(len(log["calls"]), 1)
        call = log["calls"][0]
        self.assertIsNone(call["hostname"])
        self.assertIsNone(call["path"])
        self.assertEqual(call["mediation"], f"python_{tool}")
        self.assertEqual(call["action"], "OBSERVED")
        self.assertNotIn("providerName", call)
        self.assertNotIn("upstreamService", call)
        # Owner decision, option A: the record is kept, and it is left out of
        # the call count and the host list.
        self.assertEqual(log["summary"]["hosts"], [], "no host is counted")
        self.assertEqual(log["summary"]["total_calls"], 0)
        self.assertEqual(log["summary"]["calls_without_host"], 1)
        for piece in ("llm.example.test", "s3cret"):
            self.assertNotIn(piece, text)

    @staticmethod
    def _wait(proc: subprocess.Popen) -> object:
        try:
            return proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
            return "hung"

    async def _writer_first(self, tool: str, flag: str, content: str) -> None:
        fifo = os.path.join(self.work, "cfg")
        os.mkfifo(fifo)
        self.addCleanup(_release_fifo, fifo)
        trace = f"van394-first-{tool}"

        def body(result: dict) -> None:
            about_to_open = threading.Event()

            def writer() -> None:
                about_to_open.set()
                try:
                    with open(fifo, "w", encoding="utf-8") as fh:
                        fh.write(content)
                    result["writer"] = "ok"
                except OSError as exc:
                    result["writer"] = type(exc).__name__

            thread = threading.Thread(target=writer, daemon=True)
            thread.start()
            about_to_open.wait(2)
            time.sleep(0.3)
            result["writer_waiting"] = thread.is_alive() and "writer" not in result
            t0 = time.monotonic()
            proc = subprocess.Popen([tool, flag, fifo], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            result["spawn_s"] = time.monotonic() - t0
            result["rc"] = self._wait(proc)
            _release_fifo(fifo)
            thread.join(5)

        result = await self._under_shield(trace, body)
        self.assertTrue(result["writer_waiting"], "the writer was waiting in open() before the spawn")
        self.assertEqual(result.get("writer"), "ok", "the writer was not cut off (no EPIPE)")
        self.assertEqual(result["rc"], 0, "the child did not hang")
        self.assertEqual(self._child_read(), content, "the child got every byte")
        self.assertLess(result["spawn_s"], 1.0)
        self._assert_one_call_without_host(trace, tool)

    async def test_curl_k_fifo_with_a_writer_already_waiting(self) -> None:
        await self._writer_first("curl", "-K", _CURL_CONFIG)

    async def test_wget_i_fifo_with_a_writer_already_waiting(self) -> None:
        await self._writer_first("wget", "-i", _WGET_LIST)

    async def _dev_stdin(self, tool: str, flag: str, content: str) -> None:
        trace = f"van394-stdin-{tool}"

        def body(result: dict) -> None:
            proc = subprocess.Popen(
                [tool, flag, "/dev/stdin"],
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            proc.stdin.write(content.encode("utf-8"))
            proc.stdin.close()
            result["rc"] = self._wait(proc)

        result = await self._under_shield(trace, body)
        self.assertEqual(result["rc"], 0)
        self.assertEqual(self._child_read(), content, "the child got every byte of stdin")
        self._assert_one_call_without_host(trace, tool)

    async def test_curl_k_dev_stdin_is_left_to_the_child(self) -> None:
        await self._dev_stdin("curl", "-K", _CURL_CONFIG)

    async def test_wget_i_dev_stdin_is_left_to_the_child(self) -> None:
        await self._dev_stdin("wget", "-i", _WGET_LIST)

    async def _spawn_with_file(self, trace: str, tool: str, flag: str, target: str) -> None:
        def body(result: dict) -> None:
            proc = subprocess.Popen([tool, flag, target], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            result["rc"] = self._wait(proc)

        await self._under_shield(trace, body)

    async def test_a_regular_file_is_still_recorded_with_its_host(self) -> None:
        for tool, flag, content in (
            ("curl", "-K", 'url = "https://llm.example.test/v1/x"\n'),
            ("wget", "-i", "https://llm.example.test/v1/x\n"),
        ):
            target = os.path.join(self.work, f"cfg-{tool}")
            with open(target, "w", encoding="utf-8") as fh:
                fh.write(content)
            trace = f"van394-regular-{tool}"
            await self._spawn_with_file(trace, tool, flag, target)
            self.assertEqual(self._child_read(), content)
            with open(self._run_file(trace), encoding="utf-8") as fh:
                log = json.load(fh)
            self.assertEqual([c["hostname"] for c in log["calls"]], ["llm.example.test"])
            self.assertEqual(log["summary"]["hosts"], ["llm.example.test"])

    async def test_no_call_for_a_file_with_no_url_a_missing_file_or_a_directory(self) -> None:
        no_url = os.path.join(self.work, "no-url")
        with open(no_url, "w", encoding="utf-8") as fh:
            fh.write("# nothing here\n")
        unwatched = os.path.join(self.work, "unwatched")
        with open(unwatched, "w", encoding="utf-8") as fh:
            fh.write('url = "https://other.example.test/v1/x"\n')
        targets = (no_url, unwatched, os.path.join(self.work, "missing"), self.work)
        for tool, flag in (("curl", "-K"), ("wget", "-i")):
            for i, target in enumerate(targets):
                trace = f"van394-none-{tool}-{i}"
                await self._spawn_with_file(trace, tool, flag, target)
                # The Python wrapper writes no run file when nothing was recorded.
                self.assertFalse(os.path.exists(self._run_file(trace)), f"{tool} {target}")

    # Owner decision, option A: a call with no known host is kept, and it is
    # left out of the LLM call count.

    async def _run_curls(self, trace: str, argvs: list) -> dict:
        def body(result: dict) -> None:
            for argv in argvs:
                proc = subprocess.Popen(["curl", *argv], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                self._wait(proc)

        await self._under_shield(trace, body)
        with open(self._run_file(trace), encoding="utf-8") as fh:
            return json.load(fh)

    async def test_a_call_with_no_known_host_is_kept_and_left_out_of_the_call_count(self) -> None:
        log = await self._run_curls("van394-option-a", [_NO_HOST_ARGV, _KNOWN_HOST_ARGV])
        self.assertEqual([c["hostname"] for c in log["calls"]], [None, "llm.example.test"], "both records are kept")
        self.assertEqual(log["calls"][0]["bytes_observed"], 5000, "the record keeps its own size")
        self.assertEqual(log["summary"]["total_calls"], 1)
        self.assertEqual(log["summary"]["calls_without_host"], 1)
        self.assertEqual(log["summary"]["hosts"], ["llm.example.test"])

    async def test_a_call_to_a_known_host_is_still_counted_with_its_bytes(self) -> None:
        log = await self._run_curls("van394-option-a-known", [_KNOWN_HOST_ARGV])
        self.assertEqual([c["hostname"] for c in log["calls"]], ["llm.example.test"])
        self.assertEqual(log["calls"][0]["bytes_observed"], 300)
        self.assertEqual(log["summary"]["total_calls"], 1)
        self.assertEqual(log["summary"]["calls_without_host"], 0)
        self.assertEqual(log["summary"]["hosts"], ["llm.example.test"])


_NO_HOST_ARGV = ["-K", "/dev/null", "-d", "x" * 5000]
_KNOWN_HOST_ARGV = ["-d", "y" * 300, "https://llm.example.test/v1/x"]


if __name__ == "__main__":
    unittest.main()
