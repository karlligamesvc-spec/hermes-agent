"""hc-546 — IM 直通: Codex session targeting (/codex list · <n> · resume · new).

Codex-family parity with hc-542's Claude session targeting. Covers the additive
surface on ``apex_overlay.im_passthrough`` + the driver wiring in
``agent.coding_agents.direct``:

* ``_extract_rollout_user_text`` / ``parse_codex_rollout`` — head-scan over the
  REAL rollout shape (verified against ``~/.codex/sessions``): ``session_meta``
  carries cwd + id (old metas expose ``id``, newer ones ``session_id``); the
  first typed prompt is an ``event_msg`` ``user_message``, with a non-wrapper
  ``response_item`` ``role:"user"`` as the fallback; developer /
  ``<user_instructions>`` / AGENTS.md wrappers never become a preview;
* the read-only FS layer (``list_codex_sessions`` / ``find_codex_session``)
  against a temp ``CODEX_HOME`` store — newest-first, the ≤10 cap, empty-file
  skipping, same-id de-duplication across rollout segments, filename-id
  fallback, and id validation (path-traversal defense);
* the injection red line — a control-char-laden prompt is scrubbed before it can
  reach IM;
* ``render_session_list(family="codex")`` — the reply advertises ``/codex``;
* the resume WIRING — a ``CodexDirectHarness`` with a preset ``session_id`` calls
  the app-server's ``thread/resume`` (attach) instead of ``thread/start`` (fork).

Deterministic + table-driven where the logic is pure; no real ``codex`` process.
"""

from __future__ import annotations

import json
import os

import pytest

from apex_overlay import im_passthrough
from apex_overlay.im_passthrough import (
    ParsedRollout,
    SessionInfo,
    find_codex_session,
    list_codex_sessions,
    parse_codex_rollout,
    render_session_list,
)


# ---------------------------------------------------------------------------
# _extract_rollout_user_text — which record is the first *typed* prompt
# ---------------------------------------------------------------------------


def _rec(otype, ptype, **payload):
    return {"type": otype, "payload": {"type": ptype, **payload}}


def _msg(role, *texts):
    return _rec(
        "response_item", "message", role=role,
        content=[{"type": "input_text", "text": t} for t in texts],
    )


@pytest.mark.parametrize(
    "obj,expected",
    [
        # event_msg/user_message is the clean signal.
        (_rec("event_msg", "user_message", message="the real prompt"), "the real prompt"),
        (_rec("event_msg", "user_message", message="  spaced  "), "spaced"),
        (_rec("event_msg", "user_message", message="   "), None),  # blank
        (_rec("event_msg", "user_message", message=123), None),     # non-str
        # response_item role=user fallback (non-wrapper text).
        (_msg("user", "typed via response item"), "typed via response item"),
        (_msg("user", "part one", "part two"), "part one part two"),  # blocks joined
        # wrappers are NOT user text.
        (_msg("user", "<user_instructions>do X</user_instructions>"), None),
        (_msg("user", "<environment_context>cwd=/x"), None),
        (_msg("user", "# AGENTS.md instructions for /p"), None),
        # developer/assistant roles are never user text.
        (_msg("developer", "system rules"), None),
        (_msg("assistant", "hi"), None),
        # other record types ignored.
        (_rec("event_msg", "task_started"), None),
        ({"type": "response_item", "payload": {"type": "reasoning"}}, None),
        ({"no": "payload"}, None),
    ],
)
def test_extract_rollout_user_text(obj, expected):
    assert im_passthrough._extract_rollout_user_text(obj) == expected


@pytest.mark.parametrize(
    "text,is_wrapper",
    [
        ("<user_instructions>", True),
        ("  <environment_context>", True),  # leading ws tolerated
        ("# AGENTS.md instructions", True),
        ("帮我看看股权结构", False),
        ("fix the bug in <main.py>", False),  # only a LEADING '<' flags
        ("normal prompt", False),
    ],
)
def test_looks_like_context_wrapper(text, is_wrapper):
    assert im_passthrough._looks_like_context_wrapper(text) is is_wrapper


# ---------------------------------------------------------------------------
# parse_codex_rollout — head-scan over the real jsonl shape
# ---------------------------------------------------------------------------


