"""hc-539 — IM direct-passthrough to a local coding agent, as a zero-in-place
overlay seam (A2A "遥控器" form).

What it does
============
A user whose phone IM (Feishu, via hc-417 binding) already routes to this
machine's gateway can type ``/cc`` (Claude Code) or ``/codex`` to enter
**passthrough mode** for that IM conversation. While in passthrough:

  * every subsequent message is fed **verbatim** into a persistent coding-agent
    session bound 1:1 to the IM conversation — it never reaches the Hermes
    agent's intent understanding;
  * the coding agent's output flows **verbatim** back to IM (long output is
    chunked);
  * ``/cancel`` interrupts the in-flight turn, ``/stop`` exits passthrough and
    returns to normal Hermes conversation;
  * a ``permission_request`` (a dangerous op) is **always denied** in v1 and the
    owner is notified — there is no auto-approve path here (red line).

Why a monkey-patch seam (挂钩点选型论证)
=======================================
The message router (``gateway/run.py``) is a hot upstream file; the overlay
discipline (``apex_overlay/README.md``: config > plugin > in-place) forbids
editing it. Two seams were considered:

  1. **The existing ``pre_gateway_dispatch`` plugin hook** (gateway/run.py). It
     fires per message and can ``skip``/``rewrite``, which looks like a fit —
     but it is invoked **synchronously** (``invoke_hook`` is not awaited) and
     **before auth**. Passthrough must ``await`` a coding-agent turn (run off
     the event loop) and ``await adapter.send`` for chunked delivery, and must
     only engage for authorized users. A sync, pre-auth hook cannot do that
     without detaching an unordered background task. Rejected.

  2. **Wrap ``GatewayRunner._handle_message``** (this module) — the same
     mechanism the shipped ``first_turn_ack`` seam uses to wrap
     ``_handle_message_with_agent``. The wrapper runs our async controller
     first; if passthrough is engaged it returns the reply (short-circuiting the
     Hermes agent + the whole slash-command chain, so ``/stop`` / ``/cancel``
     mean *passthrough* control while in a session, and raw text bypasses intent
     understanding). Otherwise it delegates to the untouched original. Chosen.

So ``gateway/run.py`` stays byte-for-byte upstream; the only wiring is one
``apply()`` call added to the bundled ``apex-overlay`` plugin.

Upstream-回贡候选: IM-direct-passthrough to a local coding agent is generic to
any Hermes user (not ApexNodes-specific). The clean upstream form would be an
**async** dispatch hook (an awaitable sibling of ``pre_gateway_dispatch`` that
can own the reply). Until such a hook exists upstream we express it as this
overlay seam. Flagged for upstreaming per AGENTS.md 上游回贡边界 (OS-layer,
value to non-platform users).

No-loss anchor (无损实现锚)
==========================
Output is the harness's normalized :class:`AgentEvent` stream (hc-524 #107),
folded by the already-tested ``agent.coding_agents.run_once.reduce_events``.
There is **no PTY / terminal-screen scraping** anywhere — every token comes from
an explicit protocol event (Claude ``stream-json`` / Codex ``app-server`` /
ACP ``session/update``). Session continuity is the harness's ``session_id``
round-trip (Claude ``--resume`` / Codex ``threadId`` / ACP ``sessionId``), so
the IM conversation ↔ agent session binding is persistent across messages.

Session targeting (v1.1, hc-542)
================================
``/cc`` alone still opens a *fresh* session, but a chat can now attach to one of
the machine's existing Claude Code sessions instead:

  * ``/cc list`` — the machine's recent Claude Code sessions (newest first, ≤10:
    number, project dir, first-message preview, relative time). Truth is Claude
    Code's own store (``$CLAUDE_CONFIG_DIR/projects/<slug>/<id>.jsonl``), read
    **only** — never written — and every preview is control-char-scrubbed +
    length-capped before it can reach IM (injection red line).
  * ``/cc <n>`` — attach to the n-th session the chat last listed.
  * ``/cc resume <id>`` — attach to a session by its id (id is path-validated).
  * ``/cc new [绝对目录]`` — force a fresh session (optionally in a given cwd).

Attaching presets the harness ``session_id`` before the first turn, so
continuation runs ``--resume <id>`` from the very first prompt (no new fork).
Codex has no equivalent read-only thread store wired here, so ``/codex list`` /
``/codex <n>`` reply "仅支持 Claude Code" rather than fabricate a mapping.

Credentials (§4): the harness spawns the user's own ``claude`` / ``codex`` with
a Hermes-secret-scrubbed env and the real HOME, so the coding agent authced from
its own credential store; nothing is forwarded to the cloud or logged.

Kill switch: ``HERMES_IM_PASSTHROUGH`` (default ``1``; ``0``/``false`` disables
the feature entirely — ``/cc`` then falls through to normal handling). Passthrough
is opt-in: it only ever activates after the user explicitly types ``/cc`` /
``/codex``. Optional ``HERMES_IM_PASSTHROUGH_CWD`` sets the agent's working dir
(default: ``~``; ``/cc <dir> [prompt]`` overrides per session).

Idempotent (``_MARK`` sentinel + module ``_APPLIED``) and fail-safe: any error in
the controller degrades to normal message handling — passthrough can never break
the gateway.
"""

