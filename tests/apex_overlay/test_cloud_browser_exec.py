"""hc-1203: an APEX cloud container keeps browser_exec without ``terminal`` (apex_overlay/cloud_browser_exec.py).

Upstream drops browser_exec from any tool array without ``terminal`` (``model_tools._rewrite_browser_exec``), and
APEX's cloud assistants disable ``terminal``. The hook in that function keeps the tool where
``HERMES_MANAGED_RUNTIME`` is set and nowhere else. Both callers of the gate run for real here: a fresh tool build
(``model_tools.get_tool_definitions``) and a pinned tools[] carried over by
``tools.mcp_tool_agent.restore_agent_tool_prefix``. Every case asserts first what the hook was asked (how many times,
and its verdict), so none can pass on a path that never reached it.
"""
from __future__ import annotations

import sys
import types

import pytest

import model_tools
from apex_overlay import cloud_browser_exec
from tools import mcp_tool_agent
from tools.registry import registry
from toolsets import resolve_toolset

# apex-nodes HOSTED_DISABLED_TOOLSETS: the IM composites carry terminal, disabled_toolsets strips it.
HOSTED_DISABLED = ["terminal", "delegation", "messaging", "homeassistant", "computer_use", "kanban", "a2a"]


def _tool(name: str) -> dict:
    return {"type": "function", "function": {"name": name, "description": "", "parameters": {}}}


def _names(defs: list[dict]) -> set[str]:
    return {d["function"]["name"] for d in defs}


def _set_managed(monkeypatch, value) -> None:
    if value is None:
        monkeypatch.delenv("HERMES_MANAGED_RUNTIME", raising=False)
    else:
        monkeypatch.setenv("HERMES_MANAGED_RUNTIME", value)


@pytest.fixture(autouse=True)
def _browser_harness_present(monkeypatch):
    """browser_exec's check_fn only asks whether browser-harness imports; the gate under test comes after it."""
    monkeypatch.setattr(registry.get_entry("browser_exec"), "check_fn", lambda: True)


@pytest.fixture
def hook_calls(monkeypatch) -> list[bool]:
    """Every verdict the overlay hook gave, in order (the gate imports it at call time, so this is what it runs)."""
    calls: list[bool] = []
    real = cloud_browser_exec.keeps_browser_exec

    def counting() -> bool:
        calls.append(real())
        return calls[-1]

    monkeypatch.setattr(cloud_browser_exec, "keeps_browser_exec", counting)
    return calls


@pytest.mark.parametrize(
    ("value", "kept"),
    [("1", True), ("true", True), ("yes", True), ("on", True), (" TRUE ", True),
     ("0", False), ("false", False), ("", False), (None, False)],
)
def test_a_fresh_tool_build_keeps_browser_exec_only_in_a_cloud_container(monkeypatch, hook_calls, value, kept):
    _set_managed(monkeypatch, value)

    names = _names(model_tools.get_tool_definitions(enabled_toolsets=["browser"], quiet_mode=False))

    assert hook_calls == [kept]
    assert ("browser_exec" in names) is kept
    assert "terminal" not in names


@pytest.mark.parametrize(
    "enabled", [["hermes-feishu"], ["web", "browser", "file", "code_execution"]], ids=["im-composite", "api-server"],
)
def test_the_hosted_toolset_shape_keeps_browser_exec_and_still_strips_terminal(monkeypatch, hook_calls, enabled):
    _set_managed(monkeypatch, "1")

    names = _names(model_tools.get_tool_definitions(
        enabled_toolsets=enabled, disabled_toolsets=HOSTED_DISABLED, quiet_mode=False))

    assert hook_calls == [True]
    assert "browser_exec" in names
    assert not names & set(resolve_toolset("terminal"))


@pytest.mark.parametrize("value", ["1", None], ids=["cloud", "elsewhere"])
def test_a_session_with_terminal_never_asks_the_hook(monkeypatch, hook_calls, value):
    _set_managed(monkeypatch, value)

    names = _names(model_tools.get_tool_definitions(enabled_toolsets=["browser", "terminal"], quiet_mode=False))

    assert hook_calls == []
    assert {"browser_exec", "terminal"} <= names


@pytest.mark.parametrize(
    ("value", "expected"),
    [("1", ["read_file", "browser_exec", "focus_pane"]), (None, ["read_file", "focus_pane"])],
    ids=["cloud", "elsewhere"],
)
def test_a_pinned_browser_exec_is_carried_over_only_in_a_cloud_container(monkeypatch, hook_calls, value, expected):
    """A rebuilt agent (gateway cache eviction, resume in a new process) folds the session's pin back on. A tool it
    did not build itself is carried only past the same session gates (``_drop_gated_carried_tools``); ``terminal``,
    which this session's config disables, never comes back either way."""
    _set_managed(monkeypatch, value)
    monkeypatch.setattr(mcp_tool_agent, "persist_agent_tool_names", lambda agent: None)
    pin = {"version": mcp_tool_agent.tool_pin_version(),
           "tools": [_tool(n) for n in ("read_file", "terminal", "browser_exec", "focus_pane")]}
    agent = types.SimpleNamespace(tools=[_tool("read_file")], valid_tool_names={"read_file"},
                                  enabled_toolsets=["hermes-cli"], disabled_toolsets=["terminal"])

    mcp_tool_agent.restore_agent_tool_prefix(agent, pin)

    assert hook_calls == [value == "1"]
    assert [t["function"]["name"] for t in agent.tools] == expected


@pytest.mark.parametrize("with_vault", [True, False], ids=["vault", "no-vault"])
def test_only_the_terminal_gate_is_skipped(monkeypatch, hook_calls, with_vault):
    """The rewriters after the gate still read the session's real tool set: the vault note rides on browser_exec
    only when browser_vault is there."""
    _set_managed(monkeypatch, "1")
    defs = [_tool("browser_exec")] + ([_tool("browser_vault")] if with_vault else [])

    out = {d["function"]["name"]: d for d in model_tools._apply_dynamic_schemas(defs)}

    assert hook_calls == [True]
    assert set(out) == {"browser_exec"} | ({"browser_vault"} if with_vault else set())
    assert (model_tools._VAULT_NO_PASSWORD_NOTE in out["browser_exec"]["function"]["description"]) is with_vault


def test_a_tree_without_the_overlay_keeps_upstreams_gate(monkeypatch):
    _set_managed(monkeypatch, "1")

    def build() -> set[str]:
        return _names(model_tools.get_tool_definitions(enabled_toolsets=["browser"], quiet_mode=False))

    assert "browser_exec" in build()
    monkeypatch.setitem(sys.modules, "apex_overlay.cloud_browser_exec", None)
    with pytest.raises(ImportError):
        from apex_overlay.cloud_browser_exec import keeps_browser_exec

    assert "browser_exec" not in build()
