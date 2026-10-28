"""hc-1095 版本照实说: what APEX Desktop says about its version, whether it is the newest and how to update.

Desktop's main process mirrors the app version, the shipped engine and the updater's state into
``<root>/apex/desktop-version.json`` (apps/desktop/electron/apex-version-state.ts); this seam words it
while single-thread mode is on (``APEX_SINGLE_THREAD_ACTIVE=1``). These tests pin, in a real agent's
prompt, the words for "downloaded, waiting", "already the newest" and "install put off"; that the
engine's "You run on Hermes Agent" line becomes an APEX line; that a running session hears a change
once; who gets the section; and that with the switch off, or in a cloud container, every prompt is
byte for byte the one built without this seam. The file's codes are pinned against the TypeScript
writer and the update pill's own words.
"""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from pathlib import Path

import pytest

from agent import prompt_builder, system_prompt
from agent.system_prompt import build_system_prompt
from apex_overlay import desktop_version, single_thread_prompt
from hermes_cli import plugins
from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest
from run_agent import AIAgent

ROOT = Path(__file__).resolve().parents[2]
DESKTOP = ROOT / "apps" / "desktop"
PIN = {"commit": "aa8e554e3878d08d3448474290bc0eb07a1e3f78", "version": "v2026.10.27-fork.aa8e554e"}
UPSTREAM_LINE = "You run on Hermes Agent (by Nous Research)."


@pytest.fixture(autouse=True)
def _home(monkeypatch, tmp_path):
    monkeypatch.delenv(single_thread_prompt.SWITCH_ENV, raising=False)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "apexnodes"))
    # The seam patches agent.system_prompt in place; these make every test undo it.
    for name in desktop_version._HELP_ATTRS:
        monkeypatch.setattr(system_prompt, name, getattr(prompt_builder, name))
    monkeypatch.setattr(
        "agent.coding_context.build_coding_workspace_block",
        lambda cwd=None: "Workspace (snapshot at session start):\n- Root: /pinned",
    )
    # Two builds compared byte for byte must not straddle midnight.
    monkeypatch.setattr("hermes_time.now", lambda: datetime(2026, 10, 28, 12, 0, tzinfo=UTC))
    return tmp_path / "apexnodes"


@pytest.fixture
def switch_on(monkeypatch):
    monkeypatch.setenv(single_thread_prompt.SWITCH_ENV, "1")


def _write_state(home: Path, update: dict, app_version: str = "0.17.63", engine: dict | None = PIN) -> dict:
    state = {"schema": 1, "app_version": app_version, "engine": engine, "update": update}
    (home / "apex").mkdir(parents=True, exist_ok=True)
    (home / "apex" / "desktop-version.json").write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
    return state


DOWNLOADED = {"status": "downloaded", "version": "0.17.66", "reason": None}
LATEST = {"status": "latest", "version": None, "reason": None}
DEFERRED = {"status": "deferred", "version": "0.17.66", "reason": "gateway_busy"}


def _manager(*seams) -> PluginManager:
    manager = PluginManager()
    manager._discovered = True
    ctx = PluginContext(PluginManifest(name="apex-overlay", key="apex-overlay", source="bundled"), manager)
    for seam in seams:
        assert seam.apply(ctx) is True
    return manager


def _agent(monkeypatch, manager, session_id: str = "day", platform: str = "tui") -> AIAgent:
    monkeypatch.setattr(plugins, "_plugin_manager", manager)
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


def _prompt(monkeypatch, *seams, session_id: str = "day", platform: str = "tui") -> str:
    return build_system_prompt(_agent(monkeypatch, _manager(*seams), session_id, platform))


def _turn(agent: AIAgent) -> str:
    from agent.turn_context import _collect_pre_llm_call_context

    return _collect_pre_llm_call_context(agent, effective_task_id="t", turn_id="1", original_user_message="你现在是哪个版本",
                                         messages=[], conversation_history=[{"role": "user", "content": "早"}])


