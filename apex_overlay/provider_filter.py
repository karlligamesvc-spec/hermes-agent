"""hc-392/hc-621 provider denylist — applied to upstream as a zero-in-place seam.

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
by monkey-patching upstream functions.

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

hc-621: the denylist must cover ALL exits, not just the picker
==============================================================
The two patches above only gate the **/model picker** layer. The **auth
status / credential resolution** layer never consulted the denylist, so a
denied provider was still probed — every ~7.5s in production: the desktop
shell polls ``GET /api/providers/oauth``, whose per-provider fallback calls
``get_auth_status("copilot")`` → ``get_api_key_provider_status`` →
``_resolve_api_key_provider_secret`` → ``resolve_copilot_token()`` →
``gh auth token`` subprocess. With a classic PAT (``ghp_*``) in ``gh``,
that raised + logged "Copilot token validation failed" **2684 times in
5.5 hours** on a box whose config had ``disabled_providers: [copilot]``
all along. Contract (Kael, 2026-07-30): a denied provider resolves **no**
token and fires **no** external command — on every path.

Five more patches close every remaining exit (exit inventory in the hc-621
PR / seam-test):

3. ``hermes_cli.auth.get_auth_status`` — the status dispatcher every
   status surface funnels through (web accounts endpoint, ``hermes auth
   status``, doctor, ``_has_any_provider_configured`` startup preflight,
   ``list_available_providers``, active-provider pre-read). Denied →
   static ``{"logged_in": False, "disabled": True, ...}`` with the reason;
   no store reads, no resolver calls.
4. ``hermes_cli.auth.get_api_key_provider_status`` — same gate one level
   down; today only reached via (3), pinned so a future direct caller
   stays covered.
5. ``hermes_cli.auth.resolve_api_key_provider_credentials`` — the runtime
   credential resolver (active-provider resolution, the auxiliary client's
   iterate-ALL-api-key-providers fallback chain, setup flows, the copilot
   catalog key). Denied → empty credentials, and its *second* direct
   ``resolve_copilot_token()`` call (base-URL resolution) never runs.
6. ``hermes_cli.copilot_auth.resolve_copilot_token`` — the subprocess
   itself. Belt-and-suspenders for the copilot-specific refresh paths that
   call it directly (``run_agent`` 401 refresh, auxiliary-client refresh,
   credential-pool seeding via any ``load_pool("copilot")``). The gate is
   the *denylist*, not hardcoded: remove copilot from the list and this
   wrapper is a pass-through (the seam-test proves both directions).
7. ``hermes_cli.models.provider_model_ids`` — the un-cached live-fetch
   fan-out. ``validate_requested_model`` / ``curated_models_for_provider``
   call it directly, bypassing the patched cached wrapper in (1).

All patches read the denylist fresh on every call (config can change between
picker opens), and all are no-ops when the denylist is empty — so on a box
with no ``disabled_providers`` set, behavior is identical to upstream. The
seam-test (``tests/apex_overlay/test_provider_filter_seam.py``) pins every
patched symbol so an upstream rename/move turns into a loud CI failure
instead of a silently-disarmed guard.

This module is import-safe and ``apply()`` is idempotent.
"""

from __future__ import annotations

import functools
import logging
from typing import Callable, List

logger = logging.getLogger(__name__)

# The upstream attributes we monkey-patch. Centralized so the seam-test
# can assert they still exist with a compatible signature. If upstream renames
# or moves any of these, both the patch AND the seam-test break loudly.
_TARGET_MODELS_MODULE = "hermes_cli.models"
_TARGET_CACHED_FN = "cached_provider_model_ids"
_TARGET_PROVIDER_MODEL_IDS_FN = "provider_model_ids"
_TARGET_SWITCH_MODULE = "hermes_cli.model_switch"
_TARGET_LIST_FN = "list_authenticated_providers"
# hc-621 auth/status layer targets.
_TARGET_AUTH_MODULE = "hermes_cli.auth"
_TARGET_STATUS_DISPATCH_FN = "get_auth_status"
_TARGET_APIKEY_STATUS_FN = "get_api_key_provider_status"
_TARGET_RESOLVE_CREDS_FN = "resolve_api_key_provider_credentials"
_TARGET_COPILOT_MODULE = "hermes_cli.copilot_auth"
_TARGET_COPILOT_TOKEN_FN = "resolve_copilot_token"

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
# hc-621 wrappers — auth status / credential resolution layer
# ---------------------------------------------------------------------------

_DISABLED_REASON = (
    "provider disabled via model.disabled_providers (hc-392 denylist; "
    "status short-circuited by apex_overlay hc-621 — no credential "
    "resolution, no external probe)"
)


