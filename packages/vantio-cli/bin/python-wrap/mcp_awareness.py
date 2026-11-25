"""MCP stdio awareness for Python children of `vantio run`.

The Node library evaluates a copy of each complete line. This module does
not listen and does not replace the child process. Observe never changes
what the child gets. It runs the Node helper for a line after the caller's
bytes have been handed over, with one exception: when 64 lines or 1 MiB
are waiting on a buffered pipe, the helper runs at once, and the child may
not have received those bytes yet. Enforce forwards a checked line only
when the helper exits 0 and its answer says allow; anything else is
withheld. A lone CR ends a line, as a newline does.

The mode, the policy file, the `node` path and the helper's environment
are read once, when the wrapper installs. Later changes to `os.environ`
do not change them. Code in the wrapped process can still go around the
wrapper (os.write on the pipe, or by patching this module); that is a
stated gap, not something this module prevents.
"""

from __future__ import annotations

import codecs
import errno
import io
import json
import os
import re
import select
import shutil
import signal
import subprocess
import sys
import threading
from pathlib import Path

_HELPER = Path(__file__).resolve().parent.parent / "mcp-awareness-frame.js"
_LOG_MAX = 1024 * 1024
# Same bound as the Node library (bin/mcp-awareness/bounds.js MAX_FRAME).
_MAX_FRAME = 256 * 1024
# Seconds the Node helper gets for one line. After that it is stopped.
_ASK_TIMEOUT = 5


_CONFIG = None


def _read_mode(value) -> str:
    """observe when the variable is missing, empty or `observe`. Any other
    value is enforce: `enforce` itself, and a value that cannot be read as a
    mode (`Enforce`, a typo), so that the banner and the behavior agree and
    an unreadable value never means less checking."""
    if value is None or value.strip().lower() in ("", "observe"):
        return "observe"
    return "enforce"


def _config() -> dict:
    """The settings, read once (at install). Later changes to os.environ or
    PATH do not change the mode, the policy file, which `node` runs, the
    helper's environment or where the log goes."""
    global _CONFIG
    if _CONFIG is None:
        env = dict(os.environ)
        mode = _read_mode(env.get("VANTIO_MCP_MODE"))
        # The helper reads its mode, policy file, injection and rug-pull
        # settings from this stored copy, never from the live environment.
        env["VANTIO_MCP_MODE"] = mode
        try:
            root = env.get("VANTIO_HOME") or str(Path.home() / ".vantio")
        except Exception:
            root = None
        _CONFIG = {"enforce": mode == "enforce", "mode": mode, "env": env, "node": shutil.which("node"), "log_root": root}
    return _CONFIG


def install() -> None:
    if os.environ.get("VANTIO_MCP_AWARENESS") not in ("on", "1"):
        return
    if getattr(subprocess, "_vantio_mcp_installed", False):
        return
    subprocess._vantio_mcp_installed = True  # type: ignore[attr-defined]
    config = _config()
    mode = config["mode"]
    injection = "block" if config["env"].get("VANTIO_MCP_INJECTION") == "block" else "log"
    rug = "block" if config["env"].get("VANTIO_MCP_RUG_PULL") == "block" else "log"
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
            first = gate is not None and not getattr(self, "_communication_started", False)
            if first and gate.enforce:
                with gate.lock:
                    try:
                        input, injected = gate.filter_all(input)
                        pending.extend(injected)
                    except Exception:
                        # Fail closed: nothing unchecked reaches the child.
                        input = None if input is None else input[:0]
                        pending.extend(_fixed_error().encode("utf-8"))
            self._vantio_raw = True
            try:
                out, err = super().communicate(input, timeout)
            finally:
                self._vantio_raw = False
                if first and not gate.enforce:
                    # Observe: the child has the input; now read a copy for the log.
                    gate.after_communicate(input)
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
# A line ends at a newline or at a CR. A reader with universal newlines (the
# default for Python text streams) splits on a lone CR too, so a frame after
# a CR is a line of its own for such a child.
_EOL = re.compile(rb"[\r\n]")
_RPC_KEYS = frozenset(("jsonrpc", "method"))
_ANSWER_KEYS = frozenset(("result", "error"))
_WIDE_BLANKS = frozenset(
    ch.encode("utf-8")
    for ch in "\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
)