from __future__ import annotations

import asyncio
import functools
import json
import logging
import os
import re
import time
import unicodedata
from dataclasses import dataclass
from enum import Enum
from typing import Any, Iterable, Optional

logger = logging.getLogger(__name__)

# Upstream target we monkey-patch — centralized so the seam-test pins it.
_TARGET_RUN_MODULE = "gateway.run"
_TARGET_RUNNER_CLASS = "GatewayRunner"
_TARGET_METHOD = "_handle_message"

# Per-runner state attribute: {session_key: _PassthroughSession}.
_STATE_ATTR = "_apex_im_passthrough_sessions"
# Per-runner cache of the last ``/cc list`` a chat saw: {session_key:
# [SessionInfo, ...]} — so ``/cc <n>`` resolves to exactly what was shown.
_LIST_STATE_ATTR = "_apex_im_passthrough_last_list"

_APPLIED = False
_MARK = "_apex_overlay_im_passthrough"

# Entry commands → coding-agent family id (agent.coding_agents.registry).
# ``cc`` and ``claude`` both mean Claude Code; ``codex`` means Codex. Cursor and
# CodeBuddy are intentionally not surfaced in v1 (claude/codex scope).
_ENTER_COMMANDS: dict[str, str] = {
    "cc": "claude",
    "claude": "claude",
    "codex": "codex",
}
_STOP_COMMAND = "stop"
_CANCEL_COMMAND = "cancel"

# IM messages have practical length caps; chunk long agent output under this.
# 3500 mirrors the gateway's own kanban/listing truncation budget.
_CHUNK_LIMIT = 3500

# The coding-agent harness + event reducer live in agent.coding_agents (hc-524
# #107 / hc-533 #110). Imported at module load; if unavailable the seam disarms
# cleanly (the controller returns "not engaged" and normal handling proceeds).
# Module-level so tests can monkeypatch ``im_passthrough.harness_for``.
try:  # pragma: no cover - exercised indirectly
    from agent.coding_agents import harness_for as harness_for
    from agent.coding_agents.harness import default_deny_permission as default_deny_permission
    from agent.coding_agents.run_once import reduce_events as reduce_events
except Exception:  # pragma: no cover - defensive
    harness_for = None  # type: ignore[assignment]
    default_deny_permission = None  # type: ignore[assignment]
    reduce_events = None  # type: ignore[assignment]


# ---------------------------------------------------------------------------
# Pure core — command classification + chunking (fully table-testable)
# ---------------------------------------------------------------------------


class PtAction(str, Enum):
    """What an inbound message means for the passthrough state machine."""

    IGNORE = "ignore"      # not passthrough-related — normal gateway handling
    ENTER = "enter"        # /cc | /codex while NOT in passthrough → open a session
    SWITCH = "switch"      # /cc | /codex while already in passthrough → re-open
    STOP = "stop"          # /stop while in passthrough → close + return to normal
    CANCEL = "cancel"      # /cancel while in passthrough → interrupt the turn
    FORWARD = "forward"    # any other message while in passthrough → to the agent


@dataclass(frozen=True, slots=True)
class PtDecision:
    """Result of classifying one inbound message."""

    action: PtAction
    family: Optional[str] = None      # for ENTER / SWITCH
    args: str = ""                    # command args (ENTER: cwd + first prompt)
    forward_text: str = ""            # for FORWARD — the raw, verbatim message


def classify_input(
    command: Optional[str],
    args: str,
    raw_text: str,
    *,
    in_passthrough: bool,
) -> PtDecision:
    """Classify one inbound message. Pure — no I/O, deterministic.

    ``command`` is the parsed slash-command name (``event.get_command()``, e.g.
    ``"cc"``; ``None`` for plain text). ``args`` is the text after the command.
    ``raw_text`` is the untouched message body (what gets forwarded verbatim).

    The verbatim contract: while in passthrough, *only* the three control words
    (``stop`` / ``cancel`` / an entry command) are intercepted; everything else —
    including unrelated slash commands like ``/help`` — is FORWARDED as-is, so the
    coding agent, not Hermes, decides what it means.
    """
    cmd = (command or "").strip().lower()

    if in_passthrough:
        if cmd == _STOP_COMMAND:
            return PtDecision(PtAction.STOP)
        if cmd == _CANCEL_COMMAND:
            return PtDecision(PtAction.CANCEL)
        if cmd in _ENTER_COMMANDS:
            return PtDecision(PtAction.SWITCH, family=_ENTER_COMMANDS[cmd], args=args)
        # Everything else goes to the agent verbatim.
        return PtDecision(PtAction.FORWARD, forward_text=raw_text)

    # Not in passthrough: only an explicit entry command engages (opt-in).
    if cmd in _ENTER_COMMANDS:
        return PtDecision(PtAction.ENTER, family=_ENTER_COMMANDS[cmd], args=args)
    return PtDecision(PtAction.IGNORE)


