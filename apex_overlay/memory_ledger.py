"""hc-1016 记得你 v1: the account's memory ledger in every new Desktop session.

The ledger lives on the cloud (apex-nodes ``app/services/memory_ledger.py``):
one per person, shared by APEX Desktop and, in phase 2, the account's IM
agents. Two kinds: 关于你 (who the user is) and 最近发生的 (what happened).

* Reading: APEX Desktop's main process mirrors the cloud's rendered segment to
  ``<root>/apex/memory-ledger-prompt.md`` while ``desktop_features.single_thread``
  is on and an account is signed in (electron/apex-memory-ledger.ts), and
  removes it otherwise. A plugin system-prompt section reads it when a new
  session's prompt is built, like hc-991's ``apex.user-profile``.
* Writing: the ``apex_memory`` tool adds an entry or forgets one through the
  agent-key route ``/api/v1/media/memory-ledger`` with the Desktop's managed key
  (plugins/apexnodes_gateway.py resolves base and key).
* hc-1097: ``list`` reads the whole ledger as it stands, and after any of the
  three the engine mirrors the cloud's fresh segment itself (only over a mirror
  Desktop already wrote, for the key it read with), so assistants with a
  session already open hear the change on their next turn
  (``memory_ledger_live.py``) whether or not Desktop's window showed it.

The mirror file is the only switch: no file, no section and no tool. So with
the feature off, signed out, or in a cloud container (which never has the file)
the agent's prompt and tool list are what they were before this seam.
"""

from __future__ import annotations

import logging
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping, Optional

logger = logging.getLogger(__name__)

SECTION_ID = "apex.memory-ledger"
PROMPT_RELATIVE_PATH = ("apex", "memory-ledger-prompt.md")
# The runtime caps one plugin section at 4,000 characters; the cloud renders at most 3,800.
MAX_CHARS = 4_000

TOOL_NAME = "apex_memory"
# Rides with the built-in memory toolset: wherever the agent may remember, it may use the ledger.
TOOLSET = "memory"
LEDGER_PATH = "/api/v1/media/memory-ledger"
KINDS = ("about_you", "recent")

SCHEMA = {
    "name": TOOL_NAME,
    "description": (
        "APEX 的记忆底账(电脑上和微信、飞书里的 APEX 共用这一份)。"
        "学到关于用户、以后还用得上的新东西时 add 一条 about_you;"
        "做完一件事或用户报了数据时 add 一条 recent;"
        "用户说「别记这个」「忘掉……」时 forget 对应那条。"
        "用户问到他自己的事、提示和对话里都找不到时，先 list 查最新的底账再回答。"
        "不记密码、验证码、证件号、卡号和别人的隐私。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["add", "forget", "list"]},
            "kind": {
                "type": "string",
                "enum": list(KINDS),
                "description": "add 时必填:about_you(关于你)或 recent(最近发生的)",
            },
            "content": {"type": "string", "description": "add 时必填：一句话，不超过 100 字"},
            "ref": {"type": "string", "description": "forget 时必填：底账里方括号中的 8 位编号"},
        },
        "required": ["action"],
    },
}
# hc-1082: with several assistants on, every one of them reads and writes this one ledger.
NOT_FOR_ASSISTANTS = "助手自己的名字和分工不记进底账(改名用 apex_rename);用户想让助手怎么称呼他，照常记。"

# What the agent is told when the cloud refuses (detail.code from the ledger API).
REFUSALS = {
    "empty_content": "没有要记的内容。",
    "content_too_long": "这句太长了：改成一句话、不超过 100 字再记。",
    "sensitive_content": "这条像是密码、验证码、证件号或卡号，不能记。",
    "ledger_full": "「关于你」已经记满 30 条：先请用户在「它记得什么」页里删掉几条，再记新的。",
    "entry_not_found": "底账里没有这条(可能已经删掉了)。",
    "ambiguous_ref": "这个编号对上了不止一条，请用完整编号。",
    "memory_ledger_unavailable": "这个账号没有记忆底账。",
}
LEDGER_OFF = "记忆底账没有打开(或者没有登录),这次不记。"
# The cloud's segment opens with this line (apex-nodes app/services/memory_ledger.py SEGMENT_BEGIN).
SEGMENT_BEGIN = "【APEX 记得的 · 记忆底账】"
# The cloud dates 最近发生的 entries in Beijing time.
BEIJING = timezone(timedelta(hours=8))
# A fresh read for the mirror waits this long; the tool's own call has already answered.
REFRESH_TIMEOUT_SECONDS = 20

# Whether the mirror existed when a session prompt was last built; see _note_switch.
_last_seen: bool | None = None


def prompt_path() -> Path:
    """Where Desktop mirrors the segment: the root shared by every local profile."""
    from hermes_constants import get_default_hermes_root

    return get_default_hermes_root().joinpath(*PROMPT_RELATIVE_PATH)


