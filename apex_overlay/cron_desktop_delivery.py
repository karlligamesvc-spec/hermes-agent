"""hc-1186 a scheduled job made in a Desktop chat posts its result back into that chat.

Upstream records a delivery origin only for IM chats (``tools/cronjob_job_args.py`` ``_origin_from_env``), so a
job made in a Desktop chat delivers to an IM home channel when Feishu or WeChat is bound and nowhere otherwise.
This seam adds the Desktop chat as a second destination, next to whatever upstream delivers:

1. **Where a job was made.** A ``cronjob_manage`` create (or update) that runs in a Desktop chat turn
   (``HERMES_SESSION_SOURCE == "desktop"``, no IM origin, not inside a cron run) stamps the job with
   ``apex_desktop_origin = {"session_id": <the chat's durable id>, "profile": ...}``. A create that left
   ``deliver`` out gets ``deliver="origin"`` instead of upstream's ``local``, so the result comes back here and,
   with Feishu or WeChat bound, also goes to that home channel. An explicit ``local`` stays save-only.
2. **What the tool says.** ``_local_delivery_notice`` answers for such a job that the result comes back into
   this conversation (and to the bound IM), instead of upstream's "will NOT be delivered back".
3. **At fire time.** ``cron.scheduler._deliver_result`` (the one sender for results, failure notices, crash
   notices and queued replays) runs upstream first, then posts a ``cron_result`` row into the chat: the
   compression tip of the stamped session (``resolve_resume_session_id``), or this assistant's most recent
   Desktop chat when that one was deleted. No model turn runs. A chat open in this process gets the row only
   while it is idle, appended to its live history and its state.db target the way upstream files a model
   switch marker (``tui_gateway.server._append_model_switch_marker``); a chat that is busy keeps it in a
   pending file until its turn ends. A chat not open here gets the row in state.db directly. Each pending
   file is removed once its row exists, and a row already present for the same delivery is never added twice.
4. **Telling the window.** After the row lands, ``cron.changed`` (an open-payload broadcast Desktop already
   listens to) carries ``apex_cron_result``; Desktop re-reads that chat if it is on screen and raises the OS
   notification when the user is away.

Upstream has an open PR (#83975) that records Desktop chats as ``origin = {"platform": "desktop", ...}`` and
queues the report to that chat itself. Should it land: a job with any origin is never stamped here, and a job
whose origin is upstream's Desktop one is never posted here either (``upstream_desktop_origin``), so the two
never both deliver; jobs stamped before such an upgrade keep coming back through this seam.

Cloud containers never see ``HERMES_SESSION_SOURCE == "desktop"``, so nothing is stamped and nothing changes
there. Upstream files stay untouched.
"""

from __future__ import annotations

import contextlib
import functools
import json
import logging
import sys
import threading
import time
import uuid
from pathlib import Path
from types import ModuleType
from typing import Any, Optional

from apex_overlay import post_import

logger = logging.getLogger(__name__)

ORIGIN_KEY = "apex_desktop_origin"
DISPLAY_KIND = "cron_result"
BROADCAST_EVENT = "cron.changed"
BROADCAST_KEY = "apex_cron_result"
PENDING_DIR = ("cron", "apex_desktop_results")

_TOOL_MODULE = "tools.cronjob_tools"
_ARGS_MODULE = "tools.cronjob_job_args"
_SCHEDULER_MODULE = "cron.scheduler"
_MARK = "_apex_cron_desktop_delivery"
_DRAIN_INTERVAL_SECONDS = 2.0

DESKTOP_NOTICE = (
    "Delivery: when this job runs, its result is posted back into this Desktop conversation as a scheduled-result "
    "message (no extra model turn){also}. Tell the user it will come back here.")

_drain_lock = threading.Lock()
# One poster at a time: the fire's own attempt and a drainer pass must not both post the same file.
_post_lock = threading.RLock()
_draining_homes: set[str] = set()


# ── 1. where a job was made ──────────────────────────────────────────────────────────────────────────────────