def chunk_text(text: str, limit: int = _CHUNK_LIMIT) -> list[str]:
    """Split ``text`` into IM-sized chunks, preferring newline/word boundaries.

    Pure and deterministic. Never returns a chunk longer than ``limit``; an empty
    or whitespace-only input yields ``[]`` (nothing to send).
    """
    if not text or not text.strip():
        return []
    if len(text) <= limit:
        return [text]

    chunks: list[str] = []
    remaining = text
    soft = max(1, int(limit * 0.6))  # don't split absurdly early
    while len(remaining) > limit:
        window = remaining[:limit]
        cut = window.rfind("\n")
        if cut < soft:
            space = window.rfind(" ")
            cut = space if space >= soft else limit
        if cut <= 0:
            cut = limit
        piece = remaining[:cut].rstrip()
        if piece:
            chunks.append(piece)
        remaining = remaining[cut:].lstrip("\n")
    if remaining.strip():
        chunks.append(remaining)
    return chunks


# ---------------------------------------------------------------------------
# Session targeting — /cc list · /cc <n> · /cc resume <id> · /cc new (hc-542)
# ---------------------------------------------------------------------------
#
# Kael's ask: "Claude Code 里有很多开启的 session,如何指定 session 发送指令".
# v1 always spawned a fresh session; v1.1 lets an IM chat *attach* to one of the
# machine's existing Claude Code sessions. Session truth is Claude Code's own
# native store — ``$CLAUDE_CONFIG_DIR/projects/<cwd-slug>/<sessionId>.jsonl`` (id
# == filename stem; ``cwd`` + the first user message live inside). We only ever
# READ those files (never write/delete), and every user-message preview is
# control-char-scrubbed + length-capped before it can reach IM (injection red
# line). Continuation reuses the harness's existing ``--resume <sessionId>``
# round-trip (ClaudeDirectHarness._build_prompt_args already appends it whenever
# ``session_id`` is set) — we simply preset ``session_id`` before the first
# turn, so the very first prompt attaches instead of forking a new session.


class CcKind(str, Enum):
    """What a ``/cc ...`` (or ``/codex ...``) argument string asks for."""

    NEW = "new"        # fresh session (v1 default, or explicit ``/cc new``)
    LIST = "list"      # enumerate existing sessions
    SELECT = "select"  # attach to a listed session by 1-based number
    RESUME = "resume"  # attach to a session by explicit id


@dataclass(frozen=True, slots=True)
class CcCommand:
    """Parsed ``/cc`` sub-command. Pure product of :func:`parse_cc_subcommand`."""

    kind: CcKind
    rest: str = ""          # NEW: optional leading cwd + first prompt
    index: int = 0          # SELECT: 1-based number as the user typed it
    session_id: str = ""    # RESUME: the explicit session id (may be "")
    bare: bool = False      # NEW: True when ``/cc`` was typed with no args


def parse_cc_subcommand(args: str) -> CcCommand:
    """Classify a ``/cc`` argument string. Pure, deterministic, no I/O.

    ``""`` → NEW(bare)         ·  ``list`` → LIST     ·  ``3`` → SELECT(3)
    ``resume <id>`` → RESUME   ·  ``new [dir] [msg]`` → NEW
    anything else → NEW with the whole string as rest (v1 back-compat: an
    optional leading directory token + first prompt, resolved later by I/O).
    Keywords are case-insensitive; ``cwd``/dir validation stays out of the pure
    parser (it happens in the I/O layer).
    """
    args = (args or "").strip()
    if not args:
        return CcCommand(kind=CcKind.NEW, bare=True)
    first, _, rest = args.partition(" ")
    rest = rest.strip()
    low = first.lower()
    if low == "list":
        return CcCommand(kind=CcKind.LIST)
    if first.isdigit():
        return CcCommand(kind=CcKind.SELECT, index=int(first))
    if low == "resume":
        sid = rest.split(maxsplit=1)[0] if rest else ""
        return CcCommand(kind=CcKind.RESUME, session_id=sid)
    if low == "new":
        return CcCommand(kind=CcKind.NEW, rest=rest)
    # v1 back-compat: treat the whole thing as (optional cwd) + prompt.
    return CcCommand(kind=CcKind.NEW, rest=args)


def sanitize_summary(text: str, limit: int = 40) -> str:
    """Scrub a stored user message for safe, compact display in IM.

    Injection red line: every Unicode *control/format* char (Cc/Cf/Cs/Co/Cn —
    includes ANSI ESC, NUL, and bidi/zero-width overrides that could reorder or
    spoof text) becomes a space; runs of whitespace collapse to one; the result
    is capped at ``limit`` characters (``…`` marks truncation). Pure.
    """
    if not text:
        return ""
    scrubbed = [
        " " if (ch in "\t\n\r" or unicodedata.category(ch)[0] == "C") else ch
        for ch in text
    ]
    collapsed = " ".join("".join(scrubbed).split())
    if len(collapsed) > limit:
        return collapsed[:limit].rstrip() + "…"
    return collapsed


