"""ACP harness state machine: initialize -> session/new -> prompt -> cancel,
event normalization, session-id round-trip, and permission bridging.

Driven against a scripted in-memory ACP server (no process, no threads).
"""

from __future__ import annotations

from typing import Any

import pytest

from agent.coding_agents import (
    ALLOW_ONCE,
    DENY,
    AgentEvent,
    EventKind,
    ScriptedLineChannel,
    harness_for,
)


def _reply(mid: Any, result: dict) -> dict:
    return {"jsonrpc": "2.0", "id": mid, "result": result}


def _notif(update: dict) -> dict:
    return {"jsonrpc": "2.0", "method": "session/update", "params": {"update": update}}


_PERM_REQUEST = {
    "jsonrpc": "2.0",
    "id": "perm-1",
    "method": "session/request_permission",
    "params": {
        "options": [
            {"optionId": "opt-allow", "kind": "allow_once", "name": "Allow once"},
            {"optionId": "opt-deny", "kind": "reject_once", "name": "Deny"},
        ],
        "toolCall": {"title": "run tests", "kind": "execute"},
    },
}


def make_acp_server(*, permission: bool = False):
    """A scripted ACP agent: returns the inbound messages for each outbound."""

    def responder(msg: dict) -> list[dict]:
        method = msg.get("method")
        if method == "initialize":
            return [_reply(msg["id"], {"protocolVersion": 1, "agentCapabilities": {}})]
        if method == "session/new":
            return [_reply(msg["id"], {"sessionId": "sess-1"})]
        if method == "session/prompt":
            out: list[dict] = []
            if permission:
                out.append(_PERM_REQUEST)
            out += [
                _notif({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Hello"}}),
                _notif({"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "pondering"}}),
                _notif({"sessionUpdate": "tool_call", "toolCallId": "tc1", "title": "Read", "kind": "read", "rawInput": {"path": "x.py"}}),
                _notif({"sessionUpdate": "tool_call_update", "toolCallId": "tc1", "status": "completed", "content": [{"type": "diff", "path": "x.py", "newText": "print(1)"}]}),
            ]
            out.append(_reply(msg["id"], {"stopReason": "end_turn"}))
            return out
        # session/cancel notification and permission responses: nothing back.
        return []

    return responder


def _make_harness(responder, **kw):
    return harness_for("cursor", "/tmp", channel_factory=lambda: ScriptedLineChannel(responder), **kw)


def test_open_returns_session_id_from_session_new() -> None:
    h = _make_harness(make_acp_server())
    assert h.open() == "sess-1"
    assert h.session_id == "sess-1"


def test_initialize_conformance_shape() -> None:
    h = _make_harness(make_acp_server())
    h.open()
    init = next(m for m in h.channel.sent if m.get("method") == "initialize")
    params = init["params"]
    assert params["protocolVersion"] == 1
    # We advertise NO client-side fs capability (§4: agent uses its own fs).
    assert params["clientCapabilities"]["fs"]["readTextFile"] is False
    assert params["clientCapabilities"]["fs"]["writeTextFile"] is False
    assert params["clientInfo"]["name"]


def test_prompt_normalizes_event_stream_in_order() -> None:
    h = _make_harness(make_acp_server())
    h.open()
    events = list(h.prompt("run the tests"))
    kinds = [e.kind for e in events]
    assert kinds == [
        EventKind.SESSION_STARTED,
        EventKind.AGENT_MESSAGE,
        EventKind.AGENT_THOUGHT,
        EventKind.TOOL_CALL,
        EventKind.TOOL_RESULT,
        EventKind.FILE_CHANGE,
        EventKind.TURN_COMPLETED,
    ]
    assert events[0].session_id == "sess-1"
    assert events[1].text == "Hello"
    assert events[2].text == "pondering"
    assert events[3].tool_name == "Read" and events[3].tool_call_id == "tc1"
    assert events[4].data["status"] == "completed"
    assert events[5].data["path"] == "x.py"
    assert events[-1].data["stop_reason"] == "end_turn"


def test_session_id_round_trips_into_prompt_and_cancel() -> None:
    h = _make_harness(make_acp_server())
    h.open()
    list(h.prompt("hi"))
    prompt_msg = next(m for m in h.channel.sent if m.get("method") == "session/prompt")
    # The id from session/new is exactly the id used to prompt (rule 1).
    assert prompt_msg["params"]["sessionId"] == "sess-1"

    h.cancel()
    cancel_msg = next(m for m in h.channel.sent if m.get("method") == "session/cancel")
    assert cancel_msg["params"]["sessionId"] == "sess-1"
    assert "id" not in cancel_msg  # cancel is a notification


def test_permission_allow_selects_option_and_emits_event() -> None:
    seen: list[dict] = []

    def cb(request: dict) -> str:
        seen.append(request)
        return ALLOW_ONCE

    h = _make_harness(make_acp_server(permission=True), permission_callback=cb)
    h.open()
    events = list(h.prompt("touch a file"))

    # The callback saw the request, and a PERMISSION_REQUEST event surfaced.
    assert len(seen) == 1
    assert any(e.kind == EventKind.PERMISSION_REQUEST for e in events)

    resp = next(m for m in h.channel.sent if m.get("id") == "perm-1")
    assert resp["result"]["outcome"] == {"outcome": "selected", "optionId": "opt-allow"}


def test_permission_default_deny_cancels() -> None:
    # No callback -> default deny.
    h = _make_harness(make_acp_server(permission=True))
    h.open()
    list(h.prompt("rm -rf"))
    resp = next(m for m in h.channel.sent if m.get("id") == "perm-1")
    assert resp["result"]["outcome"] == {"outcome": "cancelled"}


def test_early_process_exit_yields_error(monkeypatch) -> None:
    responder = make_acp_server()
    channel = ScriptedLineChannel(responder)

    h = harness_for("cursor", "/tmp", channel_factory=lambda: channel)
    h.open()
    # Simulate the child dying before the prompt reply arrives.
    channel.set_exit(1)

    def empty_responder(_msg):
        return []

    channel._responder = empty_responder  # prompt gets no reply, only the exit
    events = list(h.prompt("hi"))
    assert events[0].kind == EventKind.SESSION_STARTED
    assert any(e.kind == EventKind.ERROR for e in events)
