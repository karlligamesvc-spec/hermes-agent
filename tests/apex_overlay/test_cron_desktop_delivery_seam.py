"""hc-1186: a scheduled job made in a Desktop chat posts its result back into that chat.

Real pieces throughout: the cronjob tool entry, the job store, ``cron.scheduler._deliver_result`` and
``run_one_job`` (down to a fake platform sender for the IM leg), SessionDB on a temp state.db, and
``tui_gateway.server``'s own turn admission for an open chat. The seam is installed through its real patch
functions; every test checks first that it landed.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

import cron.jobs as jobs_mod
from cron import scheduler
import tools.cronjob_job_args as job_args
from apex_overlay import cron_desktop_delivery as seam
from hermes_state import SessionDB
from tools import cronjob_tools

REPO = Path(__file__).resolve().parents[2]
CHAT = "20261108_093309_be257d"
HOME_CHANNELS = ("FEISHU_HOME_CHANNEL", "WEIXIN_HOME_CHANNEL", "SLACK_HOME_CHANNEL", "TELEGRAM_HOME_CHANNEL")


@pytest.fixture
def home(tmp_path, monkeypatch):
    """A Desktop assistant's home: its job store, a state.db holding one Desktop chat, the seam installed."""
    home = tmp_path / "apexnodes"
    (home / "cron" / "output").mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(jobs_mod, "HERMES_DIR", home)
    monkeypatch.setattr(jobs_mod, "CRON_DIR", home / "cron")
    monkeypatch.setattr(jobs_mod, "JOBS_FILE", home / "cron" / "jobs.json")
    monkeypatch.setattr(jobs_mod, "OUTPUT_DIR", home / "cron" / "output")
    for name in ("HERMES_SESSION_PLATFORM", "HERMES_SESSION_CHAT_ID", *HOME_CHANNELS):
        monkeypatch.delenv(name, raising=False)
    db = SessionDB(db_path=home / "state.db")
    db.create_session(CHAT, source="desktop")
    db.append_message(CHAT, "user", content="帮我建一个定时任务")
    db.close()
    # Every patched attribute goes back after the test.
    monkeypatch.setitem(cronjob_tools._JOBLESS_ACTIONS, "create", cronjob_tools._JOBLESS_ACTIONS["create"])
    monkeypatch.setitem(cronjob_tools._JOB_ACTIONS, "update", cronjob_tools._JOB_ACTIONS["update"])
    for module, name in ((cronjob_tools, "_action_create"), (cronjob_tools, "_action_update"),
                         (cronjob_tools, "_local_delivery_notice"), (job_args, "_local_delivery_notice"),
                         (scheduler, "_deliver_result")):
        monkeypatch.setattr(module, name, getattr(module, name))
    assert seam._install_args(job_args) and seam._install_tool(cronjob_tools) and seam._install_scheduler(scheduler)
    assert getattr(scheduler._deliver_result, seam._MARK, False), "scheduler seam not installed"
    assert getattr(cronjob_tools._JOBLESS_ACTIONS["create"], seam._MARK, False), "tool seam not installed"
    return home


@pytest.fixture
def desktop_turn():
    """Session vars exactly as tui_gateway binds them for a Desktop chat turn."""
    from gateway.session_context import clear_session_vars, set_session_vars

    tokens = set_session_vars(session_key=CHAT, session_id=CHAT, source="desktop", profile="default",
                              ui_session_id="ui-1", cron_session="")
    yield
    clear_session_vars(tokens)


@pytest.fixture
def broadcasts(monkeypatch):
    from tui_gateway import server

    sent: list[tuple[str, dict]] = []
    monkeypatch.setattr(server, "_broadcast_global_event", lambda event, payload=None: sent.append((event, payload)))
    return sent


def _call(**kwargs) -> dict:
    return json.loads(cronjob_tools.cronjob(**kwargs))


def _rows(home: Path, session_id: str = CHAT) -> list[dict]:
    db = SessionDB(db_path=home / "state.db")
    try:
        return [m for m in db.get_messages(session_id) if m.get("display_kind") == seam.DISPLAY_KIND]
    finally:
        db.close()