def _is_rpc(value) -> bool:
    """An object with a `jsonrpc` or a `method` key, or one that looks like
    a response (an `id` key together with `result` or `error`), or an array
    that holds one at any depth. A server that does not check the `jsonrpc`
    key would still act on a `method` or take a response. Key case is
    ignored (`Method`, `JSONRPC`): some JSON decoders match field names
    that way."""
    stack = [value]
    while stack:
        item = stack.pop()
        if isinstance(item, dict):
            keys = {key.casefold() for key in item}
            if keys & _RPC_KEYS or ("id" in keys and keys & _ANSWER_KEYS):
                return True
        elif isinstance(item, list):
            stack.extend(item)
    return False


def _classify(line: bytes) -> str:
    """rpc: an object with a `jsonrpc` or `method` key, or with `id` and
    `result` or `error` (any case), or an array (batch) that holds one. plain: any other JSON value. bad: starts like JSON but
    does not parse (this includes a line that is not valid UTF-8)."""
    try:
        # Numbers are not converted: only the keys matter here, and Python
        # refuses to convert an integer of more than 4300 digits.
        value = json.loads(line.decode("utf-8"), parse_int=_number, parse_float=_number)
    except Exception:  # not UTF-8, not JSON, nested too deep
        return "bad"
    return "rpc" if _is_rpc(value) else "plain"


def _number(_text: str) -> int:
    return 0


def _nowhere(_data: bytes) -> None:
    return None