def ledger_on() -> bool:
    """The tool's availability: Desktop has mirrored a ledger for the signed-in account."""
    try:
        return prompt_path().is_file()
    except OSError:
        return False


def _note_switch(present: bool) -> None:
    """Drop the runtime's memoized tool list when the mirror appeared or went away.

    ``model_tools.get_tool_definitions`` memoizes per toolset selection and does
    not re-run check_fns on a hit, so without this the apex_memory tool would
    keep the availability it had when the list was first built in this process.
    The prompt section is built once per new session, so the next session's
    tool list follows the file.
    """
    global _last_seen
    if _last_seen is not None and _last_seen != present:
        try:
            import model_tools

            model_tools._clear_tool_defs_cache()
        except (ImportError, AttributeError):
            logger.warning(
                "apex-overlay: could not refresh the tool list after the memory ledger switch changed", exc_info=True
            )
    _last_seen = present


def render_section(session_info: Mapping[str, Any] | None = None) -> str:
    """The mirrored segment, or "" when there is none (the runtime then adds no section)."""
    _note_switch(ledger_on())
    text = mirror_text()
    # hc-1097: what this session's frozen prompt holds, to tell it later what changed.
    from apex_overlay import memory_ledger_live

    memory_ledger_live.note_frozen(session_info, text)
    return text


def mirror_text() -> str:
    """The segment Desktop mirrored, or "" when there is no usable one."""
    path = prompt_path()
    try:
        text = path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return ""
    except (OSError, UnicodeDecodeError) as exc:
        logger.warning("apex-overlay: could not read the memory ledger prompt at %s: %s", path, exc)
        return ""
    if len(text) > MAX_CHARS:
        logger.warning(
            "apex-overlay: memory ledger prompt at %s is %d characters (limit %d); not added",
            path,
            len(text),
            MAX_CHARS,
        )
        return ""
    return text


def schema() -> dict:
    """The tool's schema; with several assistants on, its description also keeps their names out."""
    from apex_overlay import assistant_name

    if not assistant_name.switch_on():
        return SCHEMA
    return {**SCHEMA, "description": SCHEMA["description"] + NOT_FOR_ASSISTANTS}


def _gateway():
    from plugins import apexnodes_gateway

    return apexnodes_gateway


def _refused(exc: Exception) -> str:
    from tools.registry import tool_error

    code = getattr(exc, "code", None)
    return tool_error(REFUSALS.get(code or "", str(exc)), code=code)


def _entry_lines(entries: Any) -> dict[str, list[str]]:
    """The ledger's entries as the segment writes them: 关于你 "[ref] content", 最近发生的 "MM-DD [ref] content"."""
    entries = entries if isinstance(entries, Mapping) else {}
    lines: dict[str, list[str]] = {}
    for kind in KINDS:
        lines[kind] = []
        for entry in entries.get(kind) or ():
            if not isinstance(entry, Mapping) or not entry.get("ref") or not entry.get("content"):
                continue
            line = f"[{entry['ref']}] {entry['content']}"
            if kind == "recent":
                try:
                    line = f"{datetime.fromisoformat(str(entry.get('created_at'))).astimezone(BEIJING):%m-%d} {line}"
                except ValueError:
                    pass
            lines[kind].append(line)
    return lines


def _mirror_segment(segment: Any, key: str) -> bool:
    """Put a segment this engine read in place of Desktop's mirror; True when the mirror changed.

    Desktop's main process owns the mirror: it writes it while the ledger is on and removes it when the
    switch goes off, on sign-out and on a change of account. So this only replaces a mirror that is
    there, with the cloud's own rendering, read with the key still configured (another account's reply
    never lands), in the same bytes and mode Desktop writes (electron/apex-memory-ledger.ts).
    """
    from utils import atomic_write_text

    text = segment.strip() if isinstance(segment, str) else ""
    if not text.startswith(SEGMENT_BEGIN) or len(text) > MAX_CHARS:
        return False
    path = prompt_path()
    try:
        if not path.is_file() or path.read_text(encoding="utf-8") == text + "\n":
            return False
        if _gateway().agent_api_key() != key:
            return False
        atomic_write_text(path, text + "\n", mode=0o600)
    except (OSError, UnicodeDecodeError) as exc:
        logger.warning("apex-overlay: could not refresh the memory ledger mirror at %s: %s", path, exc)
        return False
    return True


def refresh_mirror() -> bool:
    """Read the ledger again and mirror it; True when the mirror changed."""
    gateway = _gateway()
    key = gateway.agent_api_key()
    try:
        body = gateway.request_json("GET", LEDGER_PATH, timeout=REFRESH_TIMEOUT_SECONDS)
    except gateway.GatewayError as exc:
        logger.info("apex-overlay: memory ledger not re-read after a change (%s)", getattr(exc, "code", None))
        return False
    return _mirror_segment(body.get("prompt_segment"), key)


