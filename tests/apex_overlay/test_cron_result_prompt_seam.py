"""hc-1183 / hc-1186: a Desktop chat says where a scheduled job's result goes, matching what the engine does.

With hc-1186's delivery seam in place the result comes back into the chat (and to a bound Feishu or WeChat);
without it the section keeps hc-1183's wording, that it does not come back here.

test_result_delivery_prompt_identity.py checks every surface's whole prompt in a fresh process (only Desktop
chats carry this section). These tests pin the section itself: who gets it, what it says, when it names the
settings page, and that its id sorts last so a tight budget drops it first.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from agent.system_prompt import build_system_prompt
from apex_overlay import (
    approval_rules_prompt,
    chatcut,
    cron_desktop_delivery,
    cron_result_prompt,
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

DESKTOP = {"platform": "desktop"}
PLAIN = cron_result_prompt.prompt()
WITH_PAGE = cron_result_prompt.prompt(cron_result_prompt.WHERE_TO_LOOK)
NOT_BACK = cron_result_prompt.prompt(comes_back=False)
REAL_ARMED = cron_desktop_delivery.armed


@pytest.fixture
def root(tmp_path, monkeypatch):
    """A Desktop engine (the dashboard spawn sets HERMES_DESKTOP) in product mode, no account signed in."""
    home = tmp_path / "apexnodes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_DESKTOP", "1")
    monkeypatch.setenv(single_thread_prompt.SWITCH_ENV, "1")
    monkeypatch.delenv(chatcut.KEY_ENV, raising=False)
    monkeypatch.delenv(chatcut.BASE_ENV, raising=False)
    monkeypatch.setattr(cron_desktop_delivery, "armed", lambda: True)  # hc-1186's seam in place
    return home


@pytest.fixture
def signed_in(monkeypatch):
    monkeypatch.setenv(chatcut.KEY_ENV, "sk-apex-test")
    monkeypatch.setenv(chatcut.BASE_ENV, "https://apex.test")


def _mark_developer_mode(home: Path) -> None:
    marker = home.joinpath(*result_delivery_prompt.DEVELOPER_MODE_MARKER)
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text("1\n", encoding="utf-8")


def test_a_desktop_chat_carries_the_rule(root):
    assert cron_result_prompt.render_section(DESKTOP) == PLAIN


def test_without_the_delivery_seam_it_says_the_result_does_not_come_back(root, monkeypatch):
    """What the chat promises follows what the engine does: no seam, no promise."""
    monkeypatch.setattr(cron_desktop_delivery, "armed", lambda: False)
    assert cron_result_prompt.render_section(DESKTOP) == NOT_BACK
    assert "不会出现在这个对话里" in NOT_BACK and "回到这个对话里。" not in NOT_BACK.split("\n")[1]


def test_armed_follows_the_real_scheduler_patch(root, monkeypatch):
    """armed() reads the scheduler's own sender once it is loaded, not a flag set at discovery."""
    from cron import scheduler

    # The fixture stands in for the seam; this test reads the real check (installing scans the
    # sandboxed HERMES_HOME for pending results, never the user's).
    monkeypatch.setattr(cron_desktop_delivery, "armed", REAL_ARMED)

    monkeypatch.setattr(scheduler, "_deliver_result", scheduler._deliver_result)
    original = scheduler._deliver_result
    if getattr(original, cron_desktop_delivery._MARK, False):
        original = original.__wrapped__
        monkeypatch.setattr(scheduler, "_deliver_result", original)
    assert cron_desktop_delivery.armed() is False
    assert cron_desktop_delivery._install_scheduler(scheduler) is True
    assert cron_desktop_delivery.armed() is True


@pytest.mark.parametrize(
    "platform",
    ["subagent", "cron", "webhook", "api_server", "tui", "cli", "feishu", "weixin", "wecom", "dingtalk", "qqbot", "", "Desktop"],
)
def test_no_other_session_gets_it(root, platform):
    assert cron_result_prompt.render_section({"platform": platform}) == ""


@pytest.mark.parametrize("info", [None, {}])
def test_a_session_without_a_platform_gets_none(root, info):
    assert cron_result_prompt.render_section(info) == ""


def test_a_cloud_container_gets_none_even_for_a_desktop_platform(root, monkeypatch):
    monkeypatch.delenv("HERMES_DESKTOP")
    monkeypatch.setattr(honesty_prompt, "on_desktop", lambda: False)
    assert cron_result_prompt.render_section(DESKTOP) == ""