# ── 1. the three states, in a real agent's prompt ────────────────────────────

RULE_LINES = (
    "- 用户问你是什么版本、是不是最新、怎么更新时，就照上面两行回答：报 APEX 的版本号和更新情况；要更新，告诉他"
    "在电脑上的 APEX 里点左下角的「安装并重启」；没看到这个按钮，就到 设置 › 个性化 点「立即检查」。\n"
    "- 不要用终端命令、网页搜索或 GitHub 去查版本，也不要拿任何别的软件或开源项目的版本号来比：那些都不是 APEX 的版本。\n"
    "- 你就是 APEX，不说自己“跑在”别的产品或框架上；不提出帮用户升级引擎、内核，也不去改系统设置或安装目录里的文件。\n"
    "- 对话中途更新情况有变，会另外告诉你最新的，以最新那条为准。"
)


@pytest.mark.usefixtures("switch_on")
@pytest.mark.parametrize(
    ("update", "update_line"),
    [
        pytest.param(DOWNLOADED, "新版 0.17.66 已经下载好了，还没装：点左下角的「安装并重启」就能装上。", id="downloaded"),
        pytest.param(LATEST, "已经是最新版本。", id="latest"),
        pytest.param(
            DEFERRED,
            "新版 0.17.66 已经下载好，也点过「安装并重启」了，正在等：消息渠道还在回复消息，回复完自动安装更新。",
            id="deferred",
        ),
    ],
)
def test_a_new_session_carries_the_version_and_update_state(monkeypatch, _home, update, update_line):
    _write_state(_home, update)

    prompt = _prompt(monkeypatch, desktop_version)

    assert "## Plugin Context: apex.desktop-version" in prompt
    assert (
        "【APEX 版本和更新 · 平台信息】\n"
        "- 版本：APEX 0.17.63（自带的 AI 引擎 2026.10.27，跟着 APEX 一起更新）\n"
        f"- 更新：{update_line}\n" + RULE_LINES
    ) in prompt


@pytest.mark.usefixtures("switch_on")
def test_the_engines_hermes_agent_line_becomes_an_apex_line(monkeypatch, _home):
    _write_state(_home, LATEST)
    assert UPSTREAM_LINE in _prompt(monkeypatch), "the upstream source line moved; re-check where it comes from"

    prompt = _prompt(monkeypatch, desktop_version)

    assert UPSTREAM_LINE not in prompt
    assert "hermes-agent.nousresearch.com" not in prompt
    assert desktop_version.APEX_HELP_GUIDANCE in prompt
    assert prompt.count(desktop_version.APEX_HELP_GUIDANCE) == 1
    # Both variants: the skill-pointer one is used when the hermes-agent skill is installed and enabled.
    assert system_prompt.HERMES_AGENT_HELP_GUIDANCE == desktop_version.APEX_HELP_GUIDANCE
    assert system_prompt.HERMES_AGENT_HELP_GUIDANCE_NO_SKILLS == desktop_version.APEX_HELP_GUIDANCE


@pytest.mark.usefixtures("switch_on")
def test_no_internal_name_reaches_the_users_words(monkeypatch, _home):
    for update in (DOWNLOADED, LATEST, DEFERRED, {"status": "error"}, {"status": "unchecked"}, {"status": "unavailable"}):
        state = _write_state(_home, update)
        for text in (desktop_version.section_text(state), desktop_version.note_text(state)):
            assert not re.search(r"(?i)hermes|nous|fork|aa8e554e", text), text
            assert len(text) <= desktop_version.MAX_CHARS


# ── 2. off, cloud, and who gets it ───────────────────────────────────────────


