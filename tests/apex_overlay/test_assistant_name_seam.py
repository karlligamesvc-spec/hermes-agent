"""hc-1082 多助手 · 名字: each assistant's own name in the single-thread section, and apex_rename.

With several assistants on APEX Desktop, one assistant is one profile, and Desktop keeps its name in
that profile's ``profile.yaml`` ``ui_meta.apex.name`` (written through ``profiles.configure``). Desktop's
main process sets ``APEX_MULTI_BOT_ACTIVE=1`` next to ``APEX_SINGLE_THREAD_ACTIVE=1``. These tests pin:

1. Without that variable the section, the apex_memory schema and the tool list are what fork main built
   before this seam (a golden captured on main 50a50d1b), and adding the seam changes no tool.
2. With it, the section names the stored name (or APEX), tells the model to rename through the tool and
   keeps names out of the shared ledger; the apex_memory description says so too.
3. apex_rename writes the key the way ``profiles.configure`` does, checked with the gateway's own
   ``profiles.configure`` / ``profiles.list`` rather than this seam's reader.
4. A session renamed after its prompt was frozen hears the new name once.
"""

from __future__ import annotations

import difflib
import json
from pathlib import Path

import pytest

import hermes_yaml as yaml
from agent.system_prompt import build_system_prompt
from apex_overlay import assistant_name, memory_ledger, single_thread_prompt
from hermes_cli import plugins
from hermes_cli.plugins import PLUGIN_SECTIONS_END, PLUGIN_SECTIONS_START, PluginContext, PluginManager, PluginManifest
from run_agent import AIAgent
from tools.registry import registry

GOLDEN = Path(__file__).parent / "__identity__" / "multi-bot-off" / "before-hc1082.json"
LEDGER = "【APEX 记得的 · 记忆底账】\n关于你：\n- [3f2a9c1d] 不露脸，女声配音\n【APEX 记得的 · 完】\n"


@pytest.fixture
def root(tmp_path, monkeypatch):
    home = tmp_path / "apexnodes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv(single_thread_prompt.SWITCH_ENV, "1")
    monkeypatch.delenv(assistant_name.SWITCH_ENV, raising=False)
    monkeypatch.setattr(assistant_name, "_told", {})
    return home


@pytest.fixture
def multi_bot(root, monkeypatch):
    monkeypatch.setenv(assistant_name.SWITCH_ENV, "1")
    return root


def _named(root: Path, name: str = "cut") -> Path:
    home = root / "profiles" / name
    home.mkdir(parents=True)
    (home / "SOUL.md").write_text("You are APEX.", encoding="utf-8")
    return home


def _store(home: Path, ui_meta: dict, **extra) -> None:
    (home / "profile.yaml").write_text(yaml.safe_dump({**extra, "ui_meta": ui_meta}), encoding="utf-8")


# ── the switch ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("multi", "single", "on"),
    [("1", "1", True), (" 1 ", "1", True), ("1", "", False), ("", "1", False), ("true", "1", False), ("0", "1", False)],
)
def test_the_switch_needs_both_launch_variables(root, monkeypatch, multi, single, on):
    monkeypatch.setenv(assistant_name.SWITCH_ENV, multi)
    monkeypatch.setenv(single_thread_prompt.SWITCH_ENV, single)
    assert assistant_name.switch_on() is on
    assert (assistant_name.name_rules({}) != "") is on
    assert (memory_ledger.schema() is memory_ledger.SCHEMA) is not on


# ── 1. switch off: byte for byte what main built ─────────────────────────────


def _manager(*seams) -> PluginManager:
    manager = PluginManager()
    manager._discovered = True
    ctx = PluginContext(PluginManifest(name="apex-overlay", key="apex-overlay", source="bundled"), manager)
    for seam in seams:
        assert seam.apply(ctx) is True
    return manager


