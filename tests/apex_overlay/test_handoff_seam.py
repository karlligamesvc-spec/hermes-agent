"""hc-1088 多助手接力 · 引擎: the job one assistant hands to another, and what comes back.

Desktop (hc-1086) submits the hand-over message into the receiving assistant's 「APEX 主线」 and sets
``APEX_MULTI_BOT_HANDOFF_ACTIVE=1`` next to the multi-bot pair. These tests pin:

1. With any of the three variables off, the overlay's prompt seams build what fork main built before
   this seam (a golden captured on main aa8e554e): same sections, hooks and tools.
2. The ``apex.handoff`` section lists the user's other assistants with their 「分工」, only in Desktop
   chat sessions; subagents, cron, IM and the terminal get none.
3. The receiving turn hears what to do and how to hand back; its end puts the block (or the start of
   the reply) into the sender's return box; the sender's next turn carries it once.
4. A roster that changed after a session's prompt was frozen is told once.
5. The whole chain through ``AIAgent.run_conversation`` with a scripted model.
"""

from __future__ import annotations

import importlib
import json
import os
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

import hermes_yaml as yaml
from agent.system_prompt import build_system_prompt
from apex_overlay import assistant_name, handoff, single_thread_prompt
from hermes_cli import plugins
from hermes_cli.plugins import PLUGIN_SECTIONS_END, PLUGIN_SECTIONS_START, PluginContext, PluginManager, PluginManifest
from run_agent import AIAgent
from tools.registry import registry

GOLDEN = Path(__file__).parent / "__identity__" / "handoff-off" / "before-hc1088.json"
CASES = json.loads(
    (Path(__file__).resolve().parents[2] / "apps/desktop/shared/apex-handoff-cases.json").read_text(encoding="utf-8")
)
REQUEST = CASES["request"]["cases"][0]["text"]  # APEX → id h-20261028-0001
REPLY = CASES["handback"]["cases"][0]["reply"]  # 剪好了 30 秒版本… with a file and a link

# Every seam that registers on the plugin context with a prompt section, a tool or a turn hook.
PROMPT_SEAMS = (
    "user_profile_prompt",
    "memory_ledger",
    "single_thread_prompt",
    "assistant_name",
    "proactive_prompt",
    "honesty_prompt",
    "approval_rules_prompt",
)
LEDGER = "【APEX 记得的 · 记忆底账】\n关于你：\n- [3f2a9c1d] 不露脸，女声配音\n【APEX 记得的 · 完】\n"
DIVISION_SOUL = (
    "You are 小剪, an AI assistant from ApexNodes HK, working alongside APEX for the same person.\n\nBody.\n\n"
    "## 分工\n\n用户第一次打开你时定的（用户这次说的不一样时以这次为准）：\n- 主要帮用户：剪辑出片\n"
)
STATES = {"multi-on": ("1", "1"), "multi-off": ("", "1"), "single-off": ("1", ""), "all-off": ("", "")}


