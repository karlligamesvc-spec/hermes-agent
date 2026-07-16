"""ApexNodes region signal — the Python read-side of the install-time China
mirror decision.

The install/bootstrap layer decides "is this a mainland-China machine that
should use domestic mirrors?" in the single source of truth
``scripts/lib/apexnodes-region-detect.sh`` (mirrored by the ``.ps1`` for
Windows). That decision is surfaced to the *running runtime* in three places,
which this module reads back with the **exact same precedence** the shell uses:

    1. ``HERMES_CN_MIRRORS``   env, authoritative override: ``1`` = CN, ``0`` = global.
       The packaged desktop (bootstrap-runner.cjs) and ops overrides set this
       directly, so honoring it verbatim keeps runtime behavior aligned with
       how the box was provisioned.
    2. ``APEXNODES_REGION``    env, explicit knob: ``cn`` | ``global``.
    3. ``$HERMES_HOME/.apexnodes-region`` file (contents ``cn`` | ``global``)
       written by the shell detector as telemetry + runtime region signal
       (since hc-474 install-time code never reads it back; this runtime
       read-side is its only consumer).

Anything ambiguous / unset / unreadable resolves to **not-CN** (``False``),
because the only cost of guessing "global" wrong is a slightly slower metadata
refresh — never a broken path. This mirrors the shell's "default to global on
any doubt" rule.

This lives in ``apex_overlay/`` (a namespace upstream never creates) so it has a
zero-conflict merge surface, and it is import-safe: every lookup is wrapped so a
weird environment can never raise into a caller. It is pure detection — it sets
nothing and has no side effects.
"""

from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)

_TRUE_ENV = {"1", "true", "yes", "on"}
_FALSE_ENV = {"0", "false", "no", "off", ""}


def _env(name: str) -> str:
    try:
        return (os.environ.get(name) or "").strip().lower()
    except Exception:
        return ""


def _region_cache_says_cn() -> bool | None:
    """Read ``$HERMES_HOME/.apexnodes-region`` (rule 3). None if absent/unknown."""
    try:
        # Imported lazily: hermes_constants pulls in a fair bit at import time
        # and this module may be imported very early (plugin discovery).
        from hermes_constants import get_hermes_home

        cache = get_hermes_home() / ".apexnodes-region"
        if not cache.exists():
            return None
        val = cache.read_text(encoding="utf-8").strip().lower()
        if val == "cn":
            return True
        if val == "global":
            return False
    except Exception as exc:  # never let a filesystem quirk raise
        logger.debug("apex_overlay.region: could not read region cache: %s", exc)
    return None


def is_cn_mode() -> bool:
    """True when this runtime should behave as a mainland-China deployment.

    Read fresh on every call (cheap; the env var is the common case) so a
    profile switch or ops override takes effect without a restart. Fail-safe:
    any error or ambiguity returns ``False`` (global). Precedence matches
    ``scripts/lib/apexnodes-region-detect.sh``.
    """
    # Rule 1: HERMES_CN_MIRRORS — authoritative, respected verbatim.
    cn = _env("HERMES_CN_MIRRORS")
    if cn in _TRUE_ENV:
        return True
    if cn in _FALSE_ENV and cn != "":
        return False

    # Rule 2: APEXNODES_REGION explicit knob.
    region = _env("APEXNODES_REGION")
    if region == "cn":
        return True
    if region == "global":
        return False

    # Rule 3: cached shell-detector decision.
    cached = _region_cache_says_cn()
    if cached is not None:
        return cached

    # Default: global (no doubt-driven CN behavior).
    return False
