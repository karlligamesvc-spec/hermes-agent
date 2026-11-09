"""hc-1192: session titles follow the interface language, and a remote custom route titles at turn start.

Four patches on ``agent.title_generator``, armed with ``post_import.when_imported`` so plugin discovery
never imports it. ``agent/turn_context.py`` (the one turn-start entry for Desktop, CLI and the IM gateway)
imports the module at call time, and the module reads each patched name as a global at call time, so
every title path sees them. Upstream files stay untouched.

* **Title language** (``_title_language``). Upstream reads only ``auxiliary.title_generation.language``;
  empty means "the language of the user's message", so an opener of just "halo" on a Chinese APEX Desktop
  got an Indonesian title. With that key empty the title now follows ``agent.response_language`` through
  ``hermes_cli.personality.response_language_name``, the resolver the system prompt uses: APEX Desktop
  writes ``response_language: display``, so titles are in the interface language. A configured title
  language still wins; ``auto`` (the cloud default) still follows the user.
* **Greeting placeholder** (``_LANGUAGE_RULE_PINNED``, ``generate_title``, ``_is_provisional_greeting_title``).
  A bare greeting is titled "Friendly greeting", which ``auto_title_session`` stores at ``derived``
  authority so the first real request renames the session. Upstream recognises only the English phrase:
  with the language pinned, the model wrote 「友好问候」 and it was stored as ``llm``, final. The pinned
  language rule now tells the model that a bare greeting is always exactly that English placeholder (one
  fixed placeholder, which upstream's check already recognises); ``generate_title`` then returns it in the
  title language (:data:`GREETING_PLACEHOLDERS`) so the sidebar never shows English on a Chinese Desktop.
  ``_is_provisional_greeting_title`` also accepts those and a few close wordings
  (:data:`GREETING_PLACEHOLDER_VARIANTS`), for a model that translates the placeholder anyway and for an
  opener titled in the user's own language (``auto``).
* **When the model title starts** (``title_upgrade_must_wait_for_turn``). Upstream holds the title call
  until the turn ends for every ``custom`` / ``custom:<name>`` route, because a self-hosted single-slot
  server can decode the title request into the turn's reply (upstream #117296). APEX's managed route is
  ``custom`` with ``base_url`` on the remote relay, so through a long first turn the sidebar showed the
  pasted text. A custom route now waits only when its ``base_url`` is on this machine or the local network
  (:func:`is_local_endpoint`); LM Studio, ``local`` and every rule that already starts at turn start are
  upstream's.
"""

from __future__ import annotations

import functools
import ipaddress
import logging
import re
from types import ModuleType
from typing import Any, Callable, Optional
from urllib.parse import urlsplit

from apex_overlay import post_import

logger = logging.getLogger(__name__)

_TITLE_MODULE = "agent.title_generator"
_MARK = "_apex_session_title"

# The placeholder a bare greeting is stored under, by title language (the English names
# ``response_language_name`` returns): the interface languages APEX Desktop offers
# (apps/desktop/src/i18n/languages.ts). Any other language keeps upstream's English placeholder.
GREETING_PLACEHOLDERS = {
    "English": "Friendly greeting",
    "Simplified Chinese": "友好问候",
    "Traditional Chinese": "友好問候",
    "Japanese": "挨拶",
    "Arabic": "تحية ودية",
}

# Other wordings of the same placeholder: a model that translates it anyway, or titles a bare greeting in
# the user's own language. Exact matches only (after the wrapper strip upstream uses), so a topical title
# that merely contains one of them ("问候邮件怎么写") keeps its rank.
GREETING_PLACEHOLDER_VARIANTS = frozenset({
    "友好的问候", "问候", "打招呼", "简单问候", "日常问候", "寒暄",
    "友好的問候", "問候", "簡單問候", "日常問候",
    "あいさつ", "フレンドリーな挨拶", "友好的な挨拶",
    "تحية",
})

_PLACEHOLDER_KEYS = frozenset(
    title.lower() for title in (*GREETING_PLACEHOLDERS.values(), *GREETING_PLACEHOLDER_VARIANTS))

# Host names that only resolve on this machine or the local network (RFC 6761 / 6762 / 8375 and the
# common private suffixes); ``.ts.net`` is Tailscale MagicDNS, whose names point at 100.64.0.0/10 peers.
_LOCAL_HOST_SUFFIXES = (
    ".localhost", ".local", ".lan", ".internal", ".intranet", ".home", ".home.arpa", ".localdomain",
    ".corp", ".ts.net",
)


def _strip_wrappers(title: str) -> str:
    """Upstream's ``_is_provisional_greeting_title`` normalisation: outer punctuation off, lower case."""
    return re.sub(r"^[\W_]+|[\W_]+$", "", title.strip(), flags=re.UNICODE).lower()


def is_greeting_placeholder(title: str) -> bool:
    """A localised greeting placeholder (any language in the tables above)."""
    return isinstance(title, str) and _strip_wrappers(title) in _PLACEHOLDER_KEYS


