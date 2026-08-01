"""Tests for _append_model_switch_marker role fix (issue #48338).

The model switch marker must NOT use role="system" because strict providers
(vLLM, Qwen) reject system messages that appear mid-conversation. Using
role="user" is safe — the system prompt is prepended to the API message list,
so a user-role marker can appear at any later position, and the gateway's
sanitize/merge pass already coalesces consecutive user messages.
"""

from __future__ import annotations

import threading
from types import SimpleNamespace
from unittest.mock import MagicMock

from tui_gateway.server import _append_model_switch_marker


class TestAppendModelSwitchMarkerRole:
    """Verify the marker uses role='user', not role='system'."""

    def test_marker_uses_user_role(self) -> None:
        """The history entry must be role='user', not role='system'."""
        session: dict = {"session_key": "test-session", "history": []}
        _append_model_switch_marker(session, model="gpt-4o", provider="openai")
        assert len(session["history"]) == 1
        entry = session["history"][0]
        assert entry["role"] == "user", (
            f"Expected role='user' but got role='{entry['role']}'. "
            "Strict providers (vLLM, Qwen) reject mid-conversation system messages."
        )

    def test_marker_content_preserved(self) -> None:
        """The marker content must still describe the model switch."""
        session: dict = {"session_key": "s", "history": []}
        _append_model_switch_marker(session, model="qwen3.6-35b", provider="vllm")
        content = session["history"][0]["content"]
        assert "qwen3.6-35b" in content
        assert "vllm" in content
        assert "model" in content.lower()

    def test_marker_with_empty_provider(self) -> None:
        """Provider part should be omitted when provider is empty."""
        session: dict = {"session_key": "s", "history": []}
        _append_model_switch_marker(session, model="claude-sonnet-4", provider="")
        content = session["history"][0]["content"]
        assert "claude-sonnet-4" in content
        assert "via provider" not in content

    def test_marker_with_lock(self) -> None:
        """Marker should work correctly when session has a history_lock."""
        session: dict = {
            "session_key": "s",
            "history": [],
            "history_lock": threading.Lock(),
        }
        _append_model_switch_marker(session, model="gpt-4o", provider="openai")
        assert len(session["history"]) == 1
        assert session["history"][0]["role"] == "user"

    def test_marker_increments_history_version(self) -> None:
        """history_version should be incremented after appending."""
        session: dict = {"session_key": "s", "history": [], "history_version": 5}
        _append_model_switch_marker(session, model="gpt-4o", provider="openai")
        assert session["history_version"] == 6

    def test_no_marker_for_none_session(self) -> None:
        """None session should be a no-op."""
        _append_model_switch_marker(None, model="gpt-4o", provider="openai")

    def test_no_marker_for_empty_session_key(self) -> None:
        """Empty session_key should be a no-op."""
        session: dict = {"session_key": "", "history": []}
        _append_model_switch_marker(session, model="gpt-4o", provider="openai")
        assert len(session["history"]) == 0

    def test_marker_not_mid_history_system_after_turns(self) -> None:
        """The marker appended after real turns must not be a system role.

        Reproduces the #48338 shape: a switch mid-conversation must not inject
        a second system message after user/assistant turns, which strict
        OpenAI-compatible providers reject.
        """
        db = MagicMock()
        session: dict = {
            "session_key": "sess-1",
            "history": [
                {"role": "user", "content": "hello"},
                {"role": "assistant", "content": "hi"},
            ],
            "history_version": 7,
            "agent": SimpleNamespace(_session_db=db),
        }
        _append_model_switch_marker(
            session, model="qwen3.6-35b", provider="vllm"
        )
        marker = session["history"][-1]
        assert marker["role"] == "user"
        assert session["history_version"] == 8
        # The persisted row must mirror the in-memory role.
        db.append_message.assert_called_once_with(
            session_id="sess-1",
            role="user",
            content=marker["content"],
        )


class TestNoOpSwitchIsNotAPivot:
    """hc-652: a re-click on the model already in use must not append a marker.

    The marker's own text says the active model *has changed*. Emitting it when
    it did not makes the history state something untrue, and it does so in a
    ``user`` turn the model re-reads on every subsequent request of that
    session. A real desktop session carried 14 markers against 5 messages the
    user actually typed; three came from consecutive
    ``deepseek-v4-flash -> deepseek-v4-flash`` switches on one provider.
    """

    def test_same_model_and_provider_appends_nothing(self) -> None:
        session: dict = {"session_key": "s", "history": []}
        _append_model_switch_marker(
            session,
            model="deepseek-v4-flash",
            provider="custom:apex-nodes.com",
            previous_model="deepseek-v4-flash",
            previous_provider="custom:apex-nodes.com",
        )
        assert session["history"] == []

    def test_repeated_no_op_switches_do_not_accumulate(self) -> None:
        """The observed shape: three picker re-clicks in ~10 seconds."""
        session: dict = {"session_key": "s", "history": []}
        for _ in range(3):
            _append_model_switch_marker(
                session,
                model="deepseek-v4-flash",
                provider="custom:apex-nodes.com",
                previous_model="deepseek-v4-flash",
                previous_provider="custom:apex-nodes.com",
            )
        assert session["history"] == []

    def test_same_model_different_provider_still_marks(self) -> None:
        """The first switch in the real session WAS a pivot: custom -> custom:apex-nodes.com."""
        session: dict = {"session_key": "s", "history": []}
        _append_model_switch_marker(
            session,
            model="deepseek-v4-flash",
            provider="custom:apex-nodes.com",
            previous_model="deepseek-v4-flash",
            previous_provider="custom",
        )
        assert len(session["history"]) == 1
        assert "custom:apex-nodes.com" in session["history"][0]["content"]

    def test_different_model_same_provider_still_marks(self) -> None:
        session: dict = {"session_key": "s", "history": []}
        _append_model_switch_marker(
            session,
            model="kimi-k2.6",
            provider="custom:apex-nodes.com",
            previous_model="deepseek-v4-flash",
            previous_provider="custom:apex-nodes.com",
        )
        assert len(session["history"]) == 1
        assert "kimi-k2.6" in session["history"][0]["content"]

    def test_unknown_previous_state_keeps_marking(self) -> None:
        """Fail OPEN: a caller that cannot say what it was on gets the marker.

        Suppressing on an unknown prior state would silently drop real pivots,
        which is the worse failure -- the model would answer "what model are
        you?" from stale metadata.
        """
        session: dict = {"session_key": "s", "history": []}
        _append_model_switch_marker(session, model="gpt-4o", provider="openai")
        assert len(session["history"]) == 1

    def test_whitespace_and_none_do_not_defeat_the_guard(self) -> None:
        session: dict = {"session_key": "s", "history": []}
        _append_model_switch_marker(
            session,
            model=" deepseek-v4-flash ",
            provider=None,
            previous_model="deepseek-v4-flash",
            previous_provider=None,
        )
        assert session["history"] == []