def _real_agent(session_id: str, platform: str = "cli") -> AIAgent:
    return AIAgent(
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


def _callable_names(agent: AIAgent) -> set[str]:
    from agent.tool_executor import _tool_search_scoped_names

    return {tool["function"]["name"] for tool in (agent.tools or [])} | set(_tool_search_scoped_names(agent))


@pytest.fixture
def seams(root, monkeypatch):
    """A real agent's prompt and tools with the given seams registered; registrations undone after."""
    import model_tools

    (root / "apex").mkdir()
    (root / "apex" / "memory-ledger-prompt.md").write_text(LEDGER, encoding="utf-8")
    monkeypatch.setattr(
        "agent.coding_context.build_coding_workspace_block",
        lambda cwd=None: "Workspace (snapshot at session start):\n- Root: /pinned",
    )

    def build(*modules, session_id="s"):
        model_tools._clear_tool_defs_cache()
        monkeypatch.setattr(plugins, "_plugin_manager", _manager(*modules))
        agent = _real_agent(session_id)
        return agent, build_system_prompt(agent)

    try:
        yield build
    finally:
        registry.deregister(memory_ledger.TOOL_NAME)
        registry.deregister(assistant_name.TOOL_NAME)
        model_tools._clear_tool_defs_cache()


def test_switch_off_matches_what_main_built_before_this_seam(seams):
    agent, prompt = seams(memory_ledger, single_thread_prompt, assistant_name)
    start = prompt.index(PLUGIN_SECTIONS_START)
    end = prompt.index(PLUGIN_SECTIONS_END) + len(PLUGIN_SECTIONS_END)
    apex_tools = sorted(name for name in _callable_names(agent) if name.startswith("apex_"))
    snapshot = {
        "plugin_sections": prompt[start:end],
        "apex_tools": apex_tools,
        "apex_tool_schemas": {name: registry.get_entry(name).schema for name in apex_tools},
    }
    assert snapshot == json.loads(GOLDEN.read_text(encoding="utf-8"))
    assert single_thread_prompt.render_section({"profile_name": "default"}) == single_thread_prompt.SINGLE_THREAD_PROMPT


def test_switch_off_the_seam_changes_no_tool(seams):
    def tools(agent):
        return json.dumps(agent.tools, ensure_ascii=False, sort_keys=True), sorted(_callable_names(agent))

    without, _ = seams(memory_ledger, single_thread_prompt, session_id="without")
    with_seam, _ = seams(memory_ledger, single_thread_prompt, assistant_name, session_id="with")
    assert tools(with_seam) == tools(without)
    assert assistant_name.TOOL_NAME not in _callable_names(with_seam)


def test_switch_off_registers_nothing(root):
    from toolsets import resolve_toolset

    listed = sorted(resolve_toolset(assistant_name.TOOLSET))
    manager = _manager(assistant_name)
    assert sorted(resolve_toolset(assistant_name.TOOLSET)) == listed
    assert registry.get_entry(assistant_name.TOOL_NAME) is None
    assert assistant_name.on_pre_llm_call not in manager._hooks.get("pre_llm_call", [])


def test_switch_on_a_new_session_carries_the_name_and_the_tool(multi_bot, seams):
    _store(multi_bot, {"apex": {"name": "小李", "shape": "circle", "color": "violet"}})
    agent, prompt = seams(memory_ledger, single_thread_prompt, assistant_name)
    assert "- 你叫小李，是用户在 APEX 里的主助手。" in prompt
    assert single_thread_prompt.NAME_RULE not in prompt
    assert {assistant_name.TOOL_NAME, memory_ledger.TOOL_NAME} <= _callable_names(agent)
    assert registry.get_entry(memory_ledger.TOOL_NAME).schema["description"].endswith(memory_ledger.NOT_FOR_ASSISTANTS)


def test_the_tool_name_has_no_close_core_tool_to_be_repaired_into():
    from toolsets import _HERMES_CORE_TOOLS

    assert difflib.get_close_matches(assistant_name.TOOL_NAME, list(_HERMES_CORE_TOOLS), cutoff=0.7) == []


# ── 2. what the section says ─────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("profile", "stored", "says", "not_says"),
    [
        ("default", None, ["你叫 APEX，是用户在 APEX 里的主助手", "记忆底账里要是记着用户以前给你起的名字"], ["不是你的名字"]),
        ("default", "小李", ["你叫小李，是用户在 APEX 里的主助手", "旧名字都不算，以这一条为准"], ["不是你的名字", "你叫 APEX"]),
        ("cut", "小剪", ["你叫小剪，是用户在 APEX 里的一个助手，不是主助手 APEX", "是用户对主助手 APEX 说的，不是你的名字",
                         "平台规则里说的「APEX」指这个平台"], ["你叫 APEX"]),
        ("cut", None, ["- 你叫 APEX。", "是用户对主助手 APEX 说的，不是你的名字"], ["主助手；"]),
    ],
    ids=["main-unnamed", "main-renamed", "assistant-named", "assistant-unnamed"],
)
def test_the_name_lines_follow_this_profile(multi_bot, profile, stored, says, not_says):
    home = multi_bot if profile == "default" else _named(multi_bot, profile)
    if stored:
        _store(home, {"apex": {"name": stored}})
    section = single_thread_prompt.render_section({"profile_name": profile, "session_id": "s"})
    for text in says + ["用 apex_rename 存好新名字", "你的名字和分工只属于你，不记进底账", "用户想让你怎么称呼他，照常记"]:
        assert text in section
    for text in not_says + ["把这个名字记进记忆"]:
        assert text not in section


