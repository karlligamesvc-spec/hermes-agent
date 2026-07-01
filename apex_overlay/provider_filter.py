"""hc-392 provider denylist — applied to upstream as a zero-in-place seam.

What this replaces
==================
hc-392 ("China skill profile") needs the runtime to *never* probe or
live-fetch certain providers at startup — most importantly GitHub Copilot.
A stray ``GH_TOKEN`` / ``gh auth`` token on the box would otherwise make
``list_authenticated_providers()`` reach out to GitHub's Copilot model
catalog, land it in ``provider_models_cache.json``, and surface a Copilot
row in the ``/model`` picker. We don't want that on China deployments.

The original fix lived as ``+34`` in-place lines inside
``hermes_cli/model_switch.py`` (a hot file: 8 upstream commits since our
fork point). This module moves that behavior into ``apex_overlay/`` so the
upstream file stays byte-for-byte upstream, and re-applies it at load time
by monkey-patching two upstream functions.

The denylist itself stays in config (``model.disabled_providers`` in
cli-config.yaml) — that part was already a perfect data seam and is
unchanged.

How the seam works (the "before fetch" requirement)
===================================================
hc-392's contract is: a disabled provider makes **no** startup network call.
So a naive "filter the results at the end" is not enough — by then the
GitHub fetch has already happened. We need to cut the call *before* it fires.

``list_authenticated_providers()`` resolves each provider's model list
through exactly one shared helper, ``hermes_cli.models.cached_provider_model_ids(provider)``,
which is what (for copilot) fans out to ``fetch_github_model_catalog()``.
So we patch at two points:

1. ``cached_provider_model_ids`` — short-circuit disabled providers to ``[]``
   *before* the live fetch. This is the "no network call" guarantee.
2. ``list_authenticated_providers`` — drop any disabled-provider row from the
   returned list. (A disabled provider could otherwise still emit a row from
   its curated static fallback once the live fetch returns ``[]``.) Filtering
   by slug — not by "empty models" — keeps non-disabled providers that simply
   have an empty live catalog.

Both patches read the denylist fresh on every call (config can change between
picker opens), and both are no-ops when the denylist is empty — so on a box
with no ``disabled_providers`` set, behavior is identical to upstream. The
seam-test (``tests/apex_overlay/test_provider_filter_seam.py``) pins the two
patched symbols so an upstream rename/move turns into a loud CI failure
instead of a silently-disarmed guard.

This module is import-safe and ``apply()`` is idempotent.
"""

from __future__ import annotations

import functools
import logging
from typing import Callable, List

logger = logging.getLogger(__name__)

# The two upstream attributes we monkey-patch. Centralized so the seam-test
# can assert they still exist with a compatible signature. If upstream renames
# or moves either of these, both the patch AND the seam-test break loudly.
_TARGET_MODELS_MODULE = "hermes_cli.models"
_TARGET_CACHED_FN = "cached_provider_model_ids"
_TARGET_SWITCH_MODULE = "hermes_cli.model_switch"
_TARGET_LIST_FN = "list_authenticated_providers"

# Guard so apply() is idempotent even if called from multiple boot paths.
_APPLIED = False
_MARK = "_apex_overlay_provider_filter"

# CN-mode implicit denylist. In a mainland-China deployment these foreign model
# gateways are never reachable without a proxy, so probing them at startup for a
# live ``/v1/models`` catalog only stalls the picker on a doomed trans-wall
# request. We add them to the denylist *only when* the runtime is in CN mode
# (``apex_overlay.region.is_cn_mode()``) — they must stay probeable on global
# deployments, where e.g. OpenRouter is the DEFAULT ``base_url``. Because this
# can't be expressed by the static (always-on) ``model.disabled_providers``
# config key, it lives here and rides the exact same tested denylist machinery
# (both spellings via ``_provider_aliases``, both patch points) — no new patch
# point, no code path that isn't already covered by the pilot seam.
#
#   openrouter   -> foreign aggregator; api.openrouter.ai
#   nous         -> Nous Portal (nousresearch.com),墙外
#   copilot      -> GitHub Copilot; api.githubcopilot.com (also in config,
#                   listed here so CN mode covers it even if config is edited)
_CN_DISABLED_PROVIDERS = frozenset({"openrouter", "nous", "copilot"})


def _cn_disabled_provider_set() -> set:
    """CN-mode implicit denylist, or empty set outside CN mode / on error."""
    try:
        from apex_overlay.region import is_cn_mode

        if is_cn_mode():
            return set(_CN_DISABLED_PROVIDERS)
    except Exception:
        pass
    return set()


# ---------------------------------------------------------------------------
# Denylist source (config) — mirrors the original hc-392 in-place logic
# ---------------------------------------------------------------------------

def disabled_provider_set() -> set:
    """Return the effective lowercased provider denylist.

    Union of two sources, read fresh every call so a config edit or a region
    change between ``/model`` opens takes effect without a restart:

    * ``model.disabled_providers`` from config — the always-on data seam
      (hc-392; ships with ``copilot``). Mirrors the exact shape the original
      in-place hc-392 block parsed.
    * The CN-mode implicit set (:data:`_CN_DISABLED_PROVIDERS`) — added only
      when the runtime is in China mode, to keep the picker from probing
      wall-blocked foreign gateways at startup.

    Defensive: a malformed config or region lookup contributes an empty set
    (fail-open, never an exception).
    """
    denied: set = set()
    try:
        from hermes_cli.config import load_config_readonly

        mcfg = (load_config_readonly() or {}).get("model") or {}
        dp = mcfg.get("disabled_providers")
        if isinstance(dp, str):
            dp = [dp]
        if dp:
            denied |= {str(p).strip().lower() for p in dp if str(p).strip()}
    except Exception:
        pass
    denied |= _cn_disabled_provider_set()
    return denied