@pytest.mark.parametrize("with_file", [True, False], ids=["desktop-switch-off", "cloud-no-file"])
def test_switch_off_builds_the_prompt_built_without_this_seam(monkeypatch, _home, with_file):
    if with_file:
        _write_state(_home, DOWNLOADED)
    for platform in ("tui", "weixin", "subagent", "cron"):
        without = _prompt(monkeypatch, single_thread_prompt, platform=platform)
        with_seam = _prompt(monkeypatch, single_thread_prompt, desktop_version, platform=platform)

        assert with_seam == without, platform
        assert UPSTREAM_LINE in with_seam
        assert "apex.desktop-version" not in with_seam
    assert system_prompt.HERMES_AGENT_HELP_GUIDANCE_NO_SKILLS == prompt_builder.HERMES_AGENT_HELP_GUIDANCE_NO_SKILLS
    assert not (_home / "apex" / "desktop-version-told.json").exists()


@pytest.mark.usefixtures("switch_on")
@pytest.mark.parametrize(
    ("platform", "carried"),
    [("tui", True), ("cli", True), ("weixin", True), ("feishu", True), ("subagent", False), ("cron", False),
     ("webhook", False), ("api_server", False)],
)
def test_who_gets_the_section(monkeypatch, _home, platform, carried):
    _write_state(_home, DOWNLOADED)

    prompt = _prompt(monkeypatch, desktop_version, platform=platform)

    assert ("## Plugin Context: apex.desktop-version" in prompt) is carried
    # The engine line is replaced process-wide, so a subagent or cron run carries the APEX line too.
    assert UPSTREAM_LINE not in prompt


@pytest.mark.usefixtures("switch_on")
@pytest.mark.parametrize(
    "content",
    ["", "not json", json.dumps({"schema": 2, "app_version": "0.17.63"}), json.dumps({"schema": 1, "app_version": "Hermes"}),
     json.dumps(["0.17.63"])],
    ids=["empty", "garbage", "newer-schema", "bad-version", "not-an-object"],
)
def test_no_usable_file_no_section(monkeypatch, _home, content):
    (_home / "apex").mkdir(parents=True)
    (_home / "apex" / "desktop-version.json").write_text(content, encoding="utf-8")
    assert desktop_version.render_section({"platform": "tui", "session_id": "s"}) == ""
    assert desktop_version.on_pre_llm_call(session_id="s", platform="tui") is None


# ── 3. a running session hears a change once ─────────────────────────────────


@pytest.mark.usefixtures("switch_on")
def test_a_real_turn_hears_a_change_once(monkeypatch, _home):
    _write_state(_home, {"status": "downloading", "version": "0.17.66", "reason": None})
    agent = _agent(monkeypatch, _manager(desktop_version))
    assert "新版 0.17.66，正在后台下载" in build_system_prompt(agent)
    assert _turn(agent) == ""

    state = _write_state(_home, DOWNLOADED)
    assert _turn(agent) == (
        "（APEX 版本信息有变化，以这条为准：APEX 0.17.63（自带的 AI 引擎 2026.10.27，跟着 APEX 一起更新）；"
        "更新：新版 0.17.66 已经下载好了，还没装：点左下角的「安装并重启」就能装上。"
        "被问版本、是不是最新、怎么更新时照这条说，不去查别的。）"
    )
    assert _turn(agent) == ""
    assert desktop_version.note_text(state) in desktop_version.NOTE.format(
        version_line=desktop_version.version_line(state), update=desktop_version.update_sentence(state))


@pytest.mark.usefixtures("switch_on")
def test_after_an_update_a_restored_session_hears_the_new_version_once(_home):
    _write_state(_home, DOWNLOADED)
    desktop_version.render_section({"platform": "tui", "session_id": "day"})
    assert desktop_version.on_pre_llm_call(session_id="day", platform="tui") is None

    # The app restarts as 0.17.66: the stored prompt still says 0.17.63; what it was given survived on disk.
    _write_state(_home, LATEST, app_version="0.17.66")
    note = desktop_version.on_pre_llm_call(session_id="day", platform="tui")
    assert note is not None and "APEX 0.17.66" in note and "已经是最新版本。" in note
    assert desktop_version.on_pre_llm_call(session_id="day", platform="tui") is None


