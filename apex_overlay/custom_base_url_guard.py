"""Keep ``model.base_url`` pointing at the custom endpoint the runtime routes
to — the write side of the desktop model-picker collapse.

The damage
==========
The managed ApexNodes relay is registered as the **bare** ``custom`` provider
(``apps/desktop/electron/apex-managed.ts`` ``MANAGED_PROVIDER = 'custom'``).
Bare ``custom`` has no registry entry and no default host: its entire endpoint
identity is ``model.base_url``.

``hermes_cli/web_server.py`` ``_apply_main_model_assignment`` clears
``base_url`` whenever the provider changes::

    elif model_cfg.get("base_url") and new_provider != prev_provider:
        # Switching providers: the old URL belonged to the old provider, drop
        # it so the new provider's default endpoint is used.

Sound for a registry provider — ``deepseek`` knows its own host. For the custom
family there is no default endpoint to fall back to, so the clear does not
"reset to default", it **erases the only copy of the address**. A single round
trip through the desktop's silent multi-select (relay → virtual ``moa`` → back
to one model) is enough to land::

    model:
      provider: custom
      base_url: ''          # <- erased
    custom_providers:
      - name: Apex-nodes.com
        base_url: https://apex-nodes.com/relay/v1     # <- still right there

Chat keeps working (upstream's ``resolve_custom_provider`` has its own
bare-``custom`` fallback to the first saved entry — GH #17478), which is why
this hides in plain sight. The model **picker** is not so lucky: its
"probe the current custom endpoint" policy matches rows by slug or by URL, and
a blank URL matches nothing, so the live catalog is never fetched and the APEX
group collapses to the one model id declared in config. See
``apex_overlay.picker_probe_widening`` for that read-side story.

What this seam does
===================
1. **Stops the erasure.** Wraps ``_apply_main_model_assignment`` so that when
   the assignment targets the custom family and the caller supplied no URL, a
   blank result is back-filled with the endpoint upstream's own resolver
   already routes that provider to. Nothing is invented: the value written is
   exactly what ``resolve_custom_provider`` returns for that provider name, so
   config merely records the routing that was happening implicitly.

2. **Heals configs already stranded.** ``apply()`` runs a one-shot repair at
   boot for installs damaged before this shipped (Kael's machine, and every
   user who has already multi-selected).

Both are white-listed to the narrow case and never overwrite an explicit
value:

- an explicitly supplied ``base_url`` always wins — the caller is being
  specific and is never second-guessed;
- a ``base_url`` upstream *preserved* is left alone — nothing to repair;
- a target outside the custom family keeps upstream's clear verbatim, because
  there the clear is correct (a registry provider's default host takes over);
- the boot repair only ever fills a **blank** ``base_url``, so a user-set
  value cannot be touched, and it is idempotent — a repaired config produces
  no second write.

Why a seam (and not an in-place edit)
=====================================
``hermes_cli/web_server.py`` is a hot upstream file; the overlay discipline
(config > plugin > upstream PR > in-place) keeps it byte-for-byte upstream and
re-applies our behavior at load time.

Unlike the other seams, the wrapped symbol lives in the **dashboard** module,
which the gateway and plain-CLI processes never import (a whole FastAPI app,
+215 modules) — and ``apply()`` runs from inside plugin discovery, while
``web_server`` imports ``plugins.memory.config_schema`` at module scope, so
importing it eagerly would also re-enter the package discovery is walking.
Hence the one-shot import hook below: patch it now if it is already loaded,
otherwise patch it the instant something imports it, and cost nothing in the
processes that never do.

This module is import-safe and ``apply()`` is idempotent.
"""

from __future__ import annotations

import functools
import importlib.util
import logging
import sys
from typing import Any, Callable, Dict, Optional

logger = logging.getLogger(__name__)

# The upstream symbols this seam binds against. Centralized so the seam-test
# can assert they still exist with a compatible shape. If upstream renames or
# moves them, both the patch AND the seam-test break loudly.
_TARGET_WEB_MODULE = "hermes_cli.web_server"
_TARGET_ASSIGN_FN = "_apply_main_model_assignment"

