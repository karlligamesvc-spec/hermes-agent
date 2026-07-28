"""ApexNodes cloud overlay — our private namespace on top of upstream Hermes.

Why this package exists
=======================
We run a *fork-free* overlay on top of the NousResearch Hermes runtime: we
take upstream tags as-is and layer ApexNodes-specific behavior on top. The
single biggest source of merge pain is **in-place edits to hot upstream
files** — every line we add to e.g. ``hermes_cli/model_switch.py`` is a line
that can conflict on the next upstream bump.

``apex_overlay/`` is the cure. Upstream will *never* create a package with
this name, so anything we put here has a **zero-conflict** merge surface. The
discipline (see ``docs/OVERLAY-SEAM-AUDIT.md`` in hermes-cloud) is:

    config  >  plugin  >  upstream PR  >  in-place (last resort)

This package is the "plugin / boot-import" tier: our real behavioral debt is
moved *out* of the upstream file and re-applied at load time via a thin,
well-tested seam (monkey-patch where clean, a one-line hook otherwise).

Layout
------
- ``provider_filter``   — hc-392 copilot/provider denylist (the pilot seam).
- ``model_catalog_dedupe`` — hc-512 picker sentinel⇄real id pair dedupe
  (``deepseek-v4-pro-APEX`` vs live ``deepseek-v4-pro``).
- ``picker_probe_widening`` — keep the platform model list complete when the
  main provider names no saved custom endpoint (virtual ``moa``, or bare
  ``custom`` with an empty ``base_url``).
- ``custom_base_url_guard`` — stop a custom-family model switch from erasing
  ``model.base_url``, and heal configs already stranded that way.
- ``custom_row_dedupe`` — hc-598 model-directory dedupe: never list one custom
  endpoint twice (its own name plus an anonymous "Custom endpoint" alias).
- ``models_dev_fast``   — non-blocking models.dev catalog fetch (CN first paint).
- ``region``            — CN-mode detection (read side of the install-time choice).
- ``gateway_bootstrap`` — hc-384/385 non-blocking platform startup.
- ``feishu_supervisor`` — hc-384 WS self-reconnect + hc-385 heartbeat
  (v0.18: attaches via the platform registry; Feishu is a bundled plugin now).
- ``im_passthrough``    — hc-539 IM ↔ local coding-agent direct passthrough
  (``/cc`` / ``/codex``; wraps ``GatewayRunner._handle_message``).

See ``apex_overlay/README.md`` for the full pattern (plugin wiring +
monkey-patch + seam-test).
"""

from __future__ import annotations

__all__ = [
    "provider_filter",
    "model_catalog_dedupe",
    "picker_probe_widening",
    "custom_base_url_guard",
    "custom_row_dedupe",
    "models_dev_fast",
    "region",
    "gateway_bootstrap",
    "feishu_supervisor",
    "im_passthrough",
]
