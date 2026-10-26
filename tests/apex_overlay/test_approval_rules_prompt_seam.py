"""hc-1034: a new session's prompt tells the agent how to check the machine and what to do when
approval does not come, whenever approvals are on.

The engine lets a one-line read-only probe through and holds equivalent operations after a
refusal or a silent timeout; the prompt section is how the model learns the shape of a probe that
needs no click, and that it should stop and say what is waiting. These tests pin the rules, the
mode switch (approvals off: no section), and that a real agent's prompt carries it.
"""

from __future__ import annotations

import pytest

from agent.system_prompt import build_system_prompt
from apex_overlay import approval_rules_prompt
from hermes_cli import plugins
from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest
from run_agent import AIAgent
from tools import approval_context
from tools.approval_probe import is_readonly_probe


@pytest.fixture(autouse=True)
def _isolated_home(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "apexnodes"))


@pytest.mark.parametrize(("mode", "shown"), [("manual", True), ("smart", True), ("off", False)])
def test_the_section_follows_the_approval_mode(monkeypatch, mode, shown):
    monkeypatch.setattr(approval_context, "_get_approval_mode", lambda: mode)
    rendered = approval_rules_prompt.render_section({})
    assert (rendered == approval_rules_prompt.APPROVAL_RULES_PROMPT) is shown
    assert (rendered == "") is not shown


def test_an_unreadable_mode_keeps_the_rules(monkeypatch):
    def boom():
        raise RuntimeError("config unreadable")

    monkeypatch.setattr(approval_context, "_get_approval_mode", boom)
    assert approval_rules_prompt.render_section({}) == approval_rules_prompt.APPROVAL_RULES_PROMPT


@pytest.mark.parametrize(
    "rule",
    [
        "一次只发一条简单命令",
        "不用等用户批准",
        "管道、重定向、`;`、`&&` 或循环",
        "不要换工具、换写法或写成脚本去做同一件事",
        "用一句白话告诉用户在等他批准什么、为什么",
    ],
)
def test_the_section_says_what_the_gates_rely_on(rule):
    assert rule in approval_rules_prompt.APPROVAL_RULES_PROMPT


def test_the_examples_are_probes_the_engine_lets_through():
    assert is_readonly_probe('python3 -c "import PIL; print(PIL.__version__)"')
    assert '`python3 -c "import PIL; print(PIL.__version__)"`' in approval_rules_prompt.APPROVAL_RULES_PROMPT


def test_the_section_fits_its_cap():
    assert len(approval_rules_prompt.APPROVAL_RULES_PROMPT) <= approval_rules_prompt.MAX_CHARS


def _manager_with_seam() -> PluginManager:
    manager = PluginManager()
    manager._discovered = True
    ctx = PluginContext(PluginManifest(name="apex-overlay", key="apex-overlay", source="bundled"), manager)
    assert approval_rules_prompt.apply(ctx) is True
    return manager


def _real_agent(session_id: str) -> AIAgent:
    return AIAgent(
        api_key="test-key",
        base_url="https://openrouter.ai/api/v1",
        model="test/model",
        provider="openrouter",
        platform="cli",
        quiet_mode=True,
        skip_context_files=True,
        skip_memory=True,
        session_id=session_id,
    )


def test_a_new_session_prompt_carries_the_rules_unless_approvals_are_off(monkeypatch):
    monkeypatch.setattr(
        "agent.coding_context.build_coding_workspace_block",
        lambda cwd=None: "Workspace (snapshot at session start):\n- Root: /pinned",
    )
    monkeypatch.setattr(plugins, "_plugin_manager", _manager_with_seam())

    monkeypatch.setattr(approval_context, "_get_approval_mode", lambda: "manual")
    prompt = build_system_prompt(_real_agent("approvals-manual"))
    assert "## Plugin Context: apex.approval-rules" in prompt
    assert "不要换工具、换写法或写成脚本去做同一件事" in prompt

    monkeypatch.setattr(approval_context, "_get_approval_mode", lambda: "off")
    off = build_system_prompt(_real_agent("approvals-off"))
    assert "apex.approval-rules" not in off


def test_registering_twice_or_without_a_host_reports_false():
    manager = _manager_with_seam()
    ctx = PluginContext(PluginManifest(name="apex-overlay", key="apex-overlay", source="bundled"), manager)
    assert approval_rules_prompt.apply(ctx) is False
    assert approval_rules_prompt.apply(None) is False


def test_plugin_register_applies_the_seam():
    from tests.apex_overlay.conftest import run_plugin_register_with_stubbed_seams

    called = run_plugin_register_with_stubbed_seams("_approval_rules_prompt_plugin_under_test")
    assert "approval_rules_prompt" in called