def _meta(row: dict) -> dict:
    meta = row["display_metadata"]
    return json.loads(meta) if isinstance(meta, str) else meta


def _pending(home: Path) -> list[Path]:
    return sorted(home.joinpath(*seam.PENDING_DIR).glob("*.json"))


def _desktop_job(home: Path, **extra) -> dict:
    created = _call(action="create", prompt="搜一条今天的财经新闻", schedule="in 30m", name="今日财经", **extra)
    assert created["success"] is True
    return {**jobs_mod.get_job(created["job_id"]), "execution_id": f"exec-{created['job_id']}"}


# ── 1. where a job was made ──────────────────────────────────────────────────────────────────────────────────


def test_a_job_made_in_a_desktop_chat_remembers_the_chat_and_delivers(home, desktop_turn):
    created = _call(action="create", prompt="x", schedule="in 30m", name="今日财经")

    job = jobs_mod.get_job(created["job_id"])
    assert job[seam.ORIGIN_KEY] == {"session_id": CHAT, "profile": "default"}
    assert job["deliver"] == "origin" and created["deliver"] == "origin" and created["job"]["deliver"] == "origin"
    assert "posted back into this Desktop conversation" in created["message"]
    assert "local-only" not in created["message"]


def test_explicit_local_stays_save_only(home, desktop_turn):
    created = _call(action="create", prompt="x", schedule="in 30m", deliver="local")
    assert created["deliver"] == "local"
    assert "posted back" not in created.get("message", "")
    assert seam.delivers_to_desktop(jobs_mod.get_job(created["job_id"])) is False


def test_a_bound_im_is_named_in_the_notice(home, desktop_turn, monkeypatch):
    monkeypatch.setenv("SLACK_HOME_CHANNEL", "C0HOME")
    created = _call(action="create", prompt="x", schedule="in 30m")
    assert "posted back into this Desktop conversation" in created["message"]
    assert "also sent to the connected slack home channel" in created["message"]


@pytest.mark.parametrize("source", ["tui", "", "cron"])
def test_other_sessions_keep_upstream(home, source):
    from gateway.session_context import clear_session_vars, set_session_vars

    tokens = set_session_vars(session_id=CHAT, source=source, cron_session="1" if source == "cron" else "")
    try:
        created = _call(action="create", prompt="x", schedule="in 30m")
    finally:
        clear_session_vars(tokens)
    assert seam.ORIGIN_KEY not in jobs_mod.get_job(created["job_id"])
    if source != "cron":
        assert "local-only cron job" in created["message"]


def test_an_im_chat_keeps_its_own_origin(home):
    from gateway.session_context import clear_session_vars, set_session_vars

    tokens = set_session_vars(platform="feishu", chat_id="oc_chat", session_id=CHAT, source="desktop")
    try:
        created = _call(action="create", prompt="x", schedule="in 30m")
    finally:
        clear_session_vars(tokens)
    job = jobs_mod.get_job(created["job_id"])
    assert job["origin"]["platform"] == "feishu" and seam.ORIGIN_KEY not in job


def test_an_update_from_a_desktop_chat_stamps_an_older_job(home):
    created = _call(action="create", prompt="x", schedule="in 30m", deliver="origin")  # outside any chat
    assert seam.ORIGIN_KEY not in jobs_mod.get_job(created["job_id"])
    from gateway.session_context import clear_session_vars, set_session_vars

    tokens = set_session_vars(session_id=CHAT, source="desktop", cron_session="")
    try:
        updated = _call(action="update", job_id=created["job_id"], name="改名")
    finally:
        clear_session_vars(tokens)
    assert updated["success"] is True
    assert jobs_mod.get_job(created["job_id"])[seam.ORIGIN_KEY]["session_id"] == CHAT


# ── 2. at fire time ──────────────────────────────────────────────────────────────────────────────────────────


