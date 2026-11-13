"""hc-1223: a Desktop batch publishes no card for a delete inside the session's task folder.

Two terminal calls in one assistant message are prepared together, before either runs, so the
approval prepared for each guesses where it will start (its ``workdir`` or the session's folder).
A delete inside the task folder from there is not asked about ahead of time; the run checks again
from the folder it really starts in.
"""

from __future__ import annotations

from contextlib import ExitStack
from types import SimpleNamespace

from gateway.session_context import clear_session_vars
from tests.agent.test_terminal_approval_batch import _agent, _call
from tools import approval


def test_desktop_batch_runs_in_folder_deletes_without_a_card(tmp_path, monkeypatch):
    from tools.terminal_scope import reset_terminal_scope, set_terminal_scope
    from tools.terminal_tool_lifecycle import cleanup_vm
    from tui_gateway import server

    task = tmp_path / "home" / "apex" / "EP07"
    (task / "frames_a").mkdir(parents=True)
    (task / "frames_b").mkdir()
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.delenv("HERMES_DESKTOP", raising=False)
    monkeypatch.setenv("HERMES_EXEC_ASK", "1")
    monkeypatch.setenv("TERMINAL_ENV", "local")
    monkeypatch.setenv("TERMINAL_CWD", str(task))
    monkeypatch.setattr("tools.approval_context._get_approval_mode", lambda: "manual")
    monkeypatch.setattr("agent.title_generator.maybe_auto_title", lambda *a, **kw: None)
    key = "desktop-task-folder-batch"
    agent = _agent()
    agent._flush_messages_to_session_db = lambda *a, **kw: True
    cards = []

    def deny(data):  # a card here is the failure: answer it at once so the batch does not wait
        cards.append(data["command"])
        approval.resolve_gateway_approval(key, "deny", request_id=data["request_id"])

    approval.register_gateway_notify(key, deny)
    monkeypatch.setattr(server, "_sessions", {key: {
        "session_key": key, "source": "desktop", "agent": agent, "cwd": str(task),
    }})
    tokens = server._set_session_context(key)
    messages = []
    with ExitStack() as scope:
        scope.callback(reset_terminal_scope, set_terminal_scope({"TERMINAL_ENV": "local", "TERMINAL_CWD": str(task)}))
        try:
            agent._execute_tool_calls(SimpleNamespace(tool_calls=[
                _call("first", "rm -rf frames_a"), _call("second", "rm -rf frames_b && echo cleared")]), messages, key)
        finally:
            approval.unregister_gateway_notify(key)
            cleanup_vm(key)
            clear_session_vars(tokens)
    assert cards == []
    assert not (task / "frames_a").exists() and not (task / "frames_b").exists()
    assert "cleared" in messages[-1]["content"]
