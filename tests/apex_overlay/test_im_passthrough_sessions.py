"""hc-542 — IM 直通 v1.1: session targeting (/cc list · /cc <n> · /cc resume · /cc new).

Covers the additive surface on ``apex_overlay.im_passthrough``:

* pure sub-command parsing (``parse_cc_subcommand``) — list / number / resume /
  new / v1 back-compat;
* the injection red line — ``sanitize_summary`` scrubs control/format chars and
  caps length before any stored user message can reach IM;
* ``format_relative_time`` buckets;
* ``parse_session_file`` head-scan over Claude Code's real jsonl shape (the first
  line is NOT a user message; bad lines, meta records, and tool-result-only
  turns are tolerated);
* the read-only FS layer (``list_recent_sessions`` / ``find_session``) against a
  temp ``CLAUDE_CONFIG_DIR`` store, including newest-first ordering, the ≤10 cap,
  empty-file skipping, and path-traversal rejection;
* ``render_session_list`` formatting;
* the resume WIRING — a Claude harness with a preset ``session_id`` emits
  ``--resume <id>`` on its *first* prompt (so ``/cc <n>`` attaches, not forks);
* the controller paths end-to-end over an in-memory harness (list caches the
  ordering; a number/id attaches with the right cwd + preset id; codex is told
  it's Claude-only; bad number / missing id degrade cleanly).

Deterministic + table-driven where the logic is pure; no real ``claude`` process.
"""

from __future__ import annotations

import asyncio
import json
import os

import pytest

from apex_overlay import im_passthrough
from apex_overlay.im_passthrough import (
    CcKind,
    SessionInfo,
    find_session,
    format_relative_time,
    list_recent_sessions,
    parse_cc_subcommand,
    parse_session_file,
    render_session_list,
    sanitize_summary,
)


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


# ---------------------------------------------------------------------------
# parse_cc_subcommand — table-driven
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "args,kind,extra",
    [
        ("", CcKind.NEW, {"bare": True, "rest": ""}),
        ("   ", CcKind.NEW, {"bare": True, "rest": ""}),
        ("list", CcKind.LIST, {}),
        ("  LIST  ", CcKind.LIST, {}),
        ("List", CcKind.LIST, {}),
        ("3", CcKind.SELECT, {"index": 3}),
        ("10", CcKind.SELECT, {"index": 10}),
        ("0", CcKind.SELECT, {"index": 0}),
        ("resume abc-123", CcKind.RESUME, {"session_id": "abc-123"}),
        ("RESUME  abc-123  extra", CcKind.RESUME, {"session_id": "abc-123"}),
        ("resume", CcKind.RESUME, {"session_id": ""}),
        ("new", CcKind.NEW, {"bare": False, "rest": ""}),
        ("new /tmp go fix it", CcKind.NEW, {"rest": "/tmp go fix it"}),
        # v1 back-compat: not a keyword/number → whole string is rest.
        ("fix the bug", CcKind.NEW, {"rest": "fix the bug"}),
        ("~/proj do stuff", CcKind.NEW, {"rest": "~/proj do stuff"}),
        ("3x", CcKind.NEW, {"rest": "3x"}),  # not a pure integer
    ],
)
def test_parse_cc_subcommand(args, kind, extra):
    cmd = parse_cc_subcommand(args)
    assert cmd.kind is kind
    for field, value in extra.items():
        assert getattr(cmd, field) == value, f"{field} for {args!r}"


# ---------------------------------------------------------------------------
# sanitize_summary — injection red line
# ---------------------------------------------------------------------------


def test_sanitize_summary_empty():
    assert sanitize_summary("") == ""
    assert sanitize_summary("   \n\t ") == ""


def test_sanitize_summary_collapses_whitespace_and_newlines():
    assert sanitize_summary("hello\n\nworld\tthere") == "hello world there"


def test_sanitize_summary_strips_control_and_format_chars():
    # NUL, ANSI ESC sequence, zero-width space, and a bidi override must go.
    raw = "a\x00b\x1b[31mc​d‮e"
    out = sanitize_summary(raw)
    assert "\x00" not in out and "\x1b" not in out
    assert "​" not in out and "‮" not in out
    # printable content survives (ESC's payload letters remain, as text).
    for ch in "abcde":
        assert ch in out


def test_sanitize_summary_truncates_with_ellipsis():
    out = sanitize_summary("x" * 100, limit=40)
    assert out == "x" * 40 + "…"
    assert len(out) == 41  # 40 chars + the ellipsis marker