def _disabled_status(provider: str) -> dict:
    """Static status payload for a denied provider.

    Superset of the shapes both status functions return, so every caller
    (web accounts endpoint, doctor, preflight, ``hermes auth status``) sees
    a well-formed "not usable" answer without any resolver having run.
    ``disabled``/``disabled_reason`` let surfaces say *why* instead of
    rendering a generic logged-out card.
    """
    return {
        "logged_in": False,
        "configured": False,
        "provider": provider,
        "disabled": True,
        "disabled_reason": _DISABLED_REASON,
        "source": "disabled",
        "source_label": "Disabled (model.disabled_providers)",
    }


def _disabled_credentials(provider: str) -> dict:
    """Empty-credentials payload for a denied provider.

    Matches ``resolve_api_key_provider_credentials``'s dict contract
    (``provider`` / ``api_key`` / ``base_url`` / ``source``): every caller
    treats a falsy ``api_key`` as "skip this provider", which is exactly
    the denied semantics — and none of the probing that normally produces
    the key (env scan, ``gh auth token``, token exchange) has run.
    """
    return {
        "provider": provider,
        "api_key": "",
        "base_url": "",
        "source": "",
        "disabled": True,
        "disabled_reason": _DISABLED_REASON,
    }


def _wrap_get_auth_status(orig: Callable) -> Callable:
    """Deny gate on the status dispatcher — the funnel for every status probe.

    ``get_auth_status`` is what the web accounts endpoint (polled ~7.5s by
    the desktop shell), ``hermes auth status``, doctor, the startup
    preflight and ``list_available_providers`` all call per provider. For a
    denied provider we answer statically *before* any per-provider status
    helper (and therefore any token resolver / subprocess) runs.

    Mirrors upstream's own target computation: an explicit ``provider_id``
    wins, else the active provider — so a denied *active* provider is also
    answered statically.
    """

    @functools.wraps(orig)
    def wrapper(provider_id=None, *args, **kwargs):
        try:
            target = (provider_id or "").strip().lower() if isinstance(provider_id, str) else ""
            if not target:
                # Upstream: an absent/empty provider_id resolves to the active
                # provider — mirror that so a denied *active* provider is also
                # answered statically.
                from hermes_cli.auth import get_active_provider

                target = (get_active_provider() or "").strip().lower()
            if target and is_disabled(*_provider_aliases(target)):
                logger.debug(
                    "apex_overlay: static disabled auth status for denied "
                    "provider %r (hc-621)", target,
                )
                return _disabled_status(target)
        except Exception:
            # Never let the overlay break the host path.
            pass
        return orig(provider_id, *args, **kwargs)

    setattr(wrapper, _MARK, True)
    return wrapper


def _wrap_get_api_key_provider_status(orig: Callable) -> Callable:
    """Deny gate one level below the dispatcher.

    Today ``get_api_key_provider_status`` is only reached through
    ``get_auth_status`` (already gated), but it is a public symbol — this
    keeps any future direct caller covered instead of re-opening the
    ``_resolve_api_key_provider_secret`` → ``resolve_copilot_token`` path.
    """

    @functools.wraps(orig)
    def wrapper(provider_id, *args, **kwargs):
        try:
            if provider_id and is_disabled(*_provider_aliases(provider_id)):
                return _disabled_status(str(provider_id))
        except Exception:
            pass
        return orig(provider_id, *args, **kwargs)

    setattr(wrapper, _MARK, True)
    return wrapper


def _wrap_resolve_api_key_provider_credentials(orig: Callable) -> Callable:
    """Deny gate on the runtime credential resolver.

    Covers the exits that resolve credentials for actual use: active
    provider resolution (``resolve_runtime_provider``), the auxiliary
    client's iterate-every-api-key-provider fallback chain, the model setup
    flows, and the copilot catalog key. Also cuts this function's *own*
    second direct ``resolve_copilot_token()`` call (copilot base-URL
    resolution) — the one a secret-level gate would have missed.
    """

    @functools.wraps(orig)
    def wrapper(provider_id, *args, **kwargs):
        try:
            if provider_id and is_disabled(*_provider_aliases(provider_id)):
                logger.debug(
                    "apex_overlay: refusing credential resolution for denied "
                    "provider %r (hc-621)", provider_id,
                )
                return _disabled_credentials(str(provider_id))
        except Exception:
            pass
        return orig(provider_id, *args, **kwargs)

    setattr(wrapper, _MARK, True)
    return wrapper


