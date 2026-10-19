"""hc-976 — Chinese IM chats get one plain sentence instead of the runtime's session banners, as a
zero-in-place overlay seam.

What changes
============
The gateway renders two banners through the i18n catalog and hands them to the adapter like any
reply:

* the auto-reset notice ``gateway.session.auto_reset_notice`` (◐ headline, ``/resume`` hint) —
  ``gateway/run_turn.py::_hmwa_deliver_auto_reset_notice`` passes it straight to
  ``adapter.send()``. It becomes ``gateway.session.auto_reset_plain_notice``, one plain sentence
  ("之前的对话已清空。" in zh) in the same language;
* the ◆ session lines of ``GatewayRunner._format_session_info()`` (``gateway.session.info_*``),
  appended to that notice and to the ``/new`` / ``/reset`` reply, which reaches ``send()`` through
  ``_send_with_retry``. They are dropped.

hc-457 dropped both for WeChat inside ``gateway/platforms/weixin.py``, in English, mirroring the
hc-451 scheduler-side sanitizer that already hid them for scheduler-routed Feishu. hc-964 made that
matcher follow the catalog. WeCom, DingTalk, QQ and in-container Feishu had no filter and sent the
banners as they were: English on pre-i18n images, the profile's language once the runtime renders
them through ``t()``. hc-976 moves the matcher here, out of the upstream file, and applies it to all
of them. Kael decided (2026-10-19) that the notice is replaced, not dropped, on WeChat too, so a
user still learns that the earlier conversation is gone.

Where
=====
Each of these adapters' own ``send()`` is the one exit both banners share. The auto-reset notice
skips ``_send_with_retry``, so the ``cn_im_messages`` choke point would miss it. Adapter modules
load lazily (bundled plugins go through the platform registry under synthetic module names), so
``apply()`` wraps ``BasePlatformAdapter.__init__`` instead: constructing an adapter for one of
these platforms wraps its class's ``send`` once. That covers every construction path: the runner's
``_create_adapter`` (registry and built-ins), reconnect recreation, and the standalone cron /
``send_message`` senders, which call ``send()`` on a throwaway adapter. Every other platform's
adapter class is left alone, and the platform is checked again on each call.

Matching (hc-457 / hc-964 rules, unchanged)
===========================================
Patterns are built from the catalog keys' templates exactly as ``t()`` resolves them for
rendering: the active language with its per-key English fallback, the profile's ``locales/``
overlay and plugin packs. A reworded banner, or a gateway switched to another language, needs no
edit here. Loading every locale at once would parse ~5 MB of YAML on the event loop, so only what
rendering has already loaded is used. A line must open with ◐/◆ and carry label text before any
``{field}``, so an agent's own ◆ bullet points survive. The notice's glyph-less continuation lines
go only together with their headline, because on their own they may be the agent explaining a real
command. The English patterns of pre-i18n runtimes (the v2026.8.31 image) run after the catalog
ones.

A message that is left empty (◆ lines alone, or a notice when the plain sentence is unavailable) is
not sent at all: it would otherwise go out as an empty Feishu text, DingTalk card or WeCom markdown.
The result is a success with no message id, which is what WeChat's ``send()`` returned for it before.

Known limit: a gateway multiplexing profiles in different languages filters with the language
active at send time. Single-profile cloud containers are not affected.

Kill switch: ``<PLATFORM>_FILTER_RUNTIME_BANNERS=false`` (for example ``FEISHU_…``; ``WEIXIN_…`` is
hc-457's) sends that platform's banners unchanged again. Idempotent (``_MARK`` + ``_APPLIED``) and fail-safe:
any filter error sends the text unfiltered. ``apply()`` returns False only if the target symbol is
missing; the seam-test turns that into a loud CI failure.
"""

from __future__ import annotations

