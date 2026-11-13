"""hc-1223: 「本任务都允许」 answers the card and every later approval of the same task.

The record (APEX Desktop 0.17.76, 2026-11-11): a user who had said 「直接做」 was called back for 24
cards in 87 minutes, and each unanswered card blocked the turn after five minutes. The card now
offers the ``task`` choice (tools.approval_turn_grant). These tests pin what one such answer
covers: the rest of the turn's commands, scripts and flagged actions, the same task's parallel
cards and subagents. And what it does not: the next turn, another session, a turn after a refusal.
"""

from __future__ import annotations

import contextvars
import logging
import threading
from contextlib import contextmanager

import pytest

from agent.delegation_context import delegated_child_context
from tools import approval as A
from tools import approval_context, approval_hold, approval_turn_grant
from tools.approval_turn_grant import CHOICE
from tests.waiting import wait_until

SESSION = "turn-grant-session"
OTHER_SESSION = "turn-grant-other"
DANGEROUS = "rm -rf build"
WRITE_SCRIPT = 'open("out.txt", "w").write("x")'


class _Cards:
    """The session's card surface: records each card and answers it with ``answer``; ``None`` leaves it open."""

    def __init__(self, session):
        self.session = session
        self.answer: str | None = CHOICE
        self.cards: list[dict] = []

    def __call__(self, data: dict) -> None:
        self.cards.append(data)
        if self.answer is None:
            return
        with A._lock:
            entry = A._gateway_queues[self.session][-1]
            entry.result = self.answer
            entry.event.set()


@contextmanager
def _turn(turn_id: str):
    """One turn's tool dispatch, as model_tools binds it."""
    tokens = approval_context.set_current_observability_context(turn_id=turn_id)
    try:
        yield
    finally:
        approval_context.reset_current_observability_context(tokens)