def _snapshot(root: Path, monkeypatch, seams: tuple[str, ...], profile: str, platform: str) -> dict:
    """What a new session of ``profile`` on ``platform`` gets from the overlay's prompt seams."""
    import model_tools

    (root / "apex").mkdir(exist_ok=True)
    (root / "apex" / "memory-ledger-prompt.md").write_text(LEDGER, encoding="utf-8")
    bot = root / "profiles" / "apex-bot-2"
    bot.mkdir(parents=True, exist_ok=True)
    (bot / "SOUL.md").write_text(DIVISION_SOUL, encoding="utf-8")
    (bot / "profile.yaml").write_text(
        yaml.safe_dump({"ui_meta": {"apex": {"name": "小剪", "created": 200, "origin": "product"}}}), encoding="utf-8"
    )
    monkeypatch.setenv("HERMES_HOME", str(root if profile == "default" else root / "profiles" / profile))
    monkeypatch.setattr(
        "agent.coding_context.build_coding_workspace_block",
        lambda cwd=None: "Workspace (snapshot at session start):\n- Root: /pinned",
    )
    manager = PluginManager()
    manager._discovered = True
    ctx = PluginContext(PluginManifest(name="apex-overlay", key="apex-overlay", source="bundled"), manager)
    for name in seams:
        assert importlib.import_module(f"apex_overlay.{name}").apply(ctx) is True
    monkeypatch.setattr(plugins, "_plugin_manager", manager)
    model_tools._clear_tool_defs_cache()
    try:
        agent = AIAgent(
            api_key="test-key",
            base_url="https://openrouter.ai/api/v1",
            model="test/model",
            provider="openrouter",
            platform=platform,
            quiet_mode=True,
            skip_context_files=True,
            skip_memory=True,
            session_id=f"golden-{profile}-{platform}",
        )
        prompt = build_system_prompt(agent)
        start = prompt.index(PLUGIN_SECTIONS_START) if PLUGIN_SECTIONS_START in prompt else len(prompt)
        end = prompt.index(PLUGIN_SECTIONS_END) + len(PLUGIN_SECTIONS_END) if PLUGIN_SECTIONS_END in prompt else len(prompt)
        from agent.tool_executor import _tool_search_scoped_names

        callable_names = {t["function"]["name"] for t in (agent.tools or [])} | set(_tool_search_scoped_names(agent))
        tools = sorted(name for name in callable_names if name.startswith("apex_"))
        return {
            "plugin_sections": prompt[start:end],
            "section_ids": sorted(manager._system_prompt_sections),
            "hooks": {
                hook: [f"{cb.__module__}.{cb.__qualname__}" for cb in callbacks]
                for hook, callbacks in sorted(manager._hooks.items())
                if callbacks
            },
            "apex_tools": tools,
            "apex_tool_schemas": {name: registry.get_entry(name).schema for name in tools},
        }
    finally:
        for name in ("apex_memory", "apex_rename"):
            registry.deregister(name)
        model_tools._clear_tool_defs_cache()


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    for env in (handoff.SWITCH_ENV, assistant_name.SWITCH_ENV, single_thread_prompt.SWITCH_ENV):
        monkeypatch.delenv(env, raising=False)
    monkeypatch.setattr(handoff, "_told", {})
    monkeypatch.setattr(assistant_name, "_told", {})


@pytest.fixture
def root(tmp_path, monkeypatch):
    """A Desktop home: APEX, 小剪 (剪辑出片, for 抖音), 文案 with no 分工; relay on; bound to APEX."""
    home = tmp_path / "apexnodes"
    home.mkdir()
    _profile(home, "apex-bot-2", "小剪", 200, DIVISION_SOUL.replace("出片\n", "出片\n- 主要给哪个平台做：抖音\n"))
    _profile(home, "apex-bot-3", "文案", 300, "You are 文案.\n")
    for env in (handoff.SWITCH_ENV, assistant_name.SWITCH_ENV, single_thread_prompt.SWITCH_ENV):
        monkeypatch.setenv(env, "1")
    _bind(monkeypatch, home, "default")
    return home


def _profile(root: Path, profile: str, name: str, created: int, soul: str) -> Path:
    home = root / "profiles" / profile
    home.mkdir(parents=True)
    (home / "SOUL.md").write_text(soul, encoding="utf-8")
    (home / "profile.yaml").write_text(
        yaml.safe_dump({"ui_meta": {"apex": {"name": name, "created": created, "origin": "product"}}}), encoding="utf-8"
    )
    return home


def _bind(monkeypatch, root: Path, profile: str) -> None:
    """Act as the engine Desktop started for ``profile`` (``--profile`` binds the home)."""
    monkeypatch.setenv("HERMES_HOME", str(root if profile == "default" else root / "profiles" / profile))


def _manager() -> PluginManager:
    manager = PluginManager()
    manager._discovered = True
    return manager


def _ctx(manager: PluginManager) -> PluginContext:
    return PluginContext(PluginManifest(name="apex-overlay", key="apex-overlay", source="bundled"), manager)


# ── 1. switch off: what main built ───────────────────────────────────────────