import functools
import logging
import os
import re
import string
from functools import lru_cache
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Upstream target we monkey-patch — centralized so the seam-test pins it.
_TARGET_BASE_MODULE = "gateway.platforms.base"
_TARGET_ADAPTER_CLASS = "BasePlatformAdapter"
_TARGET_INIT_METHOD = "__init__"
_TARGET_SEND_METHOD = "send"

_APPLIED = False
_MARK = "_apex_overlay_cn_im_banners"

# Platforms whose replies never carry the runtime's session banners. In-container Feishu is
# included (Kael, 2026-10-19): it sends directly, and scheduler-routed Feishu already strips the same
# banners (hc-451). hc-401's "leave Feishu alone" was about cn_im_messages' text localization.
FILTERED_PLATFORMS = frozenset({"weixin", "wecom", "wecom_callback", "dingtalk", "qqbot", "feishu"})

# hc-457: the hardcoded English of pre-i18n runtimes. The notice was a fixed three-line template:
# a ◐ headline and two glyph-less continuation lines. A single-line pattern would leave those two
# visible, so the first pattern takes the whole known block, anchored on the literal template text
# rather than a generic "Use /xxx to …" wildcard (an agent may be explaining a real command). The
# headline-alone pattern is a net in case the continuation lines are ever dropped.
_LEGACY_NOTICE_PATTERNS = (
    re.compile(
        r"^[ \t]*◐[ \t]*Session automatically reset\b[^\n]*\n"
        r"[ \t]*Use /resume to browse and restore a previous session\.\n"
        r"[ \t]*Adjust reset timing in config\.yaml under session_reset\.[ \t]*$",
        re.MULTILINE,
    ),
    re.compile(r"^[ \t]*◐[ \t]*Session automatically reset\b.*$", re.MULTILINE),
)
_LEGACY_LINE_PATTERNS = (
    # "◆ Model: deepseek-v4-pro" / "◆ Provider: custom" / "◆ Context: 1.0M tokens", each on its own
    # line, as _format_session_info() emits them.
    re.compile(r"^[ \t]*◆[ \t]*(?:Model|Provider|Context|Session|Tokens)\s*:.*$", re.MULTILINE),
    # Other "◐ <Runtime notice>…" system banners share the glyph + capitalized-notice shape. Not
    # known to be the session reset, so they are dropped rather than replaced.
    re.compile(r"^[ \t]*◐[ \t]*[A-Z][a-zA-Z ]{2,40}(?:reset|cleared|compact|nudge)\b.*$", re.MULTILINE),
)

_NOTICE_KEYS = ("gateway.session.auto_reset_notice",)
_PLAIN_NOTICE_KEY = "gateway.session.auto_reset_plain_notice"
_LINE_KEYS = (
    "gateway.session.info_model", "gateway.session.info_provider", "gateway.session.info_context",
    "gateway.session.info_acting_model", "gateway.session.info_endpoint",
)
_GLYPHS = ("◐", "◆")


def _template_line_regex(line: str) -> Optional[str]:
    """Regex source for one line of a catalog template as ``t()`` renders it: the literal text
    escaped, each ``{field}`` any run of characters within the line. None for a malformed template."""
    try:
        parts = list(string.Formatter().parse(line.strip()))
    except ValueError:
        return None
    return "".join(re.escape(text) + (r"[^\n]*?" if field is not None else "") for text, field, _spec, _conv in parts)


def _is_banner_headline(line: str) -> bool:
    """◐/◆ followed by label text before the first field, so a template such as ``◆ {model}`` can
    never strip an agent's own ◆ bullet points."""
    stripped = line.strip()
    if not stripped.startswith(_GLYPHS):
        return False
    try:
        label = next(string.Formatter().parse(stripped[1:]), ("",))[0]
    except ValueError:
        return False
    return bool(label.strip())


def _whole_lines(source: str) -> re.Pattern[str]:
    """``source`` matching whole lines only, blanks around it included."""
    return re.compile(rf"^[ \t]*{source}[ \t]*$", re.MULTILINE)