def test_every_other_rule_stays_word_for_word(multi_bot):
    section = single_thread_prompt.render_section({"profile_name": "default"})
    rules = single_thread_prompt.SINGLE_THREAD_PROMPT.splitlines()
    assert rules[1] == single_thread_prompt.NAME_RULE
    head, tail = rules[0] + "\n", "\n" + "\n".join(rules[2:])
    assert section.startswith(head) and section.endswith(tail)
    # Only the name line is swapped, for three: the name, the rename tool, the shared ledger.
    name_lines = section[len(head) : len(section) - len(tail)].splitlines()
    assert len(name_lines) == 3 and single_thread_prompt.NAME_RULE not in name_lines


def test_the_section_fits_its_cap_with_the_longest_name(multi_bot):
    home = _named(multi_bot)
    _store(home, {"apex": {"name": "名" * assistant_name.MAX_STORED_CHARS}})
    section = single_thread_prompt.render_section({"profile_name": "cut"})
    assert "名" * assistant_name.MAX_STORED_CHARS in section
    assert len(section) <= single_thread_prompt.MAX_CHARS


@pytest.mark.parametrize(
    "content",
    [
        "ui_meta: [1, 2]\n",
        "ui_meta:\n  apex: 小李\n",
        "ui_meta:\n  apex:\n    name: '   '\n",
        f"ui_meta:\n  apex:\n    name: {'长' * (assistant_name.MAX_STORED_CHARS + 1)}\n",
        "- not\n- a mapping\n",
        "ui_meta: {apex: {name: 小李\n",
    ],
    ids=["ui-meta-list", "entry-string", "blank-name", "too-long", "not-a-mapping", "unparseable"],
)
def test_an_unusable_stored_name_reads_as_none(multi_bot, content):
    (multi_bot / "profile.yaml").write_text(content, encoding="utf-8")
    assert assistant_name.stored_name(multi_bot) == ""
    assert "- 你叫 APEX，" in single_thread_prompt.render_section({"profile_name": "default"})


# ── 3. apex_rename writes what profiles.configure writes ─────────────────────


def _configure(name: str, ui_meta: dict, expected: dict | None = None) -> dict:
    import tui_gateway.server as srv

    params = {"name": name, "ui_meta": ui_meta}
    if expected is not None:
        params["ui_meta_expected_revisions"] = expected
    return srv._methods["profiles.configure"]("configure", params)["result"]["applied"]


