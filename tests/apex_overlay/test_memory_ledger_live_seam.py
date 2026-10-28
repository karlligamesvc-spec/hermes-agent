"""hc-1097 共用记忆实时: what an open session hears when the shared ledger changes.

1. The case M7 found on 0.17.66: assistant B's session is open with an empty ledger, assistant A notes
   「抖音账号叫小橙子测评」 (A's engine re-reads the ledger and mirrors it), and on B's next turn the model
   gets that entry with B's message, once, while B's system prompt does not move. Without the seam B's
   model gets nothing new, which is how it came to answer 「底账是空的」.
2. What a note says: entries that appeared, changed or went away; a session's own changes are no news;
   an entry pushed past the segment's budget is not reported gone.
3. A session restored by a new engine is measured from its stored prompt and the notes in its history.
4. Who hears it: sessions people talk to whose prompt carries the ledger; never subagents or cron, and
   nothing while there is no mirror.
5. apex_memory list, and the engine's own mirror refresh: only over a mirror Desktop wrote, only for the
   key it read with, in Desktop's bytes and mode, one background reader at a time.
"""

from __future__ import annotations

import json
import os
import stat
import threading
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from apex_overlay import assistant_name, memory_ledger, memory_ledger_live, single_thread_prompt
from hermes_cli import plugins
from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest
from plugins import apexnodes_gateway
from run_agent import AIAgent
from tests.apex_overlay.test_memory_ledger_live_identity import (
    LIVE_SEAMS,
    SEAMS,
    SEGMENTS,
    TURNS,
    overlay_manager,
    run_turns,
    scripted_agent,
    setup_case,
    system_prompt,
)
from tools.registry import registry

NOTED = "抖音账号叫小橙子测评"
NOTED_LINE = f"- [5c6d7e8f] {NOTED}"
DONE_LINE = "- 10-28 [9a8b7c6d] 剪好了小橙子测评的第一条口播"


def _entry(ref: str, content: str, created_at: str) -> dict:
    return {"id": f"{ref}-0000-4000-8000-000000000000", "ref": ref, "content": content, "created_at": created_at}


# What the cloud's agent-key GET answers once A noted the account name (entries as the cloud serializes them).
AFTER_PAYLOAD = {
    "entries": {
        "about_you": [_entry("5c6d7e8f", NOTED, "2026-10-28T01:07:00+00:00"),
                      _entry("3f2a9c1d", "不露脸，女声配音", "2026-10-20T02:00:00+00:00")],
        # 01:30 on 10-28 in Beijing is still 10-27 in UTC: the list must date it as the segment does.
        "recent": [_entry("9a8b7c6d", "剪好了小橙子测评的第一条口播", "2026-10-27T17:30:00+00:00"),
                   _entry("ab12cd34", "交付了收纳三样的成片", "2026-10-27T03:00:00+00:00")],
    },
    "prompt_segment": SEGMENTS["after"],
}


@pytest.fixture
def root(tmp_path, monkeypatch):
    home = tmp_path / "apexnodes"
    (home / "apex").mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv(single_thread_prompt.SWITCH_ENV, "1")
    monkeypatch.delenv(assistant_name.SWITCH_ENV, raising=False)
    monkeypatch.setattr(assistant_name, "_told", {})
    monkeypatch.setattr(memory_ledger_live, "_sessions", memory_ledger_live.OrderedDict())
    monkeypatch.setattr(memory_ledger, "_refresh", {"running": False, "again": False})
    monkeypatch.setattr(
        "agent.coding_context.build_coding_workspace_block",
        lambda cwd=None: "Workspace (snapshot at session start):\n- Root: /pinned",
    )
    return home


def mirror(root, segment: str) -> None:
    (root / "apex" / "memory-ledger-prompt.md").write_text(segment + "\n", encoding="utf-8")


class FakeGateway:
    """The cloud's agent-key routes: POST and DELETE answer one entry, GET the whole ledger."""

    GatewayError = apexnodes_gateway.GatewayError

    def __init__(self, ledger=None, entry=None, key="agent-key"):
        self.calls = []
        self.ledger = ledger or AFTER_PAYLOAD
        self.entry = entry or AFTER_PAYLOAD["entries"]["about_you"][0]
        self.key = key
        self.gate = None  # an Event a GET waits on, to hold a reader mid-read

    def agent_api_key(self):
        return self.key

    def request_json(self, method, path, payload=None, **kwargs):
        self.calls.append((method, path))
        if method == "GET":
            if self.gate is not None:
                self.gate.wait(5)
            return self.ledger
        if method == "POST":
            return {"entry": self.entry, "created": True}
        return {"deleted": self.entry["id"]}


