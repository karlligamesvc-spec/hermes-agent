"""hc-1065: ``vision_analyze`` answers the question it was asked, without leaking reasoning.

A 37-minute editing run on APEX Desktop (2026-10-26, model ``apex-flash``) called ``vision_analyze``
17 times. Every call took the auxiliary path, which asks a second model to "fully describe and
explain everything about this image, then answer" the question. On the relay that model is
deepseek-flash with thinking on, and five of the calls spent the whole 4,096-token output budget
(relay.log ``completion=4096``). Four came back with no answer at all, and upstream's
``extract_content_or_reasoning`` then returned the private reasoning ("We need answer Chinese…") as
if it were the answer. The fifth stopped mid-sentence and was passed on as complete. The other
twelve were long descriptions that ignored "answer only two points, briefly".

Two seams, each with a test in ``tests/apex_overlay/test_vision_answer_seam.py``. Which route an
image takes (native or auxiliary) is still upstream's decision; nothing here changes it. Sending
``apex-flash`` images natively waits for a paid check that deepseek-flash accepts an image inside a
tool result (never measured; see the hc-1065 hand-over note).

* **A direct question on the auxiliary path.** The registered ``vision_analyze`` handler keeps
  upstream's native branch and replaces only the "fully describe" prompt with one that asks for a
  short, direct answer in the configured response language.
* **No reasoning as the answer.** ``tools.vision_tools.extract_content_or_reasoning`` (a module
  attribute upstream keeps patchable) is replaced by :func:`visible_answer`, which reads only the
  message ``content`` with think blocks removed and never the ``reasoning*`` fields. When the call
  stopped on its length limit, a partial answer carries :data:`CUT_OFF_NOTE` and an empty one raises
  :class:`VisionAnswerCutOff`, which ``_run_analysis`` reports as a failed analysis. That covers
  ``video_analyze`` as well, since both go through ``_call_vision_llm``.
"""

from __future__ import annotations

import asyncio
import functools
import logging
from typing import Any, Optional

from apex_overlay import post_import

logger = logging.getLogger(__name__)

_MARK = "_apex_vision_answer"
_TARGET_VISION_MODULE = "tools.vision_tools"
_TOOL_NAME = "vision_analyze"

# finish_reason values meaning the output limit stopped the answer (OpenAI, Anthropic, Responses).
_CUT_OFF_REASONS = frozenset({"length", "max_tokens", "max_output_tokens"})

CUT_OFF_NOTE = (
    "[Cut off: the vision model hit its output limit, so this answer is incomplete. Do not treat it "
    "as complete. Ask a narrower question, or pass region to look at one part.]"
)

_ANSWER_RULES = (
    "Answer the question below about this image.\n"
    "- Answer only what the question asks. Do not describe parts of the image the question does "
    "not ask about.\n"
    "- Keep it short: a few sentences, or one short line per point when the question asks about "
    "several things. Write more only when the question asks for a full description.\n"
    "- If the image does not show enough to answer a point, say so for that point instead of "
    "guessing.\n"
    "- Start with the answer itself: no preamble, no remarks about these instructions.\n"
)
_NO_QUESTION = "Say briefly what this image shows."


class VisionAnswerCutOff(RuntimeError):
    """The vision call stopped on its output limit before writing any answer."""


def _response_language(cfg: Optional[dict[str, Any]]) -> str:
    """The language name ``agent.response_language`` resolves to, or ``""`` when it follows the user."""
    from hermes_cli import personality

    configured = str(personality._get(cfg, "agent", "response_language", default="auto") or "auto").strip().lower()
    if configured in {"display", "ui", "interface"}:
        configured = str(personality._get(cfg, "display", "language", default="") or "").strip().lower()
    configured = configured.replace("_", "-")
    return personality._RESPONSE_LANGUAGE_NAMES.get(
        personality._RESPONSE_LANGUAGE_ALIASES.get(configured, configured), "")