@pytest.mark.parametrize(
    ("handoff_env", "multi", "single", "on"),
    [
        ("1", "1", "1", True),
        (" 1 ", "1", "1", True),
        ("", "1", "1", False),
        ("0", "1", "1", False),
        ("true", "1", "1", False),
        ("1", "", "1", False),
        ("1", "1", "", False),
    ],
)
def test_the_switch_needs_all_three_launch_variables(monkeypatch, handoff_env, multi, single, on):
    monkeypatch.setenv(handoff.SWITCH_ENV, handoff_env)
    monkeypatch.setenv(assistant_name.SWITCH_ENV, multi)
    monkeypatch.setenv(single_thread_prompt.SWITCH_ENV, single)
    manager = _manager()

    assert handoff.switch_on() is on
    assert handoff.apply(_ctx(manager)) is True
    assert ("apex.handoff" in manager._system_prompt_sections) is on
    assert (handoff.on_pre_llm_call in manager._hooks.get("pre_llm_call", [])) is on
    assert (handoff.on_post_llm_call in manager._hooks.get("post_llm_call", [])) is on


@pytest.mark.parametrize(
    ("state", "handoff_env"),
    [("multi-on", None), ("multi-on", "0"), ("multi-on", "true"), ("multi-off", "1"), ("single-off", "1"), ("all-off", "1")],
)
@pytest.mark.parametrize("profile", ["default", "apex-bot-2"])
def test_relay_off_builds_what_main_built(tmp_path, monkeypatch, state, handoff_env, profile):
    multi, single = STATES[state]
    monkeypatch.setenv(assistant_name.SWITCH_ENV, multi)
    monkeypatch.setenv(single_thread_prompt.SWITCH_ENV, single)
    if handoff_env is not None:
        monkeypatch.setenv(handoff.SWITCH_ENV, handoff_env)
    root = tmp_path / "apexnodes"
    root.mkdir()

    snapshot = _snapshot(root, monkeypatch, (*PROMPT_SEAMS, "handoff"), profile, "desktop")

    assert snapshot == json.loads(GOLDEN.read_text(encoding="utf-8"))[f"{state}/{profile}"]


def test_relay_on_adds_only_its_section_and_two_hooks(tmp_path, monkeypatch):
    monkeypatch.setenv(handoff.SWITCH_ENV, "1")
    monkeypatch.setenv(assistant_name.SWITCH_ENV, "1")
    monkeypatch.setenv(single_thread_prompt.SWITCH_ENV, "1")
    root = tmp_path / "apexnodes"
    root.mkdir()
    before = json.loads(GOLDEN.read_text(encoding="utf-8"))["multi-on/default"]

    after = _snapshot(root, monkeypatch, (*PROMPT_SEAMS, "handoff"), "default", "desktop")

    assert after["section_ids"] == sorted([*before["section_ids"], "apex.handoff"])
    assert after["hooks"] == {
        "post_llm_call": ["apex_overlay.handoff.on_post_llm_call"],
        "pre_llm_call": [*before["hooks"]["pre_llm_call"], "apex_overlay.handoff.on_pre_llm_call"],
    }
    assert (after["apex_tools"], after["apex_tool_schemas"]) == (before["apex_tools"], before["apex_tool_schemas"])
    section = "## Plugin Context: apex.handoff\n"
    assert section in after["plugin_sections"] and section not in before["plugin_sections"]
    # Everything else in the prompt is unchanged: the new section is one block added among the others.
    added = after["plugin_sections"].split(section)[1].split("\n## Plugin Context: ")[0]
    assert after["plugin_sections"].replace(section + added + "\n", "", 1) == before["plugin_sections"]


def test_applying_twice_on_one_manager_registers_once(root):
    manager = _manager()
    assert handoff.apply(_ctx(manager)) is True
    assert handoff.apply(_ctx(manager)) is False
    assert manager._hooks["pre_llm_call"].count(handoff.on_pre_llm_call) == 1


