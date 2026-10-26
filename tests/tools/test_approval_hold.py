"""hc-1034: after a denied or unanswered approval, equivalent operations are held for the turn.

The record this pins (APEX Desktop, 2026-10-22): a terminal check with ``python3 -c`` waited five
minutes and came back BLOCKED; the agent at once ran the same check as an execute_code script,
which waited five more minutes; later it ran a shell line without ``-c``. The BLOCKED text said
not to. ``tools.approval_hold`` makes the gates say it too:

- unanswered: anything that needs approval or runs code stops at once, with no second card;
- denied: anything that runs code asks again, even when it normally would not;
- a human grant, the next turn, or clearing the session ends the hold.
"""

from __future__ import annotations

import json

import pytest

from tools import approval as A
from tools import approval_context, approval_hold

SESSION = "hold-test-session"
DANGEROUS = "rm -rf build"
CODE_RUN = "python3 probe.py"


class _Gateway:
    """The session's notifier: records each card and answers it with ``answer`` (None = nobody does)."""

    def __init__(self):
        self.answer: str | None = None
        self.cards: list[dict] = []

    def __call__(self, data: dict) -> None:
        self.cards.append(data)
        if self.answer is None:
            return
        with A._lock:
            entries = A._gateway_queues.get(SESSION, [])
            if entries:
                entries[-1].result = self.answer
                entries[-1].event.set()