@pytest.fixture
def gateway(monkeypatch):
    fake = FakeGateway()
    monkeypatch.setattr(memory_ledger, "_gateway", lambda: fake)
    return fake


def _note(*sections: tuple[str, list[str]]) -> str:
    body = [memory_ledger_live.NOTE_BEGIN, memory_ledger_live.NOTE_INTRO]
    for heading, lines in sections:
        body += [heading, *lines]
    return "\n".join([*body, memory_ledger_live.NOTE_END])


def _deregister():
    for name in (memory_ledger.TOOL_NAME, assistant_name.TOOL_NAME):
        registry.deregister(name)


def _noted_by_assistant_a(session_id: str = "20261028_090500_apex") -> None:
    """Assistant A's engine notes the account name and re-reads the ledger (as on Desktop, in the background)."""
    result = json.loads(memory_ledger.handle({"action": "add", "kind": "about_you", "content": NOTED}, session_id=session_id))
    assert result["ok"] is True
    for thread in threading.enumerate():
        if thread.name == "apex-memory-ledger-mirror":
            thread.join(5)


# ── 1. the M7 case, end to end ───────────────────────────────────────────────


@pytest.mark.parametrize("modules", [LIVE_SEAMS, SEAMS], ids=["live-seam", "without-it"])
def test_what_assistant_a_noted_reaches_bs_open_session_on_its_next_turn(root, monkeypatch, gateway, modules):
    mirror(root, SEGMENTS["empty"])
    platform, turns = setup_case(root, monkeypatch, "multi-bot-named")  # B: 小剪, its own profile
    monkeypatch.setattr(plugins, "_plugin_manager", overlay_manager(*modules))
    monkeypatch.setattr(plugins, "_plugin_managers_by_home", {})
    try:
        sent = run_turns(
            scripted_agent(platform, "20261028_090700_cut"), turns, between=lambda n: n == 1 and _noted_by_assistant_a()
        )
    finally:
        _deregister()
    assert gateway.calls == [("POST", "/api/v1/media/memory-ledger/entries"), ("GET", "/api/v1/media/memory-ledger")]
    assert (root / "apex" / "memory-ledger-prompt.md").read_text(encoding="utf-8") == SEGMENTS["after"] + "\n"
    system = system_prompt(sent)  # one system prompt for all three turns
    assert "（还没有）" in system and NOTED not in system
    users = [[m for m in messages if m["role"] == "user"][-1]["content"] for messages in sent]
    if modules is SEAMS:
        assert users == list(TURNS)
        return
    assert users == [
        f"{TURNS[0]}\n\n{memory_ledger_live.LOOKUP_HINT}",
        f"{TURNS[1]}\n\n" + _note(
            (memory_ledger_live.APPEARED, [NOTED_LINE, "- [3f2a9c1d] 不露脸，女声配音", DONE_LINE,
                                           "- 10-27 [ab12cd34] 交付了收纳三样的成片"]),
        ),
        TURNS[2],
    ]


def test_the_assistant_that_noted_it_hears_no_news(root, monkeypatch, gateway):
    """A's own add is no news to A; a third session in the same engine still hears it."""
    mirror(root, SEGMENTS["base"])
    memory_ledger_live.note_frozen({"session_id": "a"}, SEGMENTS["base"])
    memory_ledger_live.note_frozen({"session_id": "c"}, SEGMENTS["base"])
    for session_id in ("a", "c"):
        assert memory_ledger_live.on_pre_llm_call(session_id=session_id, platform="desktop") == memory_ledger_live.LOOKUP_HINT
    _noted_by_assistant_a(session_id="a")
    assert memory_ledger_live.on_pre_llm_call(session_id="a", platform="desktop") == _note(
        (memory_ledger_live.APPEARED, [DONE_LINE])  # the one A did not write
    )
    assert NOTED_LINE in memory_ledger_live.on_pre_llm_call(session_id="c", platform="desktop")
    assert memory_ledger_live.on_pre_llm_call(session_id="c", platform="desktop") is None