_REFRESH_LOCK = threading.Lock()
# One reader at a time; a change made while it reads asks for one more read.
_refresh = {"running": False, "again": False}


def _refresh_loop() -> None:
    while True:
        try:
            refresh_mirror()
        except Exception:
            logger.warning("apex-overlay: memory ledger mirror refresh failed", exc_info=True)
        with _REFRESH_LOCK:
            # Decide and stand down in one step, or a change asking right now would be dropped.
            if not _refresh["again"]:
                _refresh["running"] = False
                return
            _refresh["again"] = False


def refresh_mirror_soon() -> Optional[threading.Thread]:
    """Re-read and mirror the ledger in the background, so this tool call does not wait for it."""
    with _REFRESH_LOCK:
        if _refresh["running"]:
            _refresh["again"] = True
            return None
        _refresh["running"] = True
    from agent.memory_provider import spawn_context_thread

    # Under the caller's context: the key and the root follow the profile scope this engine serves.
    thread = spawn_context_thread(_refresh_loop, name="apex-memory-ledger-mirror")
    thread.start()
    return thread


def _list(gateway, session_id: str) -> str:
    """The whole ledger as it stands now; the mirror and this session's view follow it."""
    from apex_overlay import memory_ledger_live
    from tools.registry import tool_result

    key = gateway.agent_api_key()
    body = gateway.request_json("GET", LEDGER_PATH, timeout=20)
    segment = body.get("prompt_segment")
    _mirror_segment(segment, key)
    memory_ledger_live.note_seen(session_id, segment if isinstance(segment, str) else "")
    lines = _entry_lines(body.get("entries"))
    return tool_result(ok=True, action="list", about_you=lines["about_you"], recent=lines["recent"])


def handle(args: Mapping[str, Any] | None, session_id: str = "", **_kwargs: Any) -> str:
    """add → {ok, action, created, entry}; forget → {ok, action, deleted}; list → {ok, action, about_you, recent}.

    Content is never logged.
    """
    from apex_overlay import memory_ledger_live
    from tools.registry import tool_error, tool_result

    if not ledger_on():
        # Switched off or signed out since this session's tool list was built.
        return tool_error(LEDGER_OFF)
    args = args if isinstance(args, Mapping) else {}
    action = str(args.get("action") or "").strip()
    gateway = _gateway()
    try:
        if action == "list":
            return _list(gateway, session_id)
        if action == "add":
            kind = str(args.get("kind") or "").strip()
            content = str(args.get("content") or "").strip()
            if kind not in KINDS:
                return tool_error("add 要写 kind:about_you 或 recent。")
            if not content:
                return tool_error(REFUSALS["empty_content"])
            body = gateway.request_json("POST", f"{LEDGER_PATH}/entries", {"kind": kind, "content": content}, timeout=20)
            entry = body.get("entry") if isinstance(body.get("entry"), dict) else {}
            memory_ledger_live.note_own_change(session_id, str(entry.get("ref") or ""))
            refresh_mirror_soon()
            return tool_result(
                ok=True,
                action="add",
                created=body.get("created") is True,
                entry={key: entry.get(key) for key in ("id", "ref", "kind", "content")},
            )
        if action == "forget":
            ref = str(args.get("ref") or "").strip()
            if not ref:
                return tool_error("forget 要写 ref:底账里方括号中的编号。")
            body = gateway.request_json("DELETE", f"{LEDGER_PATH}/entries/{ref}", timeout=20)
            memory_ledger_live.note_own_change(session_id, str(body.get("deleted") or ref))
            refresh_mirror_soon()
            return tool_result(ok=True, action="forget", deleted=body.get("deleted"))
    except gateway.GatewayError as exc:
        return _refused(exc)
    return tool_error("action 只能是 add、forget 或 list。")


def apply(ctx: Any) -> bool:
    """Register the section and the tool on this plugin's context. Idempotent per plugin manager."""
    register_section = getattr(ctx, "register_system_prompt_section", None)
    register_tool = getattr(ctx, "register_tool", None)
    if register_section is None or register_tool is None:
        logger.warning("apex-overlay: this plugin host cannot register the memory ledger seam")
        return False
    from tools.registry import no_cache_check_fn

    tool_schema = schema()
    try:
        register_section(SECTION_ID, render_section, max_chars=MAX_CHARS)
        register_tool(
            name=TOOL_NAME,
            toolset=TOOLSET,
            schema=tool_schema,
            handler=handle,
            check_fn=no_cache_check_fn(ledger_on),
            description=tool_schema["description"],
            emoji="🧠",
        )
    except ValueError as exc:
        logger.warning("apex-overlay: memory ledger seam not registered: %s", exc)
        return False
    return True