def test_the_result_comes_back_into_the_chat_without_a_model_turn(home, desktop_turn, broadcasts):
    job = _desktop_job(home)

    assert scheduler._deliver_result(job, "国家统计局公布 10 月 CPI（来源：国家统计局）") is None

    [row] = _rows(home)
    assert row["role"] == "user"
    assert row["content"].startswith("[定时任务「今日财经」到点跑完的结果（后台按时自动送来，不是用户发的消息）]")
    meta = _meta(row)
    assert meta["status"] == "ok" and meta["job_id"] == job["id"] and meta["job_name"] == "今日财经"
    assert meta["display_text"] == "国家统计局公布 10 月 CPI（来源：国家统计局）"
    assert meta["delivery_id"] == job["execution_id"]
    assert _pending(home) == []
    assert broadcasts == [(seam.BROADCAST_EVENT, {seam.BROADCAST_KEY: {
        "session_id": CHAT, "job_id": job["id"], "job_name": "今日财经", "status": "ok",
        "delivery_id": job["execution_id"], "profile": "default"}})]


def test_a_failure_notice_comes_back_too(home, desktop_turn, broadcasts):
    job = _desktop_job(home)
    scheduler._deliver_result(job, "模型没连上", for_failure=True)
    [row] = _rows(home)
    assert _meta(row)["status"] == "failed" and "没跑成" in row["content"]


def test_failure_deliver_local_keeps_failures_quiet(home, desktop_turn, broadcasts):
    job = _desktop_job(home, failure_deliver="local")
    scheduler._deliver_result(job, "模型没连上", for_failure=True)
    assert _rows(home) == [] and broadcasts == []


def test_a_save_only_job_posts_nothing(home, desktop_turn, broadcasts):
    job = _desktop_job(home, deliver="local")
    assert scheduler._deliver_result(job, "结果") is None
    assert _rows(home) == [] and _pending(home) == [] and broadcasts == []


def test_the_run_session_is_linked(home, desktop_turn, broadcasts):
    job = _desktop_job(home)
    db = SessionDB(db_path=home / "state.db")
    db.create_session(f"cron_{job['id']}_20261108_093518", source="cron")
    db.close()
    scheduler._deliver_result(job, "结果")
    assert _meta(_rows(home)[0])["run_session_id"] == f"cron_{job['id']}_20261108_093518"


def test_a_compressed_chat_gets_it_on_its_continuation(home, desktop_turn, broadcasts):
    job = _desktop_job(home)
    db = SessionDB(db_path=home / "state.db")
    db.end_session(CHAT, "compression")
    db.create_session("cont-1", source="desktop", parent_session_id=CHAT)
    db.append_message("cont-1", "user", content="压缩后的第一句")
    db.close()

    scheduler._deliver_result(job, "结果")

    assert _rows(home, CHAT) == []
    assert len(_rows(home, "cont-1")) == 1


def test_a_deleted_chat_falls_back_to_the_newest_desktop_chat(home, desktop_turn, broadcasts):
    job = _desktop_job(home)
    db = SessionDB(db_path=home / "state.db")
    db.create_session("newer-chat", source="desktop")
    db.append_message("newer-chat", "user", content="新对话")
    assert db.delete_session(CHAT)
    db.close()

    scheduler._deliver_result(job, "结果")
    assert len(_rows(home, "newer-chat")) == 1


def test_no_desktop_chat_left_drops_quietly(home, desktop_turn, broadcasts):
    job = _desktop_job(home)
    db = SessionDB(db_path=home / "state.db")
    assert db.delete_session(CHAT)
    db.close()
    assert scheduler._deliver_result(job, "结果") is None
    assert _pending(home) == [] and broadcasts == []


def test_a_retry_never_posts_twice(home, desktop_turn, broadcasts):
    job = _desktop_job(home)
    scheduler._deliver_result(job, "结果")
    path = seam._write_pending(job, "结果", False)  # what a crash between the row and the file removal leaves
    assert seam.drain_file(path) is True
    assert len(_rows(home)) == 1 and not path.exists()


# ── 3. a chat open in this process ───────────────────────────────────────────────────────────────────────────