def is_local_endpoint(base_url: str) -> bool:
    """True unless ``base_url``'s host is a public address or public DNS name.

    Local: loopback, private, link-local, CGNAT (Tailscale) and every other non-global address, a
    single-label host (``gpu-box``, a Docker service), a local suffix, and anything without a readable
    host (an endpoint we cannot place stays on upstream's safe side). A public name is not resolved: a
    title start must not wait on DNS.
    """
    text = (base_url or "").strip()
    try:
        host = (urlsplit(text if "://" in text else f"//{text}").hostname or "").rstrip(".")
    except ValueError:
        return True
    if not host:
        return True
    try:
        address = ipaddress.ip_address(host.split("%", 1)[0])
    except ValueError:
        return "." not in host or host.endswith(_LOCAL_HOST_SUFFIXES)
    mapped = getattr(address, "ipv4_mapped", None)
    return not (mapped or address).is_global


def _follow_response_language(original: Callable[[], str]) -> Callable[[], str]:
    @functools.wraps(original)
    def title_language() -> str:
        configured = original()
        if configured:
            return configured
        try:
            from hermes_cli.config import load_config_readonly
            from hermes_cli.personality import response_language_name

            return response_language_name(load_config_readonly())
        except Exception:
            logger.debug("apex-overlay: response language unreadable; the title follows the user", exc_info=True)
            return ""

    return title_language


def _recognise_localised_placeholder(original: Callable[[str], bool]) -> Callable[[str], bool]:
    @functools.wraps(original)
    def is_provisional_greeting_title(title: str) -> bool:
        return original(title) or is_greeting_placeholder(title)

    return is_provisional_greeting_title


def _placeholder_in_title_language(original: Callable[..., Optional[str]], module: ModuleType):
    @functools.wraps(original)
    def generate_title(*args: Any, **kwargs: Any) -> Optional[str]:
        title = original(*args, **kwargs)
        if not title or not module._is_provisional_greeting_title(title):
            return title
        return GREETING_PLACEHOLDERS.get(module._title_language(), title)

    return generate_title


def _remote_custom_route_starts_now(original: Callable[[Optional[dict]], bool]):
    @functools.wraps(original)
    def title_upgrade_must_wait_for_turn(main_runtime: Optional[dict]) -> bool:
        if not original(main_runtime):
            return False
        runtime = main_runtime or {}
        try:
            from hermes_cli.providers import normalize_provider

            provider = normalize_provider(str(runtime.get("provider") or "").strip().lower())
        except Exception:
            logger.debug("apex-overlay: provider unreadable; the title waits for the turn", exc_info=True)
            return True
        if provider != "custom" and not provider.startswith("custom:"):
            return True
        return is_local_endpoint(str(runtime.get("base_url") or ""))

    return title_upgrade_must_wait_for_turn


def _greeting_rule(module: ModuleType) -> Optional[str]:
    """Upstream's pinned-language rule plus the fixed greeting placeholder, or None when either is gone."""
    rule = getattr(module, "_LANGUAGE_RULE_PINNED", None)
    examples = getattr(module, "_PROMPT_GOOD_EXAMPLES", ())
    key = getattr(module, "_PROVISIONAL_GREETING_TITLE", None)
    placeholder = next((t for t in examples if isinstance(t, str) and t.lower() == key), None)
    if not isinstance(rule, str) or "{language}" not in rule or not placeholder:
        return None
    pinned = rule + (
        " The one exception is an opener that is only a greeting, with no topic yet: its title is always "
        '{"title": "' + placeholder + '"}, word for word, in English.'
    ).replace("{", "{{").replace("}", "}}")
    try:
        pinned.format(language="English")
    except (IndexError, KeyError, ValueError):
        return None
    return pinned


_TARGETS = ("_title_language", "_is_provisional_greeting_title", "generate_title", "title_upgrade_must_wait_for_turn")


def _install(module: ModuleType) -> bool:
    if getattr(module, _MARK, False):
        return True
    rule = _greeting_rule(module)
    if rule is None or not all(callable(getattr(module, name, None)) for name in _TARGETS):
        logger.error("apex-overlay: agent.title_generator no longer has the title language, greeting placeholder "
                     "or turn-wait gate this seam patches")
        return False
    module._LANGUAGE_RULE_PINNED = rule
    module._title_language = _follow_response_language(module._title_language)
    module._is_provisional_greeting_title = _recognise_localised_placeholder(module._is_provisional_greeting_title)
    module.generate_title = _placeholder_in_title_language(module.generate_title, module)
    module.title_upgrade_must_wait_for_turn = _remote_custom_route_starts_now(module.title_upgrade_must_wait_for_turn)
    setattr(module, _MARK, True)
    return True


def apply() -> bool:
    return post_import.when_imported(_TITLE_MODULE, _install)