def test_parse_codex_rollout_empty():
    p = parse_codex_rollout([])
    assert p == ParsedRollout(cwd=None, summary_raw=None, session_id=None)


def test_parse_codex_rollout_new_meta_and_user_message():
    lines = [
        json.dumps({"type": "session_meta", "payload": {
            "session_id": "019f-new", "id": "019f-new", "cwd": "/Users/k/proj"}}),
        json.dumps(_msg("developer", "<permissions instructions> ...")),
        json.dumps(_msg("user", "# AGENTS.md instructions for /Users/k/proj")),  # wrapper, skipped
        json.dumps(_rec("event_msg", "user_message", message="帮我看看股权结构")),
    ]
    p = parse_codex_rollout(lines)
    assert p.cwd == "/Users/k/proj"
    assert p.session_id == "019f-new"
    assert p.summary_raw == "帮我看看股权结构"


def test_parse_codex_rollout_old_meta_uses_id_field():
    # 2026-05 era: meta has ``id`` but NOT ``session_id``.
    lines = [
        json.dumps({"type": "session_meta", "payload": {"id": "019e-old", "cwd": "/w"}}),
        json.dumps(_rec("event_msg", "user_message", message="Hello, are you working?")),
    ]
    p = parse_codex_rollout(lines)
    assert p.session_id == "019e-old" and p.cwd == "/w"
    assert p.summary_raw == "Hello, are you working?"


def test_parse_codex_rollout_response_item_fallback_when_no_user_message():
    # A rollout with no user_message event still yields a preview from the first
    # non-wrapper role=user record.
    lines = [
        json.dumps({"type": "session_meta", "payload": {"session_id": "s", "cwd": "/c"}}),
        json.dumps(_msg("user", "<user_instructions>x")),        # wrapper
        json.dumps(_msg("user", "actual first message")),        # taken
    ]
    p = parse_codex_rollout(lines)
    assert p.summary_raw == "actual first message"


def test_parse_codex_rollout_tolerates_bad_lines():
    lines = [
        "not json at all",
        "",
        "{ broken json",
        "[1, 2, 3]",  # valid json, not a dict
        json.dumps({"type": "session_meta", "payload": {"session_id": "s1", "cwd": "/w"}}),
        json.dumps(_rec("event_msg", "user_message", message="ok")),
    ]
    p = parse_codex_rollout(lines)
    assert p.cwd == "/w" and p.session_id == "s1" and p.summary_raw == "ok"


def test_parse_codex_rollout_stops_at_max_scan():
    # cwd/summary buried past the scan window are not found (cheap head read).
    noise = [json.dumps(_rec("event_msg", "token_count")) for _ in range(50)]
    lines = noise + [json.dumps(_rec("event_msg", "user_message", message="late"))]
    p = parse_codex_rollout(lines, max_scan=10)
    assert p.summary_raw is None


# ---------------------------------------------------------------------------
# Read-only FS layer — list_codex_sessions / find_codex_session (temp store)
# ---------------------------------------------------------------------------


def _write_rollout(root, ymd, ts, sid, *, cwd, first_msg, mtime=None, id_key="session_id", body=None):
    y, mo, d = ymd
    day = os.path.join(root, "sessions", y, mo, d)
    os.makedirs(day, exist_ok=True)
    path = os.path.join(day, f"rollout-{ts}-{sid}.jsonl")
    with open(path, "w", encoding="utf-8") as fh:
        if body is None:
            fh.write(json.dumps({"type": "session_meta", "payload": {id_key: sid, "cwd": cwd}}) + "\n")
            fh.write(json.dumps(_msg("developer", "<permissions> ...")) + "\n")
            fh.write(json.dumps(_rec("event_msg", "user_message", message=first_msg)) + "\n")
        else:
            fh.write(body)
    if mtime is not None:
        os.utime(path, (mtime, mtime))
    return path