def _open_chat(monkeypatch, home: Path, *, running: bool) -> dict:
    from tui_gateway import server

    db = SessionDB(db_path=home / "state.db")
    session = {"session_key": CHAT, "history": [{"role": "user", "content": "帮我建一个定时任务"}],
               "history_lock": threading.Lock(), "history_version": 3, "running": running,
               "agent": SimpleNamespace(session_id=CHAT, _session_db=db), "profile_home": str(home)}
    monkeypatch.setitem(server._sessions, "ui-1", session)
    return session


def test_an_idle_open_chat_gets_it_in_its_live_history_too(home, desktop_turn, broadcasts, monkeypatch):
    session = _open_chat(monkeypatch, home, running=False)
    job = _desktop_job(home)

    scheduler._deliver_result(job, "结果")

    assert session["history"][-1]["display_kind"] == seam.DISPLAY_KIND
    assert session["history"][-1]["content"].endswith("结果")
    assert session["history_version"] == 4 and session["running"] is False
    assert len(_rows(home)) == 1


def test_a_busy_chat_gets_it_when_its_turn_ends(home, desktop_turn, broadcasts, monkeypatch):
    session = _open_chat(monkeypatch, home, running=True)
    monkeypatch.setattr(seam, "_ensure_drainer", lambda _home: None)  # drive the drainer by hand
    job = _desktop_job(home)

    assert scheduler._deliver_result(job, "结果") is None  # queued, not an error
    assert _rows(home) == [] and len(_pending(home)) == 1 and session["history_version"] == 3
    assert broadcasts == []

    session["running"] = False
    assert seam.drain_home(home) == 0
    assert len(_rows(home)) == 1 and _pending(home) == []
    assert session["history"][-1]["display_kind"] == seam.DISPLAY_KIND and session["running"] is False
    assert len(broadcasts) == 1


def test_results_left_by_an_exited_process_are_posted_at_start(home, desktop_turn, broadcasts):
    job = _desktop_job(home)
    seam._write_pending(job, "上次没送到的结果", False)
    assert [p.parent.parent.parent for p in _pending(home)] == [home.resolve()]
    assert seam._homes_with_pending() == [home.resolve()]
    assert seam.drain_home(home) == 0
    assert _meta(_rows(home)[0])["display_text"] == "上次没送到的结果"


# ── 3b. recurring jobs, other assistants, upstream's own Desktop origin ─────────────────────────────────────


def test_a_recurring_job_comes_back_every_run(home, desktop_turn, broadcasts):
    created = _call(action="create", prompt="x", schedule="every 2h", name="每两小时")
    job = jobs_mod.get_job(created["job_id"])
    for run in ("exec-a", "exec-b"):
        scheduler._deliver_result({**job, "execution_id": run}, f"第 {run} 次的结果")
    assert [_meta(row)["delivery_id"] for row in _rows(home)] == ["exec-a", "exec-b"]
    assert len(broadcasts) == 2


def test_another_assistants_job_comes_back_into_its_own_chat(home, monkeypatch, broadcasts, caplog_at_debug):
    """A secondary assistant: its jobs, its state.db and its chats live under profiles/<name>."""
    bot = home / "profiles" / "apex-bot-2"
    (bot / "cron" / "output").mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(bot))
    for name, value in (("HERMES_DIR", bot), ("CRON_DIR", bot / "cron"), ("JOBS_FILE", bot / "cron" / "jobs.json"),
                        ("OUTPUT_DIR", bot / "cron" / "output")):
        monkeypatch.setattr(jobs_mod, name, value)
    db = SessionDB(db_path=bot / "state.db")
    db.create_session("bot-chat-1", source="desktop")
    db.close()
    from gateway.session_context import clear_session_vars, set_session_vars

    tokens = set_session_vars(session_id="bot-chat-1", source="desktop", profile="apex-bot-2", cron_session="")
    try:
        job = _desktop_job(bot)
    finally:
        clear_session_vars(tokens)
    assert job[seam.ORIGIN_KEY] == {"session_id": "bot-chat-1", "profile": "apex-bot-2"}

    with caplog_at_debug() as caplog:
        scheduler._deliver_result(job, "小剪的结果")

    assert len(_rows(bot, "bot-chat-1")) == 1 and _rows(home) == []
    assert broadcasts[-1][1][seam.BROADCAST_KEY]["profile"] == "apex-bot-2"
    [line] = _seam_lines(caplog, logging.INFO)
    assert "Desktop chat bot-chat-1 (profile apex-bot-2," in line