def test_sanitize_summary_no_ellipsis_at_exact_limit():
    out = sanitize_summary("y" * 40, limit=40)
    assert out == "y" * 40 and "…" not in out


def test_sanitize_summary_counts_cjk_as_chars():
    out = sanitize_summary("你" * 50, limit=40)
    assert out == "你" * 40 + "…"


# ---------------------------------------------------------------------------
# format_relative_time — buckets
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "delta,expected",
    [
        (0, "刚刚"),
        (59, "刚刚"),
        (-100, "刚刚"),  # clock skew / future mtime never goes negative
        (60, "1 分钟前"),
        (3599, "59 分钟前"),
        (3600, "1 小时前"),
        (86399, "23 小时前"),
        (86400, "1 天前"),
        (200000, "2 天前"),
    ],
)
def test_format_relative_time(delta, expected):
    assert format_relative_time(1_000_000.0, 1_000_000.0 - delta) == expected


# ---------------------------------------------------------------------------
# parse_session_file — head-scan over the real jsonl shape
# ---------------------------------------------------------------------------


def test_parse_session_file_empty():
    p = parse_session_file([])
    assert p.cwd is None and p.summary_raw is None


def test_parse_session_file_first_line_is_not_user():
    # Real stores open with queue-operation / summary records; cwd + the first
    # user message appear later.
    lines = [
        json.dumps({"type": "queue-operation", "sessionId": "s1", "content": "noise"}),
        json.dumps({"type": "summary", "summary": "a title", "leafUuid": "x"}),
        json.dumps({"type": "user", "cwd": "/Users/k/proj", "message": {"role": "user", "content": "first real prompt"}}),
    ]
    p = parse_session_file(lines)
    assert p.cwd == "/Users/k/proj"
    assert p.summary_raw == "first real prompt"


def test_parse_session_file_tolerates_bad_lines():
    lines = [
        "not json at all",
        "",
        "{ broken json",
        "[1, 2, 3]",  # valid json but not a dict
        json.dumps({"type": "user", "cwd": "/w", "message": {"content": "ok"}}),
    ]
    p = parse_session_file(lines)
    assert p.cwd == "/w" and p.summary_raw == "ok"


def test_parse_session_file_skips_meta_and_tool_result_only():
    lines = [
        json.dumps({"type": "user", "isMeta": True, "cwd": "/w", "message": {"content": "meta caveat"}}),
        json.dumps({"type": "user", "message": {"content": [{"type": "tool_result", "content": "x"}]}}),
        json.dumps({"type": "user", "message": {"content": [{"type": "text", "text": "the real one"}]}}),
    ]
    p = parse_session_file(lines)
    assert p.cwd == "/w"  # meta line still contributes cwd
    assert p.summary_raw == "the real one"  # meta + tool-result skipped for text


def test_parse_session_file_joins_list_text_blocks():
    lines = [
        json.dumps({"type": "user", "cwd": "/w", "message": {"content": [
            {"type": "text", "text": "part one"},
            {"type": "text", "text": "part two"},
        ]}}),
    ]
    p = parse_session_file(lines)
    assert p.summary_raw == "part one part two"


# ---------------------------------------------------------------------------
# Read-only FS layer — list_recent_sessions / find_session (temp store)
# ---------------------------------------------------------------------------


def _write_session(root, slug, session_id, *, cwd, first_msg, mtime=None):
    proj = os.path.join(root, "projects", slug)
    os.makedirs(proj, exist_ok=True)
    path = os.path.join(proj, session_id + ".jsonl")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps({"type": "queue-operation", "content": "x"}) + "\n")
        fh.write(json.dumps({"type": "user", "cwd": cwd, "message": {"content": first_msg}}) + "\n")
    if mtime is not None:
        os.utime(path, (mtime, mtime))
    return path


def test_list_recent_sessions_newest_first_across_projects(tmp_path, monkeypatch):
    root = str(tmp_path)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", root)
    _write_session(root, "-Users-k-a", "aaaa1111", cwd="/Users/k/a", first_msg="oldest one", mtime=1000)
    _write_session(root, "-Users-k-b", "bbbb2222", cwd="/Users/k/b", first_msg="middle one", mtime=2000)
    _write_session(root, "-Users-k-a", "cccc3333", cwd="/Users/k/a", first_msg="newest one", mtime=3000)

    sessions = list_recent_sessions(10)
    assert [s.session_id for s in sessions] == ["cccc3333", "bbbb2222", "aaaa1111"]
    assert sessions[0].cwd == "/Users/k/a"
    assert sessions[0].summary == "newest one"