def _roster_row(name: str) -> dict:
    import tui_gateway.server as srv

    rows = srv._methods["profiles.list"]("list", {"include_sessions": False})["result"]["profiles"]
    return next(row for row in rows if row["name"] == name)


def test_a_rename_reaches_the_roster_and_keeps_desktops_look(multi_bot, monkeypatch):
    home = _named(multi_bot)
    monkeypatch.setenv("HERMES_HOME", str(home))  # this assistant's own engine: hermes --profile cut
    (home / "profile.yaml").write_text(
        yaml.safe_dump({"description": "剪片", "display_name": "Cut", "_ui_meta_revisions": {"hermes-bots": 4},
                        "ui_meta": {"hermes-bots": {"title": "Cut"}}}),
        encoding="utf-8",
    )
    saved = _configure("cut", {"apex": {"name": "小剪", "shape": "square", "color": "teal"}}, {"apex": 0})
    assert saved["ui_meta_revisions"] == {"apex": 1}
    assert _roster_row("cut")["ui_meta"]["apex"]["name"] == "小剪"  # the roster memo is warm now

    result = json.loads(assistant_name.handle({"name": " 「阿剪」 "}, session_id="s"))
    assert result == {"ok": True, "name": "阿剪", "previous": "小剪"}

    row = _roster_row("cut")
    assert row["ui_meta"] == {"hermes-bots": {"title": "Cut"}, "apex": {"name": "阿剪", "shape": "square", "color": "teal"}}
    assert row["ui_meta_revisions"] == {"hermes-bots": 4, "apex": 2}
    assert (row["description"], row["display_name"]) == ("剪片", "Cut")
    assert not (multi_bot / "profile.yaml").exists(), "only this assistant is renamed, never APEX"

    # Desktop's save still holding revision 1 is refused, so it re-reads instead of undoing the rename.
    stale = _configure("cut", {"apex": {"name": "小剪", "shape": "circle", "color": "teal"}}, {"apex": 1})
    assert stale["ui_meta"] is False
    assert stale["ui_meta_conflicts"] == {"apex": {"expected": 1, "actual": 2}}
    assert _roster_row("cut")["ui_meta"]["apex"]["name"] == "阿剪"


def test_a_rename_leaves_the_file_profiles_configure_would(multi_bot):
    """One rename, two writers: this tool and Desktop's ``profiles.configure`` end on the same document."""
    start = {
        "description": "剪片",
        "ui_meta": {"hermes-bots": {"title": "Cut"}, "apex": {"name": "小剪", "shape": "square", "color": "teal"}},
        "_ui_meta_revisions": {"hermes-bots": 4, "apex": 3},
    }
    tool_home, desktop_home = _named(multi_bot, "cut"), _named(multi_bot, "twin")
    for home in (tool_home, desktop_home):
        (home / "profile.yaml").write_text(yaml.safe_dump(start), encoding="utf-8")

    assistant_name.write_name(tool_home, "阿剪")
    saved = _configure("twin", {"apex": {**start["ui_meta"]["apex"], "name": "阿剪"}}, {"apex": 3})

    assert saved["ui_meta_revisions"] == {"apex": 4}
    assert yaml.safe_load((tool_home / "profile.yaml").read_text(encoding="utf-8")) == yaml.safe_load(
        (desktop_home / "profile.yaml").read_text(encoding="utf-8")
    )


def test_a_rename_keeps_the_product_origin_mark(multi_bot, monkeypatch):
    """M2 marks assistants it creates with ``origin: "product"`` (M4's tier follows APEX only for those)."""
    home = _named(multi_bot)
    monkeypatch.setenv("HERMES_HOME", str(home))
    _store(home, {"apex": {"name": "小剪", "shape": "square", "color": "teal", "origin": "product"}})
    assistant_name.handle({"name": "阿剪"})
    stored = yaml.safe_load((home / "profile.yaml").read_text(encoding="utf-8"))["ui_meta"]["apex"]
    assert stored == {"name": "阿剪", "shape": "square", "color": "teal", "origin": "product"}


