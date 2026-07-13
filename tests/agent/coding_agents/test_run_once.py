"""Deterministic tests for the hc-533 one-shot AcpHarness runner.

The reducer and job parser are pure; the end-to-end ``run_job`` path is driven
with a scripted in-memory channel (no real ``claude`` process, no threads) —
same double the hc-524 direct-provider tests use — so "claude 一族跑通" is
proven deterministically here rather than only on a real machine.
"""

from __future__ import annotations

import pytest

from agent.coding_agents import AgentEvent, EventKind, ScriptedLineChannel
from agent.coding_agents.run_once import (
    SUPPORTED_FAMILIES,
    parse_job,
    reduce_events,
    run_job,
)

# --- reduce_events: the pure fold ------------------------------------------

CLEAN_TURN = [
    AgentEvent.session_started("claude-1"),
    AgentEvent.message("Read the file"),
    AgentEvent.message("Fixed the bug"),
    AgentEvent.turn_completed("success"),
]

PERMISSION_TURN = [
    AgentEvent.session_started("cursor-9"),
    AgentEvent.message("I need to delete build/"),
    AgentEvent.permission_request({"title": "rm -rf build/", "tool": "shell"}),
    AgentEvent.turn_completed("stopped"),
]

ERROR_ONLY_TURN = [
    AgentEvent.session_started("s"),
    AgentEvent.error("hit token limit"),
    AgentEvent.turn_completed("error_max_turns"),
]

ERROR_WITH_OUTPUT_TURN = [
    AgentEvent.message("Partial answer"),
    AgentEvent.error("a non-fatal warning"),
    AgentEvent.turn_completed("success"),
]


@pytest.mark.parametrize(
    "events, expected_status, expected_output, expected_perm, expected_session",
    [
        (CLEAN_TURN, "done", "Read the file\nFixed the bug", False, "claude-1"),
        (PERMISSION_TURN, "failed", "I need to delete build/", True, "cursor-9"),
        (ERROR_ONLY_TURN, "failed", "", False, "s"),
        # Output present + a late error → still a completed run (partial success).
        (ERROR_WITH_OUTPUT_TURN, "done", "Partial answer", False, ""),
        ([], "done", "", False, ""),
    ],
)
def test_reduce_events_folds_stream(
    events, expected_status, expected_output, expected_perm, expected_session
) -> None:
    result = reduce_events(events, family="claude")
    assert result["status"] == expected_status
    assert result["output"] == expected_output
    assert result["permission_required"] is expected_perm
    assert result["session_id"] == expected_session
    assert result["family"] == "claude"


def test_reduce_events_captures_permission_summary() -> None:
    result = reduce_events(PERMISSION_TURN, family="cursor")
    assert result["permission_required"] is True
    assert result["permission_summary"] == "rm -rf build/"
    # Contract: v1 surfaces the gate, never auto-approves — the status is failed
    # so the cloud asks the owner to approve on Desktop.
    assert result["status"] == "failed"


def test_reduce_events_retains_error_text() -> None:
    assert reduce_events(ERROR_ONLY_TURN, family="claude")["error"] == "hit token limit"


# --- parse_job: validation gate --------------------------------------------


def test_parse_job_valid() -> None:
    assert parse_job({"family": "claude", "prompt": "fix it", "cwd": "/repo"}) == (
        "claude",
        "fix it",
        "/repo",
    )


def test_parse_job_accepts_agent_family_alias_and_omits_cwd() -> None:
    # The cloud payload names the field ``agent_family``; a blank cwd → None.
    assert parse_job({"agent_family": "codex", "prompt": "go", "cwd": "  "}) == (
        "codex",
        "go",
        None,
    )


@pytest.mark.parametrize(
    "payload, message_fragment",
    [
        ("not-a-dict", "job must be a JSON object"),
        ({"prompt": "x"}, "missing agent family"),
        ({"family": "codebuddy", "prompt": "x"}, "unsupported agent family"),
        ({"family": "nope", "prompt": "x"}, "unsupported agent family"),
        ({"family": "claude"}, "missing prompt"),
        ({"family": "claude", "prompt": "   "}, "missing prompt"),
    ],
)
def test_parse_job_rejects(payload, message_fragment) -> None:
    with pytest.raises(ValueError) as excinfo:
        parse_job(payload)
    assert message_fragment in str(excinfo.value)


def test_supported_families_is_first_wave_and_excludes_codebuddy() -> None:
    assert SUPPORTED_FAMILIES == ("claude", "codex", "cursor")
    assert "codebuddy" not in SUPPORTED_FAMILIES


# --- run_job: end-to-end drive over a scripted channel ---------------------

_CLAUDE_STREAM = [
    {"type": "system", "subtype": "init", "session_id": "claude-run", "tools": ["Read"]},
    {"type": "assistant", "message": {"content": [{"type": "text", "text": "All done"}]}},
    {
        "type": "result",
        "subtype": "success",
        "session_id": "claude-run",
        "result": "All done",
        "usage": {"input_tokens": 5, "output_tokens": 2},
        "is_error": False,
    },
]


def _scripted_claude(monkeypatch, stream):
    """Patch harness_for so run_job drives claude over an in-memory channel."""
    from agent.coding_agents import harness_for as real_harness_for
    from agent.coding_agents import run_once

    def fake_harness_for(family, cwd=None, **kwargs):
        return real_harness_for(
            family, cwd, channel_factory=lambda: ScriptedLineChannel(initial=list(stream))
        )

    monkeypatch.setattr(run_once, "harness_for", fake_harness_for)


def test_run_job_drives_claude_to_done(monkeypatch) -> None:
    _scripted_claude(monkeypatch, _CLAUDE_STREAM)
    result = run_job({"family": "claude", "prompt": "read x.py", "cwd": "/tmp"})
    assert result["status"] == "done"
    assert result["output"] == "All done"
    assert result["session_id"] == "claude-run"
    assert result["permission_required"] is False
    assert result["family"] == "claude"


def test_run_job_unsupported_family_fails_cleanly() -> None:
    result = run_job({"family": "codebuddy", "prompt": "x"})
    assert result["status"] == "failed"
    assert result["error"] == "invalid_job"
    assert "unsupported agent family" in result["detail"]


def test_run_job_missing_binary_reports_agent_not_available(monkeypatch) -> None:
    from agent.coding_agents import run_once

    class _Boom:
        def open(self):
            raise RuntimeError("could not launch Claude Code ('claude' not found).")

        def prompt(self, text):  # pragma: no cover - open() raises first
            return iter(())

        def close(self):
            pass

    monkeypatch.setattr(run_once, "harness_for", lambda *a, **k: _Boom())
    result = run_job({"family": "claude", "prompt": "hi"})
    assert result["status"] == "failed"
    assert result["error"] == "agent_not_available"
    assert "not found" in result["detail"]
