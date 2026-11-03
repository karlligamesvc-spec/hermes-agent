"""hc-1131: in product mode's chat, replies deliver files as cards instead of writing local paths.

test_result_delivery_prompt_identity.py pins every surface's whole prompt against a golden from clean main. These
tests pin the rule itself: which sessions get it, what it allows, that the marker Desktop writes is the one it
reads, and that it never pushes another section out of the prompt budget.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from agent.system_prompt import build_system_prompt
from apex_overlay import (
    approval_rules_prompt,
    desktop_version,
    handoff,
    honesty_prompt,
    memory_ledger,
    proactive_prompt,
    result_delivery_prompt,
    single_thread_prompt,
    user_profile_prompt,
)
from hermes_cli import plugins
from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest
from run_agent import AIAgent

PROMPT = result_delivery_prompt.RESULT_DELIVERY_PROMPT
DESKTOP = {"platform": "desktop"}


@pytest.fixture
def root(tmp_path, monkeypatch):
    home = tmp_path / "apexnodes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv(single_thread_prompt.SWITCH_ENV, "1")
    return home


def _mark_developer_mode(home: Path) -> None:
    marker = home.joinpath(*result_delivery_prompt.DEVELOPER_MODE_MARKER)
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text("1\n", encoding="utf-8")


def test_product_modes_chat_carries_the_rule(root):
    assert result_delivery_prompt.render_section(DESKTOP) == PROMPT


@pytest.mark.parametrize(("value", "on"), [("1", True), (" 1 ", True), ("true", False), ("0", False), ("", False)])
def test_the_switch_is_single_thread_modes(root, monkeypatch, value, on):
    monkeypatch.setenv(single_thread_prompt.SWITCH_ENV, value)
    assert (result_delivery_prompt.render_section(DESKTOP) == PROMPT) is on


def test_no_switch_variable_means_no_rule(root, monkeypatch):
    monkeypatch.delenv(single_thread_prompt.SWITCH_ENV)
    assert result_delivery_prompt.render_section(DESKTOP) == ""


@pytest.mark.parametrize(
    "platform",
    ["subagent", "cron", "webhook", "api_server", "tui", "cli", "feishu", "weixin", "wecom", "dingtalk", "qqbot", "", "Desktop"],
)
def test_only_the_chat_that_draws_cards_gets_it(root, platform):
    assert result_delivery_prompt.render_section({"platform": platform}) == ""


@pytest.mark.parametrize("info", [None, {}])
def test_a_session_without_a_platform_gets_none(root, info):
    assert result_delivery_prompt.render_section(info) == ""


def test_developer_mode_leaves_it_out(root):
    _mark_developer_mode(root)
    assert result_delivery_prompt.render_section(DESKTOP) == ""


def test_leaving_developer_mode_brings_it_back_for_the_next_prompt(root):
    _mark_developer_mode(root)
    root.joinpath(*result_delivery_prompt.DEVELOPER_MODE_MARKER).unlink()
    assert result_delivery_prompt.render_section(DESKTOP) == PROMPT


def test_a_named_assistants_engine_reads_the_marker_in_the_shared_root(root, monkeypatch):
    profile = root / "profiles" / "cut"
    profile.mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(profile))
    assert result_delivery_prompt.render_section(DESKTOP) == PROMPT
    _mark_developer_mode(root)
    assert result_delivery_prompt.render_section(DESKTOP) == ""


def test_a_marker_inside_a_profile_does_not_count(root, monkeypatch):
    profile = root / "profiles" / "cut"
    profile.mkdir(parents=True)
    _mark_developer_mode(profile)
    monkeypatch.setenv("HERMES_HOME", str(profile))
    assert result_delivery_prompt.render_section(DESKTOP) == PROMPT


def test_the_marker_path_is_the_one_desktop_writes():
    source = (Path(__file__).parents[2] / "apps" / "desktop" / "electron" / "apex-developer-mode.ts").read_text(encoding="utf-8")
    parts = ", ".join(f"'{part}'" for part in result_delivery_prompt.DEVELOPER_MODE_MARKER)
    assert f"path.join(hermesHome, {parts})" in source


@pytest.mark.parametrize(
    ("rule", "phrases"),
    [
        pytest.param(0, ("单独一行的 MEDIA:绝对路径", "结果卡片", "同一个文件只放一次"), id="deliver-as-card"),
        pytest.param(1, ("回复里不写本机路径", "「文件路径：…」", "「保存在…」"), id="no-path-line"),
        pytest.param(1, ("平台规则或技能要你给路径、列出路径时", "同样用 MEDIA: 这一行"), id="overrides-shared-sentences"),
        pytest.param(2, ("用户问文件在哪、要路径", "用到路径的命令", "照实写完整路径"), id="when-asked-say-it"),
        pytest.param(2, ("交付的是文件夹", "也写它的路径"), id="a-folder-is-no-card"),
    ],
)
def test_what_the_rule_says(rule, phrases):
    for phrase in phrases:
        assert phrase in result_delivery_prompt.RESULT_DELIVERY_RULES[rule]


def test_every_rule_reaches_the_prompt_within_the_section_cap():
    for rule in result_delivery_prompt.RESULT_DELIVERY_RULES:
        assert f"- {rule}" in PROMPT
    assert len(PROMPT) <= result_delivery_prompt.MAX_CHARS


def test_the_shared_sentence_it_overrides_is_still_there():
    """If apex.honesty stops saying 列出路径, the rule's override sentence has outlived its reason."""
    assert any("列出路径" in rule for rule in honesty_prompt.HONESTY_RULES)


