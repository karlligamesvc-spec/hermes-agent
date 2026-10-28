"""hc-1097 共用记忆实时: a ledger change reaches every open session on its next turn.

The memory ledger (hc-1016, ``memory_ledger.py``) reaches a Desktop session as a plugin system-prompt
section, rendered from Desktop's mirror when the session's prompt is built and frozen with it. APEX
Desktop keeps one long thread per assistant, so with several assistants on (hc-1074) a thing assistant
A noted never reached the thread assistant B already had open: B's prompt still held the ledger of B's
first turn, and B answered 「底账是空的」. One APEX has the same gap when the ledger changes elsewhere
(the 「它记得什么」 page, the WeChat chat this computer's engine serves).

This seam leaves the frozen prompt alone and tells a session what changed:

* Before each turn (``pre_llm_call``) it compares the ledger the session knows (its frozen section plus
  the notes it was given since) with the mirror, and adds the entries that appeared, changed or went
  away to that turn's user message, once. The runtime stores the note with the turn (``api_content``)
  and replays it, so the system prompt and the prompt-cache prefix never move; with nothing changed it
  adds nothing.
* On a session's first turn it adds one line: when the user asks about themselves and neither the
  ledger nor the conversation has it, look the ledger up (``apex_memory`` ``list``) before saying so.
* A session's own apex_memory calls do not come back to it as news (``memory_ledger.handle`` reports
  them here).

A session restored by a new engine (a restart, or a new session id after compaction) is measured from
the ledger in its stored prompt plus the notes in its history. Only sessions whose prompt carries the
ledger section take part, so the seam reaches the sessions the section reaches, minus the ones nobody
talks to (subagents, cron, webhooks, api_server), whose prompt is built for each job.

The mirror stays the only source. Desktop rewrites it whenever it reads the ledger (start, sign-in,
the window back after ten minutes, the 「它记得什么」 page, a 记下了 line on screen), and every local
engine (each assistant's, and the one serving WeChat on this computer) re-mirrors after its own
apex_memory call. A change made where neither runs (the cloud's IM chat, another computer) reaches
an open session on the turn after Desktop next reads the ledger, or when ``list`` reads it.
"""

from __future__ import annotations

import logging
import re
import sqlite3
import threading
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Mapping, Optional

logger = logging.getLogger(__name__)

# The cloud's segment markers (apex-nodes app/services/memory_ledger.py SEGMENT_BEGIN / SEGMENT_END).
SEGMENT_BEGIN = "【APEX 记得的 · 记忆底账】"
SEGMENT_END = "【APEX 记得的 · 完】"
# An entry line as the cloud renders it: 关于你 "- [ref] content", 最近发生的 "- MM-DD [ref] content".
_ENTRY = re.compile(r"^- (?:\d{2}-\d{2} )?\[(?P<ref>[0-9a-f]{8})\] \S")
# 「（还有 N 条较早的没放进来，…）」: entries past the segment's budget are still in the ledger.
_LEFT_OUT = "条较早的没放进来"

# Same set as apexnodes-next-steps' NON_INTERACTIVE_PLATFORMS: their prompt is built for each job.
NON_INTERACTIVE_PLATFORMS = frozenset({"api_server", "cron", "webhook", "subagent"})

NOTE_BEGIN = "【记忆底账 · 有变化】"
NOTE_END = "【记忆底账 · 变化完】"
NOTE_INTRO = (
    "这次对话开始以后，记忆底账有了下面这些变化（可能是别的助手、用户在别处，或者你自己改的）。"
    "和前面的底账对不上时，以这里为准。"
)
APPEARED = "底账里新出现的："
EDITED = "改过的："
GONE = "已经不在底账里了（删掉了或者过期了），不要再当真："

LOOKUP_HINT = (
    "（关于记忆底账：这次对话开始以后它还会变，变了会补在用户的消息后面。用户问到他自己的事"
    "（名字、账号、喜好、做过什么），前面的底账和这次对话里都找不到时，不要直接说不知道或者底账是空的："
    '先用 tool_call 查一下最新的底账（name 填 apex_memory，arguments 写 {"action": "list"}）再回答，'
    "查过还是没有再说。）"
)
_HINT_MARK = LOOKUP_HINT[:12]

