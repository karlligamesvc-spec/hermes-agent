"""The ``@file:`` / ``@folder:`` / ``@image:`` tokens a user row carries for its attachments.

A path that opens or closes a line is an attachment, not the user's words, so a session's name (auto title,
list preview) skips it: "@file:`Desktop/…` 这是…" is named 这是…, and the Desktop's
``caption\\n@image:`…``` (tui_gateway ``_build_persist_message_with_image_refs``) is named by its caption.
An inline reference reads as part of the sentence ("Review @file:notes.txt and fix…") and stays. The value
shape mirrors the canonical ``agent.context_references`` one; kept dependency-free so the titler and the
session store can share it without importing the context-reference machinery (circularity / startup
cost, #92068).
"""

import re

_QUOTED = r"(?:`[^`\n]+`|\"[^\"\n]+\"|'[^'\n]+')"
_KINDS = r"(?<![\w/])@(?:file|folder|image):"
# A quoted (space-bearing) path may carry a ``:start[-end]`` line-range suffix; a bare path swallows its own
# range via ``\S+``.
_TOKEN = rf"{_KINDS}(?:{_QUOTED}(?::\d+(?:-\d+)?)?|\S+)"
ATTACHMENT_REF_TOKEN_RE = re.compile(_TOKEN)
# At a line's end, also a quote that never closes: a list preview is cut after a fixed number of characters,
# often inside "@image:`/Users/…/Application Support/…".
_LEADING_RE = re.compile(rf"^\s*(?:{_TOKEN}\s*)+")
_TRAILING_RE = re.compile(rf"(?:\s*{_KINDS}(?:{_QUOTED}(?::\d+(?:-\d+)?)?|[`\"'][^`\"'\n]*|\S+))+\s*$")


def without_attachment_refs(text: str) -> str:
    """*text* without the attachment paths that open or close each line; whitespace collapsed within lines."""
    return "\n".join(" ".join(_TRAILING_RE.sub("", _LEADING_RE.sub("", line)).split())
                     for line in (text or "").splitlines())
