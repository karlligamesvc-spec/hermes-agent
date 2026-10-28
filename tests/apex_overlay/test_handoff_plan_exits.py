"""hc-1091 多助手二期 R6: where a relay plan (``<!-- apex:plan … -->``) may and may not go (硬规则 12).

Single-thread mode's variables reach the Desktop-hosted IM gateway too (WeChat and the others bound on this
computer), so the relay seam is registered there as well. Two exits are pinned here:

1. the 「排计划」 rule: APEX's Desktop chat sessions only — never an IM platform, a subagent, cron, a webhook,
   the API server or the terminal, and never another assistant;
2. the reply: outside Desktop chat the final reply that is sent and stored loses a plan block (and a 交回摘要,
   the other Desktop-only block), whatever order the plugins loaded in; the 「下一步」 block in the same reply
   is still numbered by apexnodes-next-steps, through the engine's own output-transform step.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import types
from pathlib import Path
from types import SimpleNamespace

import pytest

from agent.system_prompt import build_system_prompt
from agent.turn_finalizer import apply_llm_output_transform
from apex_overlay import assistant_name, handoff, single_thread_prompt
from hermes_cli import plugins
from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest
from run_agent import AIAgent
from tests.apex_overlay import test_handoff_seam as seam

REPO_ROOT = Path(__file__).resolve().parents[2]
CASES = json.loads((REPO_ROOT / "apps/desktop/shared/apex-handoff-plan-cases.json").read_text(encoding="utf-8"))
PLAN_TEXT = CASES["cases"][0]["text"]  # artboard ⑬: the reply, then 已有 + two batons
PLAN_VISIBLE = CASES["cases"][0]["visible"]
NEXT_BLOCK = "<!-- apex:next\n再挑一个 | 换一个选题\n写成脚本 | 把这个选题写成 60 秒口播脚本\n-->"
NUMBERED = "接下来可以：\n1. 再挑一个\n2. 写成脚本\n回复数字就行。"
HANDBACK = "<!-- apex:handback\n写好了 3 个标题\n-->"

IM_AND_OTHER_EXITS = ["weixin", "feishu", "wecom", "wecom_callback", "dingtalk", "qqbot", "cli", "tui"]
NO_REPLY_READER = ["subagent", "cron", "webhook", "api_server"]


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    monkeypatch.setattr(handoff, "_told", {})
    monkeypatch.setattr(assistant_name, "_told", {})


@pytest.fixture
def root(tmp_path, monkeypatch):
    """The relay seam's Desktop home: APEX, 小剪, 文案; relay on; bound to APEX."""
    home = tmp_path / "apexnodes"
    home.mkdir()
    seam._profile(home, "apex-bot-2", "小剪", 200, seam.DIVISION_SOUL)
    seam._profile(home, "apex-bot-3", "文案", 300, "You are 文案.\n")
    for env in (handoff.SWITCH_ENV, assistant_name.SWITCH_ENV, single_thread_prompt.SWITCH_ENV):
        monkeypatch.setenv(env, "1")
    seam._bind(monkeypatch, home, "default")
    return home


def _manager() -> PluginManager:
    manager = PluginManager()
    manager._discovered = True
    return manager


def _ctx(manager: PluginManager, name: str = "apex-overlay") -> PluginContext:
    return PluginContext(PluginManifest(name=name, key=name, source="bundled"), manager)