def test_upstreams_own_desktop_origin_is_left_to_upstream(home, desktop_turn, broadcasts, monkeypatch):
    """Should upstream record Desktop chats as origin (open upstream PR #83975), nothing is delivered twice."""
    upstream_origin = {"platform": "desktop", "chat_id": CHAT, "chat_name": None, "thread_id": None}
    monkeypatch.setattr(cronjob_tools, "_origin_from_env", lambda *_a, **_k: dict(upstream_origin))
    created = _call(action="create", prompt="x", schedule="in 30m")
    job = jobs_mod.get_job(created["job_id"])
    assert job["origin"]["platform"] == "desktop" and seam.ORIGIN_KEY not in job

    upstream_sends = []
    deliver_once = seam._wrap_deliver(lambda j, c, adapters=None, loop=None, *, for_failure=False: upstream_sends.append(c))
    deliver_once({**job, "execution_id": "exec-up"}, "结果")
    assert upstream_sends == ["结果"] and _rows(home) == [] and _pending(home) == [] and broadcasts == []


def test_a_job_stamped_here_that_later_carries_upstreams_origin_is_upstreams(home, desktop_turn, broadcasts):
    job = {**_desktop_job(home), "origin": {"platform": "desktop", "chat_id": CHAT}}
    assert seam.delivers_to_desktop(job) is False
    scheduler._deliver_result(job, "结果")
    assert _rows(home) == [] and broadcasts == []


def test_a_failing_first_attempt_is_not_a_failed_delivery(home, desktop_turn, broadcasts, monkeypatch):
    """The store being busy at fire time leaves the result queued for the drainer, not an error on the run."""
    started = []
    monkeypatch.setattr(seam, "_ensure_drainer", started.append)
    monkeypatch.setattr(seam, "_post", lambda _path: (_ for _ in ()).throw(RuntimeError("database is locked")))
    job = _desktop_job(home)
    assert scheduler._deliver_result(job, "结果") is None
    assert len(_pending(home)) == 1 and started == [home.resolve()]


# ── 4. both sides with an IM bound, through the real run path ────────────────────────────────────────────────


def test_with_an_im_bound_the_result_goes_to_both(home, desktop_turn, broadcasts, monkeypatch):
    (home / "config.yaml").write_text("platforms:\n  slack:\n    enabled: true\n    token: xoxb-test\n")
    monkeypatch.setenv("SLACK_HOME_CHANNEL", "C0HOME")
    sent = []

    async def fake_sender(pconfig, chat_id, message, *, thread_id=None, media_files=None, force_document=False,
                          caption=None):
        sent.append({"chat_id": chat_id, "message": message})
        return {"success": True, "chat_id": chat_id, "message_id": "1.2"}

    import gateway.platform_registry as reg
    import hermes_cli.plugins as hp

    entry = reg.platform_registry.get("slack")
    if entry is None:
        hp.discover_plugins()
        entry = reg.platform_registry.get("slack")
    if entry is None:
        pytest.skip("slack platform entry not registered")
    monkeypatch.setattr(entry, "standalone_sender_fn", fake_sender)
    monkeypatch.setattr(hp, "discover_plugins", lambda *a, **k: None)
    for name, value in (("create_execution", lambda *_a, **_k: {"id": "exec-both"}),
                        ("claim_dispatch", lambda _job_id: True), ("mark_execution_running", lambda _e: {}),
                        ("save_job_output", lambda jid, out: f"/tmp/{jid}.txt"), ("mark_job_run", lambda *a, **k: True),
                        ("finish_execution", lambda *a, **k: None), ("load_config", dict),
                        ("_upsert_incident_for_failure", lambda *_a, **_k: (False, None)),
                        ("run_job", lambda job, **_k: (True, "raw output", "今天的新闻标题", None))):
        monkeypatch.setattr(scheduler, name, value)
    job = _desktop_job(home)
    job.pop("execution_id")

    assert scheduler.run_one_job(job) is True
    # v0.23.0: an agent fire with an execution id queues its delivery; the gateway's housekeeping tick
    # drains the queue through cron.scheduler._deliver_result, the function this seam wraps (hc-1203).
    assert sent == []
    assert scheduler.drain_delivery_queue(None, None) == 1

    assert [call["chat_id"] for call in sent] == ["C0HOME"] and "今天的新闻标题" in sent[0]["message"]
    [row] = _rows(home)
    assert "今天的新闻标题" in _meta(row)["display_text"]


