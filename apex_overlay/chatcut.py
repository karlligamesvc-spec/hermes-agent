"""hc-1122 ChatCut: editing through APEX's own ChatCut account, which only the Scheduler holds.

The engine never talks to ChatCut. Its ``mcp_servers.chatcut`` entry points at the Scheduler's proxy
(``/api/v1/chatcut/mcp``) and signs in with this assistant's own APEX key, written as ``${TOOLS_GATEWAY_KEY}``
so the key itself never lands in config.yaml. The proxy adds the ChatCut credential, keeps each user to their own
projects and offers only editing tools (apex-nodes ``app/services/chatcut_proxy.py``).

There is nothing to connect: with the switch on and the user signed in to APEX the entry is there, otherwise it
is not. Nothing on this computer signs in to ChatCut either. Every user shares one ChatCut account, and ChatCut
hands browser work (imports, local renders, viewer frames) to any browser signed in to it, so a signed-in editor
here could end up running someone else's job: there is no editor in the panel. Local files go in, and finished
exports come out, through the Scheduler (apex_overlay/chatcut_files.py).

**Off means nothing.** Desktop's main process settles ``desktop_features.chatcut`` into ``APEX_CHATCUT_ACTIVE=1``
before the engine spawns. Without it (the switch off, every cloud container) no section is added, and an entry
left from before is removed at boot, so a rollback really takes the tools away.

**Only for an account that may use it.** On top of the switch the Scheduler opens ChatCut per account (the
entitlement ``chatcut``) and refuses everyone else. The engine reads the same answer, ``chatcut.enabled`` on
``/tools/v1/check`` with this assistant's APEX key, when it needs it, not once at boot: the prompt section, the
two file tools and the MCP connection to the proxy exist only while it is yes. The answer is kept for a minute;
when it changes the tool lists are re-checked and the MCP connection follows (``reconcile_mcp_servers_with_config``),
so an account opened or closed while Desktop runs needs no restart. Unreadable counts as no.
"""

from __future__ import annotations

import functools
import hashlib
import json
import logging
import os
import sys
import threading
import time
import uuid
from typing import Any, Callable, Mapping, Optional

logger = logging.getLogger(__name__)

SWITCH_ENV = "APEX_CHATCUT_ACTIVE"
SERVER_NAME = "chatcut"
# Desktop's main process puts both in the engine's env while an APEX account is signed in (apex-platform-tools.ts).
BASE_ENV = "TOOLS_GATEWAY_BASE"
KEY_ENV = "TOOLS_GATEWAY_KEY"
PROXY_PATH = "/api/v1/chatcut/mcp"
# The Scheduler's per-account answer (apex-nodes ``chatcut_access.open_to``), the probe Desktop's tools already use.
CHECK_PATH = "/tools/v1/check"
ENTITLEMENT_TTL_SECONDS = 60.0
CHECK_TIMEOUT_SECONDS = 5.0

SECTION_ID = "apex.chatcut"
MAX_SECTION_CHARS = 1_200
# Same set as apexnodes-next-steps' NON_INTERACTIVE_PLATFORMS.
NON_INTERACTIVE_PLATFORMS = frozenset({"api_server", "cron", "webhook", "subagent"})

# The proxy offers exactly these (its PROJECT_TOOLS and UNSCOPED_TOOLS); listed again here so a tool the proxy
# starts offering by mistake still does not reach the model. Paid generation is not among them, nor anything
# ChatCut may run in a browser on its own (trigger_transcript).
INCLUDED_TOOLS = (
    "apply_script",
    "browse_assets",
    "clean_script",
    "create_project",
    "detach_audio",
    "duplicate_project",
    "edit_asset",
    "edit_captions",
    "edit_item",
    "edit_project",
    "edit_track",
    "find_transcript",
    "inspect_asset",
    "inspect_item",
    "list_projects",
    "manage_markers",
    "manage_media_pool",
    "manage_timelines",
    "preview_timeline",
    "read_captions",
    "read_project",
    "read_script",
    "search_fonts",
    "smooth_audio",
    "split_item",
    "submit_export",
    "target_project",
    "track_export",
    "track_progress",
)