@pytest.mark.usefixtures("switch_on")
def test_a_restart_alone_says_nothing_but_a_session_from_before_hears_it_once(_home):
    _write_state(_home, LATEST)
    desktop_version.render_section({"platform": "tui", "session_id": "day"})
    told = json.loads((_home / "apex" / "desktop-version-told.json").read_text(encoding="utf-8"))
    assert list(told) == ["day"]

    assert desktop_version.on_pre_llm_call(session_id="day", platform="tui") is None
    assert desktop_version.on_pre_llm_call(session_id="from-0.17.63", platform="weixin") is not None
    assert desktop_version.on_pre_llm_call(session_id="from-0.17.63", platform="weixin") is None


@pytest.mark.parametrize(
    ("env", "platform", "with_file"),
    [("", "tui", True), ("1", "subagent", True), ("1", "cron", True), ("1", "tui", False)],
    ids=["switch-off", "subagent", "cron", "no-file"],
)
def test_the_hook_stays_quiet_where_nothing_is_said(monkeypatch, _home, env, platform, with_file):
    monkeypatch.setenv(single_thread_prompt.SWITCH_ENV, env)
    if with_file:
        _write_state(_home, DOWNLOADED)
    assert desktop_version.render_section({"platform": platform, "session_id": "s"}) == ""
    assert desktop_version.on_pre_llm_call(session_id="s", platform=platform) is None
    assert desktop_version.on_pre_llm_call(session_id="", platform="tui") is None


@pytest.mark.usefixtures("switch_on")
def test_what_sessions_were_given_stays_bounded(monkeypatch, _home):
    monkeypatch.setattr(desktop_version, "_MAX_TOLD", 3)
    _write_state(_home, LATEST)
    for session in ("a", "b", "c", "d"):
        desktop_version.render_section({"platform": "tui", "session_id": session})
    told = json.loads((_home / "apex" / "desktop-version-told.json").read_text(encoding="utf-8"))
    assert list(told) == ["b", "c", "d"]


# ── 4. every code, and the words around it ──────────────────────────────────


@pytest.mark.parametrize(
    ("update", "sentence"),
    [
        ({"status": "unchecked"}, "这次打开 APEX 后还没检查完更新（打开一分钟左右会自动检查）；想马上知道，可以到 设置 › 个性化 点「立即检查」。"),
        ({"status": "downloading", "version": "0.17.66"}, "有新版 0.17.66，正在后台下载；下载好后左下角会出现「安装并重启」。"),
        ({"status": "error"}, "上次检查或下载更新没成功（多半是网络问题），APEX 会自己再试；也可以到 设置 › 个性化 点「立即检查」。"),
        ({"status": "unavailable"}, "这个 APEX 不会自己更新，要更新得下载新的安装包重新安装。"),
        ({"status": "deferred", "version": "0.17.66", "reason": "a-reason-from-a-newer-desktop"},
         "新版 0.17.66 已经下载好，也点过「安装并重启」了，正在等：有任务在进行，做完后自动安装更新。"),
        ({"status": "downloaded"}, desktop_version.UPDATE_UNKNOWN),
        ({"status": "downloaded", "version": "Hermes v0.22.5"}, desktop_version.UPDATE_UNKNOWN),
        ({"status": "a-status-from-a-newer-desktop"}, desktop_version.UPDATE_UNKNOWN),
        ("not-a-dict", desktop_version.UPDATE_UNKNOWN),
    ],
    ids=["unchecked", "downloading", "error", "unavailable", "unknown-reason", "no-version", "bad-version",
         "unknown-status", "no-update"],
)
def test_every_update_code_has_its_sentence(update, sentence):
    assert desktop_version.update_sentence({"app_version": "0.17.63", "update": update}) == sentence