def desktop_chat_session_id() -> str:
    """The durable id of the Desktop chat this tool call runs in, or "" when it is not one."""
    from gateway.session_context import get_session_env
    from utils import is_truthy_value

    if get_session_env("HERMES_SESSION_SOURCE", "") != "desktop":
        return ""
    if get_session_env("HERMES_SESSION_PLATFORM", "") or is_truthy_value(get_session_env("HERMES_CRON_SESSION", "")):
        return ""
    return str(get_session_env("HERMES_SESSION_ID", "") or "").strip()


def _lane(job: dict[str, Any], for_failure: bool = False) -> str:
    from cron.scheduler_delivery import _delivery_lane_value, _normalize_deliver_value

    return _normalize_deliver_value(_delivery_lane_value(job, for_failure=for_failure))


def upstream_desktop_origin(job: dict[str, Any]) -> bool:
    """Upstream's own Desktop return address (open upstream PR #83975 records ``origin.platform == "desktop"``).
    Once upstream delivers to the chat itself, this seam stands aside for that job."""
    origin = job.get("origin")
    return isinstance(origin, dict) and str(origin.get("platform") or "").lower() == "desktop"


def delivers_to_desktop(job: dict[str, Any], for_failure: bool = False) -> bool:
    """A job this seam stamped, whose delivery (or failure-notice) lane is not save-only, and that upstream does
    not already deliver to the chat."""
    origin = job.get(ORIGIN_KEY)
    return (isinstance(origin, dict) and bool(origin.get("session_id")) and not upstream_desktop_origin(job)
            and _lane(job, for_failure) != "local")


def _stamp(module: ModuleType, job: dict[str, Any], *, deliver_omitted: bool) -> Optional[dict[str, Any]]:
    """Record the Desktop chat on a job made or changed in one; the updated job, or None when nothing changed."""
    from gateway.session_context import get_session_env

    session_id = desktop_chat_session_id()
    if not session_id or job.get("origin") or job.get(ORIGIN_KEY):
        return None
    updates: dict[str, Any] = {ORIGIN_KEY: {"session_id": session_id,
                                            "profile": str(get_session_env("HERMES_SESSION_PROFILE", "") or "")}}
    if deliver_omitted:
        updates["deliver"] = "origin"
    return module.update_job(job["id"], updates)


def _wrap_create(module: ModuleType, create):
    @functools.wraps(create)
    def create_from_desktop(a):
        result = create(a)
        try:
            payload = json.loads(result)
            job = module.get_job(payload["job_id"]) if payload.get("success") is True else None
            updated = _stamp(module, job, deliver_omitted=a.get("deliver") is None) if job else None
        except (OSError, ValueError, KeyError, TypeError):  # the job exists; a stamp we cannot add leaves it as made
            logger.warning("apex-overlay: could not record the Desktop chat on a new cron job", exc_info=True)
            return result
        if updated is None:
            return result
        payload["deliver"] = updated.get("deliver", payload.get("deliver"))
        payload["job"] = module._format_job(updated)
        return module._dumps(payload)

    return create_from_desktop


def _wrap_update(module: ModuleType, update):
    @functools.wraps(update)
    def update_from_desktop(job, a):
        result = update(job, a)
        try:
            if json.loads(result).get("success") is True and (current := module.get_job(job["id"])):
                _stamp(module, current, deliver_omitted=False)
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            logger.warning("apex-overlay: could not record the Desktop chat on an updated cron job", exc_info=True)
        return result

    return update_from_desktop


# ── 2. what the tool says ────────────────────────────────────────────────────────────────────────────────────


def _notice_applies(job: dict[str, Any], user_deliver: Optional[str]) -> bool:
    if (user_deliver or "").strip().lower() == "local":
        return False
    if job.get(ORIGIN_KEY):
        return delivers_to_desktop(job)
    return bool(desktop_chat_session_id()) and not job.get("origin")


def _im_platforms(job: dict[str, Any], user_deliver: Optional[str]) -> list[str]:
    from cron.scheduler import _resolve_delivery_targets

    probe = {**job, "deliver": user_deliver or ("origin" if _lane(job) == "local" else job.get("deliver"))}
    return sorted({str(t.get("platform")) for t in _resolve_delivery_targets(probe) or [] if t.get("platform")})