def test_the_plugin_registers_the_seam_with_the_other_context_seams():
    from tests.apex_overlay.conftest import run_plugin_register_with_stubbed_seams

    assert "handoff" in run_plugin_register_with_stubbed_seams("hc1088_plugin_register")


# ── 2. the section ───────────────────────────────────────────────────────────


def test_apex_sees_every_other_assistant_with_its_division(root):
    section = handoff.render_section({"platform": "desktop", "profile_name": "default", "session_id": "s1"})

    assert section == "\n".join(
        (
            "【APEX 接力 · 平台规则】",
            "- 用户在 APEX 里还有这几个助手，各有分工：",
            "  - 小剪：剪辑出片，主要给抖音做",
            "  - 文案：还没定分工",
            handoff.OFFER_RULE,
            handoff.PLAN_RULE,
            handoff.TURN_RULE,
        )
    )


def test_the_offer_is_a_handoff_line_in_the_next_step_block():
    """hc-1089's protocol (apex-nodes NEXT-STEPS-BLOCK-PROTOCOL.md §9): `@名字 | 按钮字 | 要它做什么`,
    the name as this section lists it; the skills write that line only when this list is in the prompt."""
    for text in (handoff.OFFER_RULE, handoff.ROSTER_NOW):
        assert "「下一步」块里写一行「交给」项：`@助手名字 | 按钮字 | 要它做什么`" in text
        assert "用户点了才交" in text
    assert "不写「交给」和名字" in handoff.OFFER_RULE
    assert "最多 3 项" in handoff.OFFER_RULE


def test_another_assistant_sees_apex_and_not_itself(root, monkeypatch):
    _bind(monkeypatch, root, "apex-bot-2")

    section = handoff.render_section({"platform": "desktop", "profile_name": "apex-bot-2", "session_id": "s1"})

    assert "  - APEX：主助手，什么活都能接\n  - 文案：还没定分工\n" in section
    assert "小剪" not in section
    # hc-1091: only APEX proposes a relay plan; the others keep the single 「交给」 line.
    assert handoff.OFFER_RULE in section
    assert handoff.PLAN_RULE not in section and "apex:plan" not in section


def test_a_renamed_apex_is_listed_by_its_new_name(root, monkeypatch):
    (root / "profile.yaml").write_text(yaml.safe_dump({"ui_meta": {"apex": {"name": "小A"}}}), encoding="utf-8")

    section = handoff.render_section({"platform": "desktop", "profile_name": "apex-bot-2", "session_id": "s1"})

    assert "  - 小A：主助手，什么活都能接\n" in section


@pytest.mark.parametrize("platform", ["subagent", "cron", "webhook", "api_server", "weixin", "feishu", "tui", "cli", ""])
def test_no_section_outside_desktop_chat(root, platform):
    assert handoff.render_section({"platform": platform, "profile_name": "default", "session_id": "s1"}) == ""


def test_no_section_without_another_assistant(tmp_path, monkeypatch):
    for env in (handoff.SWITCH_ENV, assistant_name.SWITCH_ENV, single_thread_prompt.SWITCH_ENV):
        monkeypatch.setenv(env, "1")
    (tmp_path / "apexnodes").mkdir()
    _bind(monkeypatch, tmp_path / "apexnodes", "default")

    assert handoff.render_section({"platform": "desktop", "profile_name": "default", "session_id": "s1"}) == ""


def test_a_long_role_is_cut_and_the_section_fits_its_cap(root):
    (root / "profiles" / "apex-bot-3" / "SOUL.md").write_text("## 分工\n- 主要帮用户：" + "长" * 200 + "\n", encoding="utf-8")
    for n in range(4, 12):
        _profile(root, f"apex-bot-{n}", "十二个字的名字十二个字的", 300 + n, "## 分工\n- 主要帮用户：" + "长" * 200 + "\n")

    section = handoff.render_section({"platform": "desktop", "profile_name": "default", "session_id": "s1"})

    assert "  - 文案：" + "长" * handoff.ROLE_MAX_CHARS + "…\n" in section
    assert section.count("\n  - ") == handoff.MAX_ROSTER
    assert len(section) < handoff.MAX_CHARS


