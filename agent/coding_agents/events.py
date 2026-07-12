"""Unified event model for the coding-agent orchestration harness.

Every external coding agent (Claude Code, Codex, Cursor, CodeBuddy) speaks a
different wire protocol — ACP JSON-RPC, Claude ``stream-json``, Codex
``app-server``. Each family driver normalizes its raw stream into the single
:class:`AgentEvent` vocabulary defined here so callers (the user's on-device
assistant, and later a thin Desktop UI layer) consume one shape regardless of
which agent is driving.

Iron rule #1 ("接口收敛在会话不在进程") shows up here as
:data:`EventKind.SESSION_STARTED` carrying the ``session_id`` that the caller
round-trips back into follow-up prompts and cancellation — the id from the
stream is the id you continue/cancel with.

Iron rule #2 ("状态只信显式事件") shows up as the closed vocabulary below:
every event originates from an explicit protocol message (a JSON-RPC
notification, a ``stream-json`` line, an ``item/*`` notification). Nothing is
derived from scraping a terminal screen.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass, field
from typing import Any


class EventKind(str, enum.Enum):
    """Normalized event kinds emitted by every family driver.

    Kept small and explicit on purpose: a driver may only emit these kinds, so
    a caller written against the vocabulary works for any agent family.
    """

    SESSION_STARTED = "session_started"  # data: {"session_id": str} — the round-trip id
    AGENT_MESSAGE = "agent_message"  # assistant text (delta or whole); .text
    AGENT_THOUGHT = "agent_thought"  # reasoning / thinking; .text
    TOOL_CALL = "tool_call"  # tool activity began; .tool_name, .tool_call_id, data["input"]
    TOOL_RESULT = "tool_result"  # tool activity ended; .tool_call_id, data["status"|"output"]
    FILE_CHANGE = "file_change"  # a diff/patch the agent produced; data["path"|"kind"|"diff"]
    PLAN = "plan"  # todo/plan snapshot; data["entries"]
    PERMISSION_REQUEST = "permission_request"  # agent asks to run something; data["request"]
    USAGE = "usage"  # token/cost accounting; data["usage"]
    TURN_COMPLETED = "turn_completed"  # one prompt finished; data["stop_reason"]
    ERROR = "error"  # driver/agent surfaced an error; .text


@dataclass(slots=True)
class AgentEvent:
    """One normalized event in an agent session's stream.

    ``kind`` selects the meaning; ``text`` holds the hot payload for the
    text-bearing kinds; ``data`` carries kind-specific structured fields so the
    dataclass stays flat without a subclass per kind.
    """

    kind: EventKind
    text: str | None = None
    session_id: str | None = None
    tool_name: str | None = None
    tool_call_id: str | None = None
    data: dict[str, Any] = field(default_factory=dict)

    # --- constructors (readability at call sites in the drivers) ---

    @classmethod
    def session_started(cls, session_id: str) -> "AgentEvent":
        return cls(EventKind.SESSION_STARTED, session_id=session_id, data={"session_id": session_id})

    @classmethod
    def message(cls, text: str) -> "AgentEvent":
        return cls(EventKind.AGENT_MESSAGE, text=text)

    @classmethod
    def thought(cls, text: str) -> "AgentEvent":
        return cls(EventKind.AGENT_THOUGHT, text=text)

    @classmethod
    def tool_call(cls, *, tool_call_id: str, tool_name: str, input: Any = None, kind: str | None = None) -> "AgentEvent":
        return cls(
            EventKind.TOOL_CALL,
            tool_name=tool_name,
            tool_call_id=tool_call_id,
            data={"input": input, "tool_kind": kind},
        )

    @classmethod
    def tool_result(cls, *, tool_call_id: str, status: str, output: Any = None) -> "AgentEvent":
        return cls(
            EventKind.TOOL_RESULT,
            tool_call_id=tool_call_id,
            data={"status": status, "output": output},
        )

    @classmethod
    def file_change(cls, *, path: str, kind: str, diff: str | None = None) -> "AgentEvent":
        return cls(EventKind.FILE_CHANGE, data={"path": path, "kind": kind, "diff": diff})

    @classmethod
    def plan(cls, entries: list[dict[str, Any]]) -> "AgentEvent":
        return cls(EventKind.PLAN, data={"entries": entries})

    @classmethod
    def permission_request(cls, request: dict[str, Any]) -> "AgentEvent":
        return cls(EventKind.PERMISSION_REQUEST, data={"request": request})

    @classmethod
    def usage(cls, usage: dict[str, Any]) -> "AgentEvent":
        return cls(EventKind.USAGE, data={"usage": usage})

    @classmethod
    def turn_completed(cls, stop_reason: str | None = None) -> "AgentEvent":
        return cls(EventKind.TURN_COMPLETED, data={"stop_reason": stop_reason})

    @classmethod
    def error(cls, message: str) -> "AgentEvent":
        return cls(EventKind.ERROR, text=message)


@dataclass(slots=True)
class AvailabilityInfo:
    """Result of probing whether a coding agent can be driven on this machine.

    Capability probing degrades gracefully: a missing binary is reported as
    ``installed=False`` with a human ``detail``, never an exception — the
    caller decides whether to surface "install X" or fall back to another
    family. ``logged_in`` is ``None`` when a family exposes no cheap login
    probe (we do not spend a network round-trip to find out).
    """

    family: str
    installed: bool
    command: str | None = None
    version: str | None = None
    logged_in: bool | None = None
    detail: str = ""

    @property
    def ready(self) -> bool:
        """True when the agent is installed (and, if known, logged in)."""
        return self.installed and self.logged_in is not False
