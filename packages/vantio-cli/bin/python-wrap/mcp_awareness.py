"""MCP stdio awareness for Python children of `vantio run`.

The Node library evaluates a copy of each complete line. This module does
not listen and does not replace the child process. Observe forwards the
original line. Enforce withholds a blocked line.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

_HELPER = Path(__file__).resolve().parent.parent / "mcp-awareness-frame.js"
_LOG_MAX = 1024 * 1024


def install() -> None:
    if os.environ.get("VANTIO_MCP_AWARENESS") not in ("on", "1"):
        return
    if getattr(subprocess, "_vantio_mcp_installed", False):
        return
    subprocess._vantio_mcp_installed = True  # type: ignore[attr-defined]
    mode = os.environ.get("VANTIO_MCP_MODE") if os.environ.get("VANTIO_MCP_MODE") == "enforce" else "observe"
    injection = "block" if os.environ.get("VANTIO_MCP_INJECTION") == "block" else "log"
    rug = "block" if os.environ.get("VANTIO_MCP_RUG_PULL") == "block" else "log"
    sys.stderr.write(
        f"[ ∅ VANTIO ] mcp awareness mode={mode} injection={injection} rug_pull={rug}\n"
    )
    original = subprocess.Popen

    # A subclass, not a function: other code (vantio-agent-sdk, typing's
    # subprocess.Popen[bytes], isinstance checks) needs Popen to stay a class.
    class _AwarePopen(original):  # type: ignore[misc,valid-type]
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            try:
                _attach(self, args, original)
            except Exception:
                pass

        def communicate(self, input=None, timeout=None):
            # communicate() and subprocess.run(input=...) write the input with
            # os.write, past the wrapped stdin.write (VAN-393). Filter it here.
            gate = getattr(self, "_vantio_gate", None)
            injected = b""
            if input is not None and gate is not None:
                try:
                    input, injected = gate.filter_all(input)
                except Exception:
                    injected = b""
            self._vantio_raw = True
            try:
                out, err = super().communicate(input, timeout)
            finally:
                self._vantio_raw = False
            if injected and out is not None:
                out = (injected.decode("utf-8") + out) if isinstance(out, str) else injected + out
            elif injected and gate is not None and gate.enforce:
                sys.stderr.write("[ ∅ VANTIO ] mcp frame withheld (stdout not captured)\n")
            return out, err

    subprocess.Popen = _AwarePopen  # type: ignore[misc]


def _looks_jsonrpc(line: bytes) -> bool:
    s = line.lstrip()
    return s.startswith(b"{") and b'"jsonrpc"' in s


class _Gate:
    """Per-child line handling (VAN-393).

    Only a line whose first non-blank byte is `{` is held until its newline and
    looked at. Any other line is forwarded as it arrives, so a child that is
    not an MCP server sees its stdin unchanged and at once. A JSON line that is
    not JSON-RPC is forwarded without asking the helper. In observe mode a
    JSON-RPC line is forwarded first and then checked; in enforce mode it is
    checked first and a blocked line is withheld.
    """

    def __init__(self, proc, server_id: str, orig_write, original, stdin) -> None:
        self.proc = proc
        self.server_id = server_id
        self.orig_write = orig_write
        self.original = original
        self.stdin = stdin
        self.enforce = os.environ.get("VANTIO_MCP_MODE") == "enforce"
        self.state = "start"  # start | pass | json
        self.held = bytearray()

    def _out(self, data: bytes) -> None:
        if data:
            self.orig_write(_as_stream(data.decode("utf-8", errors="replace"), self.stdin) if _text(self.stdin) else data)

    def feed(self, data: bytes, sink=None) -> None:
        """Process bytes. sink(bytes) receives what goes to the child."""
        out = sink or self._out
        i = 0
        n = len(data)
        while i < n:
            if self.state == "pass":
                j = data.find(b"\n", i)
                if j < 0:
                    out(data[i:])
                    return
                out(data[i : j + 1])
                i = j + 1
                self.state = "start"
            elif self.state == "json":
                j = data.find(b"\n", i)
                if j < 0:
                    self.held.extend(data[i:])
                    return
                self.held.extend(data[i : j + 1])
                i = j + 1
                line = bytes(self.held)
                self.held.clear()
                self.state = "start"
                self._line(line, out)
            else:  # start: hold leading blanks until the first real byte
                ch = data[i : i + 1]
                if ch in (b" ", b"\t", b"\r"):
                    self.held.extend(ch)
                    i += 1
                elif ch == b"\n":
                    self.held.extend(ch)
                    out(bytes(self.held))
                    self.held.clear()
                    i += 1
                elif ch == b"{":
                    self.state = "json"
                else:
                    if self.held:
                        out(bytes(self.held))
                        self.held.clear()
                    self.state = "pass"

    def flush_tail(self, sink=None) -> None:
        out = sink or self._out
        if self.held:
            tail = bytes(self.held)
            self.held.clear()
            if self.state == "json":
                self._line(tail, out)
            else:
                out(tail)
        self.state = "start"

    def _line(self, line: bytes, out) -> None:
        if not _looks_jsonrpc(line):
            out(line)
            return
        if not self.enforce:
            # Observe: the child gets the line first; the check only logs.
            out(line)
            self._observe(line)
            return
        verdict = _ask(line, self.server_id, self.original)
        _log_verdict(verdict)
        error = verdict.get("error") if isinstance(verdict, dict) else None
        if error:
            self.blocked(error if isinstance(error, str) else str(error))
            return
        out(line)

    def _observe(self, line: bytes) -> None:
        try:
            _log_verdict(_ask(line, self.server_id, self.original))
        except Exception:
            pass

    def blocked(self, error: str) -> None:
        sink = getattr(self, "_collect_errors", None)
        if sink is not None:
            sink.extend(error.encode("utf-8"))
        else:
            _inject(self.proc, error)

    def filter_all(self, data) -> tuple:
        """For communicate(): return (allowed input, injected stdout bytes)."""
        as_text = isinstance(data, str)
        raw = data.encode("utf-8") if as_text else bytes(data)
        allowed = bytearray()
        errors = bytearray()
        self._collect_errors = errors
        try:
            self.feed(raw, allowed.extend)
            self.flush_tail(allowed.extend)
        finally:
            self._collect_errors = None
        result = bytes(allowed)
        return (result.decode("utf-8", errors="replace") if as_text else result), bytes(errors)


def _log_verdict(verdict) -> None:
    records = verdict.get("records") if isinstance(verdict, dict) else []
    if isinstance(records, list):
        _log(records)


def _attach(proc: subprocess.Popen, args: tuple, original) -> None:
    stdin = proc.stdin
    if stdin is None or not hasattr(stdin, "write"):
        return
    command = ""
    if args and isinstance(args[0], (list, tuple)) and args[0]:
        command = str(args[0][0])
    elif args and isinstance(args[0], str):
        command = args[0]
    orig_write = stdin.write
    orig_close = stdin.close
    gate = _Gate(proc, _server_id(command), orig_write, original, stdin)
    proc._vantio_gate = gate  # type: ignore[attr-defined]

    def write(data):
        if getattr(proc, "_vantio_raw", False):
            return orig_write(data)
        count = len(data)
        gate.feed(data.encode("utf-8") if isinstance(data, str) else bytes(data))
        return count

    def writelines(lines):
        for item in lines:
            write(item)

    def close():
        if not getattr(proc, "_vantio_raw", False):
            gate.flush_tail()
        return orig_close()

    stdin.write = write  # type: ignore[method-assign]
    stdin.writelines = writelines  # type: ignore[method-assign]
    stdin.close = close  # type: ignore[method-assign]


def _inject(proc, error: str) -> None:
    """Put the fixed error on the pipe the workload reads. The child keeps the write end."""
    stdout = proc.stdout
    if stdout is None or not hasattr(stdout, "read"):
        return
    bucket = getattr(stdout, "_vantio_inject", None)
    if bucket is None:
        bucket = bytearray()
        stdout._vantio_inject = bucket  # type: ignore[attr-defined]
        orig_read = stdout.read

        def read(*args, **kwargs):
            prefix = bytes(bucket)
            bucket.clear()
            data = orig_read(*args, **kwargs)
            if isinstance(data, str):
                return prefix.decode("utf-8") + (data or "")
            return prefix + (data or b"")

        stdout.read = read  # type: ignore[method-assign]
    bucket.extend(error.encode("utf-8"))


def _text(stream) -> bool:
    return getattr(stream, "encoding", None) not in (None, "")


def _as_stream(text: str, stream):
    if _text(stream):
        return text
    return text.encode("utf-8")


def _ask(line: bytes, server_id: str, original) -> dict:
    node = shutil.which("node")
    enforce = os.environ.get("VANTIO_MCP_MODE") == "enforce"
    if node is None or not _HELPER.is_file():
        return {"records": [], "error": _fixed_error() if enforce else None}
    env = dict(os.environ)
    try:
        proc = original(
            [node, str(_HELPER), server_id],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=env,
        )
        out, _err = proc.communicate(line, timeout=5)
    except Exception:
        return {"records": [], "error": _fixed_error() if enforce else None}
    try:
        parsed = json.loads(out.decode("utf-8") if out else "{}")
    except (UnicodeError, json.JSONDecodeError):
        return {"records": [], "error": _fixed_error() if enforce else None}
    if not isinstance(parsed, dict):
        return {"records": [], "error": _fixed_error() if enforce else None}
    return parsed


def _log(records: list) -> None:
    root = os.environ.get("VANTIO_HOME") or str(Path.home() / ".vantio")
    path = Path(root) / "mcp-observations.jsonl"
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        size = path.stat().st_size if path.is_file() else 0
        with path.open("a", encoding="utf-8") as handle:
            for record in records:
                if not isinstance(record, dict) or record.get("schema") != "vantio.mcp_observation.v1":
                    continue
                reason = (record.get("decision") or {}).get("reason")
                if reason in ("ignored_non_json", "empty"):
                    continue
                line = json.dumps(record, separators=(",", ":")) + "\n"
                if size >= _LOG_MAX:
                    return
                handle.write(line)
                size += len(line.encode("utf-8"))
    except OSError:
        return


def _server_id(command: str) -> str:
    base = command.replace("\\", "/").rsplit("/", 1)[-1]
    if base.endswith(".exe"):
        base = base[:-4]
    if base and all(ch.isalnum() or ch in "_.:-" for ch in base) and len(base) <= 64:
        return base
    return "child"


def _fixed_error() -> str:
    return (
        '{"jsonrpc":"2.0","id":null,"error":{"code":-32001,'
        '"message":"vantio_mcp_policy_block","data":{"finding":"policy"}}}\n'
    )
