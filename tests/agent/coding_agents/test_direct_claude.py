"""Claude Code Direct provider: stream-json normalization + --resume round-trip."""

from __future__ import annotations

from agent.coding_agents import EventKind, ScriptedLineChannel, harness_for

STREAM = [
    {"type": "system", "subtype": "init", "session_id": "claude-abc", "tools": ["Read", "Edit"]},
    {
        "type": "assistant",
        "message": {
            "content": [
                {"type": "text", "text": "Reading the file"},
                {"type": "tool_use", "id": "tu1", "name": "Read", "input": {"path": "x.py"}},
            ]
        },
    },
    {
        "type": "user",
        "message": {
            "content": [
                {"type": "tool_result", "tool_use_id": "tu1", "content": "print(1)", "is_error": False}
            ]
        },
    },
    {
        "type": "result",
        "subtype": "success",
        "session_id": "claude-abc",
        "result": "Done",
        "usage": {"input_tokens": 12, "output_tokens": 3},
        "total_cost_usd": 0.004,
        "is_error": False,
    },
]


def _harness(stream):
    return harness_for("claude", "/tmp", channel_factory=lambda: ScriptedLineChannel(initial=list(stream)))


def test_stream_json_normalizes_to_unified_events() -> None:
    h = _harness(STREAM)
    events = list(h.prompt("read x.py"))
    kinds = [e.kind for e in events]
    assert kinds == [
        EventKind.SESSION_STARTED,
        EventKind.AGENT_MESSAGE,
        EventKind.TOOL_CALL,
        EventKind.TOOL_RESULT,
        EventKind.USAGE,
        EventKind.TURN_COMPLETED,
    ]
    assert events[0].session_id == "claude-abc"
    assert events[1].text == "Reading the file"
    assert events[2].tool_name == "Read" and events[2].tool_call_id == "tu1"
    assert events[3].tool_call_id == "tu1" and events[3].data["status"] == "completed"
    assert events[4].data["usage"]["usage"]["input_tokens"] == 12
    assert events[-1].data["stop_reason"] == "success"


def test_session_id_captured_and_round_trips_via_resume() -> None:
    h = _harness(STREAM)
    # Before any turn: no resume flag.
    assert h._build_prompt_args("hi") == ["-p", "hi"]

    list(h.prompt("first"))
    assert h.session_id == "claude-abc"  # captured from the stream

    # Next turn resumes the exact captured id (rule 1).
    assert h._build_prompt_args("again") == ["-p", "again", "--resume", "claude-abc"]


def test_tool_result_error_maps_to_failed() -> None:
    stream = [
        {"type": "system", "subtype": "init", "session_id": "s"},
        {"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "t9", "content": "boom", "is_error": True}
        ]}},
        {"type": "result", "subtype": "success", "session_id": "s", "is_error": False},
    ]
    h = _harness(stream)
    events = list(h.prompt("x"))
    tr = next(e for e in events if e.kind == EventKind.TOOL_RESULT)
    assert tr.data["status"] == "failed"


def test_error_result_emits_error_event() -> None:
    stream = [
        {"type": "system", "subtype": "init", "session_id": "s"},
        {"type": "result", "subtype": "error_max_turns", "session_id": "s", "result": "hit limit", "is_error": True},
    ]
    h = _harness(stream)
    events = list(h.prompt("x"))
    assert any(e.kind == EventKind.ERROR for e in events)
    assert events[-1].kind == EventKind.TURN_COMPLETED
    assert events[-1].data["stop_reason"] == "error_max_turns"
