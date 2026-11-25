"""MCP stdio awareness for Python children of `vantio run`.

The Node library evaluates a copy of each complete line. This module does
not listen and does not replace the child process. Observe never changes or
delays what the child gets. Enforce withholds a blocked line.
"""

from __future__ import annotations

import codecs
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

_HELPER = Path(__file__).resolve().parent.parent / "mcp-awareness-frame.js"
_LOG_MAX = 1024 * 1024
# Same bound as the Node library (bin/mcp-awareness/bounds.js MAX_FRAME).
_MAX_FRAME = 256 * 1024


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
            # os.write, past the wrapped stdin.write (VAN-393). Filter it here,
            # together with anything the gate still holds from earlier writes.
            gate = getattr(self, "_vantio_gate", None)
            pending = self.__dict__.setdefault("_vantio_errors", bytearray())
            # A retry after TimeoutExpired must not send input again.
            if gate is not None and not getattr(self, "_communication_started", False):
                try:
                    input, injected = gate.filter_all(input)
                    pending.extend(injected)
                except Exception:
                    if gate.enforce:
                        # Fail closed: nothing unchecked reaches the child.
                        input = None if input is None else input[:0]
                        pending.extend(_fixed_error().encode("utf-8"))
            self._vantio_raw = True
            try:
                out, err = super().communicate(input, timeout)
            finally:
                self._vantio_raw = False
            # Errors from earlier stdin.write calls that stdout.read did not return.
            bucket = getattr(self.stdout, "_vantio_inject", None)
            if bucket:
                pending[:0] = bucket
                bucket.clear()
            if pending and out is not None:
                injected = bytes(pending)
                pending.clear()
                out = (injected.decode("utf-8") + out) if isinstance(out, str) else injected + out
            elif pending:
                pending.clear()
                sys.stderr.write("[ ∅ VANTIO ] mcp frame withheld (stdout not captured)\n")
            return out, err

    subprocess.Popen = _AwarePopen  # type: ignore[misc]


# Blanks that may come before a frame on its line. The Node library trims the
# same set (String.prototype.trimStart), so none of them can hide a frame.
_ASCII_BLANKS = re.compile(rb"[ \t\n\r\x0b\x0c]+")
_WIDE_BLANKS = frozenset(
    ch.encode("utf-8")
    for ch in "\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
)
_WIDE_PREFIXES = frozenset(w[:k] for w in _WIDE_BLANKS for k in range(1, len(w)))


def _has_jsonrpc(value, depth: int = 0) -> bool:
    if isinstance(value, dict):
        return "jsonrpc" in value
    if isinstance(value, list) and depth < 8:
        return any(_has_jsonrpc(item, depth + 1) for item in value)
    return False


def _classify(line: bytes) -> str:
    """rpc: a JSON-RPC object, or an array (batch) that holds one.
    plain: any other JSON value. bad: starts like JSON but does not parse."""
    try:
        value = json.loads(line.decode("utf-8"))
    except Exception:  # not UTF-8, not JSON, too deep, too large a number
        return "bad"
    return "rpc" if _has_jsonrpc(value) else "plain"


def _nowhere(_data: bytes) -> None:
    return None


