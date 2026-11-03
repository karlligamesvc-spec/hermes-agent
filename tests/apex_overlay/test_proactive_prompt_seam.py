"""hc-1071 主动问、主动提: the rules single-thread mode adds on when to ask and what to offer.

The section rides hc-1015's switch (``APEX_SINGLE_THREAD_ACTIVE=1``, set by Desktop's
main process at launch). These tests pin the switch, the rules the chat relies on,
that the blocks the rules show parse with apexnodes-next-steps' own parser, that a
real agent's prompt carries the section only with the switch on, and that with the
switch off the prompt is byte for byte the one built without this seam.
"""

from __future__ import annotations

import importlib.util
import re
from datetime import UTC, datetime
from pathlib import Path

import pytest

from agent.system_prompt import build_system_prompt
from apex_overlay import proactive_prompt, single_thread_prompt
from hermes_cli import plugins
from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest
from run_agent import AIAgent

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(autouse=True)
def _no_switch(monkeypatch, tmp_path):
    monkeypatch.delenv(single_thread_prompt.SWITCH_ENV, raising=False)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "apexnodes"))


def _next_steps():
    spec = importlib.util.spec_from_file_location(
        "hc1071_next_steps_plugin", ROOT / "plugins" / "apexnodes-next-steps" / "__init__.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize(
    ("value", "on"),
    [("1", True), (" 1 ", True), ("true", False), ("on", False), ("0", False), ("", False)],
)
def test_the_switch_is_single_thread_modes(monkeypatch, value, on):
    monkeypatch.setenv(single_thread_prompt.SWITCH_ENV, value)
    assert (proactive_prompt.render_section({}) == proactive_prompt.PROACTIVE_PROMPT) is on
    assert (proactive_prompt.render_section({}) == "") is not on


@pytest.mark.parametrize(
    ("platform", "carried"),
    [
        ("desktop", True),
        ("cli", True),
        ("feishu", True),
        ("weixin", True),
        ("", True),
        ("subagent", False),
        ("cron", False),
        ("webhook", False),
        ("api_server", False),
    ],
)
def test_a_session_nobody_can_answer_gets_no_section(monkeypatch, platform, carried):
    monkeypatch.setenv(single_thread_prompt.SWITCH_ENV, "1")
    assert (proactive_prompt.render_section({"platform": platform}) == proactive_prompt.PROACTIVE_PROMPT) is carried
    assert proactive_prompt.NON_INTERACTIVE_PLATFORMS == _next_steps().NON_INTERACTIVE_PLATFORMS


@pytest.mark.parametrize(
    ("rule", "phrases"),
    [
        pytest.param(0, ("缺关键信息先问再开工", "只有用户自己知道", "返工或白花钱", "配不配音乐", "结尾放不放联系方式"), id="when-to-ask"),
        pytest.param(0, ("能从上文、画像或记忆里看出来的", "「直接做」「别问我」", "字体、转场这类小事，不问", "一句话说明按什么做的"), id="when-not-to-ask"),
        pytest.param(0, ("定时任务、子任务这类没人能回答的时候也一样",), id="nobody-to-ask"),
        pytest.param(1, ("用提问卡问（clarify）", "一张卡一个问题", "2–4 个短选项", "第 1 项放你的默认做法", "recommended=false"), id="the-card"),
        pytest.param(1, ("问题只写在卡上，正文不重复问题和选项", "开工前最多问两题", "不要每件事都问"), id="ask-little"),
        pytest.param(1, ("undelivered", "把选项编号写在回复最后", "这一轮到此为止"), id="no-card"),
        pytest.param(2, ("每交付一个结果", "「下一步」块", "2–3 个", "第 1 项放最可能点的那个", "主按钮"), id="next-steps"),
        pytest.param(2, ("在等用户回答、只是闲聊或没交付东西时不加", "failed=卡住的那一步", "技能里写了常用的下一步"), id="when-no-block"),
        pytest.param(3, ("主动提一件你能接着做的事", "正文最后用一句话问", "只放两项", "做吧", "先不用"), id="offer"),
        pytest.param(3, ("才开始做，不要先做", "一次只提一件", "不再提同一件"), id="only-on-yes"),
        pytest.param(4, ("微信、企微、钉钉、QQ、飞书", "自动变成编号", "不用自己编号", "不写「点下面的按钮」"), id="im-numbers"),
    ],
)
def test_the_rules_say_what_the_chat_relies_on(rule, phrases):
    for phrase in phrases:
        assert phrase in proactive_prompt.PROACTIVE_RULES[rule], phrase


def test_every_rule_is_one_bullet_of_the_section():
    assert proactive_prompt.PROACTIVE_PROMPT.startswith("【APEX 主动问、主动提 · 平台规则】\n- ")
    for rule in proactive_prompt.PROACTIVE_RULES:
        assert f"- {rule}" in proactive_prompt.PROACTIVE_PROMPT
    assert len(proactive_prompt.PROACTIVE_PROMPT) <= proactive_prompt.MAX_CHARS


