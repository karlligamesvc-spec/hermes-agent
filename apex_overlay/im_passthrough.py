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
import logging
import os
from dataclasses import dataclass
from enum import Enum
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Upstream target we monkey-patch — centralized so the seam-test pins it.
_TARGET_RUN_MODULE = "gateway.run"
_TARGET_RUNNER_CLASS = "GatewayRunner"
_TARGET_METHOD = "_handle_message"

# Per-runner state attribute: {session_key: _PassthroughSession}.
_STATE_ATTR = "_apex_im_passthrough_sessions"

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

def _t_entered(family: str, cwd: str) -> str:
    name = "Claude Code" if family == "claude" else ("Codex" if family == "codex" else family)
    return (
        f"已进入 {name} 直通模式(工作目录 {cwd})。\n"
        "· 直接发消息即与它对话,内容原样转发;\n"
        "· /cancel 打断当前任务,/stop 退出直通回到普通对话。"
    )


def _t_exited() -> str:
    return "已退出直通模式,回到普通对话。"


def _t_cancelled() -> str:
    return "已发送打断信号。"


def _t_busy() -> str:
    return "上一条还在处理中,请稍候,或发送 /cancel 打断。"


def _t_unavailable(family: str, detail: str) -> str:
    name = "Claude Code" if family == "claude" else ("Codex" if family == "codex" else family)
    detail = (detail or "").strip()
    tail = f"\n{detail}" if detail else ""
    return f"{name} 未接入(未安装或无法启动),无法进入直通模式。{tail}"


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


async def _enter(
    runner,
    source,
    session_key: str,
    sessions: dict,
    family: str,
    args: str,
) -> str:
    """Open (or re-open) a passthrough session bound to ``session_key``."""
    # Switch: close any existing binding first.
    old = sessions.pop(session_key, None)
    if old is not None:
        await asyncio.to_thread(old.close)

    cwd_arg, first_prompt = _split_cwd_and_prompt(args)
    cwd = _resolve_cwd(cwd_arg)

    # Build the harness WITHOUT a permission_callback → it keeps the harness
    # default (``default_deny_permission``). This is the red line: passthrough
    # never installs an approving callback. (Asserted structurally in the test.)
    harness = harness_for(family, cwd)
    try:
        avail = await asyncio.to_thread(harness.availability)
    except Exception as exc:
        return _t_unavailable(family, str(exc))
    if not getattr(avail, "installed", False):
        return _t_unavailable(family, getattr(avail, "detail", ""))

    try:
        await asyncio.to_thread(harness.open)
    except Exception as exc:
        try:
            await asyncio.to_thread(harness.close)
        except Exception:
            pass
        return _t_unavailable(family, str(exc))

    session = _PassthroughSession(family=family, harness=harness, cwd=cwd)
    sessions[session_key] = session

    welcome = _t_entered(family, cwd)
    if first_prompt:
        body = await _forward(runner, source, session, first_prompt)
        return welcome if not body else f"{welcome}\n\n{body}"
    return welcome


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
        reply = await _enter(runner, source, session_key, sessions, decision.family, decision.args)
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
