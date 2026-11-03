"""hc-1131 结果卡片交付: replies stop spelling out local paths in single-thread product mode.

hc-1130 folded the code, file cards and paths that tools show into the process area, and every result card has
its download and reveal buttons. What remained was the model's own text: a real run wrote the MEDIA: line, which
is the card, and then a 「文件路径：…」 line under it. Two sentences it may be following are shared with surfaces
that have no cards (apex.honesty's 「列出路径」, the short-video skill's 「视频路径/文件」), so they stay as they
are and this section says what they mean here. The renderer never rewrites the model's text.

When the user asks where a file is, the path is the answer, so the section allows it. A folder cannot become a
card, so it allows that too.

Only the chat that draws cards gets this: ``platform == "desktop"``, with single-thread mode on
(``APEX_SINGLE_THREAD_ACTIVE=1``) and developer mode off. A subagent has to hand the path back to its parent, and
IM, the terminal, cron, webhooks and api_server have no card. Developer mode lives in the renderer, so
electron/apex-developer-mode.ts mirrors it to a marker in the root shared by every local profile; the section
reads it whenever a prompt is built.

The id sorts after every other apex section on purpose. Sections render in id order and the ones that no longer
fit the 8,000-character budget are skipped, so with a long memory ledger and profile this one is what goes, not
single-thread mode's rules.
"""

from __future__ import annotations

import logging
from typing import Any, Mapping

from apex_overlay import single_thread_prompt

logger = logging.getLogger(__name__)

SECTION_ID = "apex.user-results"
MAX_CHARS = 1_000
DEVELOPER_MODE_MARKER = ("apex", "developer-mode")

RESULT_DELIVERY_RULES = (
    "本机文件用单独一行的 MEDIA:绝对路径 交付，界面会把它变成结果卡片，用户在卡片上就能看、下载、打开所在位置。同一个文件只放一次。",
    "除了这一行，回复里不写本机路径：不加「文件路径：…」「保存在…」这样的行，提到文件时说文件名或「这条成片」。"
    "平台规则或技能要你给路径、列出路径时，同样用 MEDIA: 这一行。",
    "用户问文件在哪、要路径，或者要你写一条用到路径的命令时，照实写完整路径。交付的是文件夹（变不成卡片）时，也写它的路径。",
)

RESULT_DELIVERY_PROMPT = "【怎么交付文件 · 平台规则】\n" + "\n".join(f"- {rule}" for rule in RESULT_DELIVERY_RULES)


def developer_mode() -> bool:
    from hermes_constants import get_default_hermes_root

    return get_default_hermes_root().joinpath(*DEVELOPER_MODE_MARKER).exists()


def render_section(session_info: Mapping[str, Any] | None = None) -> str:
    """The fixed section in product mode's chat, else "" (the runtime then adds none)."""
    if (session_info or {}).get("platform") != "desktop":
        return ""
    if not single_thread_prompt.switch_on() or developer_mode():
        return ""
    return RESULT_DELIVERY_PROMPT


def apply(ctx: Any) -> bool:
    """Register the section on this plugin's context. Idempotent per plugin manager."""
    register = getattr(ctx, "register_system_prompt_section", None)
    if register is None:
        logger.warning("apex-overlay: this plugin host cannot register system prompt sections")
        return False
    try:
        register(SECTION_ID, render_section, max_chars=MAX_CHARS)
    except ValueError as exc:
        logger.warning("apex-overlay: result delivery prompt section not registered: %s", exc)
        return False
    return True
