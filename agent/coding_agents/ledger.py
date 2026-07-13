"""Process ledger for spawned coding-agent subprocesses.

Iron rule #3 ("进程台账"): every child is entered in the ledger at spawn time,
reclaimed only when its *identity matches* the recorded handle, and never
killed by process name. This mirrors the discipline already in
``CodexAppServerClient.close()`` / ``CopilotACPClient.close()`` (each holds the
one ``Popen`` handle it spawned and terminates that exact handle) and
generalizes it into an auditable registry so a supervisor can enumerate and
reap what the harness started — and nothing it didn't.

Why not reuse ``tools/process_registry.py``: that registry is a user-facing
terminal-session manager keyed by ``task_id``/``session_key`` with
notification/completion-consumption semantics — the wrong shape and far more
surface than owning a set of ACP subprocess handles. This ledger is the small,
purpose-fit concept.
"""

from __future__ import annotations

import subprocess
import threading
import time
from dataclasses import dataclass, field


@dataclass(slots=True)
class SpawnRecord:
    """One spawned child, recorded at spawn time.

    ``pid`` is captured alongside the ``proc`` handle so teardown can assert the
    live process is still the one we spawned (identity match) before signalling
    it — a recycled pid belonging to someone else is never touched.
    """

    session_id: str
    family: str
    proc: subprocess.Popen
    pid: int
    argv: tuple[str, ...]
    spawned_at: float = field(default_factory=time.monotonic)

    def is_alive(self) -> bool:
        return self.proc.poll() is None

    def identity_matches(self) -> bool:
        """True iff the handle's live pid is still the pid we recorded.

        ``Popen.poll()`` reaps the child on exit, so a live handle whose pid
        equals the recorded pid is provably the same process — the OS cannot
        reassign a pid still owned by an un-waited child.
        """
        return self.proc.pid == self.pid and self.is_alive()


class SpawnLedger:
    """Thread-safe registry of spawned coding-agent children.

    The harness records a child here at spawn and reaps through here at close.
    ``reap``/``reap_all`` only ever signal the *exact* recorded ``Popen``
    handle — there is deliberately no "kill by name / pgrep" path.
    """

    def __init__(self) -> None:
        self._records: dict[str, SpawnRecord] = {}
        self._lock = threading.Lock()

    def record(
        self,
        *,
        session_id: str,
        family: str,
        proc: subprocess.Popen,
        argv: list[str] | tuple[str, ...],
    ) -> SpawnRecord:
        """Enter a freshly spawned child in the ledger (spawn == record)."""
        rec = SpawnRecord(
            session_id=session_id,
            family=family,
            proc=proc,
            pid=proc.pid,
            argv=tuple(argv),
        )
        with self._lock:
            self._records[session_id] = rec
        return rec

    def get(self, session_id: str) -> SpawnRecord | None:
        with self._lock:
            return self._records.get(session_id)

    def records(self) -> list[SpawnRecord]:
        """Snapshot of every currently-recorded child."""
        with self._lock:
            return list(self._records.values())

    def reap(self, session_id: str, *, timeout: float = 3.0) -> bool:
        """Terminate the recorded child for ``session_id`` by its handle.

        Returns True if a record existed and was signalled/cleaned. Signals the
        exact ``Popen`` handle only; escalates terminate -> kill on the same
        handle. Never resolves the target by process name.
        """
        with self._lock:
            rec = self._records.pop(session_id, None)
        if rec is None:
            return False
        _terminate_handle(rec.proc, timeout=timeout)
        return True

    def reap_all(self, *, timeout: float = 3.0) -> int:
        """Reap every recorded child. Returns how many records were cleared."""
        with self._lock:
            records = list(self._records.values())
            self._records.clear()
        for rec in records:
            _terminate_handle(rec.proc, timeout=timeout)
        return len(records)

    def forget(self, session_id: str) -> None:
        """Drop a record without signalling (child already exited on its own)."""
        with self._lock:
            self._records.pop(session_id, None)


def _terminate_handle(proc: subprocess.Popen, *, timeout: float) -> None:
    """Terminate a specific ``Popen`` handle, escalating to kill.

    Operates only on the handle passed in — the caller has already established
    that this is a ledger-recorded child. No ``os.kill`` by scanned pid, no
    ``pkill``/``killall``.
    """
    if proc.poll() is not None:
        return  # already exited; nothing to signal
    try:
        if proc.stdin and not proc.stdin.closed:
            try:
                proc.stdin.close()
            except OSError:
                pass
        proc.terminate()
        try:
            proc.wait(timeout=timeout)
            return
        except subprocess.TimeoutExpired:
            pass
        proc.kill()
        try:
            proc.wait(timeout=1.0)
        except subprocess.TimeoutExpired:
            pass
    except ProcessLookupError:
        # Child raced us and exited between poll() and signal — fine.
        pass
    except OSError:
        # Best-effort teardown; the handle is the only thing we ever touch.
        pass


def process_is_recorded(ledger: SpawnLedger, pid: int) -> bool:
    """Audit helper: is ``pid`` one the ledger currently owns?

    Lets a supervisor answer "did the harness spawn this?" without ever using
    it as a kill selector — enumeration is by recorded identity, not name.
    """
    return any(rec.pid == pid for rec in ledger.records())