def test_the_assistant_that_forgot_it_hears_no_news(root, monkeypatch, gateway):
    """A forget through apex_memory is no news to the session that made it."""
    gone = BASE.replace("- 10-27 [ab12cd34] 交付了收纳三样的成片", "（还没有）")
    gateway.entry = {"id": "ab12cd34-0000-4000-8000-000000000000"}
    gateway.ledger = {"entries": {}, "prompt_segment": gone}
    mirror(root, BASE)
    for session_id in ("a", "c"):
        memory_ledger_live.note_frozen({"session_id": session_id}, BASE)
        memory_ledger_live.on_pre_llm_call(session_id=session_id, platform="desktop")
    result = json.loads(memory_ledger.handle({"action": "forget", "ref": "ab12cd34"}, session_id="a"))
    assert result["ok"] is True
    for thread in threading.enumerate():
        if thread.name == "apex-memory-ledger-mirror":
            thread.join(5)
    assert (root / "apex" / "memory-ledger-prompt.md").read_text(encoding="utf-8") == gone + "\n"
    assert memory_ledger_live.on_pre_llm_call(session_id="a", platform="desktop") is None
    assert memory_ledger_live.on_pre_llm_call(session_id="c", platform="desktop") == _note(
        (memory_ledger_live.GONE, ["- 10-27 [ab12cd34] 交付了收纳三样的成片"])
    )


# ── 2. what a note says ──────────────────────────────────────────────────────

BASE = SEGMENTS["base"]


@pytest.mark.parametrize(
    ("now", "own", "expected"),
    [
        (BASE, frozenset(), ""),
        (SEGMENTS["after"], frozenset(), _note((memory_ledger_live.APPEARED, [
            NOTED_LINE, DONE_LINE]))),
        (BASE.replace("不露脸，女声配音", "不露脸，男声配音"), frozenset(), _note((memory_ledger_live.EDITED, [
            "- [3f2a9c1d] 不露脸，男声配音"]))),
        (BASE.replace("- 10-27 [ab12cd34] 交付了收纳三样的成片", "（还没有）"), frozenset(), _note((memory_ledger_live.GONE, [
            "- 10-27 [ab12cd34] 交付了收纳三样的成片"]))),
        (SEGMENTS["after"], frozenset({"5c6d7e8f"}), _note((memory_ledger_live.APPEARED, [DONE_LINE]))),
        (BASE.replace("- 10-27 [ab12cd34] 交付了收纳三样的成片", "（还没有）"), frozenset({"ab12cd34"}), ""),
    ],
    ids=["unchanged", "appeared", "edited", "gone", "own-add", "own-forget"],
)
def test_a_note_says_what_changed(now, own, expected):
    known = memory_ledger_live.parse(BASE)
    assert memory_ledger_live.note(known, memory_ledger_live.parse(now), own) == expected


def test_entries_pushed_past_the_budget_are_not_reported_gone():
    many = SEGMENTS["many"]
    assert memory_ledger_live.parse(many).partial is True
    newest = "- 10-28 [0000000d] 第13件事"
    pushed = many.replace("- 10-22 [0000000c]", f"{newest}\n- 10-22 [0000000c]").replace(
        "- 10-13 [00000003] 第3件事\n", ""
    ).replace("还有 2 条", "还有 3 条")
    assert memory_ledger_live.note(memory_ledger_live.parse(many), memory_ledger_live.parse(pushed)) == _note(
        (memory_ledger_live.APPEARED, [newest])
    )


def test_parse_reads_the_cloud_rendering_and_nothing_else():
    ledger = memory_ledger_live.parse(SEGMENTS["after"])
    assert dict(ledger.lines) == {
        "5c6d7e8f": NOTED_LINE,
        "3f2a9c1d": "- [3f2a9c1d] 不露脸，女声配音",
        "9a8b7c6d": DONE_LINE,
        "ab12cd34": "- 10-27 [ab12cd34] 交付了收纳三样的成片",
    }
    assert ledger.partial is False
    assert dict(memory_ledger_live.parse(SEGMENTS["empty"]).lines) == {}
    assert memory_ledger_live.parse("") is None and memory_ledger_live.parse(None) is None
    assert memory_ledger_live.parse("- [3f2a9c1d] 不在底账里的一行") is None