def test_the_example_block_parses_to_three_buttons_most_likely_first():
    example = re.search(r"<!-- apex:next\n.*?\n-->", proactive_prompt.PROACTIVE_RULES[2], re.DOTALL).group(0)

    visible, block = _next_steps().parse_next_steps(f"开头 10 秒做好了。\n\n{example}")

    assert visible == "开头 10 秒做好了。"
    assert block == {
        "failed": None,
        "options": [
            ("出整条", "样片可以，出整条成片"),
            ("换个声音", "配音换个声音再出一版"),
            ("开头再快点", "开头节奏再快一点，重出样片"),
        ],
    }
    assert all(len(label) <= 8 for label, _ in block["options"])


def test_the_offer_buttons_parse_to_yes_then_not_now():
    pairs = re.findall(r"「([^「」|]+ \| [^「」]+)」", proactive_prompt.PROACTIVE_RULES[3])
    text = "成片好了。要不要我顺手把小红书版做了？\n\n<!-- apex:next\n" + "\n".join(pairs) + "\n-->"

    assert _next_steps().parse_next_steps(text) == (
        "成片好了。要不要我顺手把小红书版做了？",
        {"failed": None, "options": [("做吧", "好，把小红书版也做了"), ("先不用", "先不用，就到这")]},
    )


def test_the_failed_form_parses():
    inline = re.search(r"<!-- apex:next failed=[^>]+-->", proactive_prompt.PROACTIVE_RULES[2]).group(0)
    assert _next_steps().parse_next_steps(f"没做成。\n{inline}") == (
        "没做成。",
        {"failed": "卡住的那一步", "options": []},
    )


def test_single_thread_mode_no_longer_says_just_start_without_a_condition():
    assert "- 信息够了再开工：开工前先用一句话说你要做什么、大概多久，然后直接做。" in single_thread_prompt.SINGLE_THREAD_PROMPT
    assert "- 开工前先用一句话" not in single_thread_prompt.SINGLE_THREAD_PROMPT


def _manager(*seams) -> PluginManager:
    manager = PluginManager()
    manager._discovered = True
    ctx = PluginContext(PluginManifest(name="apex-overlay", key="apex-overlay", source="bundled"), manager)
    for seam in seams:
        assert seam.apply(ctx) is True
    return manager


def _prompt(monkeypatch, manager, session_id: str, platform: str = "cli") -> str:
    monkeypatch.setattr(plugins, "_plugin_manager", manager)
    agent = AIAgent(
        api_key="test-key",
        base_url="https://openrouter.ai/api/v1",
        model="test/model",
        provider="openrouter",
        platform=platform,
        quiet_mode=True,
        skip_context_files=True,
        skip_memory=True,
        session_id=session_id,
    )
    return build_system_prompt(agent)


@pytest.fixture
def _pinned_workspace(monkeypatch):
    monkeypatch.setattr(
        "agent.coding_context.build_coding_workspace_block",
        lambda cwd=None: "Workspace (snapshot at session start):\n- Root: /pinned",
    )
    # Two builds compared byte for byte must not straddle midnight.
    fixed = datetime(2026, 10, 26, 12, 0, tzinfo=UTC)
    monkeypatch.setattr("hermes_time.now", lambda: fixed)


@pytest.mark.usefixtures("_pinned_workspace")
def test_switch_off_builds_the_prompt_built_without_this_seam(monkeypatch):
    without = _prompt(monkeypatch, _manager(single_thread_prompt), "same")
    with_seam = _prompt(monkeypatch, _manager(single_thread_prompt, proactive_prompt), "same")

    assert with_seam == without
    assert "apex.proactive" not in with_seam


@pytest.mark.usefixtures("_pinned_workspace")
def test_switch_on_a_new_session_prompt_carries_the_rules(monkeypatch):
    monkeypatch.setenv(single_thread_prompt.SWITCH_ENV, "1")

    prompt = _prompt(monkeypatch, _manager(single_thread_prompt, proactive_prompt), "on")

    assert "## Plugin Context: apex.single-thread" in prompt
    assert "## Plugin Context: apex.proactive" in prompt
    assert proactive_prompt.PROACTIVE_PROMPT in prompt


@pytest.mark.usefixtures("_pinned_workspace")
def test_switch_on_a_subagent_prompt_has_no_section(monkeypatch):
    monkeypatch.setenv(single_thread_prompt.SWITCH_ENV, "1")

    prompt = _prompt(monkeypatch, _manager(single_thread_prompt, proactive_prompt), "child", platform="subagent")

    assert "## Plugin Context: apex.single-thread" in prompt
    assert "apex.proactive" not in prompt


def test_registering_twice_or_without_a_host_reports_false():
    manager = _manager(proactive_prompt)
    ctx = PluginContext(PluginManifest(name="apex-overlay", key="apex-overlay", source="bundled"), manager)
    assert proactive_prompt.apply(ctx) is False
    assert proactive_prompt.apply(None) is False


def test_plugin_register_applies_the_seam():
    from tests.apex_overlay.conftest import run_plugin_register_with_stubbed_seams

    called = run_plugin_register_with_stubbed_seams("_proactive_prompt_plugin_under_test")
    assert "proactive_prompt" in called
