"""Newline-delimited JSON transport over a child's stdio.

A :class:`LineChannel` is a dumb, ordered duplex pipe: ``send`` writes one JSON
object as a line to the child's stdin; ``recv`` returns the next JSON object
parsed from the child's stdout (or ``None`` on timeout). All protocol meaning —
request/response correlation, notifications, server-initiated requests — lives
in the family drivers, not here. That separation is what lets the ACP session
state machine be exercised in tests against :class:`ScriptedLineChannel` with
no real process and no threads.

:class:`SubprocessLineChannel` mirrors the proven threading model in
``agent/transports/codex_app_server.py``: one reader thread turns stdout lines
into a bounded queue the caller drains on its own cadence, one thread tails
stderr for diagnostics.
"""

from __future__ import annotations

import json
import queue
import subprocess
import threading
from collections import deque
from typing import Any, Callable, Protocol


class LineChannel(Protocol):
    """Ordered duplex line transport used by the drivers."""

    def send(self, obj: dict[str, Any]) -> None: ...
    def recv(self, timeout: float = 0.0) -> dict[str, Any] | None: ...
    def poll(self) -> int | None: ...
    def stderr_tail(self, n: int = 20) -> list[str]: ...
    def close(self) -> None: ...


class SubprocessLineChannel:
    """LineChannel backed by a spawned child process over stdio.

    The channel does NOT spawn the process — the harness spawns (so the spawn
    goes through the ledger and the scrubbed env in one place) and hands the
    live ``Popen`` here. The channel owns only the read/write plumbing; the
    ledger owns the handle's lifecycle.
    """

    def __init__(self, proc: subprocess.Popen) -> None:
        if proc.stdin is None or proc.stdout is None:
            raise RuntimeError("child process must expose stdin and stdout pipes")
        self._proc = proc
        self._inbox: queue.Queue[dict[str, Any]] = queue.Queue()
        self._stderr: deque[str] = deque(maxlen=200)
        self._closed = False

        self._reader = threading.Thread(target=self._read_stdout, daemon=True)
        self._reader.start()
        if proc.stderr is not None:
            self._err_reader = threading.Thread(target=self._read_stderr, daemon=True)
            self._err_reader.start()

    def send(self, obj: dict[str, Any]) -> None:
        if self._closed:
            raise RuntimeError("channel is closed")
        stdin = self._proc.stdin
        if stdin is None:
            raise RuntimeError("child stdin not available")
        line = json.dumps(obj, ensure_ascii=False) + "\n"
        data = line.encode("utf-8") if "b" in getattr(stdin, "mode", "") else line
        try:
            stdin.write(data)
            stdin.flush()
        except (BrokenPipeError, ValueError, OSError) as exc:
            raise RuntimeError(f"child stdin closed unexpectedly: {exc}") from exc

    def recv(self, timeout: float = 0.0) -> dict[str, Any] | None:
        try:
            if timeout <= 0:
                return self._inbox.get_nowait()
            return self._inbox.get(timeout=timeout)
        except queue.Empty:
            return None

    def poll(self) -> int | None:
        return self._proc.poll()

    def stderr_tail(self, n: int = 20) -> list[str]:
        return list(self._stderr)[-n:]

    def close(self) -> None:
        # Teardown of the process handle itself is the ledger's job; the channel
        # just marks itself closed so further sends fail fast.
        self._closed = True

    # --- reader threads ---

    def _read_stdout(self) -> None:
        stdout = self._proc.stdout
        if stdout is None:
            return
        for raw in stdout:
            line = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw
            line = line.strip()
            if not line:
                continue
            try:
                self._inbox.put(json.loads(line))
            except json.JSONDecodeError:
                # Protocol violation (tracing on stdout). Keep it out of the
                # JSON inbox but preserve it for diagnostics.
                self._stderr.append(f"<non-json stdout> {line[:200]}")

    def _read_stderr(self) -> None:
        stderr = self._proc.stderr
        if stderr is None:
            return
        for raw in stderr:
            line = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw
            self._stderr.append(line.rstrip("\n"))


class ScriptedLineChannel:
    """In-memory LineChannel test double driven by a responder function.

    ``responder(outbound)`` is called for every :meth:`send` and returns the
    list of inbound messages the scripted server would emit in response, in
    order. This models an ACP / app-server peer deterministically: replies,
    streaming notifications, and server-initiated requests are just entries in
    the returned list. No threads, no real IO.
    """

    def __init__(
        self,
        responder: Callable[[dict[str, Any]], list[dict[str, Any]]] | None = None,
        *,
        initial: list[dict[str, Any]] | None = None,
    ) -> None:
        # ``responder`` models a peer that answers each send (ACP, codex
        # app-server). ``initial`` pre-seeds emissions for peers that stream
        # unprompted (Claude ``-p`` print mode reads its prompt from argv, not a
        # send, so its whole event stream is seeded up front).
        self._responder = responder or (lambda _obj: [])
        self._inbox: deque[dict[str, Any]] = deque(initial or [])
        self.sent: list[dict[str, Any]] = []
        self._closed = False
        self._exit_code: int | None = None

    def send(self, obj: dict[str, Any]) -> None:
        if self._closed:
            raise RuntimeError("channel is closed")
        self.sent.append(obj)
        for msg in self._responder(obj) or []:
            self._inbox.append(msg)

    def recv(self, timeout: float = 0.0) -> dict[str, Any] | None:
        if self._inbox:
            return self._inbox.popleft()
        return None

    def poll(self) -> int | None:
        return self._exit_code

    def set_exit(self, code: int) -> None:
        """Test hook: simulate the child having exited with ``code``."""
        self._exit_code = code

    def stderr_tail(self, n: int = 20) -> list[str]:
        return []

    def close(self) -> None:
        self._closed = True