def _wrap_notice(notice):
    @functools.wraps(notice)
    def notice_with_desktop(job, user_deliver):
        try:
            if not _notice_applies(job, user_deliver):
                return notice(job, user_deliver)
            platforms = _im_platforms(job, user_deliver)
        except (ImportError, OSError, ValueError, KeyError, TypeError):
            logger.debug("apex-overlay: Desktop delivery notice unavailable", exc_info=True)
            return notice(job, user_deliver)
        also = f", and also sent to the connected {' and '.join(platforms)} home channel" if platforms else ""
        return DESKTOP_NOTICE.format(also=also)

    setattr(notice_with_desktop, _MARK, True)
    return notice_with_desktop


# ── 3. at fire time ──────────────────────────────────────────────────────────────────────────────────────────


def _home() -> Path:
    from hermes_constants import get_hermes_home

    return Path(get_hermes_home()).resolve()


def _open_db(home: Path):
    from hermes_state import SessionDB

    return SessionDB(db_path=home / "state.db")


def _target_session(db, session_id: str) -> str:
    """The conversation to post into: the stamped chat's live tip, else this assistant's newest Desktop chat."""
    target = db.resolve_resume_session_id(session_id) or session_id
    if db.get_session(target) is not None:
        return target
    newest = db.search_sessions(source="desktop", limit=1)
    return str(newest[0]["id"]) if newest else ""


def _run_session_id(db, job_id: str) -> str:
    """The newest ``cron_<job>_<time>`` session of this job (its run), at its compression tip."""
    prefix = f"cron_{job_id}_"
    for row in db.search_sessions(source="cron", limit=50):
        if str(row.get("id") or "").startswith(prefix):
            return db.get_compression_tip(row["id"]) or row["id"]
    return ""


def model_text(job_name: str, content: str, failed: bool) -> str:
    """What the model reads in later turns: it came from the schedule, not from the user."""
    what = "没跑成，下面是原因" if failed else "到点跑完的结果"
    return f"[定时任务「{job_name}」{what}（后台按时自动送来，不是用户发的消息）]\n\n{content}"


def _write_pending(job: dict[str, Any], content: str, failed: bool) -> Path:
    home = _home()
    record = {
        "delivery_id": str(job.get("execution_id") or job.get("_bot_chat_run_id") or uuid.uuid4().hex),
        "home": str(home), "session_id": job[ORIGIN_KEY]["session_id"], "job_id": str(job.get("id") or ""),
        "job_name": str(job.get("name") or job.get("id") or ""), "status": "failed" if failed else "ok",
        "content": content, "created_at": time.time(),
    }
    pending = home.joinpath(*PENDING_DIR)
    pending.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = pending / f"{record['delivery_id']}.{'failed' if failed else 'ok'}.json"
    path.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
    return path


def _wrap_deliver(deliver):
    @functools.wraps(deliver)
    def deliver_also_to_desktop(job, content, adapters=None, loop=None, *, for_failure=False):
        error = deliver(job, content, adapters=adapters, loop=loop, for_failure=for_failure)
        if not delivers_to_desktop(job, for_failure):
            return error
        try:
            path = _write_pending(job, content, for_failure)
        except (OSError, KeyError, TypeError) as exc:
            logger.warning("apex-overlay: could not queue cron job %s for its Desktop chat", job.get("id"), exc_info=True)
            return error or f"Desktop chat delivery could not be queued: {exc}"
        try:
            drain_file(path)
        except Exception:  # the run is not a failed delivery: the result is queued and the drainer retries it
            logger.warning("apex-overlay: cron job %s will reach its Desktop chat on a retry", job.get("id"), exc_info=True)
        _ensure_drainer(path.parent.parent.parent)
        return error

    setattr(deliver_also_to_desktop, _MARK, True)
    return deliver_also_to_desktop


# ── 3b. posting a pending result ─────────────────────────────────────────────────────────────────────────────


def _already_posted(db, session_id: str, delivery_id: str, status: str) -> bool:
    """A row for this delivery already sits in the conversation (a retry after a crash must not add a second)."""
    for message in db.get_messages(session_id):
        meta = message.get("display_metadata")
        if isinstance(meta, str):
            try:
                meta = json.loads(meta)
            except ValueError:
                continue
        if (message.get("display_kind") == DISPLAY_KIND and isinstance(meta, dict)
                and meta.get("delivery_id") == delivery_id and meta.get("status") == status):
            return True
    return False