def direct_question_prompt(question: Any, cfg: Optional[dict[str, Any]] = None) -> str:
    """The auxiliary model's prompt: the answer rules, the reply language, then the question."""
    text = question.strip() if isinstance(question, str) else ""
    try:
        language = _response_language(cfg)
    except Exception:
        logger.debug("apex_overlay: response language lookup failed", exc_info=True)
        language = ""
    reply_in = f"Write the answer in {language}." if language else "Write the answer in the language of the question."
    return f"{_ANSWER_RULES}- {reply_in}\n\nQuestion: {text or _NO_QUESTION}"


def _finish_reason(response: Any) -> str:
    choices = response.get("choices") if isinstance(response, dict) else getattr(response, "choices", None)
    if not isinstance(choices, (list, tuple)) or not choices:
        return ""
    first = choices[0]
    reason = first.get("finish_reason") if isinstance(first, dict) else getattr(first, "finish_reason", None)
    return reason.strip().lower() if isinstance(reason, str) else ""


def visible_answer(response: Any, *, max_reasoning_chars: Optional[int] = None) -> str:
    """The answer the vision model wrote: ``content`` without think blocks, never a reasoning field.

    Same signature as ``extract_content_or_reasoning``; ``max_reasoning_chars`` is accepted and unused,
    because reasoning is never returned. A cut-off answer carries :data:`CUT_OFF_NOTE`; a cut-off call
    with no answer raises :class:`VisionAnswerCutOff`.
    """
    from agent.agent_runtime_helpers import strip_think_blocks
    from agent.auxiliary_client import _coerce_llm_message, _message_field

    message = _coerce_llm_message(response)
    content = message if isinstance(message, str) else _message_field(message, "content") if message else None
    text = strip_think_blocks(None, content).strip() if content else ""
    if _finish_reason(response) not in _CUT_OFF_REASONS:
        return text
    if not text:
        raise VisionAnswerCutOff(
            "the vision model used its whole output budget on private reasoning and wrote no answer "
            "(finish_reason=length). Ask a narrower question, or pass region to look at one part.")
    return f"{text}\n\n{CUT_OFF_NOTE}"


def _auxiliary_prompt(question: Any) -> str:
    """:func:`direct_question_prompt` with the live config; reads the file, so run it off the loop."""
    try:
        from hermes_cli.config import load_config
        cfg = load_config()
    except Exception:
        logger.warning("apex_overlay: config unreadable; the vision answer follows the question's language",
                       exc_info=True)
        cfg = None
    return direct_question_prompt(question, cfg)


def _wrap_handler(original, vision_tools):
    @functools.wraps(original)
    async def handler(args: dict[str, Any], **kw: Any) -> Any:
        if vision_tools._should_use_native_vision_fast_path():
            return await original(args, **kw)
        prompt = await asyncio.to_thread(_auxiliary_prompt, args.get("question", ""))
        model = vision_tools._configured_aux_model(("vision",), ("AUXILIARY_VISION_MODEL",))
        return await vision_tools.vision_analyze_tool(
            args.get("image_url", ""), prompt, model, task_id=kw.get("task_id"), region=args.get("region"))

    setattr(handler, _MARK, True)
    return handler


def _install_vision(vision_tools) -> bool:
    from tools.registry import registry

    entry = registry.get_entry(_TOOL_NAME)
    if entry is None:
        logger.error("apex_overlay: %s is not registered; its prompt and answer seam is not active", _TOOL_NAME)
        return False
    if not getattr(entry.handler, _MARK, False):
        entry.handler = _wrap_handler(entry.handler, vision_tools)
    vision_tools.extract_content_or_reasoning = visible_answer
    return True


def apply() -> bool:
    """Arm both seams. Idempotent, fail-safe, and never imports ``tools.vision_tools`` (hc-989): the
    patch runs as soon as that module has been imported, or now when it already has been."""
    return post_import.when_imported(_TARGET_VISION_MODULE, _install_vision)