def switch_on() -> bool:
    """Desktop settled the ChatCut switch on for this engine."""
    return os.environ.get(SWITCH_ENV, "").strip() == "1"


def signed_in() -> bool:
    """An APEX account is signed in, so the proxy can tell who is asking."""
    return bool(os.environ.get(KEY_ENV, "").strip() and os.environ.get(BASE_ENV, "").strip())


# key fingerprint -> (when read, the answer). A different account signed in reads afresh.
_answers: dict[str, tuple[float, bool]] = {}
_answers_lock = threading.Lock()
_refreshing: set[str] = set()


def _account() -> tuple[str, str, str]:
    base = os.environ.get(BASE_ENV, "").strip().rstrip("/")
    key = os.environ.get(KEY_ENV, "").strip()
    return base, key, hashlib.sha256(f"{base}\0{key}".encode()).hexdigest()


def _read_entitlement(base: str, key: str) -> bool:
    """``chatcut.enabled`` on the Scheduler's ``/tools/v1/check``, asked with this assistant's APEX key."""
    import httpx

    try:
        answer = httpx.get(f"{base}{CHECK_PATH}", headers={"Authorization": f"Bearer {key}"},
                           timeout=CHECK_TIMEOUT_SECONDS)
        block = answer.json().get("chatcut") if answer.status_code == 200 else None
    except (httpx.HTTPError, ValueError, AttributeError):
        logger.info("apex-overlay: could not read whether ChatCut is open to this account")
        return False
    return isinstance(block, dict) and block.get("enabled") is True


def _store(slot: str, answer: bool) -> None:
    with _answers_lock:
        before = _answers.get(slot)
        _answers[slot] = (time.monotonic(), answer)
    if (before[1] if before else False) != answer:
        _spawn(_follow_change, name="apex-chatcut-entitlement")


def _spawn(target: Callable[..., None], *, name: str, args: tuple = ()) -> None:
    """A background thread under the caller's profile scope, so the MCP reconcile works on this profile's config."""
    from agent.memory_provider import spawn_context_thread

    spawn_context_thread(target, name=name, args=args).start()


def _follow_change() -> None:
    """Opened or closed while running: re-check the tool lists, and connect or drop the MCP server to match."""
    try:
        from tools.registry import invalidate_check_fn_cache

        invalidate_check_fn_cache()
    except Exception:
        logger.warning("apex-overlay: could not re-check tool lists after the ChatCut answer changed", exc_info=True)
    if "tools.mcp_tool_discovery" not in sys.modules:
        return  # MCP never started in this process: the next discovery reads the new answer
    try:
        from tools.mcp_oauth import suppress_interactive_oauth
        from tools.mcp_tool_discovery import reconcile_mcp_servers_with_config

        with suppress_interactive_oauth():
            reconcile_mcp_servers_with_config()
    except Exception:
        logger.warning("apex-overlay: could not bring the ChatCut connection in line", exc_info=True)


def entitled() -> bool:
    """This account may use ChatCut now (switch on, signed in, and the Scheduler says yes). Waits for the
    Scheduler at most ``CHECK_TIMEOUT_SECONDS`` when the kept answer is older than a minute."""
    if not (switch_on() and signed_in()):
        return False
    base, key, slot = _account()
    with _answers_lock:
        kept = _answers.get(slot)
    if kept is not None and time.monotonic() - kept[0] < ENTITLEMENT_TTL_SECONDS:
        return kept[1]
    answer = _read_entitlement(base, key)
    _store(slot, answer)
    return answer


def _refresh(base: str, key: str, slot: str) -> None:
    try:
        _store(slot, _read_entitlement(base, key))
    finally:
        with _answers_lock:
            _refreshing.discard(slot)