def format_relative_time(now_ts: float, then_ts: float) -> str:
    """Coarse CN relative time. Pure — both timestamps are explicit args."""
    delta = now_ts - then_ts
    if delta < 60:
        return "刚刚"
    if delta < 3600:
        return f"{int(delta // 60)} 分钟前"
    if delta < 86400:
        return f"{int(delta // 3600)} 小时前"
    return f"{int(delta // 86400)} 天前"


@dataclass(frozen=True, slots=True)
class ParsedSession:
    """Head-scan result of one session jsonl: authoritative cwd + raw preview."""

    cwd: Optional[str]
    summary_raw: Optional[str]


@dataclass(frozen=True, slots=True)
class SessionInfo:
    """One resumable Claude Code session, ready to render / attach."""

    session_id: str
    cwd: str
    summary: str  # already sanitized; may be ""
    mtime: float


def _extract_user_text(obj: dict) -> Optional[str]:
    """Pull displayable text from a ``type:"user"`` record, or None.

    Skips meta records and tool-result-only turns (a user record whose content
    is only ``tool_result`` blocks carries no typed text). Claude Code stores
    ``message.content`` as either a plain string or a list of typed blocks.
    """
    if obj.get("isMeta"):
        return None
    msg = obj.get("message")
    if not isinstance(msg, dict):
        return None
    content = msg.get("content")
    if isinstance(content, str):
        return content.strip() or None
    if isinstance(content, list):
        texts = [
            b["text"].strip()
            for b in content
            if isinstance(b, dict)
            and b.get("type") == "text"
            and isinstance(b.get("text"), str)
            and b["text"].strip()
        ]
        return " ".join(texts) if texts else None
    return None


def parse_session_file(lines: Iterable[str], *, max_scan: int = 2000) -> ParsedSession:
    """Head-scan a session jsonl (iterable of raw lines) for cwd + first prompt.

    Pure over its input and fault-tolerant: non-JSON / non-dict lines are
    skipped, the first line is NOT assumed to be a user message (real stores
    open with ``queue-operation`` / ``summary`` records), and the scan stops as
    soon as both facts are found (so only the file head is read) or ``max_scan``
    lines elapse. Returns ``(None, None)`` for an empty / unusable file.
    """
    cwd: Optional[str] = None
    summary: Optional[str] = None
    for n, line in enumerate(lines):
        if cwd is not None and summary is not None:
            break
        if n >= max_scan:
            break
        line = line.strip() if isinstance(line, str) else ""
        if not line:
            continue
        try:
            obj = json.loads(line)
        except (ValueError, TypeError):
            continue
        if not isinstance(obj, dict):
            continue
        if cwd is None:
            c = obj.get("cwd")
            if isinstance(c, str) and c.strip():
                cwd = c.strip()
        if summary is None and obj.get("type") == "user":
            text = _extract_user_text(obj)
            if text:
                summary = text
    return ParsedSession(cwd=cwd, summary_raw=summary)


# A session id is a filename stem we join onto a directory — constrain it hard
# so a crafted ``/cc resume ../../etc/passwd`` can never escape the store.
_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$")


def _projects_root() -> str:
    """Claude Code's project store root. Honors ``CLAUDE_CONFIG_DIR`` (the same
    override Claude Code itself reads), else ``~/.claude``."""
    base = os.environ.get("CLAUDE_CONFIG_DIR", "").strip()
    root = os.path.expanduser(base) if base else os.path.expanduser("~/.claude")
    return os.path.join(root, "projects")


def _read_session_info(path: str) -> Optional[SessionInfo]:
    """Build a :class:`SessionInfo` from a session jsonl path (read-only)."""
    session_id = os.path.splitext(os.path.basename(path))[0]
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            parsed = parse_session_file(fh)
        mtime = os.path.getmtime(path)
    except OSError:
        return None
    slug = os.path.basename(os.path.dirname(path))
    return SessionInfo(
        session_id=session_id,
        cwd=parsed.cwd or slug,
        summary=sanitize_summary(parsed.summary_raw or ""),
        mtime=mtime,
    )


def list_recent_sessions(limit: int = 10, *, root: Optional[str] = None) -> list[SessionInfo]:
    """Newest-first Claude Code sessions across all projects (read-only FS scan).

    Only the newest ``limit`` files are parsed (sorted by mtime, then head-read),
    so a store with hundreds of sessions stays cheap. Empty files are skipped.
    Any FS error degrades to ``[]`` — listing can never raise into the gateway.
    """
    root = root or _projects_root()
    entries: list[tuple[float, str]] = []
    try:
        for proj in os.scandir(root):
            if not proj.is_dir():
                continue
            try:
                for f in os.scandir(proj.path):
                    if not (f.is_file() and f.name.endswith(".jsonl")):
                        continue
                    try:
                        st = f.stat()
                    except OSError:
                        continue
                    if st.st_size == 0:
                        continue
                    entries.append((st.st_mtime, f.path))
            except OSError:
                continue
    except OSError:
        return []
    entries.sort(key=lambda t: t[0], reverse=True)
    out: list[SessionInfo] = []
    for _mtime, path in entries:
        info = _read_session_info(path)
        if info is not None:
            out.append(info)
        if len(out) >= limit:
            break
    return out


