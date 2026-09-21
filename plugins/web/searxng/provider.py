"""SearXNG search via a user-hosted instance (``/search?format=json``).

Search-only — SearXNG aggregates upstream engines but does not fetch URLs.
Env: ``SEARXNG_URL=http://localhost:8080``.
"""

from __future__ import annotations

import logging
from typing import Any, Dict
from urllib.parse import urlparse

from plugins.web._common import BaseWebSearchProvider, provider_env, search_fail, search_ok, setup_schema, titled_rows

logger = logging.getLogger(__name__)


def _searxng_url() -> str:
    """Return the config-aware SearXNG endpoint."""
    return provider_env("SEARXNG_URL").strip()


def _searxng_api_key() -> str:
    """Return the optional APEX gateway credential."""
    return provider_env("SEARXNG_API_KEY").strip()


def _requires_platform_key(url: str) -> bool:
    """APEX gateway URLs require auth; ordinary self-hosted SearXNG stays keyless."""
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    host = (parsed.hostname or "").lower().rstrip(".")
    path = (parsed.path or "").lower().rstrip("/")
    return (
        host == "apex-nodes.com"
        or host.endswith(".apex-nodes.com")
        or "/api/v1/search/searxng" in path
    )


class SearXNGWebSearchProvider(BaseWebSearchProvider):
    """Search via a user-hosted SearXNG instance."""

    NAME = "searxng"
    DISPLAY_NAME = "SearXNG"
    KEY_ENV = "SEARXNG_URL"

    def is_available(self) -> bool:
        url = _searxng_url()
        return bool(url) and (
            not _requires_platform_key(url) or bool(_searxng_api_key())
        )

    def search(self, query: str, limit: int = 5) -> Dict[str, Any]:
        import httpx

        base_url = _searxng_url().rstrip("/")
        if not base_url:
            return search_fail("SEARXNG_URL is not set")

        api_key = _searxng_api_key()
        if _requires_platform_key(base_url) and not api_key:
            return search_fail("ApexNodes 搜索凭据缺失，请重新登录后再试")

        headers = {"Accept": "application/json"}
        if api_key:
            headers["X-API-Key"] = api_key
        try:
            response = httpx.get(
                f"{base_url}/search",
                params={"q": query, "format": "json", "pageno": 1},
                headers=headers,
                timeout=15,
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            logger.warning("SearXNG HTTP error: %s", exc)
            status = exc.response.status_code
            messages = {
                401: "ApexNodes 搜索凭据无效或已过期，请重新登录",
                403: "ApexNodes 账号尚未激活，暂时无法使用联网搜索",
                429: "联网搜索超过频率上限，请稍后再试",
            }
            return search_fail(messages.get(status, f"SearXNG returned HTTP {status}"))
        except httpx.RequestError as exc:
            logger.warning("SearXNG request error: %s", exc)
            return search_fail(f"Could not reach SearXNG at {base_url}: {exc}")

        try:
            data = response.json()
        except Exception as exc:  # noqa: BLE001
            logger.warning("SearXNG response parse error: %s", exc)
            return search_fail("Could not parse SearXNG response as JSON")

        raw_results = data.get("results", [])
        # SearXNG may return a score field; sort descending and cap to limit.
        sorted_results = sorted(raw_results, key=lambda r: float(r.get("score", 0)), reverse=True)[:limit]
        web_results = titled_rows(sorted_results, "content")
        logger.info("SearXNG search '%s': %d results (from %d raw, limit %d)", query, len(web_results), len(raw_results), limit)
        return search_ok(web_results)

    def get_setup_schema(self) -> Dict[str, Any]:
        return setup_schema(
            "SearXNG", "free · self-hosted", "Free, privacy-respecting metasearch. Point SEARXNG_URL at your instance.",
            "SEARXNG_URL", "SearXNG instance URL (e.g. http://localhost:8080)", "https://searx.space/",
        )


# ---- BEGIN PLUGIN-COMPAT (revert-scheduled; see COMPAT_MANIFEST.md) ----
# Names external plugins imported from this module before the Sep 2026 decomposition.
# Internal code MUST NOT use these (scripts/check_compat_pointers.py fails CI if it does).
# The whole block is removed by reverting the commit that added it.
import os  # noqa: F401,E402


_PLUGIN_COMPAT_LAZY = {
    'WebSearchProvider': ('agent.web_search_provider', 'WebSearchProvider'),
}


def __getattr__(name):  # PEP 562 — lazy so no import cycles
    target = _PLUGIN_COMPAT_LAZY.get(name)
    if target is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    import importlib
    from hermes_cli.plugin_compat import warn_once
    warn_once(__name__, name, *target)
    return getattr(importlib.import_module(target[0]), target[1])
# ---- END PLUGIN-COMPAT ----
