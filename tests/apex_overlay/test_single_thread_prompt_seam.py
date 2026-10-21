"""hc-1015 「只有问题和回复」: how APEX talks while single-thread mode is on.

Desktop's main process sets ``APEX_SINGLE_THREAD_ACTIVE=1`` at launch when
single-thread mode is on (hc-1014's platform flag or this install's own
switch); it is main's output, never a user setting. The apex-overlay seam
then adds a fixed section to every new local session's system prompt. These
tests pin the switch, the rules the chat relies on, that a real agent's prompt
carries them, and that with the switch off the prompt is what it was.
"""

from __future__ import annotations

import pytest

from agent.system_prompt import build_system_prompt
from apex_overlay import single_thread_prompt
from hermes_cli import plugins
from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest
from run_agent import AIAgent


@pytest.fixture(autouse=True)
def _no_switch(monkeypatch, tmp_path):
    monkeypatch.delenv(single_thread_prompt.SWITCH_ENV, raising=False)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "apexnodes"))


@pytest.mark.parametrize(
    ("value", "on"),
    [("1", True), (" 1 ", True), ("true", False), ("on", False), ("0", False), ("", False), ("2", False)],
)
def test_the_switch_is_the_launch_variable(monkeypatch, value, on):
    monkeypatch.setenv(single_thread_prompt.SWITCH_ENV, value)
    assert single_thread_prompt.switch_on() is on
    assert (single_thread_prompt.render_section({}) == single_thread_prompt.SINGLE_THREAD_PROMPT) is on
    assert (single_thread_prompt.render_section({}) == "") is not on


def test_no_variable_means_no_section():
    assert single_thread_prompt.render_section({}) == ""


@pytest.mark.parametrize(
    "rule",
    [
        "你叫 APEX",
        "把这个名字记进记忆",
        "不说工具名、技能名、模型名",
        "不报「第几步」",
        "一次最多问一个问题，并给出你的默认做法",
        "不提模型、档位和思考了多久",
        "删文件、花钱、对外发布、改系统设置这类操作照常先问，不能跳过",
    ],
)
def test_the_section_says_what_the_chat_relies_on(rule):
    assert rule in single_thread_prompt.SINGLE_THREAD_PROMPT


def test_the_section_fits_its_cap():
    assert len(single_thread_prompt.SINGLE_THREAD_PROMPT) <= single_thread_prompt.MAX_CHARS


def _manager_with_seam() -> PluginManager:
    manager = PluginManager()
    manager._discovered = True
    ctx = PluginContext(PluginManifest(name="apex-overlay", key="apex-overlay", source="bundled"), manager)
    assert single_thread_prompt.apply(ctx) is True
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


def test_a_new_session_prompt_carries_the_rules_only_with_the_switch_on(monkeypatch):
    monkeypatch.setattr(
        "agent.coding_context.build_coding_workspace_block",
        lambda cwd=None: "Workspace (snapshot at session start):\n- Root: /pinned",
    )
    monkeypatch.setattr(plugins, "_plugin_manager", _manager_with_seam())

    off = build_system_prompt(_real_agent("switch-off"))
    assert "apex.single-thread" not in off
    assert "APEX 怎么说话" not in off

    monkeypatch.setenv(single_thread_prompt.SWITCH_ENV, "1")
    prompt = build_system_prompt(_real_agent("switch-on"))
    assert "## Plugin Context: apex.single-thread" in prompt
    assert "不说工具名、技能名、模型名" in prompt
    assert "你叫 APEX" in prompt


def test_registering_twice_or_without_a_host_reports_false():
    manager = _manager_with_seam()
    ctx = PluginContext(PluginManifest(name="apex-overlay", key="apex-overlay", source="bundled"), manager)
    assert single_thread_prompt.apply(ctx) is False
    assert single_thread_prompt.apply(None) is False


def test_plugin_register_applies_the_seam():
    from tests.apex_overlay.conftest import run_plugin_register_with_stubbed_seams

    called = run_plugin_register_with_stubbed_seams("_single_thread_prompt_plugin_under_test")
    assert "single_thread_prompt" in called
