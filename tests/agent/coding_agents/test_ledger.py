"""SpawnLedger: iron rule #3 — record at spawn, reap by exact handle, no by-name kill."""

from __future__ import annotations

import subprocess

from agent.coding_agents.ledger import SpawnLedger, process_is_recorded


class FakeProc:
    """Minimal Popen stand-in that records how it was signalled.

    ``wait`` raises ``TimeoutExpired`` while alive, matching real ``Popen`` — so
    a handle that ignores ``terminate`` forces the escalation-to-kill path.
    """

    def __init__(self, pid: int = 4242, alive: bool = True) -> None:
        self.pid = pid
        self._alive = alive
        self.terminated = False
        self.killed = False
        self.stdin = None

    def poll(self) -> int | None:
        return None if self._alive else 0

    def terminate(self) -> None:
        self.terminated = True
        self._alive = False  # graceful exit on terminate

    def kill(self) -> None:
        self.killed = True
        self._alive = False

    def wait(self, timeout: float | None = None) -> int:
        if self._alive:
            raise subprocess.TimeoutExpired(cmd="fake", timeout=timeout or 0)
        return 0


def _record(ledger: SpawnLedger, session_id: str, proc: FakeProc) -> None:
    ledger.record(session_id=session_id, family="cursor", proc=proc, argv=["cursor-agent", "acp"])


def test_record_then_get_and_identity() -> None:
    ledger = SpawnLedger()
    proc = FakeProc(pid=100)
    _record(ledger, "s1", proc)
    rec = ledger.get("s1")
    assert rec is not None
    assert rec.pid == 100
    assert rec.is_alive() is True
    assert rec.identity_matches() is True


def test_reap_signals_only_the_recorded_handle() -> None:
    ledger = SpawnLedger()
    a, b = FakeProc(pid=1), FakeProc(pid=2)
    _record(ledger, "a", a)
    _record(ledger, "b", b)

    assert ledger.reap("a") is True
    # Only a's handle was signalled; b is untouched (no blanket / by-name kill).
    assert a.terminated is True
    assert b.terminated is False
    assert ledger.get("a") is None
    assert ledger.get("b") is not None


def test_reap_unknown_session_is_noop() -> None:
    ledger = SpawnLedger()
    assert ledger.reap("nope") is False


def test_reap_escalates_to_kill_when_terminate_does_not_exit() -> None:
    class StubbornProc(FakeProc):
        def terminate(self) -> None:  # ignores terminate, stays alive
            self.terminated = True

    ledger = SpawnLedger()
    proc = StubbornProc(pid=7)
    _record(ledger, "s", proc)
    ledger.reap("s", timeout=0.01)
    assert proc.terminated is True
    assert proc.killed is True  # escalated to kill on the SAME handle


def test_reap_all_only_clears_recorded_children() -> None:
    ledger = SpawnLedger()
    procs = [FakeProc(pid=i) for i in range(3)]
    for i, p in enumerate(procs):
        _record(ledger, f"s{i}", p)
    assert ledger.reap_all() == 3
    assert all(p.terminated for p in procs)
    assert ledger.records() == []


def test_forget_drops_without_signalling() -> None:
    ledger = SpawnLedger()
    proc = FakeProc()
    _record(ledger, "s", proc)
    ledger.forget("s")
    assert ledger.get("s") is None
    assert proc.terminated is False  # forget != kill


def test_dead_child_reap_does_not_signal() -> None:
    ledger = SpawnLedger()
    proc = FakeProc(pid=9, alive=False)  # already exited
    _record(ledger, "s", proc)
    ledger.reap("s")
    assert proc.terminated is False  # poll() said exited; nothing signalled
    assert proc.killed is False


def test_process_is_recorded_audit_helper() -> None:
    ledger = SpawnLedger()
    proc = FakeProc(pid=555)
    _record(ledger, "s", proc)
    assert process_is_recorded(ledger, 555) is True
    assert process_is_recorded(ledger, 999) is False


def test_ledger_has_no_kill_by_name_surface() -> None:
    # Structural guard for rule #3: the ledger must not grow a name-based kill.
    api = set(dir(SpawnLedger))
    for forbidden in ("killall", "pkill", "kill_by_name", "reap_by_name"):
        assert forbidden not in api
