"""Stop the model directory from listing one custom endpoint twice — once
under its real name and once as an anonymous "Custom endpoint".

The damage
==========
The managed ApexNodes relay is registered twice on purpose
(``apps/desktop/electron/apex-managed.ts``): ``model.provider`` is the **bare**
``custom`` slug, while ``custom_providers:`` carries a *named* entry
(``MANAGED_PROVIDER_NAME = 'Apex-nodes.com'``) so the endpoint survives picker
switches and session resume. Upstream turns that named entry into a picker row
with the slug ``custom:apex-nodes.com``.

Then ``hermes_cli/inventory.py`` runs, for the desktop's ``explicit_only``
payload::

    rows = list(rows) + _append_unconfigured_rows(rows, ctx, current_only=True)

whose contract is "the configured current provider vanished from the picker —
keep one row visible so the UI doesn't look like it silently jumped to another
provider". It decides "vanished" by *slug*: no row is named exactly ``custom``,
so it synthesizes one — even though the endpoint that selection routes to is
already on screen under its own name. The result the user sees is a second
provider group in the model menu::

    APEX-NODES.COM        deepseek-v4-pro / glm-5.2 / qwen… (the real row)
    CUSTOM ENDPOINT       deepseek-v4-pro-APEX               (this stub)

Three things are wrong with the stub, all user-visible:

1. it is the **same endpoint twice** — picking from either row routes to the
   identical URL;
2. its name is ``_PROVIDER_LABELS["custom"] = "Custom endpoint"``, an
   implementation word, which the desktop's section-label styling renders as
   the shouted ``CUSTOM ENDPOINT``;
3. it claims ``authenticated: false`` and warns "Configured provider is not
   authenticated; run ``hermes model`` to reactivate" — **false**: the very
   next row is that provider, authenticated, with its live catalog.

What this seam does
===================
Drop that synthesized row when — and only when — the endpoint it stands for is
already represented by another custom-family row in the same payload. Upstream's
rule is kept everywhere else, including the case it was actually written for: a
bare ``custom`` selection whose endpoint really is missing still gets its
placeholder row.

"Already represented" is decided the same two ways upstream itself resolves a
bare ``custom`` selection, never by guessing:

- with a ``model.base_url``, the endpoint is the URL — a listed row publishing
  the same ``api_url`` is the same endpoint;
- without one (the hc-592 damage shape), the endpoint is whatever
  ``hermes_cli.providers.resolve_custom_provider`` routes bare ``custom`` to,
  i.e. where the chat traffic is already going. If that entry's row is listed,
  the stub is its alias.

Related but NOT this seam: ``apex_overlay.custom_base_url_guard`` stops the
blank-``base_url`` shape from happening and heals configs already stranded by
it; ``apex_overlay.picker_probe_widening`` keeps the surviving row's catalog
complete. This one is only about the *duplicate row* they leave behind.

Why a seam (and not an in-place edit)
=====================================
``hermes_cli/inventory.py`` is a hot upstream file; the overlay discipline
(config > plugin > upstream PR > in-place) keeps it byte-for-byte upstream and
re-applies our behavior at load time. The patched symbol is private, so the
seam-test pins its name AND its call shape — a rename upstream must fail CI
loudly rather than silently restore the duplicate row.

This module is import-safe and ``apply()`` is idempotent.
"""

from __future__ import annotations

import functools
import logging
from typing import Any, Callable, Dict, List, Optional, Sequence

from apex_overlay.custom_base_url_guard import (
    BARE_CUSTOM_PROVIDER,
    in_custom_family,
)

logger = logging.getLogger(__name__)

# The upstream attribute this seam monkey-patches. Centralized so the seam-test
# can assert it still exists with a compatible signature.
_TARGET_INVENTORY_MODULE = "hermes_cli.inventory"
_TARGET_APPEND_FN = "_append_unconfigured_rows"

# The marker upstream stamps on the row it synthesizes for a configured-but-
# missing current provider (``_append_unconfigured_rows``). Skeleton rows for
# providers the user has simply never set up carry ``"canonical"`` instead and
# are none of this seam's business.
CONFIGURED_CURRENT_SOURCE = "configured-current"

# Guard so apply() is idempotent even if called from multiple boot paths.
_APPLIED = False
_MARK = "_apex_overlay_custom_row_dedupe"


def _norm_url(url: Any) -> str:
    """Compare endpoints the way upstream's picker does: case- and slash-blind."""
    return str(url or "").strip().rstrip("/").lower()


