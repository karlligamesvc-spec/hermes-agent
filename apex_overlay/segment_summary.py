"""hc-1218: the summary carried into a new segment of Desktop's one thread records results, not recipes.

In Desktop's single-thread product mode (hc-1014) a new local day, six idle hours, 「从头来」 and ``/new`` do not
open a new conversation. The composer middleware (``apps/desktop/src/app/single-thread/composer-middleware.ts``)
calls ``session.compress``: the engine folds the previous segment into a summary and the thread goes on from it.
That summary is the upstream checkpoint summary, written for a context window that filled up in the middle of a
task: tools used, parameters, decisions, exact values. Carried across a segment boundary, it brought an earlier
task's approach into a new task of the same kind as if it were a requirement (2026-11-08, a short video made
again as panned stills without a voice-over). hc-1185 fixed the same problem in the memory ledger.

The Desktop marks a boundary compression by starting its focus topic with :data:`MARKER` (the same constant
as ``SEGMENT_SUMMARY_MARKER`` in the composer middleware; a test reads both). With the single-thread switch on
(``APEX_SINGLE_THREAD_ACTIVE=1``, see ``single_thread_prompt``), such a compression gets two changes:

* **Summarizer rules** (``ContextCompressor._build_summary_prompt``). The focus block is replaced by
  :data:`BOUNDARY_RULES`: record what was delivered and what is still pending, not how it was done (no tool or
  model names, shot counts, how it was cut, 「没加配音」); keep preferences the user stated, attributed to the
  user. Upstream's own auto focus (the latest user turns, kept "in full detail") is dropped too, since that is
  exactly the old task's approach.
* **Header** (``ContextCompressor._assemble_compressed``). The summary body opens with :data:`HEADER`, one
  plain-Chinese line in the spirit of hc-1185's ledger header: what follows records what was done before, not
  this request's requirements; a new task of the same kind re-confirms per its skill. It sits after
  ``SUMMARY_PREFIX``, so every upstream check that recognises a handoff by its prefix still does. A
  deterministic fallback summary (the summary model failed) gets it too.

``ContextCompressor._strip_summary_prefix`` also drops the header, wherever it runs and with the switch off,
so the body read back from a carried summary (the next compression's previous summary, a rehydrated handoff
after the engine restarted) never feeds the line back into the summarizer: the next boundary has exactly one
header, and a mid-task compression later in the segment never inherits it.

What does not change: a compression without the marker (the automatic one when the context window fills,
``/compress`` typed by hand, the IM gateway, every cloud container, which never sets the switch) and a
compression with the marker while the switch is off run upstream's code unchanged. A plugin context engine
(not ``ContextCompressor``) is not touched. The memory ledger (``memory_ledger``) and cloud IM are separate.

The marker travels as the focus topic because that is the one free-text field ``session.compress`` already
carries on both of its routes (in process, and ``/compress <focus>`` to a turn-isolated compute host), so no
upstream RPC contract changes. Installed with ``post_import.when_imported`` so plugin discovery never imports
``agent.context_compressor`` itself.
"""

from __future__ import annotations

import contextvars
import functools
import inspect
import logging
from types import ModuleType
from typing import Any, Callable, Optional

from apex_overlay import post_import
from apex_overlay.single_thread_prompt import switch_on

logger = logging.getLogger(__name__)

_MODULE = "agent.context_compressor"
_MARK = "_apex_segment_summary"

MARKER = "【新的一段】"

HEADER = "这段摘要记的是以前那次做成了什么、还差什么，不是这次的要求：同类的新任务照对应的技能重新确认，不照搬以前那次的做法。"

BOUNDARY_RULES = """

SEGMENT BOUNDARY: this checkpoint closes one segment of a continuing conversation (a new day, a long break, or the user starting over). The next user message after it is a NEW request, not a continuation of the work summarized here. These rules apply to every section above, the session log included, and take precedence over the template's requests for detail:
- Record RESULTS: what was delivered, made or decided, and where it is (file or project names), plus what is still pending or unfinished.
- Do NOT record HOW the work was done: no tool, skill or model names, no parameters or prompts, no shot counts, nothing about how a video was cut or edited, nothing about whether a voice-over, music or subtitles were added or left out (for example 「用了几镜」「怎么剪的」「静态图推拉」「没加配音」). Those choices belonged to that task; a new task of the same kind makes them again.
- KEEP preferences and requirements the user stated in their own words (for example 「以后都用女声」「要竖屏」), attributed to the user under "Constraints & Preferences": they belong to the user, not to that task. A choice the assistant made on its own is not a user preference.
- Never present the earlier task as something to repeat, resume, or use as the default for a similar new request."""

_BOUNDARY: contextvars.ContextVar[bool] = contextvars.ContextVar("apex_segment_boundary", default=False)


def is_segment_focus(focus_topic: Any) -> bool:
    """Is this the focus topic the Desktop sends when it opens a new segment of the one thread?"""
    return isinstance(focus_topic, str) and focus_topic.strip().startswith(MARKER)