def _manager(*seams) -> PluginManager:
    manager = PluginManager()
    manager._discovered = True
    ctx = PluginContext(PluginManifest(name="apex-overlay", key="apex-overlay", source="bundled"), manager)
    for seam in seams:
        assert seam.apply(ctx) is True
    return manager


def _prompt_for(platform: str) -> str:
    agent = AIAgent(api_key="test-key", base_url="https://openrouter.ai/api/v1", model="test/model",
                    provider="openrouter", platform=platform, quiet_mode=True, skip_context_files=True,
                    skip_memory=True, enabled_toolsets=[], session_id="s")
    return build_system_prompt(agent)


def test_a_real_agents_prompt_carries_it_once(root, monkeypatch):
    monkeypatch.setattr(plugins, "_plugin_manager", _manager(result_delivery_prompt))
    assert _prompt_for("desktop").count(PROMPT) == 1
    assert _prompt_for("subagent").count(PROMPT) == 0


def test_a_prompt_rebuild_reads_the_marker_again(root, monkeypatch):
    from agent.system_prompt import invalidate_system_prompt

    monkeypatch.setattr(plugins, "_plugin_manager", _manager(result_delivery_prompt))
    agent = AIAgent(api_key="test-key", base_url="https://openrouter.ai/api/v1", model="test/model",
                    provider="openrouter", platform="desktop", quiet_mode=True, skip_context_files=True,
                    skip_memory=True, enabled_toolsets=[], session_id="s")
    assert PROMPT in build_system_prompt(agent)
    _mark_developer_mode(root)
    assert PROMPT in build_system_prompt(agent)  # frozen for the session until a rebuild
    invalidate_system_prompt(agent)
    assert PROMPT not in build_system_prompt(agent)


def test_its_id_sorts_after_every_other_apex_section():
    others = (approval_rules_prompt, desktop_version, handoff, honesty_prompt, memory_ledger, proactive_prompt,
              single_thread_prompt, user_profile_prompt)
    assert all(result_delivery_prompt.SECTION_ID > seam.SECTION_ID for seam in others)


def test_when_the_budget_runs_out_only_this_section_goes(root, monkeypatch):
    """A full memory ledger and profile leave no room: single-thread mode's rules and the profile stay."""
    apex = root / "apex"
    apex.mkdir()
    # Sizes that leave room for every other section but not for this one.
    (apex / "memory-ledger-prompt.md").write_text("记" * 3_000, encoding="utf-8")
    (apex / "user-profile-prompt.md").write_text("画" * 2_800, encoding="utf-8")
    monkeypatch.setattr(
        plugins,
        "_plugin_manager",
        _manager(
            approval_rules_prompt, proactive_prompt, memory_ledger, single_thread_prompt, user_profile_prompt,
            result_delivery_prompt,
        ),
    )
    rendered = {section.id for section in plugins.render_system_prompt_sections(DESKTOP)}
    assert rendered == {
        approval_rules_prompt.SECTION_ID,
        proactive_prompt.SECTION_ID,
        memory_ledger.SECTION_ID,
        single_thread_prompt.SECTION_ID,
        user_profile_prompt.SECTION_ID,
    }