def find_session(session_id: str, *, root: Optional[str] = None) -> Optional[SessionInfo]:
    """Locate one session by id across all project dirs (read-only). None if the
    id is malformed (path-traversal defense) or no such session file exists."""
    session_id = (session_id or "").strip()
    if not _SESSION_ID_RE.match(session_id):
        return None
    root = root or _projects_root()
    try:
        for proj in os.scandir(root):
            if not proj.is_dir():
                continue
            candidate = os.path.join(proj.path, session_id + ".jsonl")
            if os.path.isfile(candidate):
                return _read_session_info(candidate)
    except OSError:
        return None
    return None


def render_session_list(sessions: list[SessionInfo], *, now_ts: float) -> str:
    """Format the ``/cc list`` reply. Pure given ``sessions`` + ``now_ts``."""
    if not sessions:
        return "本机没有找到 Claude Code 历史会话。\n发送 /cc new 新开一个。"
    out = [f"本机 Claude Code 会话(新→旧,共 {len(sessions)} 条):"]
    for i, s in enumerate(sessions, 1):
        project = os.path.basename(s.cwd.rstrip("/")) or s.cwd
        out.append(f"{i}. {project} · {format_relative_time(now_ts, s.mtime)}")
        out.append(f"   {s.summary or '(无预览)'}")
        out.append(f"   id {s.session_id[:8]}")
    out.append("发送 /cc <编号> 挂接会话,或 /cc resume <会话id>。")
    return "\n".join(out)


# ---------------------------------------------------------------------------
# Rendering — verbatim agent output + the deny-all permission notice (red line)
# ---------------------------------------------------------------------------


def render_result(result: dict[str, Any]) -> str:
    """Turn a ``reduce_events`` result dict into the IM reply text.

    Verbatim agent output first. A ``permission_required`` result appends the
    deny notice — v1 NEVER auto-approves; the owner is told to act on Desktop.
    An error with no output surfaces the error. Never returns empty.
    """
    parts: list[str] = []
    output = (result.get("output") or "").strip()
    if output:
        parts.append(output)

    if result.get("permission_required"):
        summary = (result.get("permission_summary") or "").strip()
        notice = (
            "⚠️ 该操作需要审批,已按直通模式默认策略拒绝(不会自动批准)。"
            "如需放行,请在桌面端确认。"
        )
        if summary:
            notice += f"\n涉及:{summary}"
        parts.append(notice)

    error = (result.get("error") or "").strip()
    if error and not output:
        detail = (result.get("detail") or "").strip()
        parts.append(f"⚠️ 直通执行出错:{error}" + (f"({detail})" if detail else ""))

    if not parts:
        parts.append("(本轮没有文本输出)")
    return "\n\n".join(parts)


# --- user-facing control strings (inline CN; i18n keys are a follow-up) -------

def _family_name(family: str) -> str:
    return {"claude": "Claude Code", "codex": "Codex"}.get(family, family)


def _t_entered(family: str, cwd: str) -> str:
    return (
        f"已进入 {_family_name(family)} 直通模式(工作目录 {cwd})。\n"
        "· 直接发消息即与它对话,内容原样转发;\n"
        "· /cancel 打断当前任务,/stop 退出直通回到普通对话。"
    )


def _t_resumed(family: str, info: "SessionInfo") -> str:
    project = os.path.basename(info.cwd.rstrip("/")) or info.cwd
    return (
        f"已挂接到 {_family_name(family)} 会话(目录 {project})。\n"
        f"· 会话:{info.summary or '(无预览)'}\n"
        "· 直接发消息即续入该会话;/stop 退出直通。"
    )


def _t_exited() -> str:
    return "已退出直通模式,回到普通对话。"


def _t_cancelled() -> str:
    return "已发送打断信号。"


def _t_busy() -> str:
    return "上一条还在处理中,请稍候,或发送 /cancel 打断。"


def _t_list_hint() -> str:
    return "(提示:发送 /cc list 可挂接本机已有会话)"


def _t_resume_usage() -> str:
    return "用法:/cc resume <会话id>。发送 /cc list 可查看会话 id。"


def _t_index_out_of_range(count: int) -> str:
    if count <= 0:
        return "当前没有可挂接的会话。发送 /cc list 查看,或 /cc new 新开。"
    return f"编号超出范围(共 {count} 条)。发送 /cc list 重新查看。"


def _t_session_not_found(session_id: str) -> str:
    return f"未找到会话 {session_id}。发送 /cc list 查看可挂接的会话。"