# Guard so apply() is idempotent even if called from multiple boot paths.
_APPLIED = False
_MARK = "_apex_overlay_custom_base_url_guard"

# The custom-provider family: the bare slug (endpoint identity lives in
# ``model.base_url``) and the named form ``custom:<slug>`` that
# ``custom_provider_slug`` mints for a ``custom_providers`` entry. Upstream
# groups the same two shapes in ``model_switch.switch_model``'s ``is_custom``.
BARE_CUSTOM_PROVIDER = "custom"
NAMED_CUSTOM_PREFIX = "custom:"


def in_custom_family(provider: str) -> bool:
    """Is ``provider`` a custom endpoint slug (bare ``custom`` or ``custom:x``)?

    These are the providers with no registry default host, i.e. the ones for
    which clearing ``base_url`` loses the address instead of resetting it.
    """
    normalized = str(provider or "").strip().lower()
    return normalized == BARE_CUSTOM_PROVIDER or normalized.startswith(NAMED_CUSTOM_PREFIX)


def routed_endpoint_url(provider: str, config: Optional[Dict[str, Any]] = None) -> str:
    """The base URL upstream's own resolver routes ``provider`` to, or ``""``.

    Delegates to ``hermes_cli.providers.resolve_custom_provider`` over the same
    merged ``custom_providers`` + ``providers`` view the runtime uses, so this
    seam can only ever persist a routing decision upstream already makes — a
    named ``custom:<slug>`` resolves to its own row, and bare ``custom``
    resolves through upstream's documented first-valid-entry fallback.
    Returns ``""`` for anything outside the custom family, and for an install
    with no usable custom endpoint at all.
    """
    if not in_custom_family(provider):
        return ""
    try:
        from hermes_cli.config import get_compatible_custom_providers, load_config
        from hermes_cli.providers import resolve_custom_provider

        cfg = load_config() if config is None else config
        resolved = resolve_custom_provider(
            str(provider).strip(), get_compatible_custom_providers(cfg)
        )
    except Exception:
        logger.debug("apex_overlay: custom endpoint resolution failed", exc_info=True)
        return ""
    return str(getattr(resolved, "base_url", "") or "").strip() if resolved else ""


def blank_custom_base_url_repair(config: Dict[str, Any]) -> str:
    """The URL a stranded config needs written into ``model.base_url``.

    Returns ``""`` — meaning "leave this config alone" — unless all three of
    the damage signature hold: the main provider is bare ``custom``, its
    ``base_url`` is blank, and a saved custom endpoint can be resolved. A
    non-blank ``base_url`` is a value the user (or a correct assignment) put
    there and is never touched, which is also what makes the repair idempotent.
    """
    model = config.get("model") if isinstance(config, dict) else None
    if not isinstance(model, dict):
        return ""
    if str(model.get("provider") or "").strip().lower() != BARE_CUSTOM_PROVIDER:
        return ""
    if str(model.get("base_url") or "").strip():
        return ""
    return routed_endpoint_url(BARE_CUSTOM_PROVIDER, config)


def repair_config_base_url() -> bool:
    """One-shot boot self-heal for an already-stranded config. Idempotent.

    Returns ``True`` only when a repair was actually written. Managed installs
    are skipped outright — ``save_config`` refuses there and would print an
    administrator warning on every boot.
    """
    try:
        from hermes_cli.config import is_managed, load_config, save_config

        if is_managed():
            return False
        config = load_config()
        repaired_url = blank_custom_base_url_repair(config)
        if not repaired_url:
            return False
        config["model"]["base_url"] = repaired_url
        save_config(config)
    except Exception:
        logger.debug("apex_overlay: custom base_url boot repair skipped", exc_info=True)
        return False

    logger.info(
        "apex_overlay: restored model.base_url for the bare 'custom' provider "
        "from the saved custom endpoint — the model picker can probe the live "
        "catalog again"
    )
    return True


