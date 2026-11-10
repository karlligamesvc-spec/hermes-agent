"""hc-1214: APEX Desktop's web_extract through the platform's Firecrawl gateway.

The Desktop never pins ``web.extract_backend`` (a pin would send signed-out installs to Firecrawl's
keyless cloud). Signed in, ``apps/desktop/electron/backend-env.ts`` sets FIRECRAWL_API_URL (the
gateway host, https://api.apex-nodes.com) and FIRECRAWL_API_KEY (the managed key) next to the
SearXNG pair, and the runtime's backend autodetect routes extraction to firecrawl while search stays
pinned to searxng. The Desktop relies on that, so it is pinned here against a real config.yaml with
the Desktop's web block; an upstream reorder of the autodetect rungs would otherwise move it silently.

1. extraction resolves to firecrawl and search to searxng;
2. the firecrawl provider builds the direct SDK client on the gateway with the managed key, never
   the keyless cloud client;
3. firecrawl-py itself posts to <host>/v2/scrape with the key as a Bearer header (it drops any path
   in its base, which is why the gateway answers at the root).
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

GATEWAY = "https://api.apex-nodes.com"
# The runtime's default web block with the Desktop's searxng pin (apex-managed.ts ensureWebGatewayYaml).
DESKTOP_WEB_BLOCK = "web:\n  backend: ''\n  search_backend: searxng\n  extract_backend: ''\n"
OTHER_VENDOR_KEYS = ("TAVILY_API_KEY", "PERPLEXITY_API_KEY", "EXA_API_KEY", "PARALLEL_API_KEY", "KEENABLE_API_KEY",
                     "BRAVE_SEARCH_API_KEY")


@pytest.fixture
def signed_in_desktop(monkeypatch):
    """The sandboxed HERMES_HOME as a signed-in Desktop leaves it: its web block, its environment."""
    Path(os.environ["HERMES_HOME"], "config.yaml").write_text(DESKTOP_WEB_BLOCK, encoding="utf-8")
    for name in OTHER_VENDOR_KEYS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("SEARXNG_URL", f"{GATEWAY}/api/v1/search/searxng")
    monkeypatch.setenv("SEARXNG_API_KEY", "sk-managed")
    monkeypatch.setenv("FIRECRAWL_API_URL", GATEWAY)
    monkeypatch.setenv("FIRECRAWL_API_KEY", "sk-managed")
    from tools import web_tools

    monkeypatch.setattr(web_tools, "_firecrawl_client", None, raising=False)
    monkeypatch.setattr(web_tools, "_firecrawl_client_config", None, raising=False)
    return web_tools


def test_extraction_goes_to_firecrawl_and_search_stays_on_searxng(signed_in_desktop):
    assert signed_in_desktop._get_extract_backend() == "firecrawl"
    assert signed_in_desktop._get_search_backend() == "searxng"


def test_the_provider_builds_the_direct_client_on_the_gateway_with_the_managed_key(signed_in_desktop, monkeypatch):
    from plugins.web.firecrawl import provider

    built: dict = {}

    class _Sdk:
        def __init__(self, **kwargs):
            built.update(kwargs)

    monkeypatch.setattr(provider, "Firecrawl", _Sdk)

    assert provider._use_keyless_ring("extract") is False
    assert isinstance(provider._get_firecrawl_client("extract"), _Sdk)
    assert built == {"api_key": "sk-managed", "api_url": GATEWAY}


def test_firecrawl_py_posts_to_v2_scrape_at_the_gateway_root(monkeypatch):
    firecrawl = pytest.importorskip("firecrawl")
    import requests

    sent: dict = {}

    class _Answer:
        status_code = 200
        ok = True

        @staticmethod
        def json():
            return {"success": True, "data": {"markdown": "# Example", "metadata": {"sourceURL": "https://example.com"}}}

    def _post(url, headers=None, json=None, timeout=None):
        sent.update(url=url, headers=headers, body=json)
        return _Answer()

    monkeypatch.setattr(requests, "post", _post)
    # The provider's own call (plugins/web/firecrawl/provider.py _scrape_one).
    doc = firecrawl.Firecrawl(api_key="sk-managed", api_url=GATEWAY).scrape(
        url="https://example.com", formats=["markdown", "html"], timeout=60_000)

    assert sent["url"] == f"{GATEWAY}/v2/scrape"
    assert sent["headers"]["Authorization"] == "Bearer sk-managed"
    assert sent["body"]["url"] == "https://example.com" and sent["body"]["timeout"] == 60_000
    assert doc.markdown == "# Example"