def _next_steps(manager: PluginManager):
    """The real apexnodes-next-steps plugin, registered on ``manager``."""
    if "hermes_plugins" not in sys.modules:
        namespace = types.ModuleType("hermes_plugins")
        namespace.__path__ = []  # type: ignore[attr-defined]
        sys.modules["hermes_plugins"] = namespace
    plugin_dir = REPO_ROOT / "plugins" / "apexnodes-next-steps"
    name = "hermes_plugins.apexnodes_next_steps_hc1091"
    spec = importlib.util.spec_from_file_location(name, plugin_dir / "__init__.py", submodule_search_locations=[str(plugin_dir)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    module._reset_state()
    module.register(_ctx(manager, "apexnodes-next-steps"))
    return module


def _final_reply(manager: PluginManager, monkeypatch, text: str, platform: str) -> str:
    """The reply as the engine's output-transform step leaves it (agent/turn_finalizer.py)."""
    monkeypatch.setattr(plugins, "_plugin_manager", manager)
    agent = SimpleNamespace(session_id="s-1", model="test/model", platform=platform, _llm_output_transform=None)
    reply, _transformed, _before = apply_llm_output_transform(agent, text, turn_id="t-1", platform=platform)
    return reply


# ── 1. the rule ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize("platform", IM_AND_OTHER_EXITS + NO_REPLY_READER + [""])
def test_the_plan_rule_never_leaves_desktop_chat(root, platform):
    assert "apex:plan" in handoff.render_section({"platform": "desktop", "profile_name": "default", "session_id": "d"})

    section = handoff.render_section({"platform": platform, "profile_name": "default", "session_id": "s"})

    assert "apex:plan" not in section and handoff.PLAN_RULE not in section


def test_a_wechat_prompt_built_by_the_local_gateway_has_no_plan_rule(root, monkeypatch):
    manager = _manager()
    assert handoff.apply(_ctx(manager)) is True
    monkeypatch.setattr(plugins, "_plugin_manager", manager)
    monkeypatch.setattr(
        "agent.coding_context.build_coding_workspace_block",
        lambda cwd=None: "Workspace (snapshot at session start):\n- Root: /pinned",
    )

    def prompt(platform: str) -> str:
        return build_system_prompt(
            AIAgent(
                api_key="test-key",
                base_url="https://openrouter.ai/api/v1",
                model="test/model",
                provider="openrouter",
                platform=platform,
                quiet_mode=True,
                skip_context_files=True,
                skip_memory=True,
                session_id=f"s-{platform}",
            )
        )

    assert handoff.PLAN_TEMPLATE in prompt("desktop")
    for platform in ("weixin", "cron", "subagent"):
        assert "apex:plan" not in prompt(platform)


# ── 2. the reply ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize("platform", IM_AND_OTHER_EXITS + NO_REPLY_READER)
def test_outside_desktop_chat_the_reply_loses_the_plan_and_the_handback(root, monkeypatch, platform):
    manager = _manager()
    assert handoff.apply(_ctx(manager)) is True

    reply = _final_reply(manager, monkeypatch, f"{PLAN_TEXT}\n\n{HANDBACK}", platform)

    assert reply == PLAN_VISIBLE
    assert "apex:" not in reply and "<!--" not in reply


def test_desktop_chat_keeps_both_blocks_for_its_renderer(root, monkeypatch):
    manager = _manager()
    assert handoff.apply(_ctx(manager)) is True

    assert _final_reply(manager, monkeypatch, PLAN_TEXT, "desktop") == PLAN_TEXT


@pytest.mark.parametrize("next_steps_first", [True, False], ids=["next-steps-loaded-first", "overlay-loaded-first"])
@pytest.mark.parametrize("platform", ["weixin", "feishu", "cli"])
def test_the_next_step_block_in_the_same_reply_is_still_numbered(root, monkeypatch, platform, next_steps_first):
    """Only the first output-transform answer counts: the strip runs first and hands what is left on."""
    manager = _manager()
    if next_steps_first:
        _next_steps(manager)
    assert handoff.apply(_ctx(manager)) is True
    if not next_steps_first:
        _next_steps(manager)

    reply = _final_reply(manager, monkeypatch, f"{PLAN_TEXT}\n\n{NEXT_BLOCK}", platform)

    assert reply == f"{PLAN_VISIBLE}\n\n{NUMBERED}"


def test_a_reply_without_desktop_blocks_is_left_to_the_other_hooks(root, monkeypatch):
    manager = _manager()
    _next_steps(manager)
    assert handoff.apply(_ctx(manager)) is True
    text = f"{PLAN_VISIBLE}\n\n{NEXT_BLOCK}"

    assert manager._hooks["transform_llm_output"][0](response_text=text, platform="weixin") is None
    assert _final_reply(manager, monkeypatch, text, "weixin") == f"{PLAN_VISIBLE}\n\n{NUMBERED}"


def test_relay_off_registers_no_output_strip(tmp_path, monkeypatch):
    for env in (handoff.SWITCH_ENV, assistant_name.SWITCH_ENV, single_thread_prompt.SWITCH_ENV):
        monkeypatch.delenv(env, raising=False)
    manager = _manager()

    assert handoff.apply(_ctx(manager)) is True
    assert not manager._hooks.get("transform_llm_output")


@pytest.mark.parametrize(
    ("text", "visible"),
    [
        ("排好了。\n\n```\n<!-- apex:plan\n@剪辑助手 | 剪片 | 剪成竖屏\n-->\n```\n", "排好了。"),
        ("排一下：\n\n<!-- apex:plan\n@剪辑助手 | 剪", "排一下："),
        ("<!-- apex:plans -->还在", "<!-- apex:plans -->还在"),
        ("就是一段普通回复。", "就是一段普通回复。"),
    ],
    ids=["fenced", "unfinished-at-the-end", "glued-marker", "no-block"],
)
def test_strip_plan_reads_blocks_as_desktop_does(text, visible):
    assert handoff.strip_plan(text) == visible
