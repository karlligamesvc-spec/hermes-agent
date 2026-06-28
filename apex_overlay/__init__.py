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
- ``provider_filter`` — hc-392 copilot/provider denylist (the pilot seam).

See ``apex_overlay/README.md`` for the full pattern (plugin wiring +
monkey-patch + seam-test) that later phases (gateway/run.py, feishu.py,
install.sh) should copy.
"""

from __future__ import annotations

__all__ = ["provider_filter"]
