"""hc-512 model-catalog sentinel dedupe — collapse ``X`` + ``X-APEX`` pairs.

What this fixes
===============
The ApexNodes managed-LLM path writes a *sentinel* model id to config
(``deepseek-v4-pro-APEX`` — see ``apps/desktop/electron/apex-managed.cjs``:
the bare routed id ``deepseek-v4-pro`` collides with the built-in DeepSeek
catalog and mis-routes agent boot to the keyless built-in provider, so the
config anchor deliberately carries the ``-APEX`` brand suffix; the relay
routes by DB truth and ignores the request's model field entirely).

The picker catalog for that custom provider row is assembled by
``hermes_cli.model_switch.list_authenticated_providers``:

1. the row starts from the config entry's declared model(s) — the sentinel;
2. a live ``GET {base_url}/models`` probe *replaces* the list with the relay's
   real ids (``deepseek-v4-pro``, ``deepseek-v4-flash``, …);
3. the trailing current-model post-pass re-injects the configured sentinel at
   the front because the live list doesn't literally contain it.

Net result: the APEX group shows BOTH ``deepseek-v4-pro-APEX`` and
``deepseek-v4-pro`` — two rows for the exact same relay route. Worse, picking
the bare live id writes it to session/config, re-seeding the very provider
collision the sentinel exists to avoid.

The fix, at the assembly layer: within one provider row, a bare id and its
``-APEX`` sentinel are the SAME route — merge them into a single entry that
keeps the sentinel id (the collision-free anchor; the send path is unchanged,
it simply keeps sending the id it already sends today). Pairs are matched
generically (any ``X`` + ``X-APEX``), so if the seed ever grows more sentinels
(e.g. a staging ``APEXNODES_MANAGED_MODEL`` override derives ``<model>-APEX``)
they dedupe the same way. Ids without a sentinel counterpart (today:
``deepseek-v4-flash``, ``kimi-k2.6``, ``glm-5.2``, …) are untouched.

Why a seam (and not an in-place edit)
=====================================
``hermes_cli/model_switch.py`` is a hot upstream file; the overlay discipline
(config > plugin > upstream PR > in-place) keeps it byte-for-byte upstream and
re-applies our behavior at load time. Same pattern as
``apex_overlay.provider_filter`` (the pilot seam), which already wraps the
same symbol — each wrapper carries its own idempotence mark, so stacking is
safe and order-independent (dedupe only reads/edits row["models"]).

This module is import-safe and ``apply()`` is idempotent.
"""

from __future__ import annotations

import functools
import logging
from typing import Callable, List

logger = logging.getLogger(__name__)

# The upstream attribute we monkey-patch. Centralized so the seam-test can
# assert it still exists with a compatible signature. If upstream renames or
# moves it, both the patch AND the seam-test break loudly.
_TARGET_SWITCH_MODULE = "hermes_cli.model_switch"
_TARGET_LIST_FN = "list_authenticated_providers"

# Guard so apply() is idempotent even if called from multiple boot paths.
_APPLIED = False
_MARK = "_apex_overlay_model_catalog_dedupe"

# The ApexNodes sentinel brand suffix (case-insensitive on match, the stored
# spelling is preserved in the output). Kept in sync with
# MANAGED_MODEL_DISPLAY / resolveApexEndpoints in apex-managed.cjs.
_SENTINEL_SUFFIX = "-apex"


def dedupe_sentinel_pairs(models: List[str]) -> List[str]:
    """Collapse ``X`` + ``X-APEX`` pairs in one model list to the sentinel.

    - Only ids whose counterpart is ALSO present are touched; a lone bare id
      or a lone sentinel passes through unchanged.
    - The merged entry keeps the sentinel spelling exactly as it appears in
      the list (config-written case), at the position of whichever pair
      member appears first — so the picker order stays stable.
    - Matching is case-insensitive on the suffix and the base id (live ids
      and config-written ids should agree on case, but a mismatch must not
      duplicate the row).
    """
    lower_present = {str(m).lower(): str(m) for m in models if isinstance(m, str)}

    def canonical(model: str) -> str:
        low = model.lower()
        if low.endswith(_SENTINEL_SUFFIX):
            return model
        sentinel = lower_present.get(low + _SENTINEL_SUFFIX)
        return sentinel if sentinel is not None else model

    out: List[str] = []
    emitted: set = set()
    for model in models:
        if not isinstance(model, str):
            out.append(model)
            continue
        canon = canonical(model)
        key = canon.lower()
        if key in emitted:
            continue
        emitted.add(key)
        out.append(canon)
    return out


def _dedupe_row(row: dict) -> None:
    """Apply the sentinel dedupe to one provider row, in place."""
    models = row.get("models")
    if not isinstance(models, list) or len(models) < 2:
        return
    deduped = dedupe_sentinel_pairs(models)
    removed = len(models) - len(deduped)
    if removed <= 0:
        return
    row["models"] = deduped
    try:
        total = int(row.get("total_models", len(models)))
    except (TypeError, ValueError):
        total = len(models)
    row["total_models"] = max(len(deduped), total - removed)


def _wrap_list_authenticated_providers(orig: Callable) -> Callable:
    """Dedupe sentinel⇄real id pairs in every returned provider row.

    Runs AFTER upstream's own assembly (live probe replacement + the
    current-model injection post-pass, both inside the wrapped function), so
    it sees the final per-row list every picker consumer receives — the
    dashboard REST ``/api/model/options``, the gateway ``model.options``
    JSON-RPC, and ``list_picker_providers``.
    """

    @functools.wraps(orig)
    def wrapper(*args, **kwargs) -> List[dict]:
        rows = orig(*args, **kwargs)
        try:
            for row in rows or []:
                if isinstance(row, dict):
                    _dedupe_row(row)
        except Exception:
            # Never let the overlay break the host path — the un-deduped
            # list is cosmetically worse but fully functional.
            logger.debug("apex_overlay: model catalog dedupe skipped", exc_info=True)
        return rows

    setattr(wrapper, _MARK, True)
    return wrapper


def apply() -> bool:
    """Install the hc-512 sentinel-dedupe seam onto upstream. Idempotent.

    Returns ``True`` if the patch was applied (or already present), ``False``
    if the target symbol was missing (which the seam-test turns into a hard
    CI failure). Safe to call from any boot path.
    """
    global _APPLIED
    if _APPLIED:
        return True

    import importlib

    try:
        switch_mod = importlib.import_module(_TARGET_SWITCH_MODULE)
        orig_list = getattr(switch_mod, _TARGET_LIST_FN)
    except (ImportError, AttributeError) as exc:
        logger.error(
            "apex_overlay: could not patch %s.%s — hc-512 model-catalog "
            "sentinel dedupe is NOT active. Upstream may have renamed/moved "
            "it. (%s)",
            _TARGET_SWITCH_MODULE, _TARGET_LIST_FN, exc,
        )
        return False

    if not getattr(orig_list, _MARK, False):
        setattr(
            switch_mod, _TARGET_LIST_FN,
            _wrap_list_authenticated_providers(orig_list),
        )

    _APPLIED = True
    logger.debug("apex_overlay: hc-512 model catalog sentinel dedupe applied")
    return True