@lru_cache(maxsize=4)
def _compile_catalog_patterns(
    notices: tuple[str, ...], lines: tuple[str, ...],
) -> tuple[tuple[re.Pattern[str], ...], tuple[re.Pattern[str], ...]]:
    """(notice patterns, line patterns). Whole notices come before their lone headlines, which would
    otherwise strand the continuation lines."""
    blocks, headlines, singles = [], [], []
    for template in notices:
        rows = template.strip("\n").split("\n")
        sources = [_template_line_regex(row) for row in rows]
        if not _is_banner_headline(rows[0]) or None in sources:
            continue
        blocks.append(r"[ \t]*\n[ \t]*".join(sources))
        if len(sources) > 1:  # the headline alone, should it ever arrive without its continuation lines
            headlines.append(sources[0])
    for template in lines:
        source = _template_line_regex(template)
        if source and "\n" not in template.strip("\n") and _is_banner_headline(template):
            singles.append(source)
    return tuple(map(_whole_lines, (*blocks, *headlines))), tuple(map(_whole_lines, singles))


def _catalog_patterns() -> tuple[tuple[re.Pattern[str], ...], tuple[re.Pattern[str], ...]]:
    """The runtime banners as the catalog renders them right now, as (notice, line) patterns.
    Compiled once per set of templates, so a language, overlay or pack change rebuilds them; empty if
    the catalog cannot be read, which leaves the English patterns alone in effect."""
    try:
        from agent.i18n import t

        notices = tuple(t(key) for key in _NOTICE_KEYS)
        lines = tuple(t(key) for key in _LINE_KEYS)
    except Exception:
        logger.debug("apex_overlay: i18n catalog unreadable; filtering English runtime banners only", exc_info=True)
        return (), ()
    return _compile_catalog_patterns(notices, lines)


def _plain_notice() -> str:
    """The sentence that replaces the auto-reset notice, in the active language; empty (the notice
    is then dropped) if the catalog cannot be read or lacks the key."""
    try:
        from agent.i18n import t

        sentence = t(_PLAIN_NOTICE_KEY)
    except Exception:
        logger.debug("apex_overlay: i18n catalog unreadable; dropping the auto-reset notice", exc_info=True)
        return ""
    return "" if sentence == _PLAIN_NOTICE_KEY else sentence


def strip_runtime_banners(text: Optional[str]) -> Optional[str]:
    """``text`` with the runtime's session banners taken out (catalog-rendered ones, then the
    pre-i18n English ones): each auto-reset notice becomes the plain sentence, the ◆ session lines go.
    Falsy text is returned as is."""
    if not text:
        return text
    catalog_notices, catalog_lines = _catalog_patterns()
    plain = _plain_notice()
    filtered = text
    stripped_count = 0
    # Catalog patterns first: the English ◐ shape net would otherwise take the reworded English
    # headline alone and strand its "Use /resume to …" line.
    for pattern in (*catalog_notices, *_LEGACY_NOTICE_PATTERNS):
        filtered, count = pattern.subn(lambda _match: plain, filtered)
        stripped_count += count
    for pattern in (*catalog_lines, *_LEGACY_LINE_PATTERNS):
        filtered, count = pattern.subn("", filtered)
        stripped_count += count
    if stripped_count:
        logger.debug("apex_overlay: filtered %d runtime banner line(s) from an outbound reply", stripped_count)
        # Collapse the blank-line runs the removed banners leave behind and trim stray leading or
        # trailing blank lines, without touching interior single blank-line paragraph breaks.
        filtered = re.sub(r"[ \t]*\n{3,}", "\n\n", filtered)
        filtered = filtered.strip("\n")
    return filtered


def _platform_key(platform: Any) -> str:
    """A Platform enum (or raw string) as its config key; for these platforms ``.value`` is it."""
    return str(getattr(platform, "value", platform) or "").lower()


