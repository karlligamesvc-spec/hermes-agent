"""Bounded process-local outcomes for exact accepted inline prompt attempts.

No prompt content, history scan, or ambient session state is used to infer completion.
A reaped session/restarted process loses unobserved outcomes; absence means unavailable.
"""
from __future__ import annotations

import threading
import uuid

_LOCK = threading.Lock()
_MAX_OUTCOMES = 32
_TERMINAL = frozenset({"complete", "error", "interrupted"})


def begin_prompt_outcome(session: dict) -> str:
    turn_id = str(uuid.uuid4())
    with _LOCK:
        outcomes = session.setdefault("_prompt_outcomes", {})
        outcomes[turn_id] = "running"
        while len(outcomes) > _MAX_OUTCOMES:
            outcomes.pop(next(iter(outcomes)))
    return turn_id


def finish_prompt_outcome(session: dict, turn_id: str | None, status: str) -> None:
    if not turn_id or status not in _TERMINAL:
        return
    with _LOCK:
        outcomes = session.get("_prompt_outcomes", {})
        if outcomes.get(turn_id) == "running":
            outcomes[turn_id] = status


def read_prompt_outcome(session: dict, turn_id: str) -> str:
    with _LOCK:
        return session.get("_prompt_outcomes", {}).get(turn_id, "unavailable")


def run_tracked_prompt(session: dict, turn_id: str | None, run) -> None:
    """The initialization thread can fail before the normal turn runner owns cleanup."""
    try:
        run()
    except BaseException:
        finish_prompt_outcome(session, turn_id, "error")
        raise
