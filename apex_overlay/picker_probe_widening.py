"""Keep the platform model list intact when the main provider names no
saved custom endpoint (desktop model-picker collapse family).

The one collapse
================
Every normal picker open (the gateway ``model.options`` JSON-RPC and the REST
``/api/model/options``) asks upstream for the cheap probe policy::

    probe_custom_providers=False          # don't block on every saved endpoint
    probe_current_custom_provider=True    # but DO probe the current one

Upstream resolves "the current one" by matching each saved custom row against
the main model's ``provider`` / ``base_url`` (``hermes_cli/model_switch.py``,
section 4)::

    _grp_is_current = slug.lower() == _current_provider_norm or (
        _current_provider_norm == "custom"
        and bool(_current_base_url_norm)          # <-- blank kills the match
        and _grp_url_norm == _current_base_url_norm
        and _current_base_url_group_count == 1
    )

When **nothing matches**, ``_can_probe_custom_provider`` is false for every
row, the live ``GET /models`` never runs, and the ApexNodes relay row falls
back to the single model id declared in ``custom_providers``
(``deepseek-v4-pro-APEX``; the desktop writes exactly one, see
``apps/desktop/electron/apex-managed.ts`` ``buildManagedModelBlock``).

Net user-visible result: the APEX group collapses from the relay's full
catalog (GLM / Qwen / Doubao / Kimi / …) to one row. No further model can be
selected, and — because the collapse is driven by on-disk config, not session
state — it survives an app restart and hits Settings › Model too.

Two config shapes reach that dead end
=====================================
**A — virtual ``moa`` main provider.** The desktop's silent multi-select
(hc-578, MOA-INVISIBLE-DESIGN) composes 2+ platform models into a hidden preset
and assigns the main model to the virtual provider ``moa``::

    POST /api/model/set {scope: "main", provider: "moa", model: "__auto__"}

``moa`` is not an endpoint — no custom row carries that slug, so no row is
"current".

**B — bare ``custom`` with an empty ``base_url``.** The managed relay IS the
bare ``custom`` provider (``apex-managed.ts`` ``MANAGED_PROVIDER = 'custom'``),
whose endpoint identity lives entirely in ``model.base_url``.
``_apply_main_model_assignment`` (``hermes_cli/web_server.py``) clears
``base_url`` on a provider switch, so a round trip through **A** (relay →
``moa`` → back) leaves ``provider: custom`` with ``base_url: ''``. Bare
``custom`` matches no row by slug, and the URL clause above needs a non-blank
``base_url`` — so again nothing is current. Observed on a real install with an
intact ``custom_providers`` row (``Apex-nodes.com`` →
``https://apex-nodes.com/relay/v1``) sitting right there in the same config.

The rewritten flag rule
=======================
When the main provider can name no saved custom endpoint, re-interpret the
caller's "probe the current custom endpoint" as "probe the saved custom
endpoints". There is no current endpoint to single out, so probing the saved
ones is both the correct reading of the intent and exactly the work that used
to happen one click earlier, when the relay was still cleanly current. Cost is
unchanged in practice: the platform install has a single custom row (the
relay), and a composed selection is platform-only (v1 refuses to mix BYO with a
platform multi-selection).

Deliberately narrow, twice over:

- Only two provider shapes qualify — virtual ``moa``, and bare ``custom``
  *with a blank base_url*. A ``custom:<slug>`` provider matches its row by slug
  no matter what ``base_url`` says, and bare ``custom`` *with* a URL matches by
  URL; neither collapses, so neither is touched.
- The rewrite only fires when the caller asked for the current-endpoint probe
  AND opted out of the broad probe. A caller that asked for neither ("show me
  configured models, touch no network") is left alone, and a caller that
  already probes everything needs nothing.

Related but NOT this seam: a relay key rotated out from under a signed-in
desktop makes the probe *run and 401*, which strands the same row on the same
single id. That is an auth failure, not a matching failure — widening the probe
cannot fix it — and it has its own self-heal (``apex-managed.ts``
"Relay-key self-heal (401 → auto re-provision)", wired at boot, on a runtime
401, and on demand).

Why a seam (and not an in-place edit)
=====================================
``hermes_cli/model_switch.py`` is a hot upstream file; the overlay discipline
(config > plugin > upstream PR > in-place) keeps it byte-for-byte upstream and
re-applies our behavior at load time. Same pattern and same wrapped symbol as
``apex_overlay.provider_filter`` and ``apex_overlay.model_catalog_dedupe`` —
each wrapper carries its own idempotence mark, so stacking is safe and
order-independent (this one only rewrites *inputs*, the other two only read or
edit the returned rows).

The write side of shape **B** — stop clearing ``base_url`` in the first place,
and heal configs already stranded — lives in
``apex_overlay.custom_base_url_guard``. This module is the read-side net that
keeps the picker honest even when a config is already damaged.

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
_MARK = "_apex_overlay_picker_probe_widening"

# The virtual aggregate provider a composed multi-model selection assigns to
# ``model.provider``. Matches AUTO_PRESET_NAME's provider in
# apps/desktop/src/lib/moa-compose.ts and upstream's own ``moa`` picker row
# (hermes_cli/inventory.py ``_moa_provider_row``).
VIRTUAL_MOA_PROVIDER = "moa"

# The provider slug the managed relay is registered under
# (apps/desktop/electron/apex-managed.ts ``MANAGED_PROVIDER``). Bare ``custom``
# carries no endpoint identity of its own — that lives in ``model.base_url`` —
# so a blank URL leaves upstream nothing to match a saved row against.
BARE_CUSTOM_PROVIDER = "custom"


def names_no_custom_endpoint(current_provider: str, current_base_url: str = "") -> bool:
    """Is this main-model selection unable to identify a saved custom row?

    True for exactly the two shapes upstream's section-4 match cannot resolve:
    the virtual ``moa`` provider, and bare ``custom`` with a blank ``base_url``.
    Any ``custom:<slug>`` matches by slug, and bare ``custom`` with a URL
    matches by URL, so both are False.
    """
    provider = str(current_provider or "").strip().lower()
    if provider == VIRTUAL_MOA_PROVIDER:
        return True
    return provider == BARE_CUSTOM_PROVIDER and not str(current_base_url or "").strip()


def probe_flags_for(
    current_provider: str,
    *,
    probe_custom_providers: bool,
    probe_current_custom_provider: bool,
    current_base_url: str = "",
) -> tuple[bool, bool]:
    """Resolve the effective ``(broad, current_only)`` probe flags.

    Pure so the whole rule is table-testable without upstream or the network.
    Returns the flags unchanged unless the selection names no custom endpoint,
    and even then only when the caller asked for the current-endpoint probe
    while opting out of the broad one — the picker's normal-open policy.
    """
    if not names_no_custom_endpoint(current_provider, current_base_url):
        return probe_custom_providers, probe_current_custom_provider

    if probe_custom_providers or not probe_current_custom_provider:
        return probe_custom_providers, probe_current_custom_provider

    # No row can be "the current custom endpoint" — widen to the saved custom
    # endpoints so the row that actually serves the selection still reports its
    # live catalog.
    return True, probe_current_custom_provider


def _wrap_list_authenticated_providers(orig: Callable) -> Callable:
    """Widen the probe policy for a selection that names no custom endpoint.

    Rewrites only the two probe keyword arguments; every other argument and the
    return value pass through untouched, so this composes with the seams that
    post-process the returned rows.
    """

    @functools.wraps(orig)
    def wrapper(*args, **kwargs) -> List[dict]:
        try:
            # ``current_provider`` / ``current_base_url`` are the first two
            # positional parameters; the two probe flags are keyword-only
            # upstream, so they can only arrive in kwargs (absent ⇒ upstream's
            # defaults).
            current_provider = kwargs.get("current_provider", args[0] if args else "")
            current_base_url = kwargs.get(
                "current_base_url", args[1] if len(args) > 1 else ""
            )
            broad, _current_only = probe_flags_for(
                current_provider,
                probe_custom_providers=kwargs.get("probe_custom_providers", True),
                probe_current_custom_provider=kwargs.get(
                    "probe_current_custom_provider", False
                ),
                current_base_url=current_base_url,
            )
            if broad != kwargs.get("probe_custom_providers", True):
                kwargs = dict(kwargs, probe_custom_providers=broad)
                logger.debug(
                    "apex_overlay: main provider %r names no saved custom "
                    "endpoint — widened custom endpoint probing so the platform "
                    "catalog stays complete",
                    current_provider,
                )
        except Exception:
            # Never let the overlay break the host path — the un-widened call
            # still returns a usable (if collapsed) picker payload.
            logger.debug("apex_overlay: picker probe widening skipped", exc_info=True)

        return orig(*args, **kwargs)

    setattr(wrapper, _MARK, True)
    return wrapper


def apply() -> bool:
    """Install the picker probe widening seam onto upstream. Idempotent.

    Returns ``True`` if the patch was applied (or already present), ``False``
    if the target symbol was missing (which the seam-test turns into a hard CI
    failure). Safe to call from any boot path.
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
            "apex_overlay: could not patch %s.%s — the picker probe widening "
            "seam is NOT active, so a main provider that names no saved custom "
            "endpoint (virtual 'moa', or bare 'custom' with an empty base_url) "
            "will collapse the platform model list to its single configured "
            "id. Upstream may have renamed/moved it. (%s)",
            _TARGET_SWITCH_MODULE, _TARGET_LIST_FN, exc,
        )
        return False

    if not getattr(orig_list, _MARK, False):
        setattr(
            switch_mod, _TARGET_LIST_FN,
            _wrap_list_authenticated_providers(orig_list),
        )

    _APPLIED = True
    logger.debug("apex_overlay: picker probe widening seam applied")
    return True
