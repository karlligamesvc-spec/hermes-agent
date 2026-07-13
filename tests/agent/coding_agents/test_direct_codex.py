"""Codex Direct provider: app-server thread/turn lifecycle, item normalization,
thread-id round-trip, turn/interrupt cancel, and exec-approval bridging."""

from __future__ import annotations

from typing import Any

from agent.coding_agents import ALLOW_ONCE, DENY, EventKind, ScriptedLineChannel, harness_for


def _reply(mid: Any, result: dict) -> dict:
    return {"id": mid, "result": result}


def _notif(method: str, params: dict) -> dict:
    return {"method": method, "params": params}


def _item(item: dict) -> dict:
    return {"method": "item/completed", "params": {"item": item}}


_APPROVAL = {
    "id": "appr-1",
    "method": "item/commandExecution/requestApproval",
    "params": {"command": "rm -rf build", "cwd": "/tmp"},
}


def make_codex_server(*, approval: bool = False):
    def responder(msg: dict) -> list[dict]:
        method = msg.get("method")
        if method == "initialize":
            return [_reply(msg["id"], {})]
        if method == "initialized":
            return []
        if method == "thread/start":
            return [_reply(msg["id"], {"thread": {"id": "thr-1"}})]
        if method == "turn/start":
            out: list[dict] = [
                _reply(msg["id"], {}),  # ack
                # Real codex (0.130.0) nests the turn: params.turn.{id,status}.
                _notif("turn/started", {"turn": {"id": "turn-1"}}),
                _item({"type": "agentMessage", "id": "m1", "text": "Hi there"}),
            ]
            if approval:
                out.append(_APPROVAL)
            out += [
                _item({"type": "commandExecution", "id": "c1", "command": "ls", "cwd": "/tmp", "exitCode": 0, "aggregatedOutput": "file.txt"}),
                _item({"type": "fileChange", "id": "f1", "status": "completed", "changes": [{"kind": {"type": "add"}, "path": "new.py"}]}),
                _notif("thread/tokenUsage/updated", {"inputTokens": 10, "outputTokens": 4}),
                _notif("turn/completed", {"turn": {"id": "turn-1", "status": "completed"}}),
            ]
            return out
        return []  # turn/interrupt et al.

    return responder


def _harness(responder, **kw):
    return harness_for("codex", "/tmp", channel_factory=lambda: ScriptedLineChannel(responder), **kw)


def test_open_handshake_returns_thread_id() -> None:
    h = _harness(make_codex_server())
    assert h.open() == "thr-1"
    # initialize + initialized + thread/start all went out, in order.
    methods = [m.get("method") for m in h.channel.sent]
    assert methods[:3] == ["initialize", "initialized", "thread/start"]


def test_turn_items_normalize_to_unified_events() -> None:
    h = _harness(make_codex_server())
    h.open()
    events = list(h.prompt("do it"))
    kinds = [e.kind for e in events]
    assert kinds == [
        EventKind.SESSION_STARTED,
        EventKind.AGENT_MESSAGE,
        EventKind.TOOL_CALL,      # commandExecution
        EventKind.TOOL_RESULT,
        EventKind.TOOL_CALL,      # fileChange
        EventKind.FILE_CHANGE,
        EventKind.TOOL_RESULT,
        EventKind.USAGE,
        EventKind.TURN_COMPLETED,
    ]
    assert events[1].text == "Hi there"
    assert events[2].tool_name == "exec_command"
    assert events[3].data["status"] == "completed"
    assert events[5].data["path"] == "new.py" and events[5].data["kind"] == "add"
    assert events[-1].data["stop_reason"] == "completed"


def test_thread_id_round_trips_into_turn_and_interrupt() -> None:
    h = _harness(make_codex_server())
    h.open()
    list(h.prompt("go"))

    turn = next(m for m in h.channel.sent if m.get("method") == "turn/start")
    assert turn["params"]["threadId"] == "thr-1"  # rule 1

    h.cancel()
    interrupt = next(m for m in h.channel.sent if m.get("method") == "turn/interrupt")
    assert interrupt["params"] == {"threadId": "thr-1", "turnId": "turn-1"}


def test_exec_approval_accept() -> None:
    h = _harness(make_codex_server(approval=True), permission_callback=lambda req: ALLOW_ONCE)
    h.open()
    events = list(h.prompt("clean"))
    assert any(e.kind == EventKind.PERMISSION_REQUEST for e in events)
    resp = next(m for m in h.channel.sent if m.get("id") == "appr-1")
    assert resp["result"] == {"decision": "accept"}


def test_exec_approval_default_deny_declines() -> None:
    h = _harness(make_codex_server(approval=True))  # default deny
    h.open()
    list(h.prompt("clean"))
    resp = next(m for m in h.channel.sent if m.get("id") == "appr-1")
    assert resp["result"] == {"decision": "decline"}