# ── 5. what the engine log says ─────────────────────────────────────────────────────────────────────────────
# The upstream sender logs "deliver=origin but no origin or home channels — skipping delivery" when no IM home
# channel is bound, then this seam posts the result: the log must say where it went, once, with ids only.

RESULT = "国家统计局公布 10 月 CPI——这是结果正文，不该进日志"
USER_TEXT = (RESULT, "今日财经", "搜一条今天的财经新闻")


@pytest.fixture
def caplog_at_debug(caplog):
    from contextlib import contextmanager

    @contextmanager
    def capture():
        """What the block logs, and only that (hc-1227). caplog keeps the whole test's records, so once an earlier
        test leaves the root logger at INFO (the first import of hermes_cli.main runs setup_logging), a delivery
        logged before the block would count too."""
        with caplog.at_level(logging.DEBUG):
            caplog.clear()
            yield caplog

    return capture


def _seam_lines(caplog, level: int) -> list[str]:
    return [r.getMessage() for r in caplog.records if r.name == seam.logger.name and r.levelno == level]


def _no_user_text_logged(caplog) -> None:
    """Nothing this seam logs carries the result or the job's name (upstream's own line names the job)."""
    for record in caplog.records:
        if record.name != seam.logger.name:
            continue
        message = record.getMessage()
        assert not any(text in message for text in USER_TEXT), message


def test_a_delivery_into_a_chat_not_open_says_where_it_went(home, desktop_turn, broadcasts, caplog_at_debug):
    job = _desktop_job(home)
    with caplog_at_debug() as caplog:
        scheduler._deliver_result(job, RESULT)

    [line] = _seam_lines(caplog, logging.INFO)
    assert line.startswith(f"apex-overlay: cron job {job['id']}: result delivered to Desktop chat {CHAT} ")
    assert f"(profile default, delivery {job['execution_id']})" in line and seam._POSTED_STORED in line
    assert "only means no Feishu/WeChat home channel got it" in line
    upstream = [i for i, r in enumerate(caplog.records) if "skipping delivery" in r.getMessage()
                and r.name != seam.logger.name]
    ours = [i for i, r in enumerate(caplog.records) if r.getMessage() == line]
    assert upstream and upstream[0] < ours[0], "the upstream line comes first, this one says what happened next"
    _no_user_text_logged(caplog)


def test_a_delivery_into_the_open_chat_says_so(home, desktop_turn, broadcasts, monkeypatch, caplog_at_debug):
    _open_chat(monkeypatch, home, running=False)
    job = _desktop_job(home)
    with caplog_at_debug() as caplog:
        scheduler._deliver_result(job, RESULT)
    [line] = _seam_lines(caplog, logging.INFO)
    assert seam._POSTED_LIVE in line and f"Desktop chat {CHAT} " in line
    _no_user_text_logged(caplog)


def test_a_failure_notice_is_logged_as_one(home, desktop_turn, broadcasts, caplog_at_debug):
    job = _desktop_job(home)
    with caplog_at_debug() as caplog:
        scheduler._deliver_result(job, RESULT, for_failure=True)
    [line] = _seam_lines(caplog, logging.INFO)
    assert f"cron job {job['id']}: failure notice delivered to Desktop chat {CHAT} " in line
    _no_user_text_logged(caplog)