class _Gate:
    """Per-child line handling (VAN-393).

    Observe: the child's stdin is never changed. The caller writes the
    original data first, and the gate reads a copy to find JSON-RPC lines.
    Those lines are queued and go to the Node helper (for the log) after the
    bytes have been handed over: after a write to an unbuffered or
    line-buffered pipe, after flush(), after close() and after communicate().
    The queue is bounded at 64 lines or 1 MiB. When it is full the helper
    runs at once; on a buffered pipe the child may not have received those
    bytes yet. A helper that fails or hangs never changes the child's bytes.

    A line ends at a newline or at a lone CR, in both modes. Each part
    between CRs is handled as a line of its own, and the CR stays where it
    was in what the child gets.

    Enforce: blanks at the start of a line are forwarded as they arrive. A
    line whose first non-blank byte is `{` or `[` is held from that byte to
    its line end and parsed as JSON here. So is a line where up to 4 bytes
    of broken UTF-8 come right before the `{` or `[`; those bytes are held
    with it. JSON that is not JSON-RPC is forwarded without starting node.
    An object with a `jsonrpc` or `method` key (any case), a batch that
    holds one, or a line that does not parse goes to the Node helper. The
    line is forwarded only when the helper exits 0 and its answer says
    allow (see _ask). A blocked line is withheld, and so is a line whose
    check did not run or gave no usable answer (`helper_failed`). Any other
    line is forwarded as it arrives.

    The held part is bounded at _MAX_FRAME, line end included, as in the
    Node library. Past the bound one oversize gap is logged; enforce
    withholds the line up to its line end and answers with the fixed error.

    Enforce output: bytes the gate has decided to forward go to `outq`, in
    order, and `send()` hands them to the real write. A short count, None
    or BlockingIOError from the real write leaves the rest in `outq`; it is
    sent on the next write, flush, close or communicate. No forwarded byte
    is dropped or sent twice. The wrapped write accepts all of the caller's
    data or none of it (none while older bytes are still waiting on a pipe
    that would block), so a caller that loops on short counts sends
    nothing twice.

    `lock` serializes writers: one thread's write is classified and queued
    as a whole before another thread's. In observe the helper runs outside
    the lock.
    """

    def __init__(self, proc, server_id: str, orig_write, original, stdin) -> None:
        self.proc = proc
        self.server_id = server_id
        self.orig_write = orig_write
        self.original = original
        self.stdin = stdin
        self.text = _text(stdin)
        self.raw = isinstance(stdin, io.RawIOBase)
        # Fixed when the wrapper installed; os.environ is not read again.
        self.enforce = _config()["enforce"]
        self.lock = threading.RLock()
        self.outq = bytearray()  # enforce: decided to forward, not yet written
        self.orig_flush = None  # set by _attach
        self.state = "start"  # start | pass | json | drop
        self.held = bytearray()  # a `{` or `[` line, at most _MAX_FRAME bytes
        # At most 4 bytes at the start of a line that are not ASCII and not
        # yet a whole character: part of a wide blank, or broken UTF-8.
        self.pre = bytearray()
        # Enforce: a withheld line ended at a CR. If a newline comes next it
        # is the second half of that line's CRLF and is withheld with it.
        self.skip_lf = False
        self.todo = []  # observe: lines waiting for the helper
        self.todo_bytes = 0
        self.full = False  # observe: the queue reached its cap
        self.closing = False
        self.direct = isinstance(stdin, io.RawIOBase) or bool(getattr(stdin, "line_buffering", False))
        self._decoder = codecs.getincrementaldecoder("utf-8")("surrogatepass")

    def send(self) -> bool:
        """Enforce: hand queued bytes to the real write, in order. True when
        the queue is empty. False when the pipe would block; the rest stays
        queued. Each byte leaves the queue exactly when the real write has
        taken it."""
        q = self.outq
        if not q:
            return True
        if self.text:
            # The text layer takes a whole string or raises; it reports no
            # count. Never hand it half of a multi-byte character.
            chunk = bytes(q)
            del q[:]
            text = self._decoder.decode(chunk)
            if text:
                self.orig_write(text)
            return True
        done = 0
        view = memoryview(q)
        try:
            while done < len(view):
                try:
                    n = self.orig_write(view[done:])
                except BlockingIOError as exc:
                    # A buffered pipe that would block took this many bytes.
                    n = exc.characters_written
                    done += n if isinstance(n, int) and n > 0 else 0
                    return False
                except BaseException:
                    if not self.raw:
                        # A buffered writer gives no count with other errors.
                        # The bytes are its own now, as for any caller.
                        done = len(view)
                    raise
                if n is None:
                    return False  # an unbuffered pipe that would block
                done += n
            return True
        finally:
            view.release()
            del q[:done]

    def finish(self) -> None:
        """Enforce, stdin is closing: send everything that is queued. On a
        pipe that would block, wait until it takes more."""
        while not self.send():
            select.select([], [self.stdin], [])
        if not self.raw and not self.text and not self.stdin.closed:
            # The bytes were counted as taken, so the buffered writer must
            # hand them on too before the pipe closes.
            while True:
                try:
                    self.orig_flush()
                    return
                except BlockingIOError:
                    select.select([], [self.stdin], [])

    def feed(self, data: bytes, sink=None) -> None:
        """Process bytes. sink(bytes) receives what goes to the child. The
        default is the queue of bytes to forward; feed() itself writes
        nothing to the pipe."""
        out = sink or self.outq.extend
        i = 0
        n = len(data)
        while i < n:
            if self.skip_lf:
                self.skip_lf = False
                if data[i : i + 1] == b"\n":
                    i += 1
                    continue
            state = self.state
            if state == "pass" or state == "drop":
                # drop: enforce, oversize line; nothing reaches the child until its line end.
                m = _EOL.search(data, i)
                j = -1 if m is None else m.start()
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
                    self.skip_lf = state == "drop" and data[j : j + 1] == b"\r"
            elif state == "json":
                room = _MAX_FRAME - len(self.held)
                m = _EOL.search(data, i, i + room)
                j = -1 if m is None else m.start()
                if j >= 0:
                    self.held.extend(data[i : j + 1])
                    i = j + 1
                    line = bytes(self.held)
                    self.held.clear()
                    self.state = "start"
                    forwarded = self._line(line, out)
                    self.skip_lf = self.enforce and not forwarded and line.endswith(b"\r")
                    continue
                take = min(room, n - i)
                self.held.extend(data[i : i + take])
                i += take
                if len(self.held) >= _MAX_FRAME:
                    # _MAX_FRAME bytes and no line end among them. The line end
                    # is not consumed here, so the next line is not touched.
                    self._oversize()
            elif self.pre:  # start, after bytes that are not yet a whole character
                ch = data[i : i + 1]
                if ch == b"{" or ch == b"[":
                    # Broken UTF-8 right before a frame: the helper gets the
                    # whole line and answers invalid_utf8.
                    self.held.extend(self.pre)
                    self.pre.clear()
                    self.state = "json"
                elif ch >= b"\x80" and len(self.pre) < 4:
                    i += 1
                    self._pre_byte(ch, out)
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
                elif ch >= b"\x80":
                    i += 1
                    self._pre_byte(ch, out)
                else:
                    self.state = "pass"

    def _pre_byte(self, ch: bytes, out) -> None:
        self.pre.extend(ch)
        cand = bytes(self.pre)
        try:
            cand.decode("utf-8")
        except UnicodeDecodeError:
            return  # incomplete or broken: the next byte decides
        self.pre.clear()
        if cand in _WIDE_BLANKS:
            out(cand)
        else:
            self.pre.extend(cand)
            self.state = "pass"  # the pass branch sends self.pre first

    def flush_tail(self, sink=None) -> None:
        """Stdin is closing: check or forward whatever is still held."""
        out = sink or self.outq.extend
        pre = bytes(self.pre)
        held = bytes(self.held)
        state = self.state
        self.pre.clear()
        self.held.clear()
        self.state = "start"
        self.skip_lf = False
        if pre:
            out(pre)
        if held and state == "json":
            self._line(held, out)

    def _line(self, line: bytes, out) -> bool:
        """Handle one held line. True when the line went to `out`."""
        kind = _classify(line)
        if kind == "plain":
            out(line)
            return True
        if not self.enforce:
            # Observe: the child already has the line; the check only logs.
            if kind == "rpc" or b'"jsonrpc"' in line:
                self._observe(line)
            return True
        # Enforce: the helper decides. A line that does not parse goes to it too.
        # Fail closed: the line goes on only when the answer says allow.
        try:
            answer = _ask(line, self.server_id, self.original)
        except Exception:
            answer = _failed()
        _log(answer["records"])
        if answer["allow"]:
            out(line)
            return True
        self.blocked(answer["error"] or _helper_error())
        return False

    def _oversize(self) -> None:
        """The held line reached _MAX_FRAME before its newline."""
        head = bytes(self.held)
        self.held.clear()
        if not self.enforce:
            self.state = "pass"
            self._observe(head)
            return
        self.state = "drop"
        try:
            answer = _ask(head, self.server_id, self.original)
            _log(answer["records"])
        except Exception:
            answer = _failed()
        # Fail closed: an oversize line is withheld whatever the helper said.
        self.blocked(answer["error"] or _fixed_error())

    def _observe(self, line: bytes) -> None:
        """Observe: queue a line for the helper. It only logs."""
        self.todo.append(line)
        self.todo_bytes += len(line)
        if len(self.todo) >= 64 or self.todo_bytes >= 4 * _MAX_FRAME:
            self.full = True  # the write that queued this line runs the helper

    def drain(self) -> None:
        """Observe: run the helper for the queued lines. Never raises. The
        lock is held only to take the lines, not while the helper runs."""
        with self.lock:
            todo, self.todo, self.todo_bytes, self.full = self.todo, [], 0, False
        for line in todo:
            try:
                _log(_ask(line, self.server_id, self.original)["records"])
            except Exception:
                pass

    def after_communicate(self, data) -> None:
        """Observe: communicate() has sent data and closed stdin. Never raises."""
        with self.lock:
            if data is not None:
                self.watch(data)
            try:
                self.flush_tail(_nowhere)
            except Exception:
                pass
        self.drain()

    def watch(self, data, count=None) -> None:
        """Observe: read a copy of data the pipe has taken. Never raises.
        count: how much of data the real write took, when it took less."""
        try:
            if isinstance(data, str):
                raw = (data if count is None else data[:count]).encode("utf-8", "replace")
            else:
                raw = memoryview(data).tobytes()
                if count is not None:
                    raw = raw[:count]
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
        """For communicate() in enforce: return (input for the child, injected stdout bytes).

        Bytes held from earlier writes are checked first, then data, then the
        tail, because communicate() closes stdin."""
        if data is None:
            raw = b""
        elif isinstance(data, str):
            raw = data.encode("utf-8", "surrogatepass")
        else:
            raw = memoryview(data).tobytes()
        # Bytes from earlier writes that the pipe has not taken yet go first.
        allowed = bytearray(self.outq)
        del self.outq[:]
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
    orig_flush = stdin.flush
    orig_writelines = stdin.writelines
    gate = _Gate(proc, _server_id(command), orig_write, original, stdin)
    proc._vantio_gate = gate  # type: ignore[attr-defined]

    gate.orig_flush = orig_flush
    would_block = "write could not complete without blocking"

    def write(data):
        if getattr(proc, "_vantio_raw", False):
            return orig_write(data)
        if not gate.enforce:
            # Observe: the child gets the caller's own data, then a copy of
            # what the pipe took is read. The caller gets the real write's
            # own return value or exception.
            with gate.lock:
                try:
                    count = orig_write(data)
                except BlockingIOError as exc:
                    taken = exc.characters_written
                    gate.watch(data, taken if isinstance(taken, int) and taken > 0 else 0)
                    raise
                if isinstance(count, int):
                    gate.watch(data, count)
                # This pipe has no buffer (the child has the bytes), or the
                # queue is at its cap.
                run = bool(gate.todo) and (gate.direct or gate.full)
            if run:
                gate.drain()
            return count
        with gate.lock:
            if gate.text:
                if not isinstance(data, str):
                    raise TypeError(f"write() argument must be str, not {type(data).__name__}")
                # As plain Python: a string the pipe's encoding cannot take
                # raises here, before any part of it goes to the child.
                data.encode(stdin.encoding, getattr(stdin, "errors", None) or "strict")
                raw = data.encode("utf-8", "surrogatepass")
                size = len(data)
            else:
                if isinstance(data, str):
                    raise TypeError("a bytes-like object is required, not 'str'")
                raw = memoryview(data).tobytes()
                size = len(raw)
            if not gate.send():
                # Older bytes are still waiting and the pipe would block.
                # None of this data is taken, so the caller can send it again.
                if gate.raw:
                    return None
                raise BlockingIOError(errno.EAGAIN, would_block, 0)
            gate.feed(raw)
            # All of the caller's data is taken now: forwarded, held or
            # withheld. What the pipe does not take at once stays queued.
            gate.send()
            return size

    def writelines(lines):
        orig_writelines([])  # a closed file raises here, with Python's own text
        for item in lines:
            write(item)

    def flush():
        if getattr(proc, "_vantio_raw", False):
            return orig_flush()
        if gate.enforce:
            with gate.lock:
                sent = gate.send()
                result = orig_flush()
                if not sent and not gate.raw:
                    raise BlockingIOError(errno.EAGAIN, would_block, 0)
                return result
        try:
            return orig_flush()
        finally:
            if gate.todo and not gate.closing:
                gate.drain()

    def close():
        if getattr(proc, "_vantio_raw", False):
            return orig_close()  # communicate() does the gate's work itself
        if gate.enforce:
            # Whatever is held is checked or forwarded, and everything queued
            # is sent, before stdin closes.
            with gate.lock:
                try:
                    gate.flush_tail(None)
                    gate.finish()
                finally:
                    orig_close()
            return
        # Observe: close first, so the child has every byte and the end of
        # input, then read the tail and run the helper for the log.
        gate.closing = True
        try:
            orig_close()
        finally:
            gate.closing = False
            with gate.lock:
                try:
                    gate.flush_tail(_nowhere)
                except Exception:
                    pass
            gate.drain()

    stdin.write = write  # type: ignore[method-assign]
    stdin.writelines = writelines  # type: ignore[method-assign]
    stdin.flush = flush  # type: ignore[method-assign]
    stdin.close = close  # type: ignore[method-assign]