def known_entitled() -> bool:
    """The kept answer without waiting (no answer yet counts as no), for the MCP paths, which run on a shared event
    loop. A stale or missing answer is fetched in the background; when it changes, ``_follow_change`` runs."""
    if not (switch_on() and signed_in()):
        return False
    base, key, slot = _account()
    with _answers_lock:
        kept = _answers.get(slot)
        fresh = kept is not None and time.monotonic() - kept[0] < ENTITLEMENT_TTL_SECONDS
        start = not fresh and slot not in _refreshing
        if start:
            _refreshing.add(slot)
    if start:
        _spawn(_refresh, name="apex-chatcut-check", args=(base, key, slot))
    return bool(kept and kept[1])


def server_config() -> dict:
    """The ``mcp_servers`` entry. Placeholders only: the engine fills them from its env when it connects."""
    return {
        "url": f"${{{BASE_ENV}}}{PROXY_PATH}",
        "headers": {"Authorization": f"Bearer ${{{KEY_ENV}}}"},
        "tools": {"include": list(INCLUDED_TOOLS), "resources": False, "prompts": False},
        "connect_timeout": 60,
    }


def _current_block() -> Any:
    from hermes_cli.config import read_raw_config_readonly

    servers = read_raw_config_readonly().get("mcp_servers")
    return servers.get(SERVER_NAME) if isinstance(servers, dict) else None


def _is_ours(block: Any) -> bool:
    """The entry this seam writes. A developer's own server of that name points somewhere else."""
    return isinstance(block, dict) and str(block.get("url") or "").endswith(PROXY_PATH)


def _set_block(entry: Optional[dict]) -> None:
    from hermes_cli.config import mutate_config

    def edit(config: dict) -> None:
        servers = config.get("mcp_servers")
        if entry is not None:
            config["mcp_servers"] = {**(servers if isinstance(servers, dict) else {}), SERVER_NAME: entry}
        elif isinstance(servers, dict) and servers.pop(SERVER_NAME, None) is not None and not servers:
            config.pop("mcp_servers", None)

    mutate_config(edit)


def reconcile_at_boot() -> None:
    """Before MCP discovery reads the config: the entry exists exactly while the switch is on and someone is
    signed in. An older entry (a change to the allowlist, say) is rewritten. The upload consent goes with it, so
    the next person to sign in is asked again."""
    if not (switch_on() and signed_in()):
        from apex_overlay import chatcut_files

        chatcut_files.forget_consent()
    block = _current_block()
    if block is not None and not _is_ours(block):
        return
    wanted = server_config() if switch_on() and signed_in() else None
    if block != wanted:
        _set_block(wanted)


def render_section(session_info: Mapping[str, Any] | None = None) -> str:
    """When to reach for ChatCut, for a session a person is in, on an account it is open to (``entitled`` is no
    with the switch off or nobody signed in)."""
    info = session_info or {}
    if info.get("platform") in NON_INTERACTIVE_PLATFORMS or not entitled():
        return ""
    return "\n".join((
        "## 剪辑（ChatCut）",
        "用户要剪 ChatCut 工程里的视频（按文字剪、去口误、加字幕、调时间轴、导出）时用 ChatCut：工具名前缀 "
        "mcp__chatcut__，用 tool_describe / tool_call 调用；动手前用 skill_view 读 chatcut 技能（name 填 chatcut），"
        "它不在上面的技能目录里。用户没提剪辑就不提 ChatCut。",
        "这台电脑上的视频、音频、图片用 chatcut_upload_files 传进工程（第一次它会弹卡片问用户，你不用先问）；"
        "导出完成后用 chatcut_save_export 存进下载文件夹。",
        "ChatCut 走的是 APEX 的账号，用户不需要 ChatCut 账号：不要让他登录 ChatCut，也不要给他 ChatCut 编辑器的链接。",
        "用户问起素材去了哪里：先经过 APEX 的服务器，再存到 ChatCut 在美国的服务器上，放在 APEX 使用的 ChatCut 账号下。",
    ))


