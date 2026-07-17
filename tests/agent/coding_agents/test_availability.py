"""Capability probing: missing agents degrade gracefully, never raise.

The ``shutil.which`` stubs take ``**_kw`` because hc-544 makes ``_which`` pass a
``path=`` (the user-bin-augmented search PATH); the stubs ignore it and keep
asserting the same installed/degraded outcomes.
"""

from __future__ import annotations

import agent.coding_agents.direct as direct_mod
from agent.coding_agents import harness_for, probe_all


def test_missing_acp_agent_reports_not_installed(monkeypatch) -> None:
    monkeypatch.setattr("shutil.which", lambda _cmd, **_kw: None)
    info = harness_for("cursor").availability()
    assert info.installed is False
    assert info.ready is False
    assert "cursor" in info.detail.lower() or "curl" in info.detail.lower()


def test_present_acp_agent_reports_installed(monkeypatch) -> None:
    monkeypatch.setattr("shutil.which", lambda _cmd, **_kw: "/usr/local/bin/cursor-agent")
    info = harness_for("cursor").availability()
    assert info.installed is True
    assert info.ready is True
    assert info.command == "/usr/local/bin/cursor-agent"


def test_claude_availability_reads_version(monkeypatch) -> None:
    monkeypatch.setattr("shutil.which", lambda _cmd, **_kw: "/usr/local/bin/claude")
    monkeypatch.setattr(direct_mod, "_probe_version", lambda _argv: "2.1.3 (Claude Code)")
    info = harness_for("claude").availability()
    assert info.installed is True
    assert info.version == "2.1.3 (Claude Code)"
    # login is not cheaply probed -> unknown, but that doesn't block readiness.
    assert info.logged_in is None
    assert info.ready is True


def test_claude_missing_degrades(monkeypatch) -> None:
    monkeypatch.setattr("shutil.which", lambda _cmd, **_kw: None)
    info = harness_for("claude").availability()
    assert info.installed is False
    assert info.ready is False


def test_codex_availability_uses_check_codex_binary(monkeypatch) -> None:
    import agent.transports.codex_app_server as codex_mod

    monkeypatch.setattr(codex_mod, "check_codex_binary", lambda _bin: (True, "0.130.0"))
    monkeypatch.setattr("shutil.which", lambda _cmd, **_kw: "/usr/local/bin/codex")
    info = harness_for("codex").availability()
    assert info.installed is True
    assert info.version == "0.130.0"


def test_codex_missing_binary_degrades(monkeypatch) -> None:
    import agent.transports.codex_app_server as codex_mod

    monkeypatch.setattr(codex_mod, "check_codex_binary", lambda _bin: (False, "codex CLI not found"))
    info = harness_for("codex").availability()
    assert info.installed is False
    assert "not found" in info.detail


def test_probe_all_covers_launchable_families_without_raising(monkeypatch) -> None:
    import agent.transports.codex_app_server as codex_mod

    monkeypatch.setattr("shutil.which", lambda _cmd, **_kw: None)
    monkeypatch.setattr(codex_mod, "check_codex_binary", lambda _bin: (False, "missing"))
    result = probe_all()
    assert set(result) == {"claude", "codex", "cursor"}  # not parked codebuddy
    assert all(info.installed is False for info in result.values())
