"""VAN-394: the wrapper must find the same URL as main for every curl, wget,
httpie and aria2c command line, config file and list file that it can read.

The only changes from main are for a -K / -i file that is not a regular file
(FIFO, device, socket, /dev/stdin) or is over the size cap.

The fixture van394_shapes.json is shared with the Node test
(packages/vantio-cli/test/van394-shapes.test.js, which also says how
`expected_main` was generated from main). Each shape runs in a stand-in
command on PATH that exits 0. No network call is made.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_SDK_DIR = os.path.dirname(_HERE)
_FIXTURE = os.path.join(_HERE, "van394_shapes.json")
_RUNNER = os.path.join(_HERE, "van394_shapes_runner.py")


def _run(group: str) -> dict:
    with tempfile.TemporaryDirectory() as work:
        run = subprocess.run(
            [sys.executable, "-I", _RUNNER, _SDK_DIR, _FIXTURE, os.path.join(work, "run"), group],
            capture_output=True,
            text=True,
            timeout=240,
            env={"PATH": os.environ.get("PATH", "")},
        )
    if run.returncode != 0:
        raise AssertionError(f"the runner failed ({run.returncode}): {run.stderr[-2000:]}")
    return json.loads(run.stdout.strip().splitlines()[-1])


class ShapeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        with open(_FIXTURE, encoding="utf-8") as fh:
            cls.doc = json.load(fh)

    def test_the_fixture_has_main_results(self) -> None:
        self.assertTrue(self.doc["expected_main"]["generated_from"])
        self.assertGreaterEqual(len(self.doc["shapes"]), 58)
        ids = [s["id"] for s in self.doc["shapes"]]
        self.assertEqual(list(self.doc["expected_main"]["python"]), ids)
        self.assertEqual(list(self.doc["expected_main"]["node"]), ids)

    def test_every_shape_with_a_readable_file_or_no_file_records_what_main_recorded(self) -> None:
        got = _run("shapes")
        wrong = [
            f"{s['id']} {s['tool']} {s['argv']}: got {got['hosts'][s['id']]}, "
            f"main {self.doc['expected_main']['python'][s['id']]}"
            for s in self.doc["shapes"]
            if got["hosts"][s["id"]] != self.doc["expected_main"]["python"][s["id"]]
        ]
        self.assertEqual(wrong, [])
        self.assertLess(got["max_spawn_ms"], 3000)

    def test_special_files_do_not_hang_and_record_a_no_host_call_where_the_rule_says(self) -> None:
        got = _run("special")
        wrong = []
        for s in self.doc["special"]:
            want = s.get("hosts_python", s["hosts"])
            if got["hosts"][s["id"]] != want:
                wrong.append(f"{s['id']} {s['tool']} {s['argv']}: got {got['hosts'][s['id']]}, expected {want} ({s['why']})")
        self.assertEqual(wrong, [])
        self.assertLess(got["max_spawn_ms"], 3000)

    def test_python_agrees_with_node_where_main_does(self) -> None:
        # Node's results are the Node side of expected_main and the `hosts` of
        # each special shape (checked by the Node test). Here: Python equals
        # them everywhere except where main's own Node and Python differ.
        mismatch = set(self.doc["known_main_mismatch"])
        py_main = self.doc["expected_main"]["python"]
        node_main = self.doc["expected_main"]["node"]
        self.assertEqual(
            sorted(i for i in py_main if py_main[i] != node_main[i]),
            sorted(mismatch),
        )
        got = _run("shapes")
        for s in self.doc["shapes"]:
            if s["id"] not in mismatch:
                self.assertEqual(got["hosts"][s["id"]], node_main[s["id"]], s["id"])


if __name__ == "__main__":
    unittest.main()