@pytest.fixture
def gateway(monkeypatch):
    monkeypatch.setenv("HERMES_GATEWAY_SESSION", "1")
    for var in ("HERMES_INTERACTIVE", "HERMES_CRON_SESSION", "HERMES_EXEC_ASK"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(approval_context, "_get_approval_mode", lambda: "manual")
    monkeypatch.setattr(approval_context, "_get_approval_timeout", lambda: 0)  # an unanswered card times out at once
    monkeypatch.setattr(A, "_YOLO_MODE_FROZEN", False)
    gw = _Gateway()
    session_token = approval_context.set_current_session_key(SESSION)
    turn_tokens = approval_context.set_current_observability_context(turn_id="turn-1")
    with A._lock:
        A._permanent_approved.clear()
        A._session_approved.pop(SESSION, None)
        A._gateway_queues.pop(SESSION, None)
        A._gateway_notify_cbs[SESSION] = gw
    approval_hold.clear(SESSION)
    try:
        yield gw
    finally:
        approval_context.reset_current_observability_context(turn_tokens)
        approval_context.reset_current_session_key(session_token)
        approval_hold.clear(SESSION)
        with A._lock:
            A._gateway_notify_cbs.pop(SESSION, None)
            A._gateway_queues.pop(SESSION, None)
            A._session_approved.pop(SESSION, None)


def _terminal(command: str) -> dict:
    return A.check_all_command_guards(command, "local")


def _new_turn(turn_id: str):
    return approval_context.set_current_observability_context(turn_id=turn_id)


@pytest.mark.parametrize(
    ("command", "runs"),
    [
        ("python3 probe.py", True), ("bash build.sh", True), ("sh -s < x", True), ("./run", True),
        ("~/bin/tool --go", True), ("/tmp/tool", True), ("sudo python3 x.py", True), ("cd /tmp && node x.js", True),
        ("echo 'rm -rf x' | sh", True), ("npx something", True), ("uv run x.py", True), ("source env.sh", True),
        ("osascript -e 'beep'", True), ("xargs -n1 echo < list", True), ("python3", True),
        ("ls -la", False), ("command -v ffmpeg", False), ("which python3", False), ("type ffmpeg", False),
        ("python3 --version", False), ("node -v", False), ("ffmpeg -i a.mp4 b.mp4", False), ("git status", False),
        ("/usr/bin/git status", False), ("/opt/homebrew/bin/ffmpeg -version", False), ('python3 -c "import PIL"', False),
        ("for c in ffmpeg ffprobe; do command -v $c || echo MISSING; done", False),
    ],
)
def test_runs_code(command, runs):
    assert approval_hold.runs_code(command) is runs


def test_record_replay_2026_10_22(gateway):
    """The Desktop record, step by step, as the gates now answer it."""
    probe_line = ("for c in ffmpeg ffprobe; do command -v $c || echo MISSING; done; "
                  "python3 -c \"import PIL, sys; print('PIL', PIL.__version__)\" 2>&1 | tail -1")
    first = _terminal(probe_line)  # #745: still a bundled line, still a card, nobody answers
    assert first["outcome"] == "timeout" and len(gateway.cards) == 1
    assert "plain words" in first["message"]  # the model is told to say what is waiting

    script = ("import shutil\nfor m in ['PIL', 'cv2']:\n    try:\n        __import__(m)\n"
              "    except Exception:\n        print(m, 'MISSING')\n")
    second = A.check_execute_code_guard(script, "local")  # #748: same check as a script
    assert second["approved"] is False and second["outcome"] == "held"
    assert len(gateway.cards) == 1  # no second five-minute card
    assert second["message"].startswith("BLOCKED") and "another tool" in second["message"]

    assert _terminal("command -v ffmpeg")["approved"] is True  # #773: a plain check still runs
    assert _terminal('python3 -c "import PIL"')["approved"] is True  # and so does a one-line probe
    held = _terminal(CODE_RUN)  # but not the same check written to a file and run
    assert held["outcome"] == "held" and len(gateway.cards) == 1


def test_unanswered_hold_stops_flagged_and_action_gates_without_a_card(gateway):
    assert _terminal(DANGEROUS)["outcome"] == "timeout"
    assert _terminal("chmod -R 777 /tmp/x")["outcome"] == "held"
    assert A.request_tool_approval("computer_use", "click in another app")["outcome"] == "held"
    assert len(gateway.cards) == 1


def test_unanswered_hold_beats_a_session_approval(gateway):
    A.approve_session(SESSION, "execute_code")
    assert _terminal(DANGEROUS)["outcome"] == "timeout"
    assert A.check_execute_code_guard("import os\nos.remove('x')", "local")["outcome"] == "held"


def test_denied_hold_asks_again_for_a_code_run_that_never_asks(gateway):
    assert _terminal(CODE_RUN)["approved"] is True and gateway.cards == []  # no hold: runs as before
    gateway.answer = "deny"
    assert _terminal(DANGEROUS)["outcome"] == "denied"
    again = _terminal(CODE_RUN)
    assert again["outcome"] == "denied" and len(gateway.cards) == 2
    card = gateway.cards[-1]
    assert card["description"] == approval_hold.DESCRIPTION and card["pattern_keys"] == []


def test_a_grant_ends_the_hold(gateway):
    gateway.answer = "deny"
    _terminal(DANGEROUS)
    gateway.answer = "once"
    assert _terminal(CODE_RUN)["approved"] is True and len(gateway.cards) == 2
    assert _terminal("python3 other.py")["approved"] is True and len(gateway.cards) == 2
    with A._lock:
        assert "approval_hold:code" not in A._permanent_set()  # nothing persisted for the hold card


def test_denied_hold_asks_again_despite_session_approval_and_skips_the_guardian(gateway, monkeypatch):
    from tools import approval_smart
    guardian = []
    monkeypatch.setattr(approval_smart, "_smart_approve", lambda c, d: guardian.append(c) or "approve")
    monkeypatch.setattr(approval_context, "_get_approval_mode", lambda: "smart")
    A.approve_session(SESSION, "execute_code")
    gateway.answer = "deny"
    assert A.request_tool_approval("computer_use", "type in Terminal")["outcome"] == "denied"
    result = A.check_execute_code_guard("import shutil\nshutil.rmtree('build')", "local")
    assert result["outcome"] == "denied" and len(gateway.cards) == 2 and guardian == []


def test_a_held_script_with_nobody_to_ask_is_blocked_not_prompted(gateway, monkeypatch):
    gateway.answer = "deny"
    _terminal(DANGEROUS)
    monkeypatch.delenv("HERMES_GATEWAY_SESSION")  # the surface went away mid-turn
    result = A.check_execute_code_guard("import os\nos.remove('x')", "local")
    assert result["outcome"] == "held" and len(gateway.cards) == 1


def test_the_next_turn_ends_the_hold(gateway):
    _terminal(DANGEROUS)
    token = _new_turn("turn-2")
    try:
        assert _terminal(CODE_RUN)["approved"] is True
        assert approval_hold.active(SESSION) is None
    finally:
        approval_context.reset_current_observability_context(token)


def test_clear_session_ends_the_hold(gateway):
    _terminal(DANGEROUS)
    A.clear_session(SESSION)
    with A._lock:
        A._gateway_notify_cbs[SESSION] = gateway
    assert _terminal(CODE_RUN)["approved"] is True


def test_no_turn_id_records_no_hold(gateway):
    token = _new_turn("")
    try:
        _terminal(DANGEROUS)
        assert _terminal(CODE_RUN)["approved"] is True
    finally:
        approval_context.reset_current_observability_context(token)


def test_a_delegated_child_shares_the_parent_hold(gateway):
    from agent.delegation_context import delegated_child_context
    _terminal(DANGEROUS)  # parent turn-1: unanswered
    token = _new_turn("child-turn")
    try:
        with delegated_child_context("child-1"):
            assert _terminal(CODE_RUN)["outcome"] == "held"
    finally:
        approval_context.reset_current_observability_context(token)


def test_a_hold_recorded_by_a_child_holds_the_parent(gateway):
    from agent.delegation_context import delegated_child_context
    token = _new_turn("child-turn")
    try:
        with delegated_child_context("child-1"):
            assert _terminal(DANGEROUS)["outcome"] == "timeout"
    finally:
        approval_context.reset_current_observability_context(token)
    assert _terminal(CODE_RUN)["outcome"] == "held"  # parent turn-1 adopts it


def test_code_tools_without_a_gate_are_held(gateway):
    browser = {"code": "import os\nos.remove('x')"}
    assert A.held_tool_call_error("browser_exec", browser) is None  # no hold: as before
    _terminal(DANGEROUS)
    error = json.loads(A.held_tool_call_error("browser_exec", browser))
    assert error["error"].startswith("BLOCKED") and error["status"] == "blocked" and error["user_summary"]
    assert A.held_tool_call_error("process_manage", {"action": "submit", "session_id": "p1", "data": "rm x"})
    assert A.held_tool_call_error("process_manage", {"action": "poll", "session_id": "p1"}) is None
    assert A.held_tool_call_error("read_file", {"path": "x"}) is None
    assert len(gateway.cards) == 1


def test_protected_instruction_writes_read_and_feed_the_hold(gateway, monkeypatch):
    """That gate waits on its own (not through _human_decision), so it is bridged explicitly."""
    from tools import file_tools_write_guards as W
    monkeypatch.setattr(W, "_protected_instruction_config", lambda: (True, []))
    monkeypatch.setattr(W, "_protected_instruction_reason", lambda path, task_id="default", **kw: "AGENTS.md")
    gateway.answer = "deny"
    assert "was denied by the user" in W._check_protected_instruction_write(["AGENTS.md"])
    assert _terminal(CODE_RUN)["outcome"] == "denied" and len(gateway.cards) == 2  # the refusal holds code runs
    gateway.answer = None
    assert _terminal(DANGEROUS)["outcome"] == "timeout" and len(gateway.cards) == 3
    assert W._check_protected_instruction_write(["AGENTS.md"]).startswith("BLOCKED: not run")
    assert len(gateway.cards) == 3  # no new card while the earlier one went unanswered


def test_model_tools_pre_dispatch_applies_the_hold(gateway):
    import model_tools
    _terminal(DANGEROUS)
    ids = model_tools._CallIds("task", "sess", "call-1", "turn-1", None)
    _, blocked = model_tools._pre_dispatch_guards("browser_exec", {"code": "print(1)"}, True, ids, [])
    assert blocked is not None and blocked[1] == "approval_hold"
    assert json.loads(blocked[0])["error"].startswith("BLOCKED")
    _, other_turn = model_tools._pre_dispatch_guards(
        "browser_exec", {"code": "print(1)"}, True, model_tools._CallIds("task", "sess", "call-2", "turn-2", None), [])
    assert other_turn is None


def test_held_and_timeout_summaries_say_what_is_waiting(gateway, monkeypatch):
    monkeypatch.setenv("HERMES_LANGUAGE", "zh")
    timed_out = _terminal(DANGEROUS)
    held = _terminal(CODE_RUN)
    assert "需要你批准" in timed_out["user_summary"] and "回复" in timed_out["user_summary"]
    assert "需要你批准" in held["user_summary"] and "暂停" in held["user_summary"]
    assert "BLOCKED" not in held["user_summary"]