@pytest.mark.parametrize(
    "changed",
    [
        SEGMENTS["after"].replace("- 10-27 [ab12cd34]", "- 2026-10-27 [ab12cd34]"),  # a new date shape
        SEGMENTS["after"].replace("- [3f2a9c1d] ", "• [3f2a9c1d] "),  # a new bullet
        SEGMENTS["after"].replace("关于你：", "关于用户："),  # a renamed list
    ],
    ids=["date-shape", "bullet", "heading"],
)
def test_a_rendering_this_parser_does_not_know_says_nothing(root, changed):
    """Had the cloud changed its lines, every entry would read as gone; the seam stays quiet instead."""
    assert memory_ledger_live.parse(changed) is None
    mirror(root, BASE)
    memory_ledger_live.note_frozen({"session_id": "s"}, BASE)
    assert memory_ledger_live.on_pre_llm_call(session_id="s", platform="desktop") == memory_ledger_live.LOOKUP_HINT
    mirror(root, changed)
    assert memory_ledger_live.on_pre_llm_call(session_id="s", platform="desktop") is None
    mirror(root, SEGMENTS["after"])  # back to a known rendering: measured from what the session last knew
    assert memory_ledger_live.on_pre_llm_call(session_id="s", platform="desktop") == _note(
        (memory_ledger_live.APPEARED, [NOTED_LINE, DONE_LINE])
    )


# ── 3. a session a new engine restored ───────────────────────────────────────


def _stored(root, session_id: str, prompt: str) -> None:
    from hermes_state import SessionDB

    db = SessionDB()
    try:
        db.create_session(session_id, "desktop")
        db.update_system_prompt(session_id, prompt)
    finally:
        db.close()


def test_a_restored_session_hears_only_what_its_prompt_and_history_do_not_have(root):
    _stored(root, "restored", f"You are APEX.\n\n{BASE}\n\nConversation started: today")
    told = _note((memory_ledger_live.APPEARED, [NOTED_LINE]))
    history = [
        {"role": "user", "content": TURNS[0], "api_content": f"{TURNS[0]}\n\n{memory_ledger_live.LOOKUP_HINT}"},
        {"role": "assistant", "content": "好的"},
        {"role": "user", "content": TURNS[1], "api_content": f"{TURNS[1]}\n\n{told}"},
        {"role": "assistant", "content": "好的"},
        {"role": "user", "content": TURNS[2]},
    ]
    mirror(root, SEGMENTS["after"])
    assert memory_ledger_live.on_pre_llm_call(
        session_id="restored", platform="desktop", conversation_history=history
    ) == _note((memory_ledger_live.APPEARED, [DONE_LINE]))
    assert memory_ledger_live.on_pre_llm_call(session_id="restored", platform="desktop", conversation_history=history) is None


def test_a_rebuilt_prompt_keeps_what_the_session_was_told(root):
    mirror(root, BASE)
    memory_ledger_live.note_frozen({"session_id": "s"}, BASE)
    memory_ledger_live.note_own_change("s", "5c6d7e8f")
    assert memory_ledger_live.on_pre_llm_call(session_id="s", platform="desktop") == memory_ledger_live.LOOKUP_HINT
    memory_ledger_live.note_frozen({"session_id": "s"}, BASE)  # a model switch rebuilds the prompt
    assert memory_ledger_live.on_pre_llm_call(session_id="s", platform="desktop") is None
    mirror(root, SEGMENTS["after"])
    assert memory_ledger_live.on_pre_llm_call(session_id="s", platform="desktop") == _note(
        (memory_ledger_live.APPEARED, [DONE_LINE])
    )


# ── 4. who hears it ──────────────────────────────────────────────────────────


@pytest.mark.parametrize("platform", sorted(memory_ledger_live.NON_INTERACTIVE_PLATFORMS))
def test_jobs_nobody_talks_to_hear_nothing(root, platform):
    mirror(root, BASE)
    memory_ledger_live.note_frozen({"session_id": "job"}, BASE)
    mirror(root, SEGMENTS["after"])
    assert memory_ledger_live.on_pre_llm_call(session_id="job", platform=platform) is None


@pytest.mark.parametrize("platform", ["desktop", "weixin", "feishu", "cli"])
def test_sessions_people_talk_to_hear_it(root, platform):
    mirror(root, BASE)
    memory_ledger_live.note_frozen({"session_id": "s"}, BASE)
    mirror(root, SEGMENTS["after"])
    said = memory_ledger_live.on_pre_llm_call(session_id="s", platform=platform)
    assert said.startswith(memory_ledger_live.LOOKUP_HINT) and NOTED_LINE in said