def test_apex_s_section_with_the_plan_rule_fits_its_cap_at_the_longest_roster(root):
    """hc-1091: APEX's section also carries the relay plan rule; the longest names, roles and platforms still fit."""
    division = "## 分工\n- 主要帮用户：" + "长" * 200 + "\n- 主要给哪个平台做：" + "平" * 200 + "\n"
    (root / "profiles" / "apex-bot-3" / "SOUL.md").write_text(division, encoding="utf-8")
    for n in range(4, 12):
        _profile(root, f"apex-bot-{n}", "十二个字的名字十二个字的", 300 + n, division)

    section = handoff.render_section({"platform": "desktop", "profile_name": "default", "session_id": "s1"})

    assert section.count("\n  - ") == handoff.MAX_ROSTER
    assert section.endswith(handoff.PLAN_RULE + "\n" + handoff.TURN_RULE)
    assert len(section) < handoff.MAX_CHARS


def test_a_subagent_prompt_carries_no_relay_section(root, monkeypatch):
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

    assert "【APEX 接力 · 平台规则】" in prompt("desktop")
    assert "【APEX 接力 · 平台规则】" not in prompt("subagent")


# ── 3. taking a job, handing it back ─────────────────────────────────────────


def test_the_receiving_turn_hears_who_handed_it_over(root, monkeypatch):
    _bind(monkeypatch, root, "apex-bot-2")
    handoff.render_section({"platform": "desktop", "profile_name": "apex-bot-2", "session_id": "r1"})

    note = handoff.on_pre_llm_call(session_id="r1", platform="desktop", user_message=REQUEST)

    assert note == handoff.TAKING.format(sender="APEX")


def test_the_sender_is_named_as_the_sidebar_names_it(root, monkeypatch):
    request = CASES["request"]["cases"][1]["text"]  # from apex-bot-2

    note = handoff.on_pre_llm_call(session_id="", platform="desktop", user_message=request)

    assert note == handoff.TAKING.format(sender="小剪")


@pytest.mark.parametrize("message", ["你好", f"看看这个：\n{REQUEST}", ""])
def test_an_ordinary_message_gets_no_taking_note(root, message):
    handoff.render_section({"platform": "desktop", "profile_name": "default", "session_id": "s1"})
    assert handoff.on_pre_llm_call(session_id="s1", platform="desktop", user_message=message) is None


@pytest.mark.parametrize("platform", ["subagent", "cron", "weixin", "tui", "api_server", ""])
def test_outside_desktop_chat_nothing_is_taken_or_handed_back(root, platform):
    assert handoff.on_pre_llm_call(session_id="s1", platform=platform, user_message=REQUEST) is None
    handoff.on_post_llm_call(session_id="s1", platform=platform, user_message=REQUEST, assistant_response=REPLY)
    assert not (root / "apex" / "handoff").exists()


def test_the_end_of_the_turn_puts_the_block_in_the_senders_box(root, monkeypatch):
    _bind(monkeypatch, root, "apex-bot-2")
    before = time.time()

    handoff.on_post_llm_call(session_id="r1", platform="desktop", user_message=REQUEST, assistant_response=REPLY)

    entry = json.loads((root / "apex/handoff/returns/default/h-20261028-0001.json").read_text(encoding="utf-8"))
    assert before <= entry.pop("at") <= time.time()
    assert entry == {
        "v": 1,
        "id": "h-20261028-0001",
        "from": "default",
        "by": "apex-bot-2",
        "by_name": "小剪",
        "summary": "剪好了 30 秒版本，开头换成了第 2 个镜头，字幕已烧进去。",
        "files": ["/Users/me/Movies/APEX/成片-30s.mp4"],
        "links": ["https://www.douyin.com/video/7300000000000000000"],
        "has_summary": True,
    }