def ask_on_card(agent: Any, question: str, yes: str, no: str) -> Optional[str]:
    """The existing choice card. The answer the user gave; None when nothing can ask or nobody answered."""
    from tools.clarify_tool import clarify_tool

    callback = getattr(agent, "clarify_callback", None)
    if callback is None:
        return None
    # recommended: false: no option is the right one here, so none is marked.
    questions = [{"question": question, "choices": [yes, no], "recommended": False}]
    # The transcript draws a card on a `clarify` row and closes it on that row's completion. Called from inside
    # a tool nothing else opens or closes one: a second card would land on the first card's row, already answered.
    row_id, row_args = f"apex-chatcut-card-{uuid.uuid4().hex}", {"questions": questions}
    started, finished = getattr(agent, "tool_start_callback", None), getattr(agent, "tool_complete_callback", None)
    if started is not None:
        started(row_id, "clarify", row_args)
    raw = clarify_tool(questions, callback=callback)
    if finished is not None:
        finished(row_id, "clarify", row_args, raw)
    try:
        response = json.loads(raw)["responses"][0]
    except (KeyError, IndexError, TypeError, ValueError):
        return None
    return response.get("user_response") if response.get("status") == "answered" else None


def hide_unless_entitled(load: Callable[[], dict]) -> Callable[[], dict]:
    """``tools.mcp_tool_config._load_mcp_config`` without our entry while this account may not use ChatCut, so
    the engine neither connects to the proxy (which would refuse it) nor lists it. A developer's own ``chatcut``
    server is left alone."""
    @functools.wraps(load)
    def load_mcp_config() -> dict:
        servers = load()
        if isinstance(servers, dict) and _is_ours(servers.get(SERVER_NAME)) and not known_entitled():
            return {name: config for name, config in servers.items() if name != SERVER_NAME}
        return servers

    load_mcp_config.__apex_chatcut__ = True
    return load_mcp_config


def gate_mcp_tools(make_check_fn: Callable[[str], Callable[[], bool]]) -> Callable[[str], Callable[[], bool]]:
    """``_make_check_fn`` whose answer for our ``chatcut`` server also needs the account to be open, so tools
    already registered go quiet as soon as it closes, before the connection is dropped."""
    @functools.wraps(make_check_fn)
    def make(server_name: str) -> Callable[[], bool]:
        check = make_check_fn(server_name)
        if server_name != SERVER_NAME or not _is_ours(_current_block()):
            return check
        return lambda: check() and known_entitled()

    make.__apex_chatcut__ = True
    return make


def _install_config(module: Any) -> bool:
    if not getattr(module._load_mcp_config, "__apex_chatcut__", False):
        module._load_mcp_config = hide_unless_entitled(module._load_mcp_config)
    return True


def _install_check(module: Any) -> bool:
    if not getattr(module._make_check_fn, "__apex_chatcut__", False):
        module._make_check_fn = gate_mcp_tools(module._make_check_fn)
    return True


def apply(ctx: Any) -> bool:
    """Settle the entry for this launch, then, only with the switch on, add the prompt section, the two file
    tools and the per-account gate on the MCP connection."""
    register_section = getattr(ctx, "register_system_prompt_section", None)
    if register_section is None or getattr(ctx, "register_tool", None) is None:
        logger.warning("apex-overlay: this plugin host cannot register the ChatCut seam")
        return False
    try:
        reconcile_at_boot()
    except Exception:
        logger.warning("apex-overlay: could not settle the ChatCut entry at boot", exc_info=True)
    if not switch_on():
        return True
    from apex_overlay import chatcut_files, post_import

    try:
        register_section(SECTION_ID, render_section, max_chars=MAX_SECTION_CHARS)
    except ValueError as exc:
        logger.warning("apex-overlay: ChatCut prompt section not registered: %s", exc)
        return False
    chatcut_files.register(ctx)
    gated = [post_import.when_imported(name, patch) for name, patch in (
        ("tools.mcp_tool_config", _install_config),
        ("tools.mcp_tool_registration", _install_check),
        ("agent.inline_tool_executors", chatcut_files.install_inline),
    )]
    return all(gated)