def _wrap_resolve_copilot_token(orig: Callable) -> Callable:
    """Deny gate on the ``gh auth token`` subprocess itself.

    Catches the copilot-specific paths that import ``resolve_copilot_token``
    directly instead of going through the gated resolvers: the runtime's
    401 credential refresh (``run_agent``), the auxiliary client's provider
    refresh, and credential-pool seeding (fired by any
    ``load_pool("copilot")`` — picker in-loop pool checks, the web
    ``/api/credentials/pool`` listing, aux pool selection).

    The gate is the *denylist*, not the function: with copilot absent from
    ``model.disabled_providers`` this wrapper is a byte-for-byte
    pass-through (the seam-test proves both directions).
    """

    @functools.wraps(orig)
    def wrapper(*args, **kwargs):
        try:
            if is_disabled(*_provider_aliases("copilot")):
                logger.debug(
                    "apex_overlay: copilot denied — skipping token "
                    "resolution / gh subprocess (hc-621)",
                )
                return "", ""
        except Exception:
            pass
        return orig(*args, **kwargs)

    setattr(wrapper, _MARK, True)
    return wrapper


def _wrap_provider_model_ids(orig: Callable) -> Callable:
    """Short-circuit the *un-cached* live model-list fan-out.

    ``cached_provider_model_ids`` (patch 1) covers the picker, but
    ``validate_requested_model`` and ``curated_models_for_provider`` call
    ``provider_model_ids`` directly — for a denied provider that path would
    still reach the provider's live fetcher (for copilot: an unauthenticated
    GitHub catalog attempt even with no token). Same contract as patch 1:
    denied → ``[]`` before any fetch.
    """

    @functools.wraps(orig)
    def wrapper(provider, *args, **kwargs):
        try:
            if provider and is_disabled(*_provider_aliases(provider)):
                logger.debug(
                    "apex_overlay: skipping live model-id fan-out for denied "
                    "provider %r (hc-621)", provider,
                )
                return []
        except Exception:
            pass
        return orig(provider, *args, **kwargs)

    setattr(wrapper, _MARK, True)
    return wrapper


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

# (module, attribute, wrapper-factory) for every upstream symbol we patch.
# Order matters only for readability: picker layer (hc-392) first, then the
# auth/status layer (hc-621).
_PATCH_TABLE: tuple = (
    # 1: cut the cached live model fetch before it fires (picker layer).
    (_TARGET_MODELS_MODULE, _TARGET_CACHED_FN, _wrap_cached_provider_model_ids),
    # 2: drop disabled rows from the picker result.
    (_TARGET_SWITCH_MODULE, _TARGET_LIST_FN, _wrap_list_authenticated_providers),
    # 3 (hc-621): static disabled answer at the status dispatcher.
    (_TARGET_AUTH_MODULE, _TARGET_STATUS_DISPATCH_FN, _wrap_get_auth_status),
    # 4 (hc-621): same gate one level down (future direct callers).
    (_TARGET_AUTH_MODULE, _TARGET_APIKEY_STATUS_FN, _wrap_get_api_key_provider_status),
    # 5 (hc-621): refuse runtime credential resolution for denied providers.
    (_TARGET_AUTH_MODULE, _TARGET_RESOLVE_CREDS_FN, _wrap_resolve_api_key_provider_credentials),
    # 6 (hc-621): the `gh auth token` subprocess itself (direct callers).
    (_TARGET_COPILOT_MODULE, _TARGET_COPILOT_TOKEN_FN, _wrap_resolve_copilot_token),
    # 7 (hc-621): the un-cached live fan-out that bypasses patch 1.
    (_TARGET_MODELS_MODULE, _TARGET_PROVIDER_MODEL_IDS_FN, _wrap_provider_model_ids),
)


def apply() -> bool:
    """Install the hc-392/hc-621 denylist seam onto upstream. Idempotent.

    Returns ``True`` if all patches were applied (or already present),
    ``False`` if a target symbol was missing (which the seam-test turns into
    a hard CI failure — see module docstring). Safe to call from any boot
    path; multiple calls are a no-op after the first.
    """
    global _APPLIED
    if _APPLIED:
        return True

    import importlib

    ok = True
    for module_name, attr_name, wrap in _PATCH_TABLE:
        try:
            mod = importlib.import_module(module_name)
            orig = getattr(mod, attr_name)
            if not getattr(orig, _MARK, False):
                setattr(mod, attr_name, wrap(orig))
        except (ImportError, AttributeError) as exc:
            logger.error(
                "apex_overlay: could not patch %s.%s — hc-392/hc-621 provider "
                "denylist is NOT fully active. Upstream may have renamed/moved "
                "it. (%s)",
                module_name, attr_name, exc,
            )
            ok = False

    _APPLIED = ok
    if ok:
        logger.debug("apex_overlay: hc-392/hc-621 provider denylist seam applied")
    return ok