class _Gate:
    """Per-child line handling (VAN-393).

    Observe: the child's stdin is never changed or delayed. The caller writes
    the original data first, and the gate reads a copy to find JSON-RPC lines
    for the log.

    Enforce: blanks at the start of a line are forwarded as they arrive. A
    line whose first non-blank byte is `{` or `[` is held from that byte to
    its newline and parsed as JSON here. JSON that is not JSON-RPC is
    forwarded without starting node. A JSON-RPC object, a batch, or a line
    that does not parse goes to the Node helper, which alone decides; a
    blocked line is withheld. Any other line is forwarded as it arrives.

    The held part is bounded at _MAX_FRAME, newline included, as in the Node
    library. Past the bound one oversize gap is logged; enforce withholds the
    line up to its newline and answers with the fixed error.
    """

    def __init__(self, proc, server_id: str, orig_write, original, stdin) -> None:
        self.proc = proc
        self.server_id = server_id
        self.orig_write = orig_write
        self.original = original
        self.stdin = stdin
        self.text = _text(stdin)
        self.enforce = os.environ.get("VANTIO_MCP_MODE") == "enforce"
        self.state = "start"  # start | pass | json | drop
        self.held = bytearray()  # a `{` or `[` line, at most _MAX_FRAME bytes
        self.pre = bytearray()  # at most 2 bytes of a possible wide blank
        self._decoder = codecs.getincrementaldecoder("utf-8")("surrogatepass")

    def _out(self, data: bytes) -> None:
        if not data:
            return
        if not self.text:
            self.orig_write(data)
            return
        # Never hand the text stream half of a multi-byte character.
        text = self._decoder.decode(data)
        if text:
            self.orig_write(text)

    def feed(self, data: bytes, sink=None) -> None:
        """Process bytes. sink(bytes) receives what goes to the child."""
        out = sink or self._out
        i = 0
        n = len(data)
        while i < n:
            state = self.state
            if state == "pass" or state == "drop":
                # drop: enforce, oversize line; nothing reaches the child until its newline.
                j = data.find(b"\n", i)
                end = n if j < 0 else j + 1
                if state == "pass":
                    if self.pre:
                        chunk = bytes(self.pre) + data[i:end]
                        self.pre.clear()
                        out(chunk)
                    else:
                        out(data[i:end])
                i = end
                if j >= 0:
                    self.state = "start"
            elif state == "json":
                room = _MAX_FRAME - len(self.held)
                j = data.find(b"\n", i, i + room)
                if j >= 0:
                    self.held.extend(data[i : j + 1])
                    i = j + 1
                    line = bytes(self.held)
                    self.held.clear()
                    self.state = "start"
                    self._line(line, out)
                    continue
                take = min(room, n - i)
                self.held.extend(data[i : i + take])
                i += take
                if len(self.held) >= _MAX_FRAME:
                    # _MAX_FRAME bytes and no newline among them. The newline
                    # is not consumed here, so the next line is not touched.
                    self._oversize()
            elif self.pre:  # start, inside a possible wide blank
                cand = bytes(self.pre) + data[i : i + 1]
                if cand in _WIDE_BLANKS:
                    self.pre.clear()
                    out(cand)
                    i += 1
                elif cand in _WIDE_PREFIXES:
                    self.pre.extend(data[i : i + 1])
                    i += 1
                else:
                    self.state = "pass"  # the pass branch sends self.pre first
            else:  # start: blanks go to the child at once and are not kept
                m = _ASCII_BLANKS.match(data, i)
                if m is not None:
                    out(m.group())
                    i = m.end()
                    continue
                ch = data[i : i + 1]
                if ch == b"{" or ch == b"[":
                    self.state = "json"
                elif ch in _WIDE_PREFIXES:
                    self.pre.extend(ch)
                    i += 1
                else:
                    self.state = "pass"

    def flush_tail(self, sink=None) -> None:
        """Stdin is closing: check or forward whatever is still held."""
        out = sink or self._out
        pre = bytes(self.pre)
        held = bytes(self.held)
        state = self.state
        self.pre.clear()
        self.held.clear()
        self.state = "start"
        if pre:
            out(pre)
        if held and state == "json":
            self._line(held, out)

    def _line(self, line: bytes, out) -> None:
        kind = _classify(line)
        if kind == "plain":
            out(line)
            return
        if not self.enforce:
            # Observe: the child already has the line; the check only logs.
            if kind == "rpc" or b'"jsonrpc"' in line:
                self._observe(line)
            return
        # Enforce: the helper decides. A line that does not parse goes to it too.
        verdict = _ask(line, self.server_id, self.original)
        _log_verdict(verdict)
        error = verdict.get("error") if isinstance(verdict, dict) else None
        if error:
            self.blocked(error if isinstance(error, str) else str(error))
            return
        out(line)

    def _oversize(self) -> None:
        """The held line reached _MAX_FRAME before its newline."""
        head = bytes(self.held)
        self.held.clear()
        if not self.enforce:
            self.state = "pass"
            self._observe(head)
            return
        self.state = "drop"
        error = None
        try:
            verdict = _ask(head, self.server_id, self.original)
            _log_verdict(verdict)
            error = verdict.get("error") if isinstance(verdict, dict) else None
        except Exception:
            error = None
        # Fail closed: an oversize line is withheld whatever the helper said.
        self.blocked(error if isinstance(error, str) and error else _fixed_error())

    def _observe(self, line: bytes) -> None:
        try:
            _log_verdict(_ask(line, self.server_id, self.original))
        except Exception:
            pass

    def watch(self, data) -> None:
        """Observe: read a copy of data the child already has. Never raises."""
        try:
            raw = data.encode("utf-8", "replace") if isinstance(data, str) else memoryview(data).tobytes()
            self.feed(raw, _nowhere)
        except Exception:
            pass

    def blocked(self, error: str) -> None:
        sink = getattr(self, "_collect_errors", None)
        if sink is not None:
            sink.extend(error.encode("utf-8"))
        else:
            _inject(self.proc, error)

    def filter_all(self, data) -> tuple:
        """For communicate(): return (input for the child, injected stdout bytes).

        Bytes held from earlier writes are checked first, then data, then the
        tail, because communicate() closes stdin."""
        if not self.enforce:
            if data is not None:
                self.watch(data)
            try:
                self.flush_tail(_nowhere)
            except Exception:
                pass
            return data, b""
        if data is None:
            raw = b""
        elif isinstance(data, str):
            raw = data.encode("utf-8", "surrogatepass")
        else:
            raw = memoryview(data).tobytes()
        allowed = bytearray()
        errors = bytearray()
        self._collect_errors = errors
        try:
            self.feed(raw, allowed.extend)
            self.flush_tail(allowed.extend)
        finally:
            self._collect_errors = None
        if data is None and not allowed:
            return None, bytes(errors)
        result = bytes(allowed)
        as_text = isinstance(data, str) or (data is None and self.text)
        return (result.decode("utf-8", "surrogatepass") if as_text else result), bytes(errors)


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
        if not gate.enforce:
            # Observe: the child gets the caller's own data, then a copy is read.
            count = orig_write(data)
            gate.watch(data)
            return count
        if gate.text:
            if not isinstance(data, str):
                raise TypeError(f"write() argument must be str, not {type(data).__name__}")
            gate.feed(data.encode("utf-8", "surrogatepass"))
            return len(data)
        if isinstance(data, str):
            raise TypeError("a bytes-like object is required, not 'str'")
        raw = memoryview(data).tobytes()
        gate.feed(raw)
        return len(raw)

    def writelines(lines):
        for item in lines:
            write(item)

    def close():
        # Always: whatever is held is checked or forwarded before stdin closes.
        try:
            gate.flush_tail(None if gate.enforce else _nowhere)
        finally:
            orig_close()

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
