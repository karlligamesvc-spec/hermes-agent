"""hc-1046: the platform's media model catalog, as ``generate_image`` / ``generate_video`` read it.

The server serves one catalog of the image and video models a call may name, Hypit's
own models included (``catalog`` in the ``image`` / ``video`` blocks of
``/tools/v1/check``, and in ``/media/{image,video}/check`` on the legacy leg). The tools
check a model against it before a call instead of against a list built into this
client, so a model the platform adds needs no Desktop release, and the model a call
names is looked up on its own leg (``hypit:<model>`` for a Hypit model).

Which model fits which task is the assistant's call (the ``video-generation`` /
``image-generation`` skills); when the Desktop hides its model picker (tier mode and
single-thread product mode, ``apex.generation_model_choice: assistant``) the saved
picker value is the hidden default, not a choice, so it no longer overrides the
assistant's. With the picker shown (developer mode, a user's own key) the saved choice
still wins.

A server without a catalog (before hc-1046) gets every name through unchecked: it
validates the name itself.
"""

from __future__ import annotations

from typing import Any, Callable

# Who picks the model (``apex.generation_model_choice``, written by the Desktop composer).
CHOICE_KEY = "generation_model_choice"
CHOICE_ASSISTANT = "assistant"
CHOICE_USER = "user"

_LABELS = {"image": ("图片", "image"), "video": ("视频", "video")}
_COPY = {
    "unknown": (
        "平台的{label}模型目录里没有「{model}」,这次没有生成，也没有用掉额度。可以用的有：{models};"
        "不填 model 就用平台默认模型。",
        "The platform's {label} model catalog has no \"{model}\"; nothing was generated or charged. "
        "Models you can use: {models}; leave model empty for the platform default.",
    ),
    "unavailable": (
        "{reason}这次没有生成，也没有用掉额度。可以不填 model 用平台默认模型，或换成：{models}。",
        "{reason} Nothing was generated or charged. Leave model empty for the platform default, or use: {models}.",
    ),
}


def _say(key: str, media: str, english: bool, **fields: Any) -> str:
    zh, en = _COPY[key]
    return (en if english else zh).format(label=_LABELS[media][1 if english else 0], **fields)


def rows(section: Any) -> dict[str, dict[str, Any]] | None:
    """The served catalog by model id; None when the check carries none (an older server)."""
    catalog = section.get("catalog") if isinstance(section, dict) else None
    models = catalog.get("models") if isinstance(catalog, dict) else None
    if not isinstance(models, list):
        return None
    return {row["model"]: row for row in models if isinstance(row, dict) and isinstance(row.get("model"), str)}


def leg_of(section: Any, model: str) -> str:
    """The ``legs`` key a call naming ``model`` records on: the catalog row's ``leg``
    (``hypit:<model>`` for a Hypit model), else the chinaapi leg an older server lists."""
    row = (rows(section) or {}).get(model)
    leg = row.get("leg") if isinstance(row, dict) else None
    return leg if isinstance(leg, str) and leg else f"chinaapi:{model}"


def _usable(found: dict[str, dict[str, Any]]) -> str:
    names = [name for name, row in found.items() if row.get("configured") is not False]
    return "、".join(names) if names else "-"


def model_problem(
    media: str, section: Any, model: str | None, *, saved: bool, saved_unknown: str, english: bool = False
) -> str | None:
    """Why a call naming ``model`` should not start, or None to go ahead.

    This module only reads what the plugin already fetched: it holds no credential and
    makes no request, so the caller passes the user's language (``english``) in.

    ``saved``: the model came from the Desktop picker, so an id the catalog lacks reads as
    that setting being stale (``saved_unknown``), not as the assistant's typo. A model the
    catalog marks not ``configured`` with a reason of its own (a Hypit model off, not
    allowlisted) is said with that reason and the ids that work; one without (its whole
    leg switched off) is left to the leg check, which says so (``media_switched_off``)."""
    found = rows(section)
    if not model or found is None:
        return None
    row = found.get(model)
    if row is None:
        return saved_unknown if saved else _say("unknown", media, english, model=model, models=_usable(found))
    reason = str(row.get("unavailable_reason") or "").strip()
    if row.get("configured") is not False or not reason:
        return None
    if saved:
        return reason
    return _say("unavailable", media, english, reason=reason, models=_usable(found))


def assistant_picks(apex: dict[str, Any]) -> bool:
    """Is the Desktop picker hidden, so the assistant's model choice stands?"""
    return apex.get(CHOICE_KEY) == CHOICE_ASSISTANT


def read_check(read: Callable[[], Any]) -> dict[str, Any] | None:
    """One read of the leg's check block (the plugin's own reader, which already turns an
    unreadable check into None); None when it is not a block."""
    section = read()
    return section if isinstance(section, dict) else None


__all__ = [
    "CHOICE_ASSISTANT",
    "CHOICE_KEY",
    "CHOICE_USER",
    "assistant_picks",
    "leg_of",
    "model_problem",
    "read_check",
    "rows",
]