def test_list_recent_sessions_caps_and_skips_empty(tmp_path, monkeypatch):
    root = str(tmp_path)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", root)
    for i in range(15):
        _write_session(root, "-p", f"id{i:04d}", cwd="/p", first_msg=f"msg {i}", mtime=1000 + i)
    # a zero-byte session file must not consume a slot
    empty = os.path.join(root, "projects", "-p", "empty000.jsonl")
    open(empty, "w").close()
    os.utime(empty, (99999, 99999))  # newest by mtime, but empty

    sessions = list_recent_sessions(10)
    assert len(sessions) == 10, "must cap at the limit"
    assert all(s.session_id != "empty000" for s in sessions), "empty file skipped"
    assert sessions[0].session_id == "id0014", "newest non-empty first"


def test_list_recent_sessions_missing_root_is_empty(tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "does-not-exist"))
    assert list_recent_sessions(10) == []


def test_find_session_by_id(tmp_path, monkeypatch):
    root = str(tmp_path)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", root)
    _write_session(root, "-Users-k-proj", "dead-beef-01", cwd="/Users/k/proj", first_msg="hi there")

    info = find_session("dead-beef-01")
    assert info is not None
    assert info.session_id == "dead-beef-01"
    assert info.cwd == "/Users/k/proj"
    assert info.summary == "hi there"

    assert find_session("no-such-id") is None


@pytest.mark.parametrize("evil", ["../../etc/passwd", "a/b", "..", "", "  ", "x" * 500])
def test_find_session_rejects_traversal_and_malformed(tmp_path, monkeypatch, evil):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path))
    assert find_session(evil) is None


# ---------------------------------------------------------------------------
# render_session_list — formatting (pure)
# ---------------------------------------------------------------------------


def test_render_session_list_empty():
    out = render_session_list([], now_ts=1_000_000.0)
    assert "没有找到" in out and "/cc new" in out


def test_render_session_list_numbers_projects_and_time():
    sessions = [
        SessionInfo(session_id="aaaa1111bbbb", cwd="/Users/k/hermes-cloud", summary="fix the thing", mtime=999_940.0),
        SessionInfo(session_id="cccc2222dddd", cwd="/Users/k/other", summary="", mtime=996_400.0),
    ]
    out = render_session_list(sessions, now_ts=1_000_000.0)
    assert "共 2 条" in out
    assert "1. hermes-cloud · 1 分钟前" in out
    assert "fix the thing" in out
    assert "2. other · 1 小时前" in out
    assert "(无预览)" in out  # empty summary falls back
    assert "id aaaa1111" in out  # short id prefix shown
    assert "/cc <编号>" in out and "/cc resume" in out


# ---------------------------------------------------------------------------
# Resume WIRING — a preset session_id makes the FIRST prompt use --resume
# ---------------------------------------------------------------------------


def test_claude_first_prompt_attaches_when_session_preset():
    from agent.coding_agents import harness_for

    h = harness_for("claude", "/tmp")
    # Fresh: no id yet → a brand-new session (no --resume).
    assert "--resume" not in h._build_prompt_args("hello")

    # What _build_and_open(resume_session_id=...) does: preset before first turn.
    h.session_id = "sess-xyz-01"
    args = h._build_prompt_args("hello")
    assert args[:2] == ["-p", "hello"]
    assert "--resume" in args and "sess-xyz-01" in args
    assert args[args.index("--resume") + 1] == "sess-xyz-01", "id follows --resume"


# ---------------------------------------------------------------------------
# Controller paths — in-memory harness, no real process
# ---------------------------------------------------------------------------


class _FakeHarness:
    def __init__(self, *, installed=True):
        self._installed = installed
        self.session_id = None
        self.cwd = None
        self.opened = False
        self.opened_with_session_id = "__unset__"
        self.closed = False
        self.prompts: list[str] = []

    def availability(self):
        from agent.coding_agents.events import AvailabilityInfo

        return AvailabilityInfo(family="claude", installed=self._installed, detail="fake")

    def open(self):
        self.opened = True
        self.opened_with_session_id = self.session_id  # capture the preset id
        return self.session_id or ""

    def close(self):
        self.closed = True

    def cancel(self):
        pass

    def prompt(self, text):
        from agent.coding_agents.events import AgentEvent

        self.prompts.append(text)
        return iter([
            AgentEvent.session_started(self.session_id or "s"),
            AgentEvent.message(f"echo:{text}"),
            AgentEvent.turn_completed("end_turn"),
        ])


