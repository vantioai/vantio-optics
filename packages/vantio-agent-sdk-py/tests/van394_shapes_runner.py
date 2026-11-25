"""Run the VAN-394 command shapes through one copy of the Python wrapper.

Not a test. test_van394_shapes.py runs it for the current tree, and the fixture
generator runs it for a checkout of main, so both sides use the same code.

    python3 -I van394_shapes_runner.py <sdk-dir> <fixture.json> <work-dir> <group>

<group> is "shapes" (the shapes main can run) or "special" (FIFO, socket,
/dev/stdin and the other files main cannot be run on). It prints one JSON
object: {"hosts": {id: [host or null, ...]}, "max_spawn_ms": n}.

Every command is a stand-in on PATH that exits 0. No network call is made.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time

MARK = "mark.example.test"


def make_files(doc: dict, files_dir: str) -> list:
    keep = []
    for name, spec in doc["files"].items():
        path = os.path.join(files_dir, name)
        if spec.get("fifo"):
            os.mkfifo(path)
        elif spec.get("socket"):
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.bind(path)
            sock.listen(1)
            keep.append(sock)
        elif spec.get("dir"):
            os.mkdir(path)
        elif spec.get("symlink"):
            os.symlink(spec["symlink"].replace("{dir}", files_dir), path)
        else:
            text = spec.get("text", "") + spec.get("repeat", "") * spec.get("times", 0) + spec.get("then", "")
            with open(path, "wb") as fh:
                fh.write(text.replace("{dir}", files_dir).encode("utf-8"))
    return keep


def main() -> None:
    sdk_dir, fixture, work, group = sys.argv[1:5]
    with open(fixture, encoding="utf-8") as fh:
        doc = json.load(fh)
    shutil.rmtree(work, ignore_errors=True)
    bin_dir, files_dir, home = (os.path.join(work, x) for x in ("bin", "files", "home"))
    for d in (bin_dir, files_dir, home):
        os.makedirs(d)
    for tool in ("curl", "wget", "aria2c", "http"):
        path = os.path.join(bin_dir, tool)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("#!/bin/sh\nexit 0\n")
        os.chmod(path, 0o755)
    keep = make_files(doc, files_dir)
    os.environ.update({
        "VANTIO_HOME": home,
        "HOME": home,
        "VANTIO_EXTRA_LLM_HOSTS": f"llm.example.test,{MARK}",
        "PATH": bin_dir + os.pathsep + os.environ["PATH"],
    })
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        os.environ.pop(name, None)
    os.environ["NO_PROXY"] = "*"
    sys.path.insert(0, sdk_dir)
    from vantio import shield  # noqa: E402

    shapes = doc[group]
    spans: list = []

    def body() -> None:
        for shape in shapes:
            argv = [a.replace("{dir}", files_dir) for a in shape["argv"]]
            started = time.monotonic()
            subprocess.run([shape["tool"], *argv], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           stdin=subprocess.DEVNULL, timeout=10)
            spans.append(int((time.monotonic() - started) * 1000))
            subprocess.run(["curl", f"https://{MARK}/"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           stdin=subprocess.DEVNULL, timeout=10)

    async def run() -> None:
        async with shield(trace_id="van394shapes"):
            worker = threading.Thread(target=body, daemon=True)
            worker.start()
            worker.join(180)
            if worker.is_alive():
                print("HANG", file=sys.stderr)
                os._exit(3)

    asyncio.run(run())
    with open(os.path.join(home, "runs", "van394shapes.json"), encoding="utf-8") as fh:
        log = json.load(fh)
    per: list = [[]]
    for call in log["calls"]:
        if call.get("hostname") == MARK:
            per.append([])
        else:
            per[-1].append(call.get("hostname"))
    per.pop()
    result = {shape["id"]: per[i] for i, shape in enumerate(shapes)}
    print(json.dumps({"hosts": result, "max_spawn_ms": max(spans) if spans else 0}))
    del keep


if __name__ == "__main__":
    main()