def _t_targeting_claude_only() -> str:
    return "会话列表与挂接目前仅支持 Claude Code(/cc);/codex 只会新开会话。"


def _t_unavailable(family: str, detail: str) -> str:
    detail = (detail or "").strip()
    tail = f"\n{detail}" if detail else ""
    return f"{_family_name(family)} 未接入(未安装或无法启动),无法进入直通模式。{tail}"


# ---------------------------------------------------------------------------
# Session state
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class _PassthroughSession:
    """One IM-conversation ↔ coding-agent binding."""

    family: str
    harness: Any
    cwd: str
    busy: bool = False

    def close(self) -> None:
        try:
            self.harness.close()
        except Exception:  # pragma: no cover - teardown must not raise
            logger.debug("apex_overlay: passthrough harness close failed", exc_info=True)


def _sessions_for(runner) -> dict:
    sessions = getattr(runner, _STATE_ATTR, None)
    if sessions is None:
        sessions = {}
        setattr(runner, _STATE_ATTR, sessions)
    return sessions


def _last_list_for(runner) -> dict:
    cache = getattr(runner, _LIST_STATE_ATTR, None)
    if cache is None:
        cache = {}
        setattr(runner, _LIST_STATE_ATTR, cache)
    return cache


def _enabled() -> bool:
    return os.environ.get("HERMES_IM_PASSTHROUGH", "1").strip().lower() not in {
        "0", "false", "off", "no", "",
    }


def _resolve_cwd(cwd_arg: str) -> str:
    """Resolve the coding agent's working dir. ``cwd_arg`` (from ``/cc <dir>``)
    wins if it is an existing directory; else the env override; else ``~``."""
    if cwd_arg:
        candidate = os.path.expanduser(cwd_arg)
        if os.path.isdir(candidate):
            return candidate
    env = os.environ.get("HERMES_IM_PASSTHROUGH_CWD", "").strip()
    if env:
        candidate = os.path.expanduser(env)
        if os.path.isdir(candidate):
            return candidate
    return os.path.expanduser("~")


def _split_cwd_and_prompt(args: str) -> tuple[str, str]:
    """From ``/cc`` args, peel an optional leading directory token off the front.

    ``/cc ~/proj fix the bug`` → cwd=``~/proj``, prompt=``fix the bug``.
    ``/cc fix the bug``        → cwd=``""`` (default), prompt=``fix the bug``.
    Deterministic: the first token is treated as cwd ONLY if it resolves to an
    existing directory.
    """
    args = (args or "").strip()
    if not args:
        return "", ""
    first, _, rest = args.partition(" ")
    if os.path.isdir(os.path.expanduser(first)):
        return first, rest.strip()
    return "", args


# ---------------------------------------------------------------------------
# Turn driving (blocking harness work is run off the event loop)
# ---------------------------------------------------------------------------


def _drive_turn(harness, text: str) -> list:
    """Drain one harness turn to a list of AgentEvents. Blocking — call via
    ``asyncio.to_thread`` so the gateway event loop stays responsive (and a
    concurrent ``/cancel`` task can call ``harness.cancel()`` meanwhile)."""
    return list(harness.prompt(text))


async def _deliver(runner, source, reply: str) -> str:
    """Chunk ``reply`` and deliver it. Returns the final chunk for the gateway's
    normal delivery path (correct threading); earlier chunks go out directly."""
    chunks = chunk_text(reply, _CHUNK_LIMIT)
    if len(chunks) <= 1:
        return chunks[0] if chunks else ""
    adapter = None
    try:
        adapter = runner._adapter_for_source(source)
    except Exception:
        adapter = None
    if adapter is None:
        # No adapter handle — fall back to returning the whole reply.
        return reply
    chat_id = str(getattr(source, "chat_id", "") or "")
    for chunk in chunks[:-1]:
        try:
            await adapter.send(chat_id, chunk)
        except Exception:
            logger.debug("apex_overlay: passthrough chunk send failed", exc_info=True)
    return chunks[-1]


async def _forward(runner, source, session: _PassthroughSession, text: str) -> str:
    """Feed ``text`` verbatim to the bound harness and return the reply text."""
    if session.busy:
        return _t_busy()
    session.busy = True
    try:
        events = await asyncio.to_thread(_drive_turn, session.harness, text)
    except Exception as exc:
        logger.debug("apex_overlay: passthrough turn failed", exc_info=True)
        return f"⚠️ 直通执行出错:{type(exc).__name__}: {exc}"
    finally:
        session.busy = False

    result = reduce_events(events, family=session.family)
    reply = render_result(result)
    return await _deliver(runner, source, reply)


