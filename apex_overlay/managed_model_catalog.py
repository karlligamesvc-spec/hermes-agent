"""Give the platform relay a usable cold-cache model-discovery budget.

The shared picker caps generic endpoints at 1.5 seconds. A first relay request
from Windows exceeded that budget and silently reduced the menu to its configured
DeepSeek sentinel. Keep upstream's credential-scoped cache and discovery rules;
only widen the network budget for our HTTPS relay, across CLI/REST/Desktop.
"""
from __future__ import annotations

import functools
from urllib.parse import urlsplit

RELAY_CATALOG_TIMEOUT_SECONDS = 15.0
_MARK = '_apex_managed_catalog_budget'


def is_platform_relay(base_url: str | None) -> bool:
    try:
        url = urlsplit(base_url or '')
        return (url.scheme == 'https' and url.hostname in {
            'apex-nodes.com', 'api.apex-nodes.com', 'claw.apex-nodes.com',
        } and url.port in (None, 443) and url.path.rstrip('/') == '/relay/v1')
    except ValueError:
        return False


def apply() -> bool:
    from hermes_cli import models

    original = getattr(models, 'probe_api_models', None)
    if not callable(original):
        return False
    if getattr(original, _MARK, False):
        return True

    @functools.wraps(original)
    def probe(api_key, base_url, timeout=5.0, api_mode=None, request_headers=None):
        if is_platform_relay(base_url):
            timeout = max(timeout, RELAY_CATALOG_TIMEOUT_SECONDS)
        return original(api_key, base_url, timeout=timeout, api_mode=api_mode,
                        request_headers=request_headers)

    setattr(probe, _MARK, True)
    models.probe_api_models = probe
    return True
