"""Keep the platform model list intact while a composed multi-model selection
is active (desktop v0.16.17 multi-select regression).

What this fixes
===============
The desktop's silent multi-select (hc-578, MOA-INVISIBLE-DESIGN) composes 2+
platform models into a hidden preset and then assigns the main model to the
**virtual** provider ``moa``::

    POST /api/model/set {scope: "main", provider: "moa", model: "__auto__"}

``moa`` is not an endpoint — it has no ``base_url`` of its own, and
``_apply_main_model_assignment`` (hermes_cli/web_server.py) clears
``model.base_url`` on a provider switch, so after the second click config holds
``model.provider: moa`` and an empty ``model.base_url``.

Every normal picker open (the gateway ``model.options`` JSON-RPC and the REST
``/api/model/options``) asks upstream for the cheap probe policy::

    probe_custom_providers=False          # don't block on every saved endpoint
    probe_current_custom_provider=True    # but DO probe the current one

Upstream resolves "the current one" by matching the row's slug against
``model.provider`` (``hermes_cli/model_switch.py``, section 4:
``_grp_is_current = slug.lower() == _current_provider_norm or ...``). With
``moa`` as the main provider, **no** custom row matches — so nothing is probed
at all, and the ApexNodes relay row falls back to the single model id declared
in ``custom_providers`` (``deepseek-v4-pro-APEX``; the desktop writes exactly
one, see ``apps/desktop/electron/apex-managed.cjs`` ``buildManagedModelBlock``).

Net user-visible result: the moment a second model is checked, the APEX group
collapses from the relay's full catalog (GLM / Qwen / Doubao / Kimi / …) to one
row. The user cannot check a third model, and — because the collapse is driven
by on-disk config, not by session state — it survives an app restart and hits
Settings › Model too. This is the same "list shrank to one model" failure the
relay-key self-heal already documents (apex-managed.cjs), reached by a second
route: there the probe 401s, here it never runs.

The fix
=======
When the main provider is the virtual ``moa``, re-interpret the caller's
"probe the current custom endpoint" as "probe the saved custom endpoints".
There is no current endpoint to single out — the models the user actually
selected are served by the member endpoints of the composed preset — so
probing the saved custom providers is both the correct reading of the intent
and exactly the work that used to happen one click earlier, when the relay was
still the current provider. Cost is unchanged in practice: a composed selection
is platform-only (v1 refuses to mix BYO with a platform multi-selection), so
the single relay row is the only custom endpoint in play.

Deliberately narrow: the rewrite only fires when the caller asked for the
current-endpoint probe AND opted out of the broad probe. A caller that asked
for neither ("show me configured models, touch no network") is left alone, and
a caller that already probes everything needs nothing.

Why a seam (and not an in-place edit)
=====================================
``hermes_cli/model_switch.py`` is a hot upstream file; the overlay discipline
(config > plugin > upstream PR > in-place) keeps it byte-for-byte upstream and
re-applies our behavior at load time. Same pattern and same wrapped symbol as
``apex_overlay.provider_filter`` and ``apex_overlay.model_catalog_dedupe`` —
each wrapper carries its own idempotence mark, so stacking is safe and
order-independent (this one only rewrites *inputs*, the other two only read or
edit the returned rows).

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
_MARK = "_apex_overlay_moa_picker_probe"

# The virtual aggregate provider a composed multi-model selection assigns to
# ``model.provider``. Matches AUTO_PRESET_NAME's provider in
# apps/desktop/src/lib/moa-compose.ts and upstream's own ``moa`` picker row
# (hermes_cli/inventory.py ``_moa_provider_row``).
VIRTUAL_MOA_PROVIDER = "moa"


def probe_flags_for(
    current_provider: str,
    *,
    probe_custom_providers: bool,
    probe_current_custom_provider: bool,
) -> tuple[bool, bool]:
    """Resolve the effective ``(broad, current_only)`` probe flags.

    Pure so the whole rule is table-testable without upstream or the network.
    Returns the flags unchanged for every provider except the virtual ``moa``,
    and even there only when the caller asked for the current-endpoint probe
    while opting out of the broad one — the picker's normal-open policy.
    """
    if str(current_provider or "").strip().lower() != VIRTUAL_MOA_PROVIDER:
        return probe_custom_providers, probe_current_custom_provider

    if probe_custom_providers or not probe_current_custom_provider:
        return probe_custom_providers, probe_current_custom_provider

    # No row can be "the current custom endpoint" when the current provider is
    # virtual — widen to the saved custom endpoints so the row that actually
    # serves the composed selection still reports its live catalog.
    return True, probe_current_custom_provider


def _wrap_list_authenticated_providers(orig: Callable) -> Callable:
    """Widen the probe policy for a virtual-``moa`` main provider.

    Rewrites only the two probe keyword arguments; every other argument and the
    return value pass through untouched, so this composes with the seams that
    post-process the returned rows.
    """

    @functools.wraps(orig)
    def wrapper(*args, **kwargs) -> List[dict]:
        try:
            # ``current_provider`` is the first positional parameter; the two
            # probe flags are keyword-only upstream, so they can only arrive in
            # kwargs (absent ⇒ upstream's defaults).
            current_provider = kwargs.get("current_provider", args[0] if args else "")
            broad, current_only = probe_flags_for(
                current_provider,
                probe_custom_providers=kwargs.get("probe_custom_providers", True),
                probe_current_custom_provider=kwargs.get(
                    "probe_current_custom_provider", False
                ),
            )
            if broad != kwargs.get("probe_custom_providers", True):
                kwargs = dict(kwargs, probe_custom_providers=broad)
                logger.debug(
                    "apex_overlay: virtual 'moa' main provider — widened custom "
                    "endpoint probing so the platform catalog stays complete"
                )
        except Exception:
            # Never let the overlay break the host path — the un-widened call
            # still returns a usable (if collapsed) picker payload.
            logger.debug("apex_overlay: moa picker probe widening skipped", exc_info=True)

        return orig(*args, **kwargs)

    setattr(wrapper, _MARK, True)
    return wrapper


def apply() -> bool:
    """Install the virtual-``moa`` probe seam onto upstream. Idempotent.

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
            "apex_overlay: could not patch %s.%s — the virtual-'moa' picker "
            "probe seam is NOT active, so composing a multi-model selection "
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
    logger.debug("apex_overlay: virtual-'moa' picker probe seam applied")
    return True