class _FakeSource:
    def __init__(self, user_id="u1", chat_id="c1"):
        self.user_id = user_id
        self.chat_id = chat_id
        self.internal = False


class _FakeEvent:
    def __init__(self, text, source=None):
        self.text = text
        self.source = source or _FakeSource()
        self.internal = False

    def get_command(self):
        if not self.text or not self.text.startswith("/"):
            return None
        return self.text.split(maxsplit=1)[0][1:].lower() or None

    def get_command_args(self):
        parts = self.text.split(maxsplit=1)
        return parts[1] if len(parts) > 1 else ""


class _FakeRunner:
    def __init__(self):
        self._authorized = True

    def _session_key_for_source(self, source):
        return f"{source.user_id}:{source.chat_id}"

    def _is_user_authorized(self, source):
        return self._authorized

    def _adapter_for_source(self, source):
        return None


def _install_factory(monkeypatch, harness):
    captured: dict = {}

    def _factory(family, cwd=None, **kwargs):
        captured["family"] = family
        captured["cwd"] = cwd
        captured["kwargs"] = kwargs
        harness.cwd = cwd
        return harness

    monkeypatch.setattr(im_passthrough, "harness_for", _factory)
    return captured


def _fake_sessions(n):
    return [
        SessionInfo(session_id=f"sess-{i}", cwd=f"/proj/{i}", summary=f"summary {i}", mtime=1000 - i)
        for i in range(n)
    ]


def test_cc_list_renders_and_does_not_open_a_harness(monkeypatch):
    harness = _FakeHarness()
    _install_factory(monkeypatch, harness)
    monkeypatch.setattr(im_passthrough, "list_recent_sessions", lambda limit=10: _fake_sessions(3))
    runner = _FakeRunner()

    handled, reply = _run(im_passthrough.maybe_handle_passthrough(runner, _FakeEvent("/cc list")))
    assert handled is True
    assert "共 3 条" in reply and "summary 0" in reply
    assert harness.opened is False, "listing must not spawn an agent"
    # ordering cached for a subsequent /cc <n>
    cache = getattr(runner, im_passthrough._LIST_STATE_ATTR)
    assert [s.session_id for s in cache["u1:c1"]] == ["sess-0", "sess-1", "sess-2"]


def test_cc_number_attaches_to_listed_session(monkeypatch):
    harness = _FakeHarness()
    captured = _install_factory(monkeypatch, harness)
    monkeypatch.setattr(im_passthrough, "list_recent_sessions", lambda limit=10: _fake_sessions(3))
    runner = _FakeRunner()
    src = _FakeSource()

    async def _go():
        await im_passthrough.maybe_handle_passthrough(runner, _FakeEvent("/cc list", src))
        handled, reply = await im_passthrough.maybe_handle_passthrough(runner, _FakeEvent("/cc 2", src))
        assert handled is True
        assert "已挂接" in reply and "summary 1" in reply
        # attached to the 2nd listed session: right cwd + preset id BEFORE open.
        assert captured["cwd"] == "/proj/1"
        assert harness.opened_with_session_id == "sess-1", "first turn will --resume this id"
        assert "permission_callback" not in captured["kwargs"], "red line: no approver"
        sessions = getattr(runner, im_passthrough._STATE_ATTR)
        assert sessions[runner._session_key_for_source(src)].cwd == "/proj/1"

    _run(_go())


def test_cc_number_without_prior_list_recomputes(monkeypatch):
    harness = _FakeHarness()
    captured = _install_factory(monkeypatch, harness)
    monkeypatch.setattr(im_passthrough, "list_recent_sessions", lambda limit=10: _fake_sessions(2))
    runner = _FakeRunner()

    handled, reply = _run(im_passthrough.maybe_handle_passthrough(runner, _FakeEvent("/cc 1")))
    assert handled is True and "已挂接" in reply
    assert captured["cwd"] == "/proj/0"
    assert harness.opened_with_session_id == "sess-0"