def _listed_custom_rows(rows: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Custom-family rows already in the payload, excluding the bare slug.

    The bare ``custom`` slug is the anonymous alias; only rows that carry an
    endpoint identity of their own (``custom:<name>``) can make it redundant.
    """
    listed = []
    for row in rows:
        slug = str(row.get("slug") or "").strip().lower()
        if slug and slug != BARE_CUSTOM_PROVIDER and in_custom_family(slug):
            listed.append(row)
    return listed


def _routed_row_slug(custom_providers: Optional[List[Dict[str, Any]]]) -> str:
    """The picker slug of the entry upstream routes bare ``custom`` to, or ``""``.

    Delegates to upstream's own ``resolve_custom_provider`` (its documented
    first-valid-entry fallback for the bare slug — GH #17478) and mints the slug
    with upstream's own ``custom_provider_slug``, so this can only ever name a
    row upstream would itself have produced.
    """
    try:
        from hermes_cli.providers import custom_provider_slug, resolve_custom_provider

        resolved = resolve_custom_provider(BARE_CUSTOM_PROVIDER, custom_providers)
    except Exception:
        logger.debug("apex_overlay: bare custom resolution failed", exc_info=True)
        return ""
    name = str(getattr(resolved, "name", "") or "").strip() if resolved else ""
    return custom_provider_slug(name).lower() if name else ""


def bare_custom_row_is_alias(
    rows: Sequence[Dict[str, Any]],
    *,
    current_base_url: str = "",
    custom_providers: Optional[List[Dict[str, Any]]] = None,
) -> bool:
    """Is a synthesized bare-``custom`` row a second face of a row in ``rows``?

    Pure, so the whole rule is table-testable without upstream or the network.
    ``False`` — meaning "upstream's row is doing its job, leave it" — whenever
    no listed custom row can be shown to be the same endpoint.
    """
    listed = _listed_custom_rows(rows)
    if not listed:
        return False

    url = _norm_url(current_base_url)
    if url:
        return any(_norm_url(row.get("api_url")) == url for row in listed)

    routed_slug = _routed_row_slug(custom_providers)
    if not routed_slug:
        return False
    return any(str(row.get("slug") or "").strip().lower() == routed_slug for row in listed)


def drop_aliased_bare_custom(
    extras: List[Dict[str, Any]],
    rows: Sequence[Dict[str, Any]],
    ctx: Any,
) -> List[Dict[str, Any]]:
    """Filter upstream's synthesized rows down to the ones still worth showing.

    Only ever removes the bare-``custom`` ``configured-current`` row, and only
    when ``bare_custom_row_is_alias`` says the endpoint is already on screen.
    Every other synthesized row passes through untouched.
    """
    keep: List[Dict[str, Any]] = []
    for extra in extras:
        slug = str(extra.get("slug") or "").strip().lower()
        source = str(extra.get("source") or "").strip().lower()
        if slug != BARE_CUSTOM_PROVIDER or source != CONFIGURED_CURRENT_SOURCE:
            keep.append(extra)
            continue
        if bare_custom_row_is_alias(
            rows,
            current_base_url=getattr(ctx, "current_base_url", "") or "",
            custom_providers=getattr(ctx, "custom_providers", None),
        ):
            logger.debug(
                "apex_overlay: dropped the anonymous bare-'custom' row — the "
                "endpoint it names is already listed under its own name"
            )
            continue
        keep.append(extra)
    return keep


def _wrap_append_unconfigured_rows(orig: Callable) -> Callable:
    """Post-filter upstream's synthesized rows; inputs pass through untouched."""

    @functools.wraps(orig)
    def wrapper(rows, ctx, **kwargs) -> List[Dict[str, Any]]:
        extras = orig(rows, ctx, **kwargs)
        try:
            if isinstance(extras, list):
                return drop_aliased_bare_custom(extras, rows or [], ctx)
        except Exception:
            # Never let the overlay break the host path — upstream's own rows
            # are returned untouched.
            logger.debug("apex_overlay: custom row dedupe skipped", exc_info=True)
        return extras

    setattr(wrapper, _MARK, True)
    return wrapper


def apply() -> bool:
    """Install the duplicate-row filter. Idempotent, safe from any boot path.

    Returns ``False`` when the upstream symbol is missing (the seam-test turns
    that into a hard CI failure) — never raises.
    """
    global _APPLIED
    if _APPLIED:
        return True

    try:
        from hermes_cli import inventory
    except Exception:
        logger.warning("apex_overlay: hermes_cli.inventory unavailable", exc_info=True)
        return False

    orig = getattr(inventory, _TARGET_APPEND_FN, None)
    if orig is None:
        logger.error(
            "apex_overlay: could not patch %s.%s — the model directory will "
            "list the managed endpoint twice, the second time as the "
            "implementation word 'Custom endpoint' with a false "
            "'not authenticated' warning. Upstream may have renamed/moved it.",
            _TARGET_INVENTORY_MODULE, _TARGET_APPEND_FN,
        )
        return False

    if not getattr(orig, _MARK, False):
        setattr(inventory, _TARGET_APPEND_FN, _wrap_append_unconfigured_rows(orig))

    _APPLIED = True
    logger.debug("apex_overlay: custom row dedupe seam applied")
    return True
