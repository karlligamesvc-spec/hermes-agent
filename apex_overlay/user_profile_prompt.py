"""hc-991 first-use creator intake: the account's 用户画像 in every new Desktop session.

The three Start-page cards ask a new user what they make, where they publish
and what troubles them most; the answers live in the account's profile on the
cloud. A cloud agent carries the profile as a segment of ``agent.system_prompt``
(apex-nodes ``build_user_profile_prompt_for_user``). APEX Desktop's main process
mirrors that same rendered segment into ``<root>/apex/user-profile-prompt.md``
whenever the signed-in account reads or edits it, and removes the file when
the account changes or signs out (electron/apex-creator-profile.ts).

This seam registers a plugin system-prompt section that reads the file when a
new session's prompt is built, so a local agent knows the same things a cloud
agent does. The file is account-level, so it sits at the Hermes root, not in a
profile home: every local profile of this Desktop belongs to the signed-in
account. No file, no section. Cloud containers never have the file.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Mapping

logger = logging.getLogger(__name__)

SECTION_ID = "apex.user-profile"
PROMPT_RELATIVE_PATH = ("apex", "user-profile-prompt.md")
# The runtime caps one plugin section at 4,000 characters; the cloud's segment is a few hundred.
MAX_CHARS = 4_000


def prompt_path() -> Path:
    """Where Desktop mirrors the segment: the root shared by every local profile."""
    from hermes_constants import get_default_hermes_root

    return get_default_hermes_root().joinpath(*PROMPT_RELATIVE_PATH)


def render_section(_session_info: Mapping[str, Any] | None = None) -> str:
    """The mirrored segment, or "" when there is none (the runtime then adds no section)."""
    path = prompt_path()
    try:
        text = path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return ""
    except (OSError, UnicodeDecodeError) as exc:
        logger.warning("apex-overlay: could not read the user profile prompt at %s: %s", path, exc)
        return ""
    if len(text) > MAX_CHARS:
        logger.warning(
            "apex-overlay: user profile prompt at %s is %d characters (limit %d); not added",
            path,
            len(text),
            MAX_CHARS,
        )
        return ""
    return text


def apply(ctx: Any) -> bool:
    """Register the section on this plugin's context. Idempotent per plugin manager."""
    register = getattr(ctx, "register_system_prompt_section", None)
    if register is None:
        logger.warning("apex-overlay: this plugin host cannot register system prompt sections")
        return False
    try:
        register(SECTION_ID, render_section, max_chars=MAX_CHARS)
    except ValueError as exc:
        logger.warning("apex-overlay: user profile prompt section not registered: %s", exc)
        return False
    return True