def _inject(proc, error: str) -> None:
    """Put the fixed error on the pipe the workload reads. The child keeps the write end."""
    stdout = proc.stdout
    if stdout is None or not hasattr(stdout, "read"):
        # The same notice as the communicate() path.
        try:
            sys.stderr.write("[ ∅ VANTIO ] mcp frame withheld (stdout not captured)\n")
        except Exception:
            pass
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


# WOULD_BLOCK is what a helper in observe mode says about a line it would
# block. A helper in enforce mode never says it, so it is not an allow.
_ALLOW_ACTIONS = frozenset(("ALLOW", "LOG"))


def _failed() -> dict:
    """The check did not run or gave no usable answer. Enforce withholds."""
    return {"records": [], "error": _helper_error(), "allow": False}


def _stop(proc) -> None:
    """Kill the helper (and anything it started) and reap it. Never raises."""
    try:
        if os.name == "posix":
            os.killpg(proc.pid, signal.SIGKILL)  # its own group, see _ask
        else:
            proc.kill()
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
    for stream in (proc.stdin, proc.stdout):
        try:
            if stream is not None:
                stream.close()
        except Exception:
            pass
    try:
        proc.wait(timeout=5)
    except Exception:
        pass


def _ask(line: bytes, server_id: str, original) -> dict:
    """Run the Node helper for one line. Never raises.

    Returns {"records": list, "error": str or None, "allow": bool}.
    `allow` is true only for the answer mcp-awareness-frame.js gives for a
    line it lets through: exit code 0, a JSON object whose `error` is null
    and whose `records` is a list with at least one observation record,
    each with an ALLOW or LOG decision. A helper block (exit
    code 0 and an `error` string) keeps the helper's error. Everything else
    is `helper_failed`: no node, a node that does not start, a non-zero
    exit, a timeout, empty output, `{}`, or output that is not that shape.
    The caller logs the records; only enforce reads `allow` and `error`.
    """
    config = _config()
    node = config["node"]  # resolved once, when the wrapper installed
    if node is None or not _HELPER.is_file():
        return _failed()
    proc = None
    try:
        proc = original(
            [node, str(_HELPER), server_id],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            # The stored environment: mode, policy file and the rest are
            # what they were when the wrapper installed.
            env=dict(config["env"]),
            # Its own process group, so a hung helper can be stopped whole.
            start_new_session=os.name == "posix",
        )
        out, _err = proc.communicate(line, timeout=_ASK_TIMEOUT)
    except BaseException as exc:
        # Timeout, a broken pipe, an interrupt: no helper is left running.
        if proc is not None:
            _stop(proc)
        if not isinstance(exc, Exception):
            raise
        return _failed()
    if proc.returncode != 0:
        return _failed()
    try:
        parsed = json.loads(out.decode("utf-8"))
    except Exception:
        return _failed()
    if not isinstance(parsed, dict) or "error" not in parsed:
        return _failed()
    records = parsed.get("records")
    error = parsed["error"]
    if not isinstance(records, list) or not all(isinstance(r, dict) for r in records):
        return _failed()
    if isinstance(error, str) and error:
        return {"records": records, "error": error, "allow": False}
    # Not an allow answer. The records are still returned for the log:
    # in observe the helper reports a GAP or BLOCK record with a null error.
    refused = {"records": records, "error": _helper_error(), "allow": False}
    if error is not None or not records:
        return refused
    for record in records:
        decision = record.get("decision")
        action = decision.get("action") if isinstance(decision, dict) else None
        if record.get("schema") != "vantio.mcp_observation.v1" or action not in _ALLOW_ACTIONS:
            return refused
    return {"records": records, "error": None, "allow": True}


def _log(records: list) -> None:
    root = _config()["log_root"]  # fixed when the wrapper installed
    if not root:
        return
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


def _helper_error() -> str:
    """Enforce: the check for a line did not run or gave no usable answer."""
    return (
        '{"jsonrpc":"2.0","id":null,"error":{"code":-32001,'
        '"message":"vantio_mcp_policy_block","data":{"finding":"helper_failed"}}}\n'
    )


def _fixed_error() -> str:
    return (
        '{"jsonrpc":"2.0","id":null,"error":{"code":-32001,'
        '"message":"vantio_mcp_policy_block","data":{"finding":"policy"}}}\n'
    )