def test_a_busy_chat_logs_the_wait_once_then_the_delivery(home, desktop_turn, broadcasts, monkeypatch, caplog_at_debug):
    session = _open_chat(monkeypatch, home, running=True)
    monkeypatch.setattr(seam, "_ensure_drainer", lambda _home: None)  # drive the drainer by hand
    job = _desktop_job(home)
    with caplog_at_debug() as caplog:
        scheduler._deliver_result(job, RESULT)
        for _ in range(3):  # drainer passes while the turn runs
            assert seam.drain_home(home) == 1
        [waiting] = _seam_lines(caplog, logging.INFO)
        assert f"cron job {job['id']}: Desktop chat {CHAT} (profile default) is in a turn" in waiting
        assert _pending(home)[0].name in waiting

        session["running"] = False
        assert seam.drain_home(home) == 0
    waiting_again, delivered = _seam_lines(caplog, logging.INFO)
    assert waiting_again == waiting and seam._POSTED_LIVE in delivered
    _no_user_text_logged(caplog)


def test_a_second_attempt_at_the_same_delivery_is_not_logged_as_another(home, desktop_turn, broadcasts, caplog_at_debug):
    job = _desktop_job(home)
    scheduler._deliver_result(job, RESULT)
    path = seam._write_pending(job, RESULT, False)  # what a crash between the row and the file removal leaves
    with caplog_at_debug() as caplog:
        assert seam.drain_file(path) is True
    assert _seam_lines(caplog, logging.INFO) == []
    assert any("not posted twice" in line for line in _seam_lines(caplog, logging.DEBUG))


def _age(path: Path, seconds: float) -> None:
    then = path.stat().st_mtime - seconds
    os.utime(path, (then, then))


def test_an_unreadable_pending_file_warns_once_and_is_moved_aside(home, caplog_at_debug):
    pending = home.joinpath(*seam.PENDING_DIR)
    pending.mkdir(parents=True)
    (pending / "exec-x.ok.json").write_text("{not json", encoding="utf-8")
    _age(pending / "exec-x.ok.json", seam._UNREADABLE_GRACE_SECONDS + 60)  # long past any write still in flight
    with caplog_at_debug() as caplog:
        assert [seam.drain_home(home) for _ in range(3)] == [0, 0, 0]
    [warning] = _seam_lines(caplog, logging.WARNING)
    assert "exec-x.ok.json is unreadable; moved aside to exec-x.ok.unreadable" in warning
    assert not (pending / "exec-x.ok.json").exists() and (pending / "exec-x.ok.unreadable").exists()


def test_a_drainer_pass_during_a_write_never_sees_a_half_written_result(home, desktop_turn, broadcasts, monkeypatch,
                                                                          caplog_at_debug):
    """A result queued while another one waits: the drainer's pass may land mid-write. The file appears whole or
    not at all, so nothing is moved aside and the result is delivered once."""
    import utils

    seen = []
    real_replace = utils.atomic_replace

    def a_drainer_pass_before_the_rename(tmp, target):
        queued = sorted(p.name for p in Path(target).parent.glob("*.json"))
        seen.append((queued, seam.drain_home(home)))
        return real_replace(tmp, target)

    monkeypatch.setattr(utils, "atomic_replace", a_drainer_pass_before_the_rename)
    job = _desktop_job(home)
    with caplog_at_debug() as caplog:
        scheduler._deliver_result(job, RESULT)

    assert len(seen) == 1, "the result was not staged and renamed into the queue"
    assert seen == [([], 0)], "the drainer saw the result before it was whole"
    assert not list(home.joinpath(*seam.PENDING_DIR).glob("*.unreadable")) and _pending(home) == []
    assert len(_rows(home)) == 1
    [line] = _seam_lines(caplog, logging.INFO)
    assert f"cron job {job['id']}: result delivered to Desktop chat {CHAT} " in line