def test_without_a_block_the_start_of_the_reply_goes_back(root, monkeypatch):
    _bind(monkeypatch, root, "apex-bot-2")
    reply = "这个我需要你先告诉我视频放在哪里。" + "啊" * 400 + "\n<!-- apex:next\n出整条 | 出整条成片\n-->"

    handoff.on_post_llm_call(session_id="r1", platform="desktop", user_message=REQUEST, assistant_response=reply)

    entry = json.loads((root / "apex/handoff/returns/default/h-20261028-0001.json").read_text(encoding="utf-8"))
    assert entry["has_summary"] is False
    assert entry["summary"] == ("这个我需要你先告诉我视频放在哪里。" + "啊" * 400)[: handoff.HEAD_MAX_CHARS] + "…"
    assert (entry["files"], entry["links"]) == ([], [])


@pytest.mark.parametrize("reply", ["", "   \n", None])
def test_a_turn_with_no_reply_hands_nothing_back(root, monkeypatch, reply):
    _bind(monkeypatch, root, "apex-bot-2")
    handoff.on_post_llm_call(session_id="r1", platform="desktop", user_message=REQUEST, assistant_response=reply)
    assert not (root / "apex" / "handoff").exists()


def test_an_ordinary_turn_hands_nothing_back(root):
    handoff.on_post_llm_call(session_id="s1", platform="desktop", user_message="你好", assistant_response=REPLY)
    assert not (root / "apex" / "handoff").exists()


def _hand_back(root, monkeypatch, request: str = REQUEST, reply: str = REPLY, receiver: str = "apex-bot-2") -> None:
    _bind(monkeypatch, root, receiver)
    handoff.on_post_llm_call(session_id="r1", platform="desktop", user_message=request, assistant_response=reply)
    _bind(monkeypatch, root, "default")


def test_the_senders_next_turn_carries_it_once(root, monkeypatch):
    handoff.render_section({"platform": "desktop", "profile_name": "default", "session_id": "s1"})
    _hand_back(root, monkeypatch)

    first = handoff.on_pre_llm_call(session_id="s1", platform="desktop", user_message="怎么样了")
    second = handoff.on_pre_llm_call(session_id="s1", platform="desktop", user_message="好")

    assert first == "\n".join(
        (
            handoff.RETURNED.format(receiver="小剪"),
            "> 剪好了 30 秒版本，开头换成了第 2 个镜头，字幕已烧进去。",
            "文件：/Users/me/Movies/APEX/成片-30s.mp4",
            "链接：https://www.douyin.com/video/7300000000000000000",
            handoff.RETURNED_TAIL.format(receiver="小剪"),
        )
    )
    assert second is None
    assert list((root / "apex/handoff/returns/default").iterdir()) == []


def test_what_came_back_without_a_block_says_so(root, monkeypatch):
    _hand_back(root, monkeypatch, reply="视频放在哪里？\n\n第二段\n<!-- apex:next\n去小剪那边看 | 带我去看\n-->")

    [note] = handoff.take_returns("default")

    assert note == "\n".join(
        (
            handoff.RETURNED_BARE.format(receiver="小剪"),
            "> 视频放在哪里？\n>\n> 第二段",
            handoff.RETURNED_BARE_TAIL.format(receiver="小剪"),
        )
    )


def test_it_reaches_only_the_sender_and_only_on_desktop(root, monkeypatch):
    _hand_back(root, monkeypatch)

    _bind(monkeypatch, root, "apex-bot-3")
    assert handoff.on_pre_llm_call(session_id="", platform="desktop", user_message="你好") is None
    _bind(monkeypatch, root, "default")
    assert handoff.on_pre_llm_call(session_id="", platform="weixin", user_message="你好") is None
    assert handoff.on_pre_llm_call(session_id="", platform="subagent", user_message="你好") is None
    assert handoff.on_pre_llm_call(session_id="", platform="desktop", user_message="你好").startswith("（「小剪」")