def _live_session(session_key: str):
    """``(sid, session)`` of a chat open in this process whose live target is ``session_key``, else None."""
    server = sys.modules.get("tui_gateway.server")
    if server is None:
        return None
    with server._sessions_lock:
        candidates = list(server._sessions.items())
    for sid, session in candidates:
        live_ids = {str(session.get("session_key") or ""), str(getattr(session.get("agent"), "session_id", "") or "")}
        if session_key in live_ids and session.get("history_lock") is not None:
            return sid, session
    return None


def _append_to_live(server: ModuleType, session: dict, text: str, meta: dict[str, Any]) -> bool:
    """Append while the chat is idle, as upstream files a model switch marker; False when a turn is running."""
    from agent.context_compressor import _DB_PERSISTED_MARKER
    from agent.message_metadata import stamp_message_uid

    with server._session_turn_admission(session) as admitted:
        if not admitted or session.get("running"):
            return False
        session["running"] = True
    try:
        entry: dict[str, Any] = {"role": "user", "content": text, "display_kind": DISPLAY_KIND,
                                 "display_metadata": meta}
        agent = session.get("agent")
        db = getattr(agent, "_session_db", None) if agent is not None else None
        if db is None:
            server._ensure_session_db_row(session)
        with (contextlib.nullcontext(db) if db is not None else server._session_db(session)) as db:
            if db is None:
                raise RuntimeError("the open chat has no session store")
            row_id = db.append_message(session_id=server._submit_row_target_key(session), role="user",
                                       content=text, display_kind=DISPLAY_KIND, display_metadata=meta,
                                       message_uid=stamp_message_uid(entry))
        entry["_row_id"], entry[_DB_PERSISTED_MARKER] = row_id, True
        with session["history_lock"]:
            session["history"].append(entry)
            session["history_version"] = int(session.get("history_version", 0)) + 1
        return True
    finally:
        server._notif_release_turn(session)


def _broadcast(record: dict[str, Any], session_id: str) -> None:
    server = sys.modules.get("tui_gateway.server")
    if server is None:
        return
    from hermes_constants import profile_name_for_home

    payload = {BROADCAST_KEY: {
        "session_id": session_id, "job_id": record["job_id"], "job_name": record["job_name"],
        "status": record["status"], "delivery_id": record["delivery_id"],
        "profile": profile_name_for_home(record["home"]) or "default",
    }}
    try:
        server._broadcast_global_event(BROADCAST_EVENT, payload)
    except Exception:  # a window we cannot reach still finds the row on its next transcript refresh
        logger.debug("apex-overlay: cron result broadcast failed", exc_info=True)


def drain_file(path: Path) -> bool:
    """Post one pending result; True once its row exists (the file is then removed), False to retry later."""
    with _post_lock:
        return _post(path)


def _post(path: Path) -> bool:
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return True
    except (OSError, ValueError):
        logger.warning("apex-overlay: unreadable pending cron result %s left in place", path, exc_info=True)
        return False
    home = Path(record["home"])
    db = _open_db(home)
    try:
        target = _target_session(db, record["session_id"])
        if not target:
            logger.warning("apex-overlay: cron job %s has no Desktop chat left to post into", record["job_id"])
            path.unlink(missing_ok=True)
            return True
        meta = {"job_id": record["job_id"], "job_name": record["job_name"], "status": record["status"],
                "delivery_id": record["delivery_id"], "run_session_id": _run_session_id(db, record["job_id"]),
                "display_text": record["content"]}
        text = model_text(record["job_name"], record["content"], record["status"] == "failed")
        if not _already_posted(db, target, record["delivery_id"], record["status"]):
            live = _live_session(target)
            if live is not None:
                if not _append_to_live(sys.modules["tui_gateway.server"], live[1], text, meta):
                    return False
            else:
                db.append_message(session_id=target, role="user", content=text, display_kind=DISPLAY_KIND,
                                  display_metadata=meta)
    finally:
        db.close()
    path.unlink(missing_ok=True)
    _broadcast(record, target)
    return True