_MAX_SESSIONS = 512
_MAX_OWN = 256


@dataclass(frozen=True)
class Ledger:
    """A ledger text's entries: ref → the entry's line as rendered. ``partial``: it says some were left out."""

    lines: Mapping[str, str]
    partial: bool = False


@dataclass(frozen=True)
class _Session:
    known: Optional[Ledger]  # None: this session's prompt carries no ledger
    hinted: bool = False
    own: frozenset[str] = field(default_factory=frozenset)  # refs this session added or forgot itself


_LOCK = threading.Lock()
_sessions: OrderedDict[str, _Session] = OrderedDict()


def parse(text: Any) -> Optional[Ledger]:
    """The ledger segment in ``text`` (a section, a stored prompt, the mirror), or None when there is none."""
    if not isinstance(text, str):
        return None
    start = text.find(SEGMENT_BEGIN)
    if start < 0:
        return None
    end = text.find(SEGMENT_END, start)
    lines: dict[str, str] = {}
    partial = False
    for raw in text[start : end if end >= 0 else len(text)].splitlines():
        line = raw.strip()
        match = _ENTRY.match(line)
        if match:
            lines.setdefault(match["ref"], line)
        elif _LEFT_OUT in line:
            partial = True
    return Ledger(lines, partial)


def note(known: Ledger, now: Ledger, own: frozenset[str] = frozenset()) -> str:
    """What changed from ``known`` to ``now`` as one block for the model, or "" when nothing did.

    Refs in ``own`` changed in this session itself and are left out. While ``now`` says some entries
    were left out, an entry missing from it may only have been pushed past the budget, so none is
    reported gone.
    """
    appeared = [line for ref, line in now.lines.items() if ref not in known.lines and ref not in own]
    edited = [line for ref, line in now.lines.items() if known.lines.get(ref, line) != line and ref not in own]
    gone = [] if now.partial else [line for ref, line in known.lines.items() if ref not in now.lines and ref not in own]
    if not (appeared or edited or gone):
        return ""
    parts = [NOTE_BEGIN, NOTE_INTRO]
    for heading, lines in ((APPEARED, appeared), (EDITED, edited), (GONE, gone)):
        if lines:
            parts += [heading, *lines]
    parts.append(NOTE_END)
    return "\n".join(parts)


def _message_text(message: Any) -> str:
    """A user message's text as the model got it: the stored injection sidecar and the typed text."""
    if not isinstance(message, Mapping) or message.get("role") != "user":
        return ""
    parts = []
    for key in ("api_content", "content"):
        value = message.get(key)
        if isinstance(value, str):
            parts.append(value)
        elif isinstance(value, list):
            parts.extend(str(item.get("text") or "") for item in value if isinstance(item, Mapping))
    return "\n".join(parts)


def _with_notes(known: Ledger, history: Any) -> Ledger:
    """``known`` with the notes this seam already put into the conversation applied, oldest first."""
    lines = dict(known.lines)
    for message in history if isinstance(history, list) else ():
        text = _message_text(message)
        start = text.find(NOTE_BEGIN)
        while start >= 0:
            end = text.find(NOTE_END, start)
            heading = ""
            for raw in text[start : end if end >= 0 else len(text)].splitlines():
                line = raw.strip()
                if line in (APPEARED, EDITED, GONE):
                    heading = line
                elif heading and (match := _ENTRY.match(line)):
                    if heading == GONE:
                        lines.pop(match["ref"], None)
                    else:
                        lines[match["ref"]] = line
            start = text.find(NOTE_BEGIN, end) if end >= 0 else -1
    return Ledger(lines, known.partial)


def _hinted(history: Any) -> bool:
    """Whether the conversation already carries the lookup line (a restored session keeps it)."""
    return isinstance(history, list) and any(_HINT_MARK in _message_text(message) for message in history)