def _wrap_apply_main_model_assignment(orig: Callable) -> Callable:
    """Stop a custom-family assignment from persisting an empty ``base_url``.

    Runs after upstream so its own preservation rules (explicit URL wins,
    same-provider re-pick keeps the URL) decide first; this only fills a blank
    the clear-on-switch branch would otherwise leave behind.
    """

    @functools.wraps(orig)
    def wrapper(model_cfg, provider, model, base_url="", api_key="", **kwargs):
        result = orig(model_cfg, provider, model, base_url, api_key, **kwargs)
        try:
            if str(base_url or "").strip():
                return result  # caller was explicit — never second-guess it
            if not isinstance(result, dict):
                return result
            if str(result.get("base_url") or "").strip():
                return result  # upstream kept one — nothing was lost
            if not in_custom_family(provider):
                return result  # registry provider: the clear is correct

            routed_url = routed_endpoint_url(provider)
            if routed_url:
                result["base_url"] = routed_url
                logger.debug(
                    "apex_overlay: kept model.base_url on the custom-family "
                    "switch to %r (%s) — clearing it would erase the endpoint",
                    provider, routed_url,
                )
        except Exception:
            # Never let the overlay break the host path — upstream's own
            # assignment already landed and is returned untouched.
            logger.debug("apex_overlay: custom base_url guard skipped", exc_info=True)

        return result

    setattr(wrapper, _MARK, True)
    return wrapper


def _patch_web_server(module) -> bool:
    """Install the assignment wrapper onto an imported ``web_server`` module."""
    orig = getattr(module, _TARGET_ASSIGN_FN, None)
    if orig is None:
        logger.error(
            "apex_overlay: could not patch %s.%s — switching models inside the "
            "custom provider family will keep erasing model.base_url, which "
            "collapses the platform model picker to one id. Upstream may have "
            "renamed/moved it.",
            _TARGET_WEB_MODULE, _TARGET_ASSIGN_FN,
        )
        return False
    if not getattr(orig, _MARK, False):
        setattr(module, _TARGET_ASSIGN_FN, _wrap_apply_main_model_assignment(orig))
    return True


class _PatchOnImport:
    """One-shot ``sys.meta_path`` finder that patches web_server as it loads.

    Delegates the actual finding to the rest of ``sys.meta_path`` (guarded
    against re-entering itself), wraps the returned loader's ``exec_module`` so
    the patch lands the moment the module body finishes, then unhooks itself.
    """

    def __init__(self) -> None:
        self._busy = False

    def find_spec(self, fullname, path=None, target=None):
        if fullname != _TARGET_WEB_MODULE or self._busy:
            return None
        self._busy = True
        try:
            spec = importlib.util.find_spec(fullname)
        except Exception:
            logger.debug("apex_overlay: web_server spec lookup failed", exc_info=True)
            return None
        finally:
            self._busy = False

        loader = getattr(spec, "loader", None)
        inner_exec = getattr(loader, "exec_module", None)
        if loader is None or inner_exec is None:
            return None

        def exec_module(module):
            inner_exec(module)
            self.unhook()
            _patch_web_server(module)

        setattr(loader, "exec_module", exec_module)
        return spec

    def unhook(self) -> None:
        try:
            sys.meta_path.remove(self)
        except ValueError:
            pass


def apply() -> bool:
    """Install the base_url guard + run the boot self-heal. Idempotent.

    Returns ``True`` if the guard is in place (or armed for a later import),
    ``False`` if the target symbol was missing from an already-loaded
    ``web_server`` (which the seam-test turns into a hard CI failure). Safe to
    call from any boot path.
    """
    global _APPLIED
    if _APPLIED:
        return True

    loaded = sys.modules.get(_TARGET_WEB_MODULE)
    if loaded is not None:
        patched = _patch_web_server(loaded)
    else:
        sys.meta_path.insert(0, _PatchOnImport())
        patched = True

    _APPLIED = True
    repair_config_base_url()
    logger.debug("apex_overlay: custom base_url guard seam applied")
    return patched
