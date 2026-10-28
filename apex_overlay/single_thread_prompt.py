"""hc-1015 「只有问题和回复」: how APEX talks in single-thread mode.

Kael 2026-10-21 decided APEX Desktop becomes one person in one conversation
(``desktop_features.single_thread``, off by default, internal accounts first).
The chat then shows only the question and the answer: the turn's work is one
activity line and a folded 「看过程」 (apps/desktop single-thread-process.tsx).
That only works if the answer itself does not narrate the machinery, so this
seam adds a fixed prompt section to every new local session while the switch
is on: no tool, skill or model names, one question at most with a default,
the name APEX unless the user renamed it, and confirmations kept.

Desktop's main process settles the switch (hc-1014's platform flag or this
install's own APEXNODES_SINGLE_THREAD) into its own output variable
``APEX_SINGLE_THREAD_ACTIVE=1`` at launch, before the engine spawns
(electron/apex-single-thread.ts). No variable, no section: cloud containers
never set it, and a Desktop with the switch off builds exactly the prompt it
built before. The engine does not know the renderer's developer mode, so the
rules stay on there too; developer mode only adds technical detail on screen.

hc-1082: with several assistants on (``APEX_MULTI_BOT_ACTIVE=1``), the name
line is replaced by apex_overlay/assistant_name.py's lines: this assistant's
stored name, renaming through its tool, and the shared memory ledger. Without
that variable the section is ``SINGLE_THREAD_PROMPT`` as before.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Mapping

logger = logging.getLogger(__name__)

SECTION_ID = "apex.single-thread"
SWITCH_ENV = "APEX_SINGLE_THREAD_ACTIVE"
MAX_CHARS = 2_000

NAME_RULE = "- 你叫 APEX。用户给你改了名字（比如「以后叫你小李」），就用新名字称呼自己，并把这个名字记进记忆，以后一直用；被问名字时报最新的那个。"

SINGLE_THREAD_PROMPT = f"""【APEX 怎么说话 · 平台规则】
{NAME_RULE}
- 只说用户关心的事和结果。不说工具名、技能名、模型名、参数名和任何内部代号，不报「第几步」，不说「调用了…」「加载技能…」「走…流程」。做事的过程界面会自己显示；真要提，用一句人话带过，比如「我先把视频下载下来听一遍」。
- 信息够了再开工：开工前先用一句话说你要做什么、大概多久，然后直接做。
- 一次最多问一个问题，并给出你的默认做法，比如「我先按 45 秒口播写，不对你说」。
- 不提模型、档位和思考了多久。用户问你用的什么模型，就说由 APEX 平台按要做的事安排。
- 删文件、花钱、对外发布、改系统设置这类操作照常先问，不能跳过；问的时候用一句白话说清要做什么、会有什么后果。"""


def switch_on() -> bool:
    return os.environ.get(SWITCH_ENV, "").strip() == "1"


def render_section(session_info: Mapping[str, Any] | None = None) -> str:
    """The section while the switch is on, else "" (the runtime then adds none)."""
    if not switch_on():
        return ""
    # Imported here: apex-nodes loads this file on its own to compare the shared rules (tests/test_hc1018_*).
    from apex_overlay import assistant_name

    name_rules = assistant_name.name_rules(session_info)
    return SINGLE_THREAD_PROMPT.replace(NAME_RULE, name_rules, 1) if name_rules else SINGLE_THREAD_PROMPT


def apply(ctx: Any) -> bool:
    """Register the section on this plugin's context. Idempotent per plugin manager."""
    register = getattr(ctx, "register_system_prompt_section", None)
    if register is None:
        logger.warning("apex-overlay: this plugin host cannot register system prompt sections")
        return False
    try:
        register(SECTION_ID, render_section, max_chars=MAX_CHARS)
    except ValueError as exc:
        logger.warning("apex-overlay: single-thread prompt section not registered: %s", exc)
        return False
    return True
