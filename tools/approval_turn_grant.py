"""「本任务都允许」: one answer allows the card and every later approval of the same task (hc-1223).

On an APEX Desktop a user who said 「直接做」 still had to click Run on card after card, and a card
nobody answers expires after ``approvals.timeout`` and blocks the turn (:mod:`tools.approval_hold`).
The card now also offers the ``task`` choice. Answering it runs that one operation like ``once``,
and records a grant that the three gates of :mod:`tools.approval` (commands, execute_code, flagged
actions) and model_tools' held-tool check read before they would ask: every later operation of the
same task runs without a card. Hardline commands, the operator's ``approvals.deny`` rules and the
protected-instruction write gate never ask through these gates, so the grant never reaches them.

Scope: the task is the conversation turn the grant was made in, keyed by the root turn id
(``approval_context._approval_root_turn_id``: a delegated child's own dispatches keep their
parent's), so a subagent working for the task is covered and the session's next turn is not. A
grant is held in memory only, per approval session key: it never persists, never reaches another
session or profile, and ends with the turn, a human denial in the session
(:func:`tools.approval_hold.observe`) or ``clear_session``. A call with no turn id bound neither
records nor sees a grant, and the choice is offered only where a turn id is bound.
"""

from __future__ import annotations

import logging
import threading

from tools import approval_context

CHOICE = "task"
_MAX_SESSIONS = 256

logger = logging.getLogger(__name__)
_lock = threading.Lock()
_grants: dict[str, str] = {}  # approval session key -> root turn id of the granted task


def _task_turn() -> str:
    return approval_context._approval_root_turn_id.get() or ""


def offer(*, smart_denied: bool) -> dict:
    """``{"allow_task": True}`` for a card that may offer the task choice, else ``{}``: a smart-DENY owner
    override covers one operation only, and a call with no turn id has no task to scope a grant to."""
    return {"allow_task": True} if not smart_denied and _task_turn() else {}


def answered(session_key: str, data: dict, choice: str | None) -> None:
    """After a gateway card was answered: when it offered the task choice and got it, record the grant
    and answer the session's other open cards that offered it the same way (parallel tool calls), so
    no card of this task is left waiting."""
    if choice != CHOICE or not data.get("allow_task") or not record(session_key):
        return
    from tools import approval
    with approval._lock:
        waiting = [entry.data.get("request_id") for entry in approval._gateway_queues.get(session_key, [])
                   if entry.data.get("allow_task")]
    for request_id in waiting:
        approval.resolve_gateway_approval(session_key, CHOICE, request_id=request_id)


def record(session_key: str) -> bool:
    """Record the task-wide grant for the current task; False when there is no task to scope it to."""
    turn = _task_turn()
    if not session_key or not turn:
        return False
    with _lock:
        new = _grants.get(session_key) != turn
        _grants.pop(session_key, None)
        _grants[session_key] = turn
        while len(_grants) > _MAX_SESSIONS:
            _grants.pop(next(iter(_grants)))
    if new:
        logger.info("approval: user allowed every approval for the rest of this task (session=%s turn=%s)",
                    session_key, turn)
    return True


def active(session_key: str) -> bool:
    """True while the current call belongs to the task a grant in *session_key* was made for."""
    turn = _task_turn()
    with _lock:
        return bool(turn) and _grants.get(session_key) == turn


def revoke(session_key: str) -> None:
    with _lock:
        _grants.pop(session_key, None)