def test_a_rename_never_marks_a_profile_as_product(multi_bot, monkeypatch):
    """A developer-mode bot renamed in chat gets only a name, so it does not start following APEX's tier."""
    home = _named(multi_bot)
    monkeypatch.setenv("HERMES_HOME", str(home))
    _store(home, {"hermes-bots": {"title": "Worker"}})
    assistant_name.handle({"name": "阿剪"})
    ui_meta = yaml.safe_load((home / "profile.yaml").read_text(encoding="utf-8"))["ui_meta"]
    assert ui_meta == {"hermes-bots": {"title": "Worker"}, "apex": {"name": "阿剪"}}


def test_the_same_name_again_leaves_the_revision(multi_bot):
    json.loads(assistant_name.handle({"name": "小李"}))
    before = (multi_bot / "profile.yaml").read_bytes()
    assert json.loads(assistant_name.handle({"name": "小李"})) == {"ok": True, "name": "小李", "previous": "小李"}
    assert (multi_bot / "profile.yaml").read_bytes() == before
    assert yaml.safe_load(before)["_ui_meta_revisions"] == {"apex": 1}


@pytest.mark.parametrize(
    ("args", "error"),
    [
        ({}, assistant_name.NO_NAME),
        ({"name": " 「」 "}, assistant_name.NO_NAME),
        ({"name": "名" * (assistant_name.MAX_NAME_CHARS + 1)}, assistant_name.TOO_LONG),
        (None, assistant_name.NO_NAME),
    ],
    ids=["missing", "only-quotes", "too-long", "no-args"],
)
def test_bad_names_are_refused_and_nothing_is_written(multi_bot, args, error):
    assert json.loads(assistant_name.handle(args)) == {"error": error}
    assert not (multi_bot / "profile.yaml").exists()


def test_a_name_at_the_limit_is_kept(multi_bot):
    name = "名" * assistant_name.MAX_NAME_CHARS
    assert json.loads(assistant_name.handle({"name": name}))["name"] == name


def test_with_the_switch_off_the_tool_refuses_and_writes_nothing(root):
    assert json.loads(assistant_name.handle({"name": "小李"})) == {"error": assistant_name.SWITCH_OFF}
    assert not (root / "profile.yaml").exists()


@pytest.mark.parametrize(
    "content",
    ["- not\n- a mapping\n", "ui_meta: {apex: {name: 小李\n"],
    ids=["not-a-mapping", "unparseable"],
)
def test_a_profile_file_it_cannot_read_is_never_replaced(multi_bot, content):
    (multi_bot / "profile.yaml").write_text(content, encoding="utf-8")
    assert json.loads(assistant_name.handle({"name": "小李"})) == {"error": assistant_name.NOT_SAVED}
    assert (multi_bot / "profile.yaml").read_text(encoding="utf-8") == content


# The SOUL first line: the name's second home, written by Desktop too (hc-1078), one shared case file.
SOUL_CASES = json.loads(
    (Path(__file__).resolve().parents[2] / "apps/desktop/shared/apex-bot-soul-cases.json").read_text(encoding="utf-8")
)
TEMPLATE_BODY = "\n\nYou are helpful, knowledgeable, and direct.\n\n## 分工\n剪辑出片\n"


def test_the_soul_line_is_the_one_desktop_writes():
    assert assistant_name.SOUL_NAME_LINE == SOUL_CASES["name_line_template"]
    for case in SOUL_CASES["name_lines"]:
        assert assistant_name.rename_in_soul(SOUL_CASES["name_lines"][0]["line"], case["name"]) == case["line"]


@pytest.mark.parametrize("case", SOUL_CASES["parse"], ids=[f"parse-{i}" for i in range(len(SOUL_CASES["parse"]))])
def test_the_soul_line_parses_like_desktop(case):
    assert assistant_name.soul_name(case["soul"]) == case["name"]