def test_a_result_still_being_written_is_read_again_not_moved_aside(home, desktop_turn, broadcasts, caplog_at_debug):
    """Whatever wrote a pending file non-atomically (Windows' contended-replace fallback rewrites in place),
    a fresh file that does not parse yet is retried, never taken for corrupt."""
    job = _desktop_job(home)
    path = seam._write_pending(job, RESULT, False)
    whole = path.read_text(encoding="utf-8")
    path.write_text(whole[: len(whole) // 2], encoding="utf-8")  # half of it, just written
    with caplog_at_debug() as caplog:
        assert seam.drain_home(home) == 1
        assert path.exists() and not list(path.parent.glob("*.unreadable")) and _rows(home) == []
        assert _seam_lines(caplog, logging.WARNING) == []

        path.write_text(whole, encoding="utf-8")
        assert seam.drain_home(home) == 0
    assert len(_rows(home)) == 1
    [line] = _seam_lines(caplog, logging.INFO)
    assert "result delivered to Desktop chat" in line


def test_temp_files_a_killed_writer_left_are_cleared_once_old(home, caplog_at_debug):
    pending = home.joinpath(*seam.PENDING_DIR)
    pending.mkdir(parents=True)
    old, fresh = pending / ".exec-old.ok_ab12.tmp", pending / ".exec-new.ok_cd34.tmp"
    for temp in (old, fresh):
        temp.write_text("{", encoding="utf-8")
    _age(old, seam._STALE_TEMP_SECONDS + 60)
    with caplog_at_debug() as caplog:
        assert seam.drain_home(home) == 0
        assert seam.drain_home(home) == 0
    assert not old.exists() and fresh.exists()
    [warning] = _seam_lines(caplog, logging.WARNING)
    assert ".exec-old.ok_ab12.tmp" in warning


def test_no_chat_left_warns_with_job_and_profile(home, desktop_turn, broadcasts, caplog_at_debug):
    job = _desktop_job(home)
    db = SessionDB(db_path=home / "state.db")
    assert db.delete_session(CHAT)
    db.close()
    with caplog_at_debug() as caplog:
        scheduler._deliver_result(job, RESULT)
    [warning] = _seam_lines(caplog, logging.WARNING)
    assert f"cron job {job['id']} has no Desktop chat left to post into (profile default)" in warning
    assert _seam_lines(caplog, logging.INFO) == []
    _no_user_text_logged(caplog)


def test_a_job_this_seam_does_not_deliver_logs_nothing_from_it(home, desktop_turn, broadcasts, caplog_at_debug):
    job = _desktop_job(home, deliver="local")
    with caplog_at_debug() as caplog:
        scheduler._deliver_result(job, RESULT)
    assert [r for r in caplog.records if r.name == seam.logger.name and r.levelno >= logging.INFO] == []


# ── wiring ───────────────────────────────────────────────────────────────────────────────────────────────────


def test_plugin_register_applies_the_seam():
    from tests.apex_overlay.conftest import run_plugin_register_with_stubbed_seams

    assert "cron_desktop_delivery" in run_plugin_register_with_stubbed_seams("_apex_overlay_plugin_hc1186")


def test_apply_before_the_imports_patches_them_when_they_load():
    """Production order: discovery arms the seam; the tool and the scheduler load later."""
    script = (
        "import sys\n"
        "from apex_overlay import cron_desktop_delivery as seam\n"
        "names = ('tools.cronjob_tools', 'tools.cronjob_job_args', 'cron.scheduler')\n"
        "assert not any(n in sys.modules for n in names)\n"
        "assert seam.apply() is True and seam.armed() is True\n"
        "assert not any(n in sys.modules for n in names)\n"
        "import tools.cronjob_tools as tool, tools.cronjob_job_args as args, cron.scheduler as sched\n"
        "patched = (tool._JOBLESS_ACTIONS['create'], tool._JOB_ACTIONS['update'], tool._local_delivery_notice,\n"
        "           args._local_delivery_notice, sched._deliver_result)\n"
        "assert all(getattr(fn, seam._MARK, False) for fn in patched), patched\n"
        "assert seam.armed() is True and seam.apply() is True\n"
        "assert (tool._JOBLESS_ACTIONS['create'], sched._deliver_result) == (patched[0], patched[4])\n"
        "print('ok')\n"
    )
    done = subprocess.run([sys.executable, "-c", script], cwd=REPO, capture_output=True, text=True, timeout=120,
                          check=False)
    assert done.returncode == 0 and done.stdout.strip().endswith("ok"), done.stderr[-2000:]