def drain_home(home: Path) -> int:
    """Try every pending result under ``home``; returns how many are still waiting."""
    pending = home.joinpath(*PENDING_DIR)
    waiting = 0
    for path in sorted(pending.glob("*.json")) if pending.is_dir() else []:
        try:
            if not drain_file(path):
                waiting += 1
        except Exception:  # one bad record must not wedge the others; it stays for the next pass
            logger.warning("apex-overlay: could not post pending cron result %s", path, exc_info=True)
            waiting += 1
    return waiting


def _ensure_drainer(home: Path) -> None:
    """A daemon pass every few seconds until nothing under ``home`` waits (a chat busy in a long turn)."""
    key = str(home)
    with _drain_lock:
        if key in _draining_homes:
            return
        _draining_homes.add(key)

    def run():
        try:
            while drain_home(home):
                time.sleep(_DRAIN_INTERVAL_SECONDS)
        finally:
            with _drain_lock:
                _draining_homes.discard(key)

    from agent.memory_provider import spawn_context_thread

    # The spawner's scope rides along (a fire's profile scope, or the launch one at start).
    spawn_context_thread(run, name="apex-cron-desktop-results").start()


# ── wiring ───────────────────────────────────────────────────────────────────────────────────────────────────


def _install_tool(module: ModuleType) -> bool:
    jobless, actions = getattr(module, "_JOBLESS_ACTIONS", None), getattr(module, "_JOB_ACTIONS", None)
    needed = ("get_job", "update_job", "_format_job", "_dumps", "_local_delivery_notice")
    if not (isinstance(jobless, dict) and isinstance(actions, dict) and "create" in jobless and "update" in actions
            and all(hasattr(module, name) for name in needed)):
        logger.error("apex-overlay: tools.cronjob_tools has no create/update action or job helpers to patch")
        return False
    if getattr(jobless["create"], _MARK, False):
        return True
    create, update = _wrap_create(module, jobless["create"]), _wrap_update(module, actions["update"])
    setattr(create, _MARK, True)
    setattr(update, _MARK, True)
    jobless["create"], actions["update"] = create, update
    module._action_create, module._action_update = create, update
    if not getattr(module._local_delivery_notice, _MARK, False):
        module._local_delivery_notice = _wrap_notice(module._local_delivery_notice)
    return True


def _install_args(module: ModuleType) -> bool:
    notice = getattr(module, "_local_delivery_notice", None)
    if notice is None:
        logger.error("apex-overlay: tools.cronjob_job_args has no _local_delivery_notice to patch")
        return False
    if not getattr(notice, _MARK, False):
        module._local_delivery_notice = _wrap_notice(notice)
    return True


def _install_scheduler(module: ModuleType) -> bool:
    deliver = getattr(module, "_deliver_result", None)
    if deliver is None:
        logger.error("apex-overlay: cron.scheduler has no _deliver_result to patch")
        return False
    if not getattr(deliver, _MARK, False):
        module._deliver_result = _wrap_deliver(deliver)
    try:  # results left pending by a process that exited first: post them now, or once their chat is idle
        for home in _homes_with_pending():
            _ensure_drainer(home)
    except (OSError, RuntimeError):
        logger.debug("apex-overlay: no pending cron results to drain at start", exc_info=True)
    return True


def _homes_with_pending() -> list[Path]:
    """The root and every assistant's profile that has results waiting."""
    from hermes_constants import get_default_hermes_root

    root = Path(get_default_hermes_root()).resolve()
    homes = [root, *(p for p in (root / "profiles").iterdir() if p.is_dir())] if (root / "profiles").is_dir() else [root]
    return [home for home in homes if any(home.joinpath(*PENDING_DIR).glob("*.json"))]


_armed = False


def armed() -> bool:
    """Whether results really come back: the scheduler's sender is wrapped, or will be when it loads.
    apex.user-scheduled (cron_result_prompt) promises the chat only while this holds."""
    if post_import.is_imported(_SCHEDULER_MODULE):
        return bool(getattr(getattr(sys.modules[_SCHEDULER_MODULE], "_deliver_result", None), _MARK, False))
    return _armed


def apply() -> bool:
    global _armed
    ok = post_import.when_imported(_ARGS_MODULE, _install_args)
    ok = post_import.when_imported(_TOOL_MODULE, _install_tool) and ok
    ok = post_import.when_imported(_SCHEDULER_MODULE, _install_scheduler) and ok
    _armed = ok
    return ok