async def _build_and_open(
    family: str,
    cwd: str,
    *,
    resume_session_id: Optional[str] = None,
) -> tuple[Optional["_PassthroughSession"], Optional[str]]:
    """Build a harness for ``family`` at ``cwd``, probe, and open it.

    Returns ``(session, None)`` on success or ``(None, error_text)`` otherwise.
    The harness is built WITHOUT a permission_callback → it keeps the deny-all
    default (red line; asserted structurally in the test). When
    ``resume_session_id`` is given it is preset on the harness BEFORE ``open()``
    so the first turn attaches via ``--resume`` instead of forking a new session
    (ClaudeDirectHarness._build_prompt_args appends it off ``session_id``)."""
    harness = harness_for(family, cwd)
    if resume_session_id:
        harness.session_id = resume_session_id
    try:
        avail = await asyncio.to_thread(harness.availability)
    except Exception as exc:
        return None, _t_unavailable(family, str(exc))
    if not getattr(avail, "installed", False):
        return None, _t_unavailable(family, getattr(avail, "detail", ""))
    try:
        await asyncio.to_thread(harness.open)
    except Exception as exc:
        try:
            await asyncio.to_thread(harness.close)
        except Exception:
            pass
        return None, _t_unavailable(family, str(exc))
    return _PassthroughSession(family=family, harness=harness, cwd=cwd), None


async def _enter(
    runner,
    source,
    session_key: str,
    sessions: dict,
    family: str,
    rest: str,
    *,
    bare: bool = False,
) -> str:
    """Open (or re-open) a FRESH passthrough session bound to ``session_key``."""
    # Switch: close any existing binding first.
    old = sessions.pop(session_key, None)
    if old is not None:
        await asyncio.to_thread(old.close)

    cwd_arg, first_prompt = _split_cwd_and_prompt(rest)
    cwd = _resolve_cwd(cwd_arg)

    session, error = await _build_and_open(family, cwd)
    if session is None:
        return error or _t_unavailable(family, "")
    sessions[session_key] = session

    welcome = _t_entered(family, cwd)
    if bare and family == "claude":
        welcome += "\n" + _t_list_hint()
    if first_prompt:
        body = await _forward(runner, source, session, first_prompt)
        return welcome if not body else f"{welcome}\n\n{body}"
    return welcome


async def _enter_resumed(
    runner,
    source,
    session_key: str,
    sessions: dict,
    family: str,
    info: "SessionInfo",
) -> str:
    """Attach ``session_key`` to an existing Claude Code session (``info``)."""
    old = sessions.pop(session_key, None)
    if old is not None:
        await asyncio.to_thread(old.close)

    session, error = await _build_and_open(
        family, info.cwd, resume_session_id=info.session_id
    )
    if session is None:
        return error or _t_unavailable(family, "")
    sessions[session_key] = session
    return _t_resumed(family, info)


# --- /cc list · /cc <n> · /cc resume <id> dispatch (Claude-only) -------------


async def _handle_list(runner, session_key: str, family: str) -> str:
    """``/cc list`` — enumerate sessions and cache the ordering for ``/cc <n>``.
    A pure query: it never opens/closes/switches the bound session."""
    if family != "claude":
        return _t_targeting_claude_only()
    sessions = await asyncio.to_thread(list_recent_sessions, 10)
    _last_list_for(runner)[session_key] = sessions
    return render_session_list(sessions, now_ts=time.time())


async def _handle_select(
    runner, source, session_key: str, sessions: dict, family: str, index: int
) -> str:
    """``/cc <n>`` — attach to the n-th session of the chat's last list."""
    if family != "claude":
        return _t_targeting_claude_only()
    cached = _last_list_for(runner).get(session_key)
    if cached is None:
        cached = await asyncio.to_thread(list_recent_sessions, 10)
        _last_list_for(runner)[session_key] = cached
    if index < 1 or index > len(cached):
        return _t_index_out_of_range(len(cached))
    return await _enter_resumed(runner, source, session_key, sessions, family, cached[index - 1])


async def _handle_resume_id(
    runner, source, session_key: str, sessions: dict, family: str, session_id: str
) -> str:
    """``/cc resume <id>`` — attach to a session by explicit id."""
    if family != "claude":
        return _t_targeting_claude_only()
    if not session_id:
        return _t_resume_usage()
    info = await asyncio.to_thread(find_session, session_id)
    if info is None:
        return _t_session_not_found(session_id)
    return await _enter_resumed(runner, source, session_key, sessions, family, info)


async def _handle_entry(
    runner, source, session_key: str, sessions: dict, family: str, args: str
) -> str:
    """Route a ``/cc`` / ``/codex`` entry by its sub-command (list/n/resume/new)."""
    sub = parse_cc_subcommand(args)
    if sub.kind is CcKind.LIST:
        return await _handle_list(runner, session_key, family)
    if sub.kind is CcKind.SELECT:
        return await _handle_select(runner, source, session_key, sessions, family, sub.index)
    if sub.kind is CcKind.RESUME:
        return await _handle_resume_id(runner, source, session_key, sessions, family, sub.session_id)
    return await _enter(runner, source, session_key, sessions, family, sub.rest, bare=sub.bare)


async def _exit(runner, source, session_key: str, sessions: dict) -> str:
    session = sessions.pop(session_key, None)
    if session is not None:
        await asyncio.to_thread(session.close)
    return _t_exited()


