"""hc-1036 证据等级和交付诚实 in every Desktop session.

A cloud agent carries these rules in its config.yaml system prompt (apex-nodes
``agent_behavior_policy.HONESTY_RULES``; apex-nodes CI compares that tuple with this
one). APEX Desktop gets them from this seam, decided by the same Desktop test the
platform tools use, so a cloud container never carries them twice. These tests pin
both Desktop signals, the no-section case, the rules the guards rely on, and that a
real agent's prompt carries the section.
"""

from __future__ import annotations

import pytest

from agent.system_prompt import build_system_prompt
from apex_overlay import honesty_prompt
from hermes_cli import plugins
from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest
from run_agent import AIAgent


@pytest.fixture(autouse=True)
def _not_desktop(monkeypatch, tmp_path):
    monkeypatch.delenv("HERMES_DESKTOP", raising=False)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "apexnodes"))
    from plugins import apexnodes_gateway

    monkeypatch.setattr(apexnodes_gateway, "_managed_provider_entry", lambda: None)


def test_no_desktop_signal_means_no_section():
    assert honesty_prompt.render_section({}) == ""


def test_the_dashboard_spawn_variable_turns_it_on(monkeypatch):
    monkeypatch.setenv("HERMES_DESKTOP", "1")
    assert honesty_prompt.render_section({}) == honesty_prompt.HONESTY_PROMPT


def test_the_messaging_gateway_on_a_signed_in_desktop_gets_it_too(monkeypatch):
    from plugins import apexnodes_gateway

    monkeypatch.setattr(apexnodes_gateway, "_managed_provider_entry", lambda: {"name": "apex-nodes.com"})
    assert honesty_prompt.render_section({}) == honesty_prompt.HONESTY_PROMPT


@pytest.mark.parametrize(
    "rule",
    [
        "官方(权威机构自己发布，你这次真打开过或用户给了原文，旁边写上出处)",
        "自称引用了官方也算二手",
        "✅ 只给官方和一手",
        "写进技能或记忆时也不能",
        "不说「直连抖音」「抖音官方后台」",
        "input_mode 是 text_only",
        "没用上的也列",
        "不自己换模型、换供应商、换配音服务",
        "做不到的直接说做不到",
    ],
)
def test_the_section_says_what_the_guards_rely_on(rule):
    assert rule in honesty_prompt.HONESTY_PROMPT


def test_the_section_fits_its_cap():
    assert len(honesty_prompt.HONESTY_PROMPT) <= honesty_prompt.MAX_CHARS


def _manager_with_seam() -> PluginManager:
    manager = PluginManager()
    manager._discovered = True
    ctx = PluginContext(PluginManifest(name="apex-overlay", key="apex-overlay", source="bundled"), manager)
    assert honesty_prompt.apply(ctx) is True
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


def test_a_new_desktop_session_prompt_carries_the_rules(monkeypatch):
    monkeypatch.setattr(
        "agent.coding_context.build_coding_workspace_block",
        lambda cwd=None: "Workspace (snapshot at session start):\n- Root: /pinned",
    )
    monkeypatch.setattr(plugins, "_plugin_manager", _manager_with_seam())

    off = build_system_prompt(_real_agent("cloud"))
    assert "apex.honesty" not in off and "证据和交付" not in off

    monkeypatch.setenv("HERMES_DESKTOP", "1")
    prompt = build_system_prompt(_real_agent("desktop"))
    assert "## Plugin Context: apex.honesty" in prompt
    assert "✅ 只给官方和一手" in prompt


def test_registering_twice_or_without_a_host_reports_false():
    manager = _manager_with_seam()
    ctx = PluginContext(PluginManifest(name="apex-overlay", key="apex-overlay", source="bundled"), manager)
    assert honesty_prompt.apply(ctx) is False
    assert honesty_prompt.apply(None) is False


def test_plugin_register_applies_the_seam():
    from tests.apex_overlay.conftest import run_plugin_register_with_stubbed_seams

    called = run_plugin_register_with_stubbed_seams("_honesty_prompt_plugin_under_test")
    assert "honesty_prompt" in called