def test_another_assistant_gets_what_apex_hands_back(root, monkeypatch):
    _hand_back(root, monkeypatch, request=CASES["request"]["cases"][1]["text"], receiver="default")
    _bind(monkeypatch, root, "apex-bot-2")

    note = handoff.on_pre_llm_call(session_id="", platform="desktop", user_message="好了吗")

    assert note.startswith(handoff.RETURNED.format(receiver="APEX"))
    assert not (root / "apex/handoff/returns/apex-bot-2/h2.json").exists()


def test_at_most_three_come_back_in_one_turn_oldest_first(root, monkeypatch):
    box = handoff.returns_dir("default")
    box.mkdir(parents=True)
    for n in range(5):
        entry = {"id": f"h{n}", "by": "apex-bot-2", "by_name": f"助手{n}", "at": time.time(), "summary": f"第{n}个", "has_summary": True}
        (box / f"h{n}.json").write_text(json.dumps(entry, ensure_ascii=False), encoding="utf-8")
        os.utime(box / f"h{n}.json", (1_000 + n, 1_000 + n))

    first = handoff.take_returns("default")
    second = handoff.take_returns("default")

    assert [note.split("」")[0] for note in first] == ["（「助手0", "（「助手1", "（「助手2"]
    assert [note.split("」")[0] for note in second] == ["（「助手3", "（「助手4"]
    assert handoff.take_returns("default") == []


def test_one_older_than_a_week_or_unreadable_is_dropped_unread(root):
    box = handoff.returns_dir("default")
    box.mkdir(parents=True)
    old = {"id": "old", "by_name": "小剪", "at": time.time() - handoff.RETURN_MAX_AGE_SECONDS - 60, "summary": "旧", "has_summary": True}
    (box / "old.json").write_text(json.dumps(old), encoding="utf-8")
    (box / "broken.json").write_text("{not json", encoding="utf-8")
    (box / "list.json").write_text("[]", encoding="utf-8")
    (box / ".tmp_x.json").write_text("{}", encoding="utf-8")

    assert handoff.take_returns("default") == []
    assert sorted(path.name for path in box.iterdir()) == [".tmp_x.json"]


def test_an_entry_another_engine_took_first_is_not_told_twice(root, monkeypatch):
    _hand_back(root, monkeypatch)
    real_replace = os.replace

    def lose_the_race(src, dst):
        real_replace(src, Path(dst).with_name(".someone-else.taken"))  # the other engine's claim lands first
        raise FileNotFoundError(src)

    monkeypatch.setattr(handoff.os, "replace", lose_the_race)
    assert handoff.take_returns("default") == []


def test_a_box_it_cannot_write_logs_and_the_turn_goes_on(root, monkeypatch, caplog):
    (root / "apex").mkdir()
    (root / "apex" / "handoff").write_text("not a directory", encoding="utf-8")
    _bind(monkeypatch, root, "apex-bot-2")

    handoff.on_post_llm_call(session_id="r1", platform="desktop", user_message=REQUEST, assistant_response=REPLY)

    assert "could not hand job h-20261028-0001 back to default" in caplog.text


# ── 4. a roster that changed after the prompt was frozen ─────────────────────


def test_a_new_session_built_with_the_roster_hears_nothing_more(root):
    handoff.render_section({"platform": "desktop", "profile_name": "default", "session_id": "s1"})
    assert handoff.on_pre_llm_call(session_id="s1", platform="desktop", user_message="你好") is None


def test_a_new_assistant_is_told_once(root):
    handoff.render_section({"platform": "desktop", "profile_name": "default", "session_id": "s1"})
    _profile(root, "apex-bot-4", "选题", 400, "## 分工\n- 主要帮用户：找选题\n")

    first = handoff.on_pre_llm_call(session_id="s1", platform="desktop", user_message="你好")
    second = handoff.on_pre_llm_call(session_id="s1", platform="desktop", user_message="你好")

    assert first == handoff.ROSTER_NOW.format(lines="- 小剪：剪辑出片，主要给抖音做\n- 文案：还没定分工\n- 选题：找选题")
    assert second is None