@pytest.fixture
def cards(monkeypatch):
    monkeypatch.setenv("HERMES_GATEWAY_SESSION", "1")
    for var in ("HERMES_INTERACTIVE", "HERMES_CRON_SESSION", "HERMES_EXEC_ASK"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(approval_context, "_get_approval_mode", lambda: "manual")
    monkeypatch.setattr(A, "_YOLO_MODE_FROZEN", False)
    surfaces = {key: _Cards(key) for key in (SESSION, OTHER_SESSION)}
    key_token = approval_context.set_current_session_key(SESSION)
    with A._lock:
        for key, surface in surfaces.items():
            A._session_approved.pop(key, None)
            A._gateway_notify_cbs[key] = surface
    for key in surfaces:
        approval_hold.clear(key)
        approval_turn_grant.revoke(key)
    try:
        yield surfaces[SESSION]
    finally:
        approval_context.reset_current_session_key(key_token)
        with A._lock:
            for key in surfaces:
                A._gateway_notify_cbs.pop(key, None)
                A._gateway_queues.pop(key, None)
                A._session_approved.pop(key, None)
        for key in surfaces:
            approval_hold.clear(key)
            approval_turn_grant.revoke(key)


def _terminal(command: str = DANGEROUS) -> dict:
    return A.check_all_command_guards(command, "local")


def test_one_answer_covers_every_later_gate_of_the_turn(cards):
    with _turn("turn-1"):
        first = _terminal()
        assert first["approved"] is True and len(cards.cards) == 1
        cards.answer = "deny"  # a second card would now be refused: none may appear
        later = _terminal("chmod -R 777 /tmp/x")
        assert later["approved"] is True
        assert [entry["scope"] for entry in later["pre_approved"]] == ["task"]  # the run says why
        assert A.check_execute_code_guard(WRITE_SCRIPT, "local")["approved"] is True
        assert A.request_tool_approval("computer_use", "click in another app")["approved"] is True
    assert len(cards.cards) == 1


def test_the_card_offers_the_choice_only_inside_a_task(cards, monkeypatch):
    cards.answer = "once"
    with _turn("turn-1"):
        _terminal()
    _terminal()  # no turn bound: no task to scope a grant to
    assert cards.cards[0]["allow_task"] is True and "allow_task" not in cards.cards[1]

    from tools import approval_smart
    monkeypatch.setattr(approval_context, "_get_approval_mode", lambda: "smart")
    monkeypatch.setattr(approval_smart, "_smart_approve", lambda command, description: "deny")
    with _turn("turn-2"):
        _terminal()
    assert cards.cards[2]["smart_denied"] is True and "allow_task" not in cards.cards[2]


def test_the_next_turn_asks_again(cards):
    with _turn("turn-1"):
        _terminal()
    cards.answer = "deny"
    with _turn("turn-2"):
        assert _terminal()["outcome"] == "denied"
    assert len(cards.cards) == 2


def test_a_refusal_in_the_turn_ends_the_grant(cards, monkeypatch):
    """The protected-instruction gate never honours the grant; refusing it there ends the grant."""
    from tools import file_tools_write_guards as W
    monkeypatch.setattr(W, "_protected_instruction_config", lambda: (True, []))
    monkeypatch.setattr(W, "_protected_instruction_reason", lambda path, task_id="default", **kw: "AGENTS.md")
    with _turn("turn-1"):
        _terminal()
        cards.answer = "deny"
        assert "was denied by the user" in W._check_protected_instruction_write(["AGENTS.md"])
        assert _terminal()["outcome"] == "denied"
    assert len(cards.cards) == 3


def test_the_grant_outlasts_a_card_nobody_answered(cards, monkeypatch):
    """A protected-write card that times out (the user is away) does not stop the granted task."""
    from tools import file_tools_write_guards as W
    monkeypatch.setattr(W, "_protected_instruction_config", lambda: (True, []))
    monkeypatch.setattr(W, "_protected_instruction_reason", lambda path, task_id="default", **kw: "AGENTS.md")
    monkeypatch.setattr(approval_context, "_get_approval_timeout", lambda: 0)
    with _turn("turn-1"):
        _terminal()
        cards.answer = None
        assert "timed out" in W._check_protected_instruction_write(["AGENTS.md"])
        assert _terminal("python3 render.py")["approved"] is True  # held without the grant
        assert A.held_tool_call_error("browser_exec", {"code": "print(1)"}) is None
    assert len(cards.cards) == 2


def test_other_sessions_and_clear_session(cards):
    with _turn("turn-1"):
        _terminal()
        other = A._gateway_notify_cbs[OTHER_SESSION]
        other.answer = "deny"
        token = approval_context.set_current_session_key(OTHER_SESSION)
        try:
            assert _terminal()["outcome"] == "denied" and len(other.cards) == 1
        finally:
            approval_context.reset_current_session_key(token)
        A.clear_session(SESSION)
        A._gateway_notify_cbs[SESSION] = cards
        cards.answer = "deny"
        assert _terminal()["outcome"] == "denied"
    assert len(cards.cards) == 2


def test_a_subagent_shares_the_task(cards):
    """A delegated child's dispatches bind its own turn id; the grant follows the parent's task, both ways."""
    with _turn("parent-turn"):
        with delegated_child_context("child-session"), _turn("child-turn"):
            assert _terminal()["approved"] is True  # the child answers 「本任务都允许」
        cards.answer = "deny"
        assert A.check_execute_code_guard(WRITE_SCRIPT, "local")["approved"] is True
        with delegated_child_context("child-session"), _turn("child-turn-2"):
            assert _terminal("chmod -R 777 /tmp/x")["approved"] is True
    assert len(cards.cards) == 1


def test_parallel_cards_of_the_task_are_answered_together(cards):
    """Two tool calls of one batch wait on two cards; 「本任务都允许」 on one answers the other too."""
    cards.answer = None
    results: dict[str, dict] = {}

    def run(name, command):
        results[name] = _terminal(command)

    with _turn("turn-1"):
        threads = [threading.Thread(target=contextvars.copy_context().run, args=(run, name, command), daemon=True)
                   for name, command in (("a", DANGEROUS), ("b", "chmod -R 777 /tmp/x"))]
        for thread in threads:
            thread.start()
        wait_until(lambda: len(A.list_gateway_approvals(SESSION)) == 2, what="both cards open")
        first = A.list_gateway_approvals(SESSION)[0]["request_id"]
        assert A.resolve_gateway_approval(SESSION, CHOICE, request_id=first) == 1
        for thread in threads:
            thread.join(timeout=10)
    assert results["a"]["approved"] is True and results["b"]["approved"] is True
    assert len(cards.cards) == 2 and A.list_gateway_approvals(SESSION) == []


def test_the_grant_is_logged_once(cards, caplog):
    with caplog.at_level(logging.INFO, logger="tools.approval_turn_grant"), _turn("turn-1"):
        _terminal()
        _terminal("chmod -R 777 /tmp/x")
    granted = [record for record in caplog.records if "allowed every approval" in record.getMessage()]
    assert len(granted) == 1 and SESSION in granted[0].getMessage()