def _stored_ledger(session_id: str) -> Optional[Ledger]:
    """The ledger in a session's stored prompt: the bytes its frozen prompt was built with, or None."""
    from hermes_state import SessionDB

    try:
        db = SessionDB(read_only=True)
        try:
            row = db.get_session(session_id)
        finally:
            db.close()
    except (sqlite3.Error, OSError) as exc:
        logger.warning("apex-overlay: could not read the stored prompt of session %s: %s", session_id, exc)
        return None
    return parse((row or {}).get("system_prompt"))


def _remember(session_id: str, session: _Session) -> None:
    with _LOCK:
        _sessions[session_id] = session
        _sessions.move_to_end(session_id)
        while len(_sessions) > _MAX_SESSIONS:
            _sessions.popitem(last=False)


def _session(session_id: str, history: Any) -> _Session:
    with _LOCK:
        session = _sessions.get(session_id)
    if session is not None:
        return session
    # Built by an earlier engine: restored after a restart, or a new id after compaction.
    known = _stored_ledger(session_id)
    return _Session(_with_notes(known, history) if known is not None else None)


def note_frozen(session_info: Mapping[str, Any] | None, text: str) -> None:
    """A session's prompt was just built with ``text`` as its ledger section ("" for none)."""
    session_id = str((session_info or {}).get("session_id") or "")
    if not session_id:
        return
    with _LOCK:
        previous = _sessions.get(session_id)
    # A rebuild of a live session (a model switch) keeps what it was already told.
    hinted, own = (previous.hinted, previous.own) if previous else (False, frozenset())
    _remember(session_id, _Session(parse(text), hinted, own))


def note_own_change(session_id: str, ref: str) -> None:
    """This session added or forgot ``ref`` itself (apex_memory): it is no news to it."""
    with _LOCK:
        session = _sessions.get(session_id)
    if session is None or session.known is None or not ref:
        return
    own = session.own | {ref[:8].lower()}
    if len(own) > _MAX_OWN:
        own = frozenset({ref[:8].lower()})
    _remember(session_id, _Session(session.known, session.hinted, own))


def note_seen(session_id: str, segment: str) -> None:
    """This session just read the whole ledger (apex_memory list): that is what it knows now."""
    with _LOCK:
        session = _sessions.get(session_id)
    seen = parse(segment)
    if session is None or session.known is None or seen is None:
        return
    _remember(session_id, _Session(seen, session.hinted, session.own))


def _mirror() -> Optional[Ledger]:
    """The ledger Desktop mirrored, or None with no usable mirror (switched off, signed out)."""
    from apex_overlay import memory_ledger

    text = memory_ledger.mirror_text()
    return parse(text) if text else None


def on_pre_llm_call(
    session_id: str = "", platform: str = "", conversation_history: Any = None, **_: Any
) -> Optional[str]:
    """The lookup line on a session's first turn and what changed in the ledger since, else None."""
    if not session_id or platform in NON_INTERACTIVE_PLATFORMS:
        return None
    now = _mirror()
    if now is None:
        return None
    session = _session(session_id, conversation_history)
    if session.known is None:
        _remember(session_id, session)
        return None
    hinted = session.hinted or _hinted(conversation_history)
    parts = [] if hinted else [LOOKUP_HINT]
    change = note(session.known, now, session.own)
    if change:
        parts.append(change)
    _remember(session_id, _Session(now, True, session.own))
    return "\n\n".join(parts) or None


def apply(ctx: Any) -> bool:
    """Register the turn hook on this plugin's context. Idempotent per plugin manager."""
    register_hook = getattr(ctx, "register_hook", None)
    if register_hook is None:
        logger.warning("apex-overlay: this plugin host cannot register the live memory ledger seam")
        return False
    hooks = getattr(getattr(ctx, "_manager", None), "_hooks", {})
    if on_pre_llm_call in hooks.get("pre_llm_call", ()):
        logger.warning("apex-overlay: live memory ledger seam already registered on this plugin manager")
        return False
    register_hook("pre_llm_call", on_pre_llm_call)
    return True