def without_header(text: str) -> str:
    """``text`` minus a leading :data:`HEADER` line (every copy, if a summarizer repeated it)."""
    while text.startswith(HEADER):
        text = text[len(HEADER):].lstrip("\n")
    return text


def with_header(summary: str, summary_prefix: str) -> str:
    """The handoff ``summary`` with :data:`HEADER` as the first line of its body; unchanged when it does not
    start with ``summary_prefix`` (a handoff must keep its prefix first, or upstream stops recognising it)."""
    if not summary.startswith(summary_prefix):
        logger.warning("apex-overlay: a segment summary does not start with the handoff prefix; no header added")
        return summary
    body = without_header(summary[len(summary_prefix):].lstrip("\n"))
    return f"{summary_prefix}\n{HEADER}\n{body}" if body else f"{summary_prefix}\n{HEADER}"


def _argument(signature: inspect.Signature, name: str, args: tuple, kwargs: dict) -> Any:
    try:
        return signature.bind(*args, **kwargs).arguments.get(name)
    except TypeError:
        return None


def _replaced(signature: inspect.Signature, args: tuple, kwargs: dict, **values: Any) -> Optional[inspect.BoundArguments]:
    try:
        bound = signature.bind(*args, **kwargs)
    except TypeError:
        return None
    bound.arguments.update(values)
    return bound


def _mark_boundary(original: Callable[..., Any]) -> Callable[..., Any]:
    signature = inspect.signature(original)

    @functools.wraps(original)
    def compress(*args: Any, **kwargs: Any) -> Any:
        if not (switch_on() and is_segment_focus(_argument(signature, "focus_topic", args, kwargs))):
            return original(*args, **kwargs)
        token = _BOUNDARY.set(True)
        try:
            return original(*args, **kwargs)
        finally:
            _BOUNDARY.reset(token)

    setattr(compress, _MARK, True)
    return compress


def _boundary_rules(original: Callable[..., str]) -> Callable[..., str]:
    signature = inspect.signature(original)

    @functools.wraps(original)
    def _build_summary_prompt(*args: Any, **kwargs: Any) -> str:
        bound = _replaced(signature, args, kwargs, focus_topic=None) if _BOUNDARY.get() else None
        if bound is None:
            return original(*args, **kwargs)
        return original(*bound.args, **bound.kwargs) + BOUNDARY_RULES

    setattr(_build_summary_prompt, _MARK, True)
    return _build_summary_prompt


def _boundary_header(original: Callable[..., Any], summary_prefix: str) -> Callable[..., Any]:
    signature = inspect.signature(original)

    @functools.wraps(original)
    def _assemble_compressed(*args: Any, **kwargs: Any) -> Any:
        summary = _argument(signature, "summary", args, kwargs) if _BOUNDARY.get() else None
        if not isinstance(summary, str):
            return original(*args, **kwargs)
        bound = _replaced(signature, args, kwargs, summary=with_header(summary, summary_prefix))
        return original(*bound.args, **bound.kwargs) if bound is not None else original(*args, **kwargs)

    setattr(_assemble_compressed, _MARK, True)
    return _assemble_compressed


def _strip_header_too(original: Callable[[str], str]) -> Callable[[str], str]:
    @functools.wraps(original)
    def _strip_summary_prefix(summary: str) -> str:
        return without_header(original(summary))

    setattr(_strip_summary_prefix, _MARK, True)
    return _strip_summary_prefix


_TARGETS = {
    "compress": ("self", "messages", "focus_topic"),
    "_build_summary_prompt": ("self", "content_to_summarize", "focus_topic"),
    "_assemble_compressed": ("self", "summary"),
}


def unpatched(method: Any) -> Any:
    """``method`` as upstream defined it: a seam wrapper (marked :data:`_MARK`) unwrapped."""
    while getattr(method, _MARK, False):
        method = method.__wrapped__
    return method


def _targets_present(cls: type) -> bool:
    for name, params in _TARGETS.items():
        method = cls.__dict__.get(name)
        if not callable(method) or not set(params) <= set(inspect.signature(method).parameters):
            return False
    return isinstance(cls.__dict__.get("_strip_summary_prefix"), staticmethod)


def _install(module: ModuleType) -> bool:
    if getattr(module, _MARK, False):
        return True
    cls = getattr(module, "ContextCompressor", None)
    prefix = getattr(module, "SUMMARY_PREFIX", None)
    if not isinstance(cls, type) or not isinstance(prefix, str) or not _targets_present(cls):
        logger.error("apex-overlay: agent.context_compressor no longer has the compress, summary prompt, "
                     "assembly or prefix-strip methods the segment summary seam patches")
        return False
    cls.compress = _mark_boundary(cls.__dict__["compress"])
    cls._build_summary_prompt = _boundary_rules(cls.__dict__["_build_summary_prompt"])
    cls._assemble_compressed = _boundary_header(cls.__dict__["_assemble_compressed"], prefix)
    cls._strip_summary_prefix = staticmethod(_strip_header_too(cls.__dict__["_strip_summary_prefix"].__func__))
    setattr(module, _MARK, True)
    return True


def apply() -> bool:
    return post_import.when_imported(_MODULE, _install)
