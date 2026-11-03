"""hc-1122 ChatCut: editing through APEX's own ChatCut account, which only the Scheduler holds.

The engine never talks to ChatCut. Its ``mcp_servers.chatcut`` entry points at the Scheduler's proxy
(``/api/v1/chatcut/mcp``) and signs in with this assistant's own APEX key, written as ``${TOOLS_GATEWAY_KEY}``
so the key itself never lands in config.yaml. The proxy adds the ChatCut credential, keeps each user to their own
projects and offers only editing tools (apex-nodes ``app/services/chatcut_proxy.py``).

There is nothing to connect: with the switch on and the user signed in to APEX the entry is there, otherwise it
is not. Nothing on this computer signs in to ChatCut either. Every user shares one ChatCut account, and ChatCut
hands browser work (imports, local renders, viewer frames) to any browser signed in to it, so a signed-in editor
here could end up running someone else's job. Until ChatCut can keep users apart that way, there is no editor in
the panel and no import of local files; the prompt section says so.

**Off means nothing.** Desktop's main process settles ``desktop_features.chatcut`` into ``APEX_CHATCUT_ACTIVE=1``
before the engine spawns. Without it (the switch off, every cloud container) no section is added, and an entry
left from before is removed at boot, so a rollback really takes the tools away.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Mapping, Optional

logger = logging.getLogger(__name__)

SWITCH_ENV = "APEX_CHATCUT_ACTIVE"
SERVER_NAME = "chatcut"
# Desktop's main process puts both in the engine's env while an APEX account is signed in (apex-platform-tools.ts).
BASE_ENV = "TOOLS_GATEWAY_BASE"
KEY_ENV = "TOOLS_GATEWAY_KEY"
PROXY_PATH = "/api/v1/chatcut/mcp"

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
    signed in. An older entry (a change to the allowlist, say) is rewritten."""
    block = _current_block()
    if block is not None and not _is_ours(block):
        return
    wanted = server_config() if switch_on() and signed_in() else None
    if block != wanted:
        _set_block(wanted)


def render_section(session_info: Mapping[str, Any] | None = None) -> str:
    """When to reach for ChatCut, for a session a person is in."""
    info = session_info or {}
    if not switch_on() or not signed_in() or info.get("platform") in NON_INTERACTIVE_PLATFORMS:
        return ""
    return "\n".join((
        "## 剪辑（ChatCut）",
        "用户要剪 ChatCut 工程里的视频（按文字剪、去口误、加字幕、调时间轴、导出）时用 ChatCut：工具名前缀 "
        "mcp__chatcut__，用 tool_describe / tool_call 调用；动手前用 skill_view 读 chatcut 技能（name 填 chatcut），"
        "它不在上面的技能目录里。用户没提剪辑就不提 ChatCut。",
        "现在还不能把这台电脑上的文件导入 ChatCut。用户要剪本机视频时如实说明，用别的办法照常帮他。",
        "ChatCut 走的是 APEX 的账号，用户不需要 ChatCut 账号：不要让他登录 ChatCut，也不要给他 ChatCut 编辑器的链接。",
        "用户问起素材去了哪里：传到 ChatCut（美国），存在 APEX 使用的 ChatCut 账号下。",
    ))


def apply(ctx: Any) -> bool:
    """Settle the entry for this launch, then, only with the switch on, add the prompt section."""
    register_section = getattr(ctx, "register_system_prompt_section", None)
    if register_section is None:
        logger.warning("apex-overlay: this plugin host cannot register the ChatCut seam")
        return False
    try:
        reconcile_at_boot()
    except Exception:
        logger.warning("apex-overlay: could not settle the ChatCut entry at boot", exc_info=True)
    if not switch_on():
        return True
    try:
        register_section(SECTION_ID, render_section, max_chars=MAX_SECTION_CHARS)
    except ValueError as exc:
        logger.warning("apex-overlay: ChatCut prompt section not registered: %s", exc)
        return False
    return True