def is_disabled(*slugs: str) -> bool:
    """True if any of the given slug spellings is in the denylist.

    Accepts multiple spellings (Hermes slug + models.dev id, e.g.
    ``"copilot"`` and ``"github-copilot"``) so a denylist entry under either
    name matches — same contract as the original ``_is_disabled_provider``.
    """
    denied = disabled_provider_set()
    if not denied:
        return False
    return any(s and str(s).lower() in denied for s in slugs)


def _provider_aliases(slug: str) -> tuple:
    """All spellings a denylist might use for *slug* (Hermes id + models.dev id).

    The picker iterates providers under their Hermes slug (``copilot``) but a
    user might denylist the models.dev id (``github-copilot``) or vice-versa.
    Resolve both directions so ``is_disabled()`` matches regardless of which
    spelling the live row carries.
    """
    s = str(slug or "").strip()
    if not s:
        return ()
    spellings = {s, s.lower()}
    try:
        from agent.models_dev import PROVIDER_TO_MODELS_DEV

        mdev = PROVIDER_TO_MODELS_DEV.get(s) or PROVIDER_TO_MODELS_DEV.get(s.lower())
        if mdev:
            spellings.add(mdev)
        # reverse: slug might already be a models.dev id
        for hermes_id, mdev_id in PROVIDER_TO_MODELS_DEV.items():
            if mdev_id == s or mdev_id == s.lower():
                spellings.add(hermes_id)
    except Exception:
        pass
    return tuple(spellings)


# ---------------------------------------------------------------------------
# Monkey-patch wrappers
# ---------------------------------------------------------------------------

def _wrap_cached_provider_model_ids(orig: Callable) -> Callable:
    """Short-circuit disabled providers to ``[]`` *before* the live fetch.

    This is the load-bearing patch: for ``copilot`` the unpatched call fans
    out to ``fetch_github_model_catalog()`` (a GitHub network round-trip).
    Returning ``[]`` here means that call never fires for a disabled provider
    — the hc-392 "no startup network call" guarantee.
    """

    @functools.wraps(orig)
    def wrapper(provider, *args, **kwargs):
        try:
            if provider and is_disabled(*_provider_aliases(provider)):
                logger.debug(
                    "apex_overlay: skipping live model fetch for disabled "
                    "provider %r (hc-392 denylist)", provider,
                )
                return []
        except Exception:
            # Never let the overlay break the host path — fall through to
            # upstream behavior if anything in our check misfires.
            pass
        return orig(provider, *args, **kwargs)

    setattr(wrapper, _MARK, True)
    return wrapper


def _wrap_list_authenticated_providers(orig: Callable) -> Callable:
    """Drop disabled-provider rows from the picker result.

    The fetch short-circuit above stops the network call, but a disabled
    provider could still surface a row from its *curated static* fallback
    (which kicks in when the live list is empty). Strip those rows by slug so
    a disabled provider is fully invisible in the picker — matching the
    original in-loop ``continue``.
    """

    @functools.wraps(orig)
    def wrapper(*args, **kwargs) -> List[dict]:
        rows = orig(*args, **kwargs)
        try:
            denied = disabled_provider_set()
            if not denied or not rows:
                return rows
            return [
                r for r in rows
                if not is_disabled(*_provider_aliases(r.get("slug", "")))
            ]
        except Exception:
            return rows

    setattr(wrapper, _MARK, True)
    return wrapper


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def apply() -> bool:
    """Install the hc-392 denylist seam onto upstream. Idempotent.

    Returns ``True`` if the patches were applied (or already present),
    ``False`` if a target symbol was missing (which the seam-test turns into
    a hard CI failure — see module docstring). Safe to call from any boot
    path; multiple calls are a no-op after the first.
    """
    global _APPLIED
    if _APPLIED:
        return True

    import importlib

    ok = True

    # Patch 1: cached_provider_model_ids (cut the fetch before it fires).
    try:
        models_mod = importlib.import_module(_TARGET_MODELS_MODULE)
        orig_cached = getattr(models_mod, _TARGET_CACHED_FN)
        if not getattr(orig_cached, _MARK, False):
            setattr(
                models_mod, _TARGET_CACHED_FN,
                _wrap_cached_provider_model_ids(orig_cached),
            )
    except (ImportError, AttributeError) as exc:
        logger.error(
            "apex_overlay: could not patch %s.%s — hc-392 provider denylist "
            "is NOT active. Upstream may have renamed/moved it. (%s)",
            _TARGET_MODELS_MODULE, _TARGET_CACHED_FN, exc,
        )
        ok = False

    # Patch 2: list_authenticated_providers (drop disabled rows).
    try:
        switch_mod = importlib.import_module(_TARGET_SWITCH_MODULE)
        orig_list = getattr(switch_mod, _TARGET_LIST_FN)
        if not getattr(orig_list, _MARK, False):
            setattr(
                switch_mod, _TARGET_LIST_FN,
                _wrap_list_authenticated_providers(orig_list),
            )
    except (ImportError, AttributeError) as exc:
        logger.error(
            "apex_overlay: could not patch %s.%s — hc-392 provider denylist "
            "is NOT active. Upstream may have renamed/moved it. (%s)",
            _TARGET_SWITCH_MODULE, _TARGET_LIST_FN, exc,
        )
        ok = False

    _APPLIED = ok
    if ok:
        logger.debug("apex_overlay: hc-392 provider denylist seam applied")
    return ok