def test_a_restored_session_hears_the_roster_once(root):
    first = handoff.on_pre_llm_call(session_id="restored", platform="desktop", user_message="你好")
    assert first == handoff.ROSTER_NOW.format(lines="- 小剪：剪辑出片，主要给抖音做\n- 文案：还没定分工")
    assert handoff.on_pre_llm_call(session_id="restored", platform="desktop", user_message="你好") is None


def test_when_the_last_other_assistant_is_gone_it_stops_offering(root):
    import shutil

    handoff.render_section({"platform": "desktop", "profile_name": "default", "session_id": "s1"})
    for profile in ("apex-bot-2", "apex-bot-3"):
        shutil.rmtree(root / "profiles" / profile)

    assert handoff.on_pre_llm_call(session_id="s1", platform="desktop", user_message="你好") == handoff.ROSTER_NONE
    assert handoff.on_pre_llm_call(session_id="s1", platform="desktop", user_message="你好") is None


# ── 5. the chain through a real turn ─────────────────────────────────────────


def _response(content: str) -> SimpleNamespace:
    message = SimpleNamespace(content=content, tool_calls=None)
    return SimpleNamespace(choices=[SimpleNamespace(message=message, finish_reason="stop")], model="test/model", usage=None)


def _agent(session_id: str) -> AIAgent:
    with (
        patch("model_tools.get_tool_definitions", return_value=[]),
        patch("model_tools.check_toolset_requirements", return_value={}),
        patch("agent.process_bootstrap.OpenAI"),
    ):
        agent = AIAgent(
            api_key="test-key-1234567890",
            base_url="https://openrouter.ai/api/v1",
            model="test/model",
            platform="desktop",
            quiet_mode=True,
            skip_context_files=True,
            skip_memory=True,
            session_id=session_id,
        )
    agent.client = MagicMock()
    agent._use_prompt_caching = False
    agent.compression_enabled = False
    agent.save_trajectories = False
    return agent


def _run(agent: AIAgent, message: str, reply: str) -> dict:
    agent.client.chat.completions.create.side_effect = [_response(reply)]
    with (
        patch.object(agent, "_persist_session"),
        patch.object(agent, "_save_trajectory"),
        patch.object(agent, "_cleanup_task_resources"),
    ):
        return agent.run_conversation(message)


def _last_user(agent: AIAgent) -> str:
    sent = agent.client.chat.completions.create.call_args_list[-1].kwargs["messages"]
    content = [m for m in sent if m.get("role") == "user"][-1]["content"]
    return content if isinstance(content, str) else "".join(part.get("text", "") for part in content)


def _engine(monkeypatch, root: Path, profile: str) -> None:
    """Act as the engine process Desktop started for ``profile``: its home and its own plugin manager."""
    _bind(monkeypatch, root, profile)
    manager = _manager()
    assert handoff.apply(_ctx(manager)) is True
    monkeypatch.setattr(plugins, "_plugin_manager", manager)


def test_a_hand_over_and_its_return_through_real_turns(root, monkeypatch):
    monkeypatch.setattr(plugins, "_plugin_managers_by_home", {})
    monkeypatch.setattr(
        "agent.coding_context.build_coding_workspace_block",
        lambda cwd=None: "Workspace (snapshot at session start):\n- Root: /pinned",
    )

    # 小剪's engine takes the job in its own main thread.
    _engine(monkeypatch, root, "apex-bot-2")
    receiver = _agent("bot-main")
    result = _run(receiver, REQUEST, REPLY)
    assert _last_user(receiver).startswith(REQUEST + "\n\n" + handoff.TAKING.format(sender="APEX"))
    assert result["final_response"] == REPLY
    assert (root / "apex/handoff/returns/default/h-20261028-0001.json").is_file()

    # APEX's engine: the next turn carries the summary, the one after it does not.
    _engine(monkeypatch, root, "default")
    sender = _agent("apex-main")
    _run(sender, "剪好了吗？", "剪好了，30 秒版在小剪那边。")
    assert "> 剪好了 30 秒版本，开头换成了第 2 个镜头，字幕已烧进去。" in _last_user(sender)
    _run(sender, "好", "好的。")
    assert _last_user(sender) == "好"