def filters_platform(platform: Any) -> bool:
    """Whether replies on ``platform`` lose the runtime banners: one of FILTERED_PLATFORMS and not
    switched off by ``<PLATFORM>_FILTER_RUNTIME_BANNERS``."""
    key = _platform_key(platform)
    if key not in FILTERED_PLATFORMS:
        return False
    switch = os.environ.get(f"{key.upper()}_FILTER_RUNTIME_BANNERS", "true")
    return switch.strip().lower() in {"1", "true", "yes", "on"}


# ===========================================================================
# Monkey-patch wrappers (fail-safe: an error sends the text unfiltered)
# ===========================================================================

def _wrap_send(orig):
    """Strip the banners from ``content`` before the adapter's own ``send()`` sees it."""

    @functools.wraps(orig)
    async def send(self, chat_id, content, *args, **kwargs):
        filtered = content
        try:
            if isinstance(content, str) and filters_platform(getattr(self, "platform", None)):
                filtered = strip_runtime_banners(content)
        except Exception:
            logger.debug("apex_overlay: runtime banner filter failed; sending unfiltered", exc_info=True)
            filtered = content
        if filtered != content and not filtered.strip():
            from gateway.platforms.base import SendResult

            return SendResult(success=True)
        return await orig(self, chat_id, filtered, *args, **kwargs)

    setattr(send, _MARK, True)
    return send


def _instrument_send(adapter_cls) -> None:
    """Wrap ``adapter_cls.send`` once; a class whose ``send`` is already wrapped (its own or an
    instrumented parent's) is left as is."""
    send = getattr(adapter_cls, _TARGET_SEND_METHOD, None)
    if send is None or getattr(send, _MARK, False):
        return
    setattr(adapter_cls, _TARGET_SEND_METHOD, _wrap_send(send))


def _wrap_init(orig):
    """After the base constructor has set ``self.platform``, instrument the class of an adapter
    for one of FILTERED_PLATFORMS."""

    @functools.wraps(orig)
    def __init__(self, *args, **kwargs):
        orig(self, *args, **kwargs)
        try:
            if _platform_key(getattr(self, "platform", None)) in FILTERED_PLATFORMS:
                _instrument_send(type(self))
        except Exception:
            logger.warning(
                "apex_overlay: could not install the runtime banner filter on %s; its replies may "
                "carry the session-reset notice and the ◆ session lines.",
                type(self).__name__, exc_info=True,
            )

    setattr(__init__, _MARK, True)
    return __init__


# ===========================================================================
# Public entry point
# ===========================================================================

def apply() -> bool:
    """Install the banner filter seam onto upstream. Idempotent, fail-safe.

    Returns True when ``BasePlatformAdapter.__init__`` is wrapped (or already was), False if the
    target is missing (the seam-test turns that into a hard CI failure). Never raises into plugin
    discovery.
    """
    global _APPLIED
    if _APPLIED:
        return True

    import importlib

    try:
        base_mod = importlib.import_module(_TARGET_BASE_MODULE)
        adapter_cls = getattr(base_mod, _TARGET_ADAPTER_CLASS)
        orig_init = adapter_cls.__dict__[_TARGET_INIT_METHOD]
    except (ImportError, AttributeError, KeyError) as exc:
        logger.error(
            "apex_overlay: could not patch %s.%s.%s; the runtime's session banners will reach "
            "WeChat, WeCom, DingTalk, QQ and Feishu users. Upstream may have renamed it. (%s)",
            _TARGET_BASE_MODULE, _TARGET_ADAPTER_CLASS, _TARGET_INIT_METHOD, exc,
        )
        return False

    if not getattr(orig_init, _MARK, False):
        setattr(adapter_cls, _TARGET_INIT_METHOD, _wrap_init(orig_init))

    _APPLIED = True
    logger.debug("apex_overlay: CN-IM runtime banner filter seam applied")
    return True
