"""hc-1071 主动问、主动提: when APEX asks first, what it offers after a result.

Single-thread mode (hc-1015's ``apex.single-thread`` section) tells APEX to say
what it will do and get on with it. On its own that reads as "never ask": a
37-minute editing session on 10-26 picked the music and the closing contact line
itself and ended with a paragraph of suggestions instead of buttons. The skills
that carry an intake question and a 「下一步」 block only help when the session
loaded them, and loaded a current copy (that Desktop's skills had stopped
updating weeks earlier). These rules ship with the engine instead:

- ask with a clarify card before starting when a fact only the user knows is
  missing and a wrong guess means redoing or paying twice; decide small things
  yourself and say so; one question per card, two at most before starting;
- end every delivered result with an apex-next/1 block (2–3 options, the most
  likely one first: the single-thread chat fills the first button);
- after a finished piece (成片, 发布包, a whole report) offer one follow-on job
  as a question, with 「做吧」「先不用」, and start it only on a yes;
- in IM the card and the buttons arrive as numbers, so never number by hand.

The renderers already exist: the Desktop clarify card, the next-step row
(components/assistant-ui/next-steps.tsx, first button filled under
``[data-single-thread-chat]``), the gateway's numbered clarify fallback and
apexnodes-next-steps' numbered block. This section only decides when to use them.

Same switch as hc-1015 (``APEX_SINGLE_THREAD_ACTIVE=1``, set by Desktop's main
process at launch): no switch, no section, so a Desktop with single-thread mode
off and every cloud container build the prompt they built before. Subagents, cron
runs, webhooks and api_server sessions get none either: nobody there can answer a
card or click a button. Cloud IM agents
get the same rules from apex-nodes ``app/services/im_question_reply_only.py``
(``PROACTIVE_RULES``, inside the hc-1018 section); apex-nodes CI compares the two
tuples word for word.
"""

from __future__ import annotations

import logging
from typing import Any, Mapping

from apex_overlay import single_thread_prompt

logger = logging.getLogger(__name__)

SECTION_ID = "apex.proactive"
MAX_CHARS = 2_000
# Same set as apexnodes-next-steps' NON_INTERACTIVE_PLATFORMS.
NON_INTERACTIVE_PLATFORMS = frozenset({"api_server", "cron", "webhook", "subagent"})

# Word for word apex-nodes im_question_reply_only.PROACTIVE_RULES.
PROACTIVE_RULES = (
    "缺关键信息先问再开工：关键信息是只有用户自己知道、定错了要返工或白花钱的事，比如发在哪个平台、多长、"
    "真人出镜还是 AI 口播、用谁的声音、配不配音乐、结尾放不放联系方式。能从上文、画像或记忆里看出来的，"
    "用户说过「直接做」「别问我」的，还有字体、转场这类小事，不问，自己定，回复里一句话说明按什么做的；"
    "定时任务、子任务这类没人能回答的时候也一样。",
    "用提问卡问（clarify）：一张卡一个问题，2–4 个短选项，第 1 项放你的默认做法；问用户自己的情况或口味时"
    "不标推荐（recommended=false）。用户也能直接打字回答。问题只写在卡上，正文不重复问题和选项。"
    "开工前最多问两题，问完就开做，不要每件事都问。没有提问卡（工具不在，或结果是 undelivered）时，"
    "把选项编号写在回复最后，请用户回编号，这一轮到此为止。",
    "每交付一个结果（脚本、方案、样片、成片、分析、文案、改好的文件），回复最后加一个「下一步」块，"
    "给 2–3 个用户最可能接着做的事，第 1 项放最可能点的那个，界面上它是主按钮：\n"
    "<!-- apex:next\n"
    "出整条 | 样片可以，出整条成片\n"
    "换个声音 | 配音换个声音再出一版\n"
    "开头再快点 | 开头节奏再快一点，重出样片\n"
    "-->\n"
    "每行左边是按钮上的字，动词开头，8 个字以内；右边是用户点了以后替他发出的那句话，用用户的口吻写清对哪个结果做什么。"
    "块后面不再写字。在等用户回答、只是闲聊或没交付东西时不加；失败或只做出一部分时只写 "
    "<!-- apex:next failed=卡住的那一步 -->。技能里写了常用的下一步，就从里面挑。",
    "交付成片、发布包、整份报告这类最终成果后，主动提一件你能接着做的事：挑用户最可能用得上的一件"
    "（比如他说过也发小红书，就问「要不要我顺手把小红书版做了？竖图加笔记文案。」），正文最后用一句话问。"
    "这时下一步块只放两项：「做吧 | 好，把小红书版也做了」和「先不用 | 先不用，就到这」。"
    "用户点了「做吧」或说要，才开始做，不要先做；一次只提一件，用户说不用，就不再提同一件。",
    "在微信、企微、钉钉、QQ、飞书这些聊天软件里，提问卡和下一步按钮会自动变成编号，用户回数字就行："
    "照上面写，不用自己编号，也不写「点下面的按钮」。",
)

PROACTIVE_PROMPT = "【APEX 主动问、主动提 · 平台规则】\n" + "\n".join(f"- {rule}" for rule in PROACTIVE_RULES)


def render_section(session_info: Mapping[str, Any] | None = None) -> str:
    """The fixed section while single-thread mode is on, else "" (the runtime then adds none).

    A session nobody can answer (subagents, cron, webhooks, api_server: the platforms
    apexnodes-next-steps strips blocks for) gets none either: it should not stop to ask.
    """
    if (session_info or {}).get("platform") in NON_INTERACTIVE_PLATFORMS:
        return ""
    return PROACTIVE_PROMPT if single_thread_prompt.switch_on() else ""


def apply(ctx: Any) -> bool:
    """Register the section on this plugin's context. Idempotent per plugin manager."""
    register = getattr(ctx, "register_system_prompt_section", None)
    if register is None:
        logger.warning("apex-overlay: this plugin host cannot register system prompt sections")
        return False
    try:
        register(SECTION_ID, render_section, max_chars=MAX_CHARS)
    except ValueError as exc:
        logger.warning("apex-overlay: proactive prompt section not registered: %s", exc)
        return False
    return True
