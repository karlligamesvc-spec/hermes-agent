"""hc-1183 定时任务的结果去哪: a Desktop chat tells the user where a scheduled job's result goes.

A cron job made in a Desktop chat has nowhere to deliver "back here". The engine records an origin only for an IM
chat (``tools/cronjob_job_args.py`` ``_origin_from_env`` needs HERMES_SESSION_PLATFORM and HERMES_SESSION_CHAT_ID,
which a Desktop session never sets), so at fire time ``deliver=origin`` falls back to an IM home channel: the
Feishu or WeChat app bound through the IM 入口 (cron fires get those names too, hc-1169). With none bound the
result is only saved on this computer (``cron/scheduler_delivery.py`` ``_unresolved_delivery_outcome``). The
create result says so, in English; still, in the hc-1166 acceptance run (0.17.74) both assistants told the user
the result would come back into the conversation. The ``deliver`` field of the tool schema reads "Omit to address
the chat/topic this job was created from", which is true only for IM chats.

So every Desktop chat gets this section: the result does not come back here, where it goes instead, and to tell
the user so. Desktop is told apart the way apex.honesty does it (``honesty_prompt.on_desktop``), so a cloud
container's prompt stays as it was; subagents, cron runs and IM chats have another platform and get nothing.
The page to open it is named only where it exists: product mode with an APEX account has
设置 › 助手与记录 › 定时运行 (apps/desktop product-settings.ts ``PRODUCT_VIEWS``); developer mode and an own key
have no such tab.

The id sorts after every other apex section, so on a tight prompt budget this is the section that goes.
"""

from __future__ import annotations

import logging
from typing import Any, Mapping

logger = logging.getLogger(__name__)

SECTION_ID = "apex.user-scheduled"
MAX_CHARS = 600

WHERE_TO_LOOK = "，用户在「设置 › 助手与记录 › 定时运行」里点开那次运行就能看到"

HEADER = "【定时任务的结果去哪 · 平台规则】"


def rules(where: str = "") -> tuple[str, ...]:
    return (
        "在这里建的定时任务，到点后在后台单独跑，跑出的结果不会出现在这个对话里。",
        "APEX 连着飞书或微信时，结果会发到那边的私聊（任务设成只保存在本机的除外）；"
        f"没连时，结果只保存在这台电脑上{where}。",
        "建好或改好定时任务后，照实告诉用户结果会去哪、在哪看，不要说结果会回到这个对话里；"
        "工具返回说结果不会投递时，以它为准。",
    )


def prompt(where: str = "") -> str:
    return HEADER + "\n" + "\n".join(f"- {rule}" for rule in rules(where))


def settings_page_shown() -> bool:
    """Whether 设置 › 助手与记录 › 定时运行 is on screen: product mode, not developer mode, an APEX account."""
    from apex_overlay import chatcut, result_delivery_prompt, single_thread_prompt

    return single_thread_prompt.switch_on() and not result_delivery_prompt.developer_mode() and chatcut.signed_in()


def render_section(session_info: Mapping[str, Any] | None = None) -> str:
    """The section in a Desktop chat, else "" (the runtime then adds none)."""
    from apex_overlay import honesty_prompt

    if (session_info or {}).get("platform") != "desktop" or not honesty_prompt.on_desktop():
        return ""
    return prompt(WHERE_TO_LOOK if settings_page_shown() else "")


def apply(ctx: Any) -> bool:
    """Register the section on this plugin's context. Idempotent per plugin manager."""
    register = getattr(ctx, "register_system_prompt_section", None)
    if register is None:
        logger.warning("apex-overlay: this plugin host cannot register system prompt sections")
        return False
    try:
        register(SECTION_ID, render_section, max_chars=MAX_CHARS)
    except ValueError as exc:
        logger.warning("apex-overlay: scheduled result prompt section not registered: %s", exc)
        return False
    return True