def test_no_mirror_or_no_section_means_nothing(root):
    memory_ledger_live.note_frozen({"session_id": "s"}, BASE)
    assert memory_ledger_live.on_pre_llm_call(session_id="s", platform="desktop") is None  # switched off
    memory_ledger_live.note_frozen({"session_id": "before-sign-in"}, "")
    mirror(root, SEGMENTS["after"])
    assert memory_ledger_live.on_pre_llm_call(session_id="before-sign-in", platform="desktop") is None
    # Not seen in this engine and nothing stored: no ledger to measure from.
    assert memory_ledger_live.on_pre_llm_call(session_id="unknown", platform="desktop") is None
    assert memory_ledger_live.on_pre_llm_call(session_id="", platform="desktop") is None


# ── 5. list and the engine's own mirror refresh ──────────────────────────────


def test_list_reads_the_whole_ledger_and_the_session_knows_it_after(root, gateway):
    mirror(root, BASE)
    memory_ledger_live.note_frozen({"session_id": "s"}, BASE)
    assert memory_ledger_live.on_pre_llm_call(session_id="s", platform="desktop") == memory_ledger_live.LOOKUP_HINT
    result = json.loads(memory_ledger.handle({"action": "list"}, session_id="s"))
    assert result == {
        "ok": True,
        "action": "list",
        "about_you": [f"[5c6d7e8f] {NOTED}", "[3f2a9c1d] 不露脸，女声配音"],
        "recent": ["10-28 [9a8b7c6d] 剪好了小橙子测评的第一条口播", "10-27 [ab12cd34] 交付了收纳三样的成片"],
    }
    assert gateway.calls == [("GET", "/api/v1/media/memory-ledger")]
    assert (root / "apex" / "memory-ledger-prompt.md").read_text(encoding="utf-8") == SEGMENTS["after"] + "\n"
    assert memory_ledger_live.on_pre_llm_call(session_id="s", platform="desktop") is None


def test_list_without_the_mirror_reads_nothing(root, gateway):
    assert json.loads(memory_ledger.handle({"action": "list"}, session_id="s")) == {"error": memory_ledger.LEDGER_OFF}
    assert gateway.calls == []


def test_the_refreshed_mirror_has_desktops_bytes_and_mode(root, gateway):
    target = root / "apex" / "memory-ledger-prompt.md"
    mirror(root, BASE)
    os.chmod(target, 0o644)
    assert memory_ledger.refresh_mirror() is True
    assert target.read_bytes() == (SEGMENTS["after"] + "\n").encode("utf-8")
    assert stat.S_IMODE(target.stat().st_mode) == 0o600
    assert memory_ledger.refresh_mirror() is False  # the same bytes: no write


@pytest.mark.parametrize(
    ("has_mirror", "next_key", "segment"),
    [
        (False, None, SEGMENTS["after"]),
        (True, "next-account-key", SEGMENTS["after"]),
        (True, None, "关于你：\n- [5c6d7e8f] 不是底账"),
        (True, None, SEGMENTS["after"] + "记" * memory_ledger.MAX_CHARS),
        (True, None, None),
    ],
    ids=["no-mirror", "account-changed", "not-a-segment", "oversized", "missing"],
)
def test_the_engine_never_turns_the_ledger_on_or_crosses_accounts(root, gateway, has_mirror, next_key, segment):
    target = root / "apex" / "memory-ledger-prompt.md"
    if has_mirror:
        mirror(root, BASE)
    key = gateway.agent_api_key()
    if next_key:
        gateway.key = next_key  # signed out and in as someone else while the read was out
    before = target.read_bytes() if target.exists() else None
    assert memory_ledger._mirror_segment(segment, key) is False
    assert (target.read_bytes() if target.exists() else None) == before


def test_one_background_reader_at_a_time_and_none_dropped(root, gateway):
    mirror(root, BASE)
    gateway.gate = threading.Event()
    first = memory_ledger.refresh_mirror_soon()
    assert first is not None
    assert memory_ledger.refresh_mirror_soon() is None
    assert memory_ledger.refresh_mirror_soon() is None
    gateway.gate.set()
    first.join(5)
    assert not first.is_alive()
    assert gateway.calls == [("GET", "/api/v1/media/memory-ledger")] * 2  # the first read and one more
    assert memory_ledger._refresh == {"running": False, "again": False}
    assert (root / "apex" / "memory-ledger-prompt.md").read_text(encoding="utf-8") == SEGMENTS["after"] + "\n"