def test_list_codex_sessions_newest_first_across_days(tmp_path, monkeypatch):
    root = str(tmp_path)
    monkeypatch.setenv("CODEX_HOME", root)
    _write_rollout(root, ("2026", "05", "26"), "2026-05-26T04-51-49", "aaaa-1111",
                   cwd="/p/a", first_msg="oldest", mtime=1000)
    _write_rollout(root, ("2026", "06", "20"), "2026-06-20T03-26-51", "bbbb-2222",
                   cwd="/p/b", first_msg="middle", mtime=2000)
    _write_rollout(root, ("2026", "07", "17"), "2026-07-17T06-56-33", "cccc-3333",
                   cwd="/p/c", first_msg="newest", mtime=3000)

    sessions = list_codex_sessions(10)
    assert [s.session_id for s in sessions] == ["cccc-3333", "bbbb-2222", "aaaa-1111"]
    assert sessions[0].cwd == "/p/c" and sessions[0].summary == "newest"


def test_list_codex_sessions_caps_and_skips_empty(tmp_path, monkeypatch):
    root = str(tmp_path)
    monkeypatch.setenv("CODEX_HOME", root)
    for i in range(15):
        _write_rollout(root, ("2026", "07", "01"), f"2026-07-01T00-00-{i:02d}", f"id-{i:04d}",
                       cwd="/p", first_msg=f"msg {i}", mtime=1000 + i)
    # a zero-byte rollout must not consume a slot, even though it is newest.
    empty = os.path.join(root, "sessions", "2026", "07", "01", "rollout-x-empty-9999.jsonl")
    open(empty, "w").close()
    os.utime(empty, (99999, 99999))

    sessions = list_codex_sessions(10)
    assert len(sessions) == 10, "must cap at the limit"
    assert all(s.session_id != "empty-9999" for s in sessions), "empty file skipped"
    assert sessions[0].session_id == "id-0014", "newest non-empty first"


def test_list_codex_sessions_dedupes_same_id_across_segments(tmp_path, monkeypatch):
    # Resuming a codex session writes a NEW rollout file carrying the ORIGINAL
    # id — the list must show that session once (its newest segment).
    root = str(tmp_path)
    monkeypatch.setenv("CODEX_HOME", root)
    _write_rollout(root, ("2026", "07", "10"), "2026-07-10T01-00-00", "dup-id-0001",
                   cwd="/p", first_msg="first segment", mtime=1000)
    _write_rollout(root, ("2026", "07", "11"), "2026-07-11T01-00-00", "dup-id-0001",
                   cwd="/p", first_msg="resumed segment", mtime=2000)
    _write_rollout(root, ("2026", "07", "12"), "2026-07-12T01-00-00", "other-0002",
                   cwd="/p", first_msg="other", mtime=1500)

    sessions = list_codex_sessions(10)
    ids = [s.session_id for s in sessions]
    assert ids == ["dup-id-0001", "other-0002"], "same id shown once, newest segment"
    assert sessions[0].summary == "resumed segment"


def test_list_codex_sessions_filename_id_fallback(tmp_path, monkeypatch):
    # A rollout whose meta omits the id still resolves via the filename UUID.
    root = str(tmp_path)
    monkeypatch.setenv("CODEX_HOME", root)
    body = (
        json.dumps({"type": "session_meta", "payload": {"cwd": "/p"}}) + "\n"
        + json.dumps(_rec("event_msg", "user_message", message="hi")) + "\n"
    )
    _write_rollout(root, ("2026", "07", "17"), "2026-07-17T06-56-33",
                   "019f705d-5991-7493-8bb0-a92040243830", cwd="/p", first_msg="", body=body)
    sessions = list_codex_sessions(10)
    assert len(sessions) == 1
    assert sessions[0].session_id == "019f705d-5991-7493-8bb0-a92040243830"
    assert sessions[0].summary == "hi"


def test_list_codex_sessions_scrubs_control_chars(tmp_path, monkeypatch):
    # Injection red line: a control-char-laden prompt is scrubbed before display.
    root = str(tmp_path)
    monkeypatch.setenv("CODEX_HOME", root)
    _write_rollout(root, ("2026", "07", "17"), "2026-07-17T06-56-33", "ctrl-0001",
                   cwd="/p", first_msg="a\x00b\x1b[31mc​d", mtime=1000)
    sessions = list_codex_sessions(10)
    s = sessions[0].summary
    assert "\x00" not in s and "\x1b" not in s and "​" not in s
    for ch in "abcd":
        assert ch in s