def test_cc_number_out_of_range(monkeypatch):
    harness = _FakeHarness()
    _install_factory(monkeypatch, harness)
    monkeypatch.setattr(im_passthrough, "list_recent_sessions", lambda limit=10: _fake_sessions(2))
    runner = _FakeRunner()

    handled, reply = _run(im_passthrough.maybe_handle_passthrough(runner, _FakeEvent("/cc 9")))
    assert handled is True
    assert "超出范围" in reply
    assert harness.opened is False
    assert getattr(runner, im_passthrough._STATE_ATTR, {}) == {}


def test_cc_resume_by_id(monkeypatch):
    harness = _FakeHarness()
    captured = _install_factory(monkeypatch, harness)
    info = SessionInfo(session_id="abc-99", cwd="/Users/k/target", summary="resume me", mtime=1.0)
    monkeypatch.setattr(im_passthrough, "find_session", lambda sid: info if sid == "abc-99" else None)
    runner = _FakeRunner()

    handled, reply = _run(im_passthrough.maybe_handle_passthrough(runner, _FakeEvent("/cc resume abc-99")))
    assert handled is True and "已挂接" in reply
    assert captured["cwd"] == "/Users/k/target"
    assert harness.opened_with_session_id == "abc-99"


def test_cc_resume_unknown_id(monkeypatch):
    harness = _FakeHarness()
    _install_factory(monkeypatch, harness)
    monkeypatch.setattr(im_passthrough, "find_session", lambda sid: None)
    runner = _FakeRunner()

    handled, reply = _run(im_passthrough.maybe_handle_passthrough(runner, _FakeEvent("/cc resume ghost")))
    assert handled is True and "未找到会话" in reply
    assert harness.opened is False


def test_cc_resume_missing_id_shows_usage(monkeypatch):
    harness = _FakeHarness()
    _install_factory(monkeypatch, harness)
    runner = _FakeRunner()

    handled, reply = _run(im_passthrough.maybe_handle_passthrough(runner, _FakeEvent("/cc resume")))
    assert handled is True and "用法" in reply
    assert harness.opened is False


def test_bare_cc_appends_list_hint(monkeypatch):
    harness = _FakeHarness()
    _install_factory(monkeypatch, harness)
    runner = _FakeRunner()

    handled, reply = _run(im_passthrough.maybe_handle_passthrough(runner, _FakeEvent("/cc")))
    assert handled is True
    assert "直通模式" in reply
    assert "/cc list" in reply, "bare /cc must advertise session attaching"
    assert harness.opened is True


def test_cc_new_with_dir_forces_fresh_session(monkeypatch, tmp_path):
    harness = _FakeHarness()
    captured = _install_factory(monkeypatch, harness)
    runner = _FakeRunner()

    handled, reply = _run(
        im_passthrough.maybe_handle_passthrough(runner, _FakeEvent(f"/cc new {tmp_path}"))
    )
    assert handled is True and "直通模式" in reply
    assert captured["cwd"] == str(tmp_path), "explicit cwd honored"
    assert harness.opened_with_session_id in (None, ""), "new session is NOT a resume"


def test_codex_list_is_claude_only(monkeypatch):
    harness = _FakeHarness()
    _install_factory(monkeypatch, harness)
    called = {"n": 0}
    monkeypatch.setattr(im_passthrough, "list_recent_sessions", lambda limit=10: called.__setitem__("n", called["n"] + 1) or [])
    runner = _FakeRunner()

    handled, reply = _run(im_passthrough.maybe_handle_passthrough(runner, _FakeEvent("/codex list")))
    assert handled is True
    assert "仅支持 Claude Code" in reply
    assert called["n"] == 0, "must not scan the Claude store for a codex list"
    assert harness.opened is False


def test_cc_list_while_in_session_does_not_close_it(monkeypatch):
    harness = _FakeHarness()
    _install_factory(monkeypatch, harness)
    monkeypatch.setattr(im_passthrough, "list_recent_sessions", lambda limit=10: _fake_sessions(1))
    runner = _FakeRunner()
    src = _FakeSource()

    async def _go():
        await im_passthrough.maybe_handle_passthrough(runner, _FakeEvent("/cc", src))
        assert harness.opened is True
        handled, reply = await im_passthrough.maybe_handle_passthrough(runner, _FakeEvent("/cc list", src))
        assert handled and "共 1 条" in reply
        # the query must NOT tear down the live session
        assert harness.closed is False
        sessions = getattr(runner, im_passthrough._STATE_ATTR)
        assert src.user_id + ":" + src.chat_id in sessions

    _run(_go())