@pytest.mark.parametrize("case", SOUL_CASES["rename"], ids=[f"rename-{i}" for i in range(len(SOUL_CASES["rename"]))])
def test_the_soul_line_renames_like_desktop(case):
    assert assistant_name.rename_in_soul(case["soul"], case["next"]) == case["expected"]


@pytest.mark.parametrize(
    ("soul", "renamed"),
    [
        (assistant_name.SOUL_NAME_LINE.format(name="小剪") + TEMPLATE_BODY,
         assistant_name.SOUL_NAME_LINE.format(name="阿剪") + TEMPLATE_BODY),
        ((assistant_name.SOUL_NAME_LINE.format(name="小剪") + TEMPLATE_BODY).replace("\n", "\r\n"),
         assistant_name.SOUL_NAME_LINE.format(name="阿剪") + TEMPLATE_BODY),
        ("You are my editor.\nMore.\n", None),
        ("You are APEX, an intelligent AI assistant from ApexNodes HK. You are helpful.\n", None),
    ],
    ids=["template", "template-crlf", "hand-written", "apex-identity"],
)
def test_a_rename_carries_into_a_template_soul_only(multi_bot, monkeypatch, soul, renamed):
    home = _named(multi_bot)
    monkeypatch.setenv("HERMES_HOME", str(home))
    (home / "SOUL.md").write_bytes(soul.encode("utf-8"))
    assert json.loads(assistant_name.handle({"name": "阿剪"}))["ok"] is True
    assert (home / "SOUL.md").read_bytes().decode("utf-8") == (renamed if renamed is not None else soul)


def test_apexs_own_soul_is_never_rewritten(multi_bot):
    soul = assistant_name.SOUL_NAME_LINE.format(name="APEX") + TEMPLATE_BODY
    (multi_bot / "SOUL.md").write_text(soul, encoding="utf-8")
    assert json.loads(assistant_name.handle({"name": "小李"}))["name"] == "小李"
    assert assistant_name.stored_name(multi_bot) == "小李"
    assert (multi_bot / "SOUL.md").read_text(encoding="utf-8") == soul


def test_a_soul_line_already_naming_it_is_left_as_written(multi_bot, monkeypatch):
    home = _named(multi_bot)
    monkeypatch.setenv("HERMES_HOME", str(home))
    soul = (assistant_name.SOUL_NAME_LINE.format(name="阿剪") + TEMPLATE_BODY).replace("\n", "\r\n").encode("utf-8")
    (home / "SOUL.md").write_bytes(soul)
    assistant_name.handle({"name": "阿剪"})
    assert (home / "SOUL.md").read_bytes() == soul


def test_the_same_name_still_heals_a_stale_soul_line(multi_bot, monkeypatch):
    home = _named(multi_bot)
    monkeypatch.setenv("HERMES_HOME", str(home))
    _store(home, {"apex": {"name": "阿剪"}})
    (home / "SOUL.md").write_text(assistant_name.SOUL_NAME_LINE.format(name="小剪") + TEMPLATE_BODY, encoding="utf-8")
    assistant_name.handle({"name": "阿剪"})
    assert assistant_name.soul_name((home / "SOUL.md").read_text(encoding="utf-8")) == "阿剪"


def test_a_soul_it_cannot_write_still_keeps_the_stored_name(multi_bot, monkeypatch):
    import utils

    def refuse(*_args, **_kwargs):
        raise PermissionError("read-only")

    home = _named(multi_bot)
    monkeypatch.setenv("HERMES_HOME", str(home))
    soul = assistant_name.SOUL_NAME_LINE.format(name="小剪") + TEMPLATE_BODY
    (home / "SOUL.md").write_text(soul, encoding="utf-8")
    monkeypatch.setattr(utils, "atomic_write_bytes", refuse)
    assert json.loads(assistant_name.handle({"name": "阿剪"})) == {"ok": True, "name": "阿剪", "previous": "APEX"}
    assert assistant_name.stored_name(home) == "阿剪"
    assert (home / "SOUL.md").read_text(encoding="utf-8") == soul