@pytest.mark.parametrize(
    ("engine", "line"),
    [
        (PIN, "APEX 0.17.63（自带的 AI 引擎 2026.10.27，跟着 APEX 一起更新）"),
        ({"version": "v2026.10.27", "commit": "x"}, "APEX 0.17.63（自带的 AI 引擎 2026.10.27，跟着 APEX 一起更新）"),
        ({"version": "0.22.5", "commit": "x"}, "APEX 0.17.63"),
        (None, "APEX 0.17.63"),
    ],
    ids=["pinned", "bare-calver", "upstream-semver", "unpackaged"],
)
def test_the_engine_shows_only_as_its_date(engine, line):
    assert desktop_version.version_line({"app_version": "0.17.63", "engine": engine}) == line


def _ts(relative: str) -> str:
    return (DESKTOP / relative).read_text(encoding="utf-8")


def test_the_codes_are_the_ones_the_typescript_writer_writes():
    source = _ts("electron/apex-version-state.ts")
    union = re.search(r"export type DesktopUpdateStatus =((?:\s*\|\s*'[a-z_]+')+)", source).group(1)
    assert set(re.findall(r"'([a-z_]+)'", union)) == set(desktop_version.UPDATE_SENTENCES)
    assert re.search(r"export const VERSION_STATE_DIR = '([^']+)'", source).group(1) == desktop_version.STATE_RELATIVE_PATH[0]
    assert re.search(r"export const VERSION_STATE_FILE = '([^']+)'", source).group(1) == desktop_version.STATE_RELATIVE_PATH[1]
    assert "schema: 1" in source


def test_the_reasons_are_word_for_word_what_the_update_pill_says():
    source = _ts("src/i18n/desktop-update.ts")
    zh = source[source.index("const zh: DesktopUpdateCopy"):]
    block = zh[zh.index("deferred: {"):zh.index("}")]
    pill = dict(re.findall(r"(\w+): '([^']*)'", block))
    assert pill == desktop_version.DEFERRED_REASONS
    busy = _ts("electron/runtime-update-busy.ts")
    assert set(re.findall(r"'([a-z_]+)'", busy[busy.index("const BUSY_REASONS"):].split("\n")[0])) == set(pill)


def test_the_directions_name_the_buttons_desktop_shows():
    zh = _ts("src/i18n/zh.ts")
    assert "installRestart: '安装并重启'" in zh
    assert "checkNow: '立即检查'" in zh
    assert "personalization: '个性化'" in zh


# ── 5. registration ──────────────────────────────────────────────────────────


def test_switch_off_registers_and_patches_nothing():
    manager = _manager(desktop_version)
    assert not manager._hooks.get("pre_llm_call")
    assert desktop_version.SECTION_ID not in manager._system_prompt_sections
    assert system_prompt.HERMES_AGENT_HELP_GUIDANCE == prompt_builder.HERMES_AGENT_HELP_GUIDANCE


@pytest.mark.usefixtures("switch_on")
def test_registering_twice_or_without_a_host_reports_false():
    manager = _manager(desktop_version)
    ctx = PluginContext(PluginManifest(name="apex-overlay", key="apex-overlay", source="bundled"), manager)
    assert desktop_version.apply(ctx) is False
    assert desktop_version.apply(None) is False


@pytest.mark.usefixtures("switch_on")
def test_a_moved_upstream_line_is_reported_not_guessed(monkeypatch):
    monkeypatch.delattr(system_prompt, "HERMES_AGENT_HELP_GUIDANCE_NO_SKILLS")
    assert desktop_version._install_help_guidance(system_prompt) is False
    assert system_prompt.HERMES_AGENT_HELP_GUIDANCE == prompt_builder.HERMES_AGENT_HELP_GUIDANCE


def test_plugin_register_applies_the_seam():
    from tests.apex_overlay.conftest import run_plugin_register_with_stubbed_seams

    called = run_plugin_register_with_stubbed_seams("_desktop_version_plugin_under_test")
    assert "desktop_version" in called