def test_a_failed_read_leaves_the_mirror(root, gateway, monkeypatch):
    mirror(root, BASE)

    def refuse(*_args, **_kwargs):
        raise apexnodes_gateway.GatewayError("网络不通", code="network_unreachable")

    monkeypatch.setattr(gateway, "request_json", refuse)
    assert memory_ledger.refresh_mirror() is False
    assert (root / "apex" / "memory-ledger-prompt.md").read_text(encoding="utf-8") == BASE + "\n"


# ── registration ─────────────────────────────────────────────────────────────


def test_registering_twice_or_without_a_host_reports_false():
    manager = PluginManager()
    manager._discovered = True
    ctx = PluginContext(PluginManifest(name="apex-overlay", key="apex-overlay", source="bundled"), manager)
    assert memory_ledger_live.apply(ctx) is True
    assert manager._hooks["pre_llm_call"] == [memory_ledger_live.on_pre_llm_call]
    assert memory_ledger_live.apply(ctx) is False
    assert memory_ledger_live.apply(None) is False


def test_plugin_register_applies_the_seam():
    from tests.apex_overlay.conftest import run_plugin_register_with_stubbed_seams

    called = run_plugin_register_with_stubbed_seams("_memory_ledger_live_plugin_under_test")
    assert "memory_ledger_live" in called


# ── through the runtime's tool_call bridge ───────────────────────────────────


def _reply(content: str, tool_calls=None) -> SimpleNamespace:
    message = SimpleNamespace(content=content, tool_calls=tool_calls)
    finish = "tool_calls" if tool_calls else "stop"
    return SimpleNamespace(choices=[SimpleNamespace(message=message, finish_reason=finish)], model="test/model", usage=None)


def _bridged_add(content: str) -> SimpleNamespace:
    """The model's call as Desktop sends it: apex_memory is deferred, so it goes through tool_call."""
    arguments = {"calls": [{"name": "apex_memory", "arguments": {"action": "add", "kind": "about_you", "content": content}}]}
    function = SimpleNamespace(name="tool_call", arguments=json.dumps(arguments, ensure_ascii=False))
    return _reply("", [SimpleNamespace(id="call-ledger", type="function", function=function)])


def test_a_bridged_add_is_this_sessions_own_change(root, monkeypatch, gateway):
    """The model reaches apex_memory through tool_call; the handler still learns which session wrote."""
    mirror(root, BASE)
    monkeypatch.setattr(plugins, "_plugin_manager", overlay_manager(*LIVE_SEAMS))
    monkeypatch.setattr(plugins, "_plugin_managers_by_home", {})
    try:
        with patch("agent.process_bootstrap.OpenAI"):
            agent = AIAgent(
                api_key="test-key-1234567890", base_url="https://openrouter.ai/api/v1", model="test/model",
                platform="desktop", quiet_mode=True, skip_context_files=True, skip_memory=True,
                session_id="20261028_091000_bridge",
            )
        agent.client = MagicMock()
        agent.client.chat.completions.create.side_effect = [_bridged_add(NOTED), _reply("记下了"), _reply("好的")]
        agent._use_prompt_caching = False
        agent.compression_enabled = False
        agent.save_trajectories = False
        history = None
        for text in TURNS[:2]:
            with (
                patch.object(agent, "_persist_session"),
                patch.object(agent, "_save_trajectory"),
                patch.object(agent, "_cleanup_task_resources"),
            ):
                history = agent.run_conversation(text, conversation_history=history)["messages"]
            for thread in threading.enumerate():
                if thread.name == "apex-memory-ledger-mirror":
                    thread.join(5)
    finally:
        _deregister()
    assert gateway.calls == [("POST", "/api/v1/media/memory-ledger/entries"), ("GET", "/api/v1/media/memory-ledger")]
    sent = agent.client.chat.completions.create.call_args_list[-1].kwargs["messages"]
    # Its own add is no news; the entry it did not write is.
    assert [m for m in sent if m["role"] == "user"][-1]["content"] == f"{TURNS[1]}\n\n" + _note(
        (memory_ledger_live.APPEARED, [DONE_LINE])
    )