def test_list_codex_sessions_missing_root_is_empty(tmp_path, monkeypatch):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "does-not-exist"))
    assert list_codex_sessions(10) == []


def test_find_codex_session_by_id_and_prefix(tmp_path, monkeypatch):
    root = str(tmp_path)
    monkeypatch.setenv("CODEX_HOME", root)
    sid = "019f705d-5991-7493-8bb0-a92040243830"
    _write_rollout(root, ("2026", "07", "17"), "2026-07-17T06-56-33", sid,
                   cwd="/Users/k/target", first_msg="resume me")

    info = find_codex_session(sid)
    assert info is not None and info.session_id == sid and info.cwd == "/Users/k/target"
    # the displayed 8-char prefix also resolves (filename substring match).
    assert find_codex_session(sid[:8]) is not None
    assert find_codex_session("no-such-id-here") is None


@pytest.mark.parametrize("evil", ["../../etc/passwd", "a/b", "..", "", "  ", "x" * 500])
def test_find_codex_session_rejects_traversal_and_malformed(tmp_path, monkeypatch, evil):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    assert find_codex_session(evil) is None


# ---------------------------------------------------------------------------
# render_session_list(family="codex") — the reply advertises /codex
# ---------------------------------------------------------------------------


def test_render_session_list_codex_empty():
    out = render_session_list([], now_ts=1_000_000.0, family="codex")
    assert "没有找到 Codex" in out and "/codex new" in out and "/cc" not in out


def test_render_session_list_codex_numbers_and_command():
    sessions = [
        SessionInfo(session_id="019f705d-aaaa-bbbb", cwd="/Users/k/ban", summary="穿透股权", mtime=999_940.0),
        SessionInfo(session_id="019e60e8-cccc-dddd", cwd="/Users/k/other", summary="", mtime=996_400.0),
    ]
    out = render_session_list(sessions, now_ts=1_000_000.0, family="codex")
    assert "本机 Codex 会话" in out and "共 2 条" in out
    assert "1. ban · 1 分钟前" in out and "穿透股权" in out
    assert "2. other · 1 小时前" in out and "(无预览)" in out
    assert "id 019f705d" in out
    assert "/codex <编号>" in out and "/codex resume" in out
    assert "/cc" not in out, "codex reply must not mention /cc"


# ---------------------------------------------------------------------------
# Driver resume WIRING — a preset session_id makes open() attach, not fork
# ---------------------------------------------------------------------------


def _codex_server():
    """A scripted app-server that answers the handshake + start/resume."""
    def responder(msg: dict) -> list[dict]:
        method = msg.get("method")
        if method == "initialize":
            return [{"id": msg["id"], "result": {}}]
        if method == "initialized":
            return []
        if method == "thread/start":
            return [{"id": msg["id"], "result": {"thread": {"id": "fresh-thread"}}}]
        if method == "thread/resume":
            tid = msg["params"]["threadId"]
            return [{"id": msg["id"], "result": {"thread": {"id": tid, "sessionId": tid}}}]
        return []
    return responder


def _codex_harness():
    from agent.coding_agents import ScriptedLineChannel, harness_for

    return harness_for("codex", "/tmp", channel_factory=lambda: ScriptedLineChannel(_codex_server()))


def test_codex_open_resumes_preset_session_via_thread_resume():
    h = _codex_harness()
    # What _build_and_open(resume_session_id=...) does: preset before open().
    h.session_id = "019ee159-ae8c-7ad0-99c4-a26760da9a56"
    assert h.open() == "019ee159-ae8c-7ad0-99c4-a26760da9a56"
    methods = [m.get("method") for m in h.channel.sent]
    assert "thread/resume" in methods, "preset id must ATTACH, not fork"
    assert "thread/start" not in methods, "must not also start a fresh thread"
    resume = next(m for m in h.channel.sent if m.get("method") == "thread/resume")
    assert resume["params"] == {"threadId": "019ee159-ae8c-7ad0-99c4-a26760da9a56"}


def test_codex_open_without_preset_starts_fresh_thread():
    h = _codex_harness()
    assert h.open() == "fresh-thread"  # unchanged default (backward compatible)
    methods = [m.get("method") for m in h.channel.sent]
    assert "thread/start" in methods and "thread/resume" not in methods