def test_single_thread_mode_off_still_carries_it(root, monkeypatch):
    """Where the result goes does not depend on the mode; only the page it names does."""
    monkeypatch.delenv(single_thread_prompt.SWITCH_ENV)
    assert cron_result_prompt.render_section(DESKTOP) == PLAIN


def test_product_mode_with_an_account_names_the_settings_page(root, signed_in):
    assert cron_result_prompt.render_section(DESKTOP) == WITH_PAGE
    assert "「设置 › 助手与记录 › 定时运行」" in WITH_PAGE


@pytest.mark.parametrize("why", ["switch-off", "developer-mode", "own-key"])
def test_the_page_is_named_only_where_it_is_on_screen(root, signed_in, monkeypatch, why):
    if why == "switch-off":
        monkeypatch.setenv(single_thread_prompt.SWITCH_ENV, "0")
    elif why == "developer-mode":
        _mark_developer_mode(root)
    else:
        monkeypatch.delenv(chatcut.KEY_ENV)
    assert cron_result_prompt.render_section(DESKTOP) == PLAIN


def test_the_settings_page_it_names_is_the_one_desktop_shows():
    """Settings › 助手与记录 (hc-1133 activity tab) holds 定时运行 in product mode's settings."""
    desktop = Path(__file__).parents[2] / "apps" / "desktop" / "src"
    menu = (desktop / "i18n" / "account-menu.ts").read_text(encoding="utf-8")
    settings = (desktop / "app" / "settings" / "product-settings.ts").read_text(encoding="utf-8")
    nav = (desktop / "i18n" / "zh.ts").read_text(encoding="utf-8")
    assert "activity: '助手与记录'" in menu
    assert "'activity'" in settings.split("const PRODUCT_VIEWS", 1)[1].split("\n", 1)[0]
    assert "'scheduled-runs': '定时运行'" in nav


@pytest.mark.parametrize(
    ("rule", "phrases"),
    [
        pytest.param(0, ("后台单独跑", "「定时任务结果」", "自动回到这个对话里"), id="back-here"),
        pytest.param(1, ("飞书或微信", "也会同时发到那边的私聊", "只保存在本机的，不回对话也不发出去"), id="also-im"),
        pytest.param(2, ("照实告诉用户结果会回到这个对话", "连着飞书或微信的也会发到那边", "以它为准"), id="say-so"),
    ],
)
def test_what_the_rule_says(rule, phrases):
    for phrase in phrases:
        assert phrase in cron_result_prompt.rules()[rule]


@pytest.mark.parametrize(
    ("rule", "phrases"),
    [
        pytest.param(0, ("后台单独跑", "不会出现在这个对话里"), id="not-back-here"),
        pytest.param(1, ("飞书或微信", "那边的私聊", "只保存在本机的除外", "只保存在这台电脑上"), id="where-it-goes"),
        pytest.param(2, ("照实告诉用户结果会去哪、在哪看", "不要说结果会回到这个对话里", "以它为准"), id="say-so"),
    ],
)
def test_what_the_fallback_says(rule, phrases):
    for phrase in phrases:
        assert phrase in cron_result_prompt.rules(comes_back=False)[rule]


@pytest.mark.parametrize("text", [PLAIN, WITH_PAGE, NOT_BACK, cron_result_prompt.prompt(cron_result_prompt.WHERE_TO_LOOK, False)],
                         ids=["plain", "with-page", "fallback", "fallback-with-page"])
def test_every_rule_reaches_the_prompt_within_the_section_cap(text):
    assert text.startswith(cron_result_prompt.HEADER + "\n")
    assert text.count("\n- ") == len(cron_result_prompt.rules())
    assert len(text) <= cron_result_prompt.MAX_CHARS


def test_its_id_sorts_after_every_other_apex_section():
    others = (approval_rules_prompt, desktop_version, handoff, honesty_prompt, memory_ledger, proactive_prompt,
              result_delivery_prompt, single_thread_prompt, user_profile_prompt)
    assert all(cron_result_prompt.SECTION_ID > seam.SECTION_ID for seam in others)


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
    monkeypatch.setattr(plugins, "_plugin_manager", _manager(cron_result_prompt))
    assert _prompt_for("desktop").count(PLAIN) == 1
    for platform in ("subagent", "cron", "feishu"):
        assert cron_result_prompt.HEADER not in _prompt_for(platform)


def test_plugin_register_applies_the_seam():
    from tests.apex_overlay.conftest import run_plugin_register_with_stubbed_seams

    assert "cron_result_prompt" in run_plugin_register_with_stubbed_seams("_apex_overlay_plugin_hc1183_prompt")
