"""hc-1036 证据等级和交付诚实: the rules a cloud agent carries, in every Desktop session.

A cloud agent gets these sentences in its config.yaml system prompt (apex-nodes
``app/services/agent_behavior_policy.py``, ``HONESTY_RULES``). APEX Desktop never
receives that prompt, so this seam adds the same sentences as a plugin system-prompt
section; apex-nodes CI compares the two tuples word for word.

Desktop only, by the one Desktop test the platform tools already use
(``plugins/apexnodes_gateway._is_desktop``: ``HERMES_DESKTOP`` on the dashboard spawn,
or the managed provider entry a signed-in Desktop writes, which the messaging gateway
subprocess also sees). A cloud container that runs this overlay already has the rules
in its prompt, so it gets no second copy.

The rules are also enforced where that is cheap: apexnodes-honesty-tools refuses a
skill or memory write that raises an evidence level and an unasked model switch after
a failure; apexnodes-next-steps lists paid files the reply did not show.
"""

from __future__ import annotations

import logging
from typing import Any, Mapping

logger = logging.getLogger(__name__)

SECTION_ID = "apex.honesty"
MAX_CHARS = 2_000

# Word for word apex-nodes agent_behavior_policy.HONESTY_RULES.
HONESTY_RULES = (
    "证据等级：重要结论都说清来源等级——官方(权威机构自己发布，你这次真打开过或用户给了原文，旁边写上出处)、"
    "一手(你自己拿到的原始数据或原文：打开过的页面、工具返回的数字、用户给的材料)、"
    "二手(别人的转述：搜索摘要、博主笔记、机构或自媒体文章，自称引用了官方也算二手)、"
    "推测(你自己的推断，包括拿往年的日期套今年)。✅ 只给官方和一手。",
    "等级只能照实写：回复里不能往高了写，写进技能或记忆时也不能;二手资料存进去仍标二手并写明出处。",
    "说清数据怎么来的：平台数据经第三方数据服务转接(比如「经 TikHub 拿到的抖音公开数据」)，不说「直连抖音」「抖音官方后台」。",
    "说工具用了什么、做出了什么，要和工具结果一致：结果显示只按文字生成(input_mode 是 text_only)，就不说按照片做了。",
    "花钱生成的视频、图片，这一轮结束前全部给用户看或列出路径，没用上的也列。",
    "生成或配音失败、超时后，不自己换模型、换供应商、换配音服务：先把结果告诉用户，问他换不换;同样的设置重试可以。",
    "做不到的直接说做不到(某个能力暂时不可用、工具缺你要的输入)，先交付能做的部分，不暗示做过。",
)

HONESTY_PROMPT = "【证据和交付 · 平台规则】\n" + "\n".join(f"- {rule}" for rule in HONESTY_RULES)


def on_desktop() -> bool:
    try:
        from plugins import apexnodes_gateway
    except Exception:
        logger.warning("apex-overlay: the platform gateway module is missing; no honesty section", exc_info=True)
        return False
    return apexnodes_gateway._is_desktop()


def render_section(_session_info: Mapping[str, Any] | None = None) -> str:
    """The fixed section on Desktop, else "" (the runtime then adds none)."""
    return HONESTY_PROMPT if on_desktop() else ""


def apply(ctx: Any) -> bool:
    """Register the section on this plugin's context. Idempotent per plugin manager."""
    register = getattr(ctx, "register_system_prompt_section", None)
    if register is None:
        logger.warning("apex-overlay: this plugin host cannot register system prompt sections")
        return False
    try:
        register(SECTION_ID, render_section, max_chars=MAX_CHARS)
    except ValueError as exc:
        logger.warning("apex-overlay: honesty prompt section not registered: %s", exc)
        return False
    return True
