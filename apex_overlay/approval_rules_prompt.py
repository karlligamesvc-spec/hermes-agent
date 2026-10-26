"""hc-1034: how a local APEX agent checks the machine, and what it does when approval does not come.

APEX Desktop runs with manual approvals (electron/apex-managed.ts): a dangerous command, and every
execute_code script, waits for the user's click. On a user's Desktop (2026-10-22) a read-only
check bundled into one shell line with ``python3 -c`` waited five minutes and came back BLOCKED;
the agent then ran the same check as an execute_code script (five more minutes) and later as a
shell line without ``-c``, without telling the user what it was waiting for.

The engine now lets a whole-command read-only probe through (tools/approval_probe.py) and holds
equivalent operations after a denial or an unanswered prompt (tools/approval_hold.py). This
section tells the model the two habits that make that work: one simple command per check, and
stop and say what is waiting instead of trying another route. With approvals off (cloud agents
in native mode) nothing waits on a click, so there is no section.
"""

from __future__ import annotations

import logging
from typing import Any, Mapping

logger = logging.getLogger(__name__)

SECTION_ID = "apex.approval-rules"
MAX_CHARS = 1_000

APPROVAL_RULES_PROMPT = """【需要批准的操作 · 平台规则】
- 只想确认环境（某个程序或 Python 包有没有装、是什么版本）时，一次只发一条简单命令，例如 `command -v ffmpeg`、`python3 -c "import PIL; print(PIL.__version__)"`。这样的只读检查不用等用户批准；用管道、重定向、`;`、`&&` 或循环把它们拼在一起，就会弹出批准。
- 用户拒绝了某个操作，或者批准请求没人回应时：不要换工具、换写法或写成脚本去做同一件事。先做不依赖它的部分，然后用一句白话告诉用户在等他批准什么、为什么，等他回复再继续。"""


def render_section(_session_info: Mapping[str, Any] | None = None) -> str:
    """The rules unless approvals are off, else "" (the runtime then adds no section)."""
    try:
        from tools.approval_context import _get_approval_mode

        mode = _get_approval_mode()
    except Exception:
        logger.debug("apex-overlay: approval mode unreadable; keeping the approval rules", exc_info=True)
        mode = "manual"
    return "" if mode == "off" else APPROVAL_RULES_PROMPT


def apply(ctx: Any) -> bool:
    """Register the section on this plugin's context. Idempotent per plugin manager."""
    register = getattr(ctx, "register_system_prompt_section", None)
    if register is None:
        logger.warning("apex-overlay: this plugin host cannot register system prompt sections")
        return False
    try:
        register(SECTION_ID, render_section, max_chars=MAX_CHARS)
    except ValueError as exc:
        logger.warning("apex-overlay: approval rules prompt section not registered: %s", exc)
        return False
    return True