async def _cancel(runner, source, session: _PassthroughSession) -> str:
    try:
        await asyncio.to_thread(session.harness.cancel)
    except Exception:
        logger.debug("apex_overlay: passthrough cancel failed", exc_info=True)
    return _t_cancelled()


# ---------------------------------------------------------------------------
# Controller — the single entry the wrapper calls
# ---------------------------------------------------------------------------


_NOT_ENGAGED: tuple[bool, Any] = (False, None)


def _is_authorized(runner, source) -> bool:
    try:
        if getattr(source, "user_id", None) is None:
            return False
        return bool(runner._is_user_authorized(source))
    except Exception:
        return False


async def maybe_handle_passthrough(runner, event) -> tuple[bool, Any]:
    """Decide whether this message is passthrough, and if so handle it.

    Returns ``(handled, reply)``. ``handled=False`` means the wrapper must fall
    through to the original ``_handle_message`` (normal gateway flow). Fully
    defensive: any failure returns ``not engaged`` so normal handling proceeds.
    """
    if harness_for is None or reduce_events is None:
        return _NOT_ENGAGED
    if not _enabled():
        return _NOT_ENGAGED

    source = getattr(event, "source", None)
    if source is None or getattr(event, "internal", False):
        return _NOT_ENGAGED

    try:
        session_key = runner._session_key_for_source(source)
    except Exception:
        return _NOT_ENGAGED

    sessions = _sessions_for(runner)
    existing = sessions.get(session_key)

    command = event.get_command() if hasattr(event, "get_command") else None
    args = ""
    if command and hasattr(event, "get_command_args"):
        try:
            args = event.get_command_args().strip()
        except Exception:
            args = ""
    raw_text = getattr(event, "text", "") or ""

    decision = classify_input(command, args, raw_text, in_passthrough=existing is not None)
    if decision.action is PtAction.IGNORE:
        return _NOT_ENGAGED

    # From here we intend to engage — but only for authorized, real users. If
    # not authorized, fall through so the gateway runs its pairing/reject path.
    if not _is_authorized(runner, source):
        return _NOT_ENGAGED

    if decision.action in (PtAction.ENTER, PtAction.SWITCH):
        assert decision.family is not None  # ENTER/SWITCH always carry a family
        reply = await _handle_entry(runner, source, session_key, sessions, decision.family, decision.args)
        return True, reply
    if decision.action is PtAction.STOP:
        return True, await _exit(runner, source, session_key, sessions)

    # CANCEL / FORWARD only arise when in_passthrough was True, so ``existing`` is
    # non-None here. Guard defensively (and to narrow the type) rather than assert.
    if existing is None:  # pragma: no cover - unreachable given classify_input
        return _NOT_ENGAGED
    if decision.action is PtAction.CANCEL:
        return True, await _cancel(runner, source, existing)
    if decision.action is PtAction.FORWARD:
        return True, await _forward(runner, source, existing, decision.forward_text)

    return _NOT_ENGAGED  # pragma: no cover - all actions handled above


# ---------------------------------------------------------------------------
# The method wrapper + apply()
# ---------------------------------------------------------------------------


def _wrap_handle_message(orig):
    """Wrap ``GatewayRunner._handle_message`` to intercept passthrough first."""

    @functools.wraps(orig)
    async def wrapper(self, event, *args, **kwargs):
        try:
            handled, reply = await maybe_handle_passthrough(self, event)
        except Exception:
            # Passthrough must NEVER break normal message handling.
            logger.debug("apex_overlay: passthrough controller failed", exc_info=True)
            handled, reply = _NOT_ENGAGED
        if handled:
            return reply
        return await orig(self, event, *args, **kwargs)

    setattr(wrapper, _MARK, True)
    return wrapper


def apply() -> bool:
    """Install the passthrough seam. Idempotent, fail-safe.

    Returns True when the wrapper is in place (or already present), False if the
    target symbol is missing (the seam-test turns that into a hard CI failure).
    Never raises into plugin discovery.
    """
    global _APPLIED
    if _APPLIED:
        return True

    import importlib

    try:
        run_mod = importlib.import_module(_TARGET_RUN_MODULE)
        runner_cls = getattr(run_mod, _TARGET_RUNNER_CLASS)
        orig = getattr(runner_cls, _TARGET_METHOD)
    except (ImportError, AttributeError) as exc:
        logger.error(
            "apex_overlay: could not patch %s.%s.%s — IM passthrough (/cc, /codex) "
            "is NOT active. Upstream may have renamed/moved it. (%s)",
            _TARGET_RUN_MODULE, _TARGET_RUNNER_CLASS, _TARGET_METHOD, exc,
        )
        return False

    if not getattr(orig, _MARK, False):
        setattr(runner_cls, _TARGET_METHOD, _wrap_handle_message(orig))

    _APPLIED = True
    logger.debug("apex_overlay: im_passthrough seam applied")
    return True