def test_the_write_holds_the_gateways_ui_meta_lock_when_it_runs_there():
    import tui_gateway.server as srv

    assert assistant_name._ui_meta_lock() is srv._profile_ui_meta_lock


# ── 4. a rename after the prompt was frozen ──────────────────────────────────


def test_a_rename_from_the_sidebar_is_said_once(multi_bot):
    _store(multi_bot, {"apex": {"name": "小李"}})
    single_thread_prompt.render_section({"profile_name": "default", "session_id": "s"})
    assert assistant_name.on_pre_llm_call(session_id="s", platform="desktop") is None

    _configure("default", {"apex": {"name": "阿杰"}})
    assert assistant_name.on_pre_llm_call(session_id="s", platform="desktop") == assistant_name.NAME_CHANGED.format(name="阿杰")
    assert assistant_name.on_pre_llm_call(session_id="s", platform="desktop") is None


def test_a_real_turn_carries_the_note_after_a_sidebar_rename(multi_bot, seams):
    from agent.turn_context import _collect_pre_llm_call_context

    _store(multi_bot, {"apex": {"name": "小李"}})
    agent, prompt = seams(memory_ledger, single_thread_prompt, assistant_name, session_id="day")
    assert "你叫小李" in prompt

    def turn():
        return _collect_pre_llm_call_context(agent, effective_task_id="t", turn_id="1", original_user_message="在吗",
                                             messages=[], conversation_history=[{"role": "user", "content": "早"}])

    assert turn() == ""
    _configure("default", {"apex": {"name": "阿杰"}})
    assert turn() == assistant_name.NAME_CHANGED.format(name="阿杰")
    assert turn() == ""


def test_the_sessions_own_rename_needs_no_note(multi_bot):
    single_thread_prompt.render_section({"profile_name": "default", "session_id": "s"})
    assistant_name.handle({"name": "小李"}, session_id="s")
    assert assistant_name.on_pre_llm_call(session_id="s", platform="desktop") is None


@pytest.mark.parametrize(
    ("stored", "note"), [("小李", assistant_name.NAME_NOW.format(name="小李")), (None, None)], ids=["stored", "none"]
)
def test_a_restored_session_hears_a_stored_name_once(multi_bot, stored, note):
    if stored:
        _store(multi_bot, {"apex": {"name": stored}})
    assert assistant_name.on_pre_llm_call(session_id="restored", platform="desktop") == note
    assert assistant_name.on_pre_llm_call(session_id="restored", platform="desktop") is None


@pytest.mark.parametrize("platform", sorted(assistant_name.NON_INTERACTIVE_PLATFORMS))
def test_no_note_off_screen_or_with_the_switch_off(multi_bot, monkeypatch, platform):
    _store(multi_bot, {"apex": {"name": "小李"}})
    assert assistant_name.on_pre_llm_call(session_id="s", platform=platform) is None
    monkeypatch.delenv(assistant_name.SWITCH_ENV)
    assert assistant_name.on_pre_llm_call(session_id="s", platform="desktop") is None


# ── registration ─────────────────────────────────────────────────────────────


def test_registering_twice_or_without_a_host_reports_false(multi_bot):
    manager = _manager(assistant_name)
    try:
        assert manager._hooks["pre_llm_call"] == [assistant_name.on_pre_llm_call]
        ctx = PluginContext(PluginManifest(name="apex-overlay", key="apex-overlay", source="bundled"), manager)
        assert assistant_name.apply(ctx) is False
        assert manager._hooks["pre_llm_call"] == [assistant_name.on_pre_llm_call]
        assert assistant_name.apply(None) is False
    finally:
        registry.deregister(assistant_name.TOOL_NAME)


def test_plugin_register_applies_the_seam():
    from tests.apex_overlay.conftest import run_plugin_register_with_stubbed_seams

    called = run_plugin_register_with_stubbed_seams("_assistant_name_plugin_under_test")
    assert "assistant_name" in called
