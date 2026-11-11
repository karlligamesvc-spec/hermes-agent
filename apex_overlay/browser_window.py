"""hc-1179 Desktop browser window: a persistent, visible Chromium the user can sign into.

Ported to Hermes v0.23.0 in hc-1203. v0.23.0 removed agent-browser: ``browser_exec`` drives the
Chromium that ``tools.browser_session`` launches through ``tools.browser_launcher``, and that path
reads three settings of its own, which carry hc-1179's three asks:

- **A window.** ``browser.headed`` (``tools.browser_session_cloud.is_headed_mode``). The Desktop
  product seed sets it (``apex-managed.ts`` ``browser.headed: true``); cloud stays headless.
- **Sign-ins that last.** ``browser.user_data_dir``: one persistent profile every session of this
  assistant shares (``tools.browser_session._launch_target`` keys the Chromium by that directory, so
  it is one window), ``""`` meaning a throwaway profile per session. This seam answers
  ``<HERMES_HOME>/apex-browser-profile`` when nothing is pinned and the window is headed on a Mac or
  Windows Desktop, so a sign-in in the window is still signed in next time. One directory per
  assistant home keeps each assistant's logins its own. A profile the user pinned always wins;
  headless (the cloud) gets nothing; Linux is left alone, where the Bot Desktop pins its own
  profile through the same setting (``tools.bot_desktop.browser.profile_dir``).
- **An off-by-default switch,** ``apex.browser_hide_automation``: when a human turns it on,
  ``--disable-blink-features=AutomationControlled`` joins ``browser.chromium_args``, which
  ``tools.browser_launcher.build_chromium_argv`` appends to every launch. It changes how
  third-party sites see the browser, so it ships OFF and enabling it is a platform-rules / legal
  decision, never a default. This seam only adds a launch flag; it solves no human-verification
  challenge and inspects no site's defenses.

Both accessors are read at call time by their callers (``from tools.browser_session_cloud import …``
inside the function), and neither is memoized, so wrapping the module attribute reaches every
launch and a switch flipped in settings applies on the next launch without a restart. Both wraps
are idempotent (``_MARK``) and fail-safe: a missing upstream symbol logs and returns False (the
seam test turns that into a hard CI failure) but never raises into plugin discovery, and an error
inside a wrapper falls back to upstream's answer.
"""

from __future__ import annotations

import functools
import logging
import sys

logger = logging.getLogger(__name__)

# Truthy spellings, mirroring the other overlay seams (stt_no_lazy_install, region).
_TRUE_ENV = {"1", "true", "yes", "on"}

# Off-by-default config switch (apex: block in config.yaml). A human sets it to true.
HIDE_AUTOMATION_KEY = "browser_hide_automation"
# The Chromium launch flag; appended to browser.chromium_args, never exclusive.
AUTOMATION_HIDE_ARG = "--disable-blink-features=AutomationControlled"

# Per-assistant persistent Chromium user-data-dir, under this profile's Hermes home.
PROFILE_DIR_NAME = "apex-browser-profile"

# APEX Desktop ships for these; Linux keeps upstream's answer (the Bot Desktop pins its own profile).
_DESKTOP_PLATFORMS = ("darwin", "win32")

_CONFIG_MODULE = "tools.browser_session_cloud"
_USER_DATA_DIR_FN = "user_data_dir"
_CHROMIUM_ARGS_FN = "chromium_args"

_APPLIED = False
_MARK = "_apex_overlay_browser_window"


def _on_desktop_platform() -> bool:
    """A Mac or Windows host: where APEX Desktop runs and no Bot Desktop pins a profile."""
    return sys.platform in _DESKTOP_PLATFORMS


def _headed() -> bool:
    """``browser.headed`` as the launcher reads it. Any error means False (no persistent profile)."""
    try:
        from tools.browser_session_cloud import is_headed_mode

        return bool(is_headed_mode())
    except Exception:
        logger.debug("apex_overlay: headed-mode probe failed", exc_info=True)
        return False


def _hide_automation_enabled() -> bool:
    """``apex.browser_hide_automation`` from the raw profile config. Default False, defensive.

    Read fresh per launch so a human flipping it in settings takes effect without a restart. Never
    raises: any error means "off", so the window keeps Chromium's default automation markers.
    """
    try:
        from hermes_cli.config import read_raw_config_readonly

        apex_cfg = read_raw_config_readonly().get("apex", {})
        if isinstance(apex_cfg, dict):
            return str(apex_cfg.get(HIDE_AUTOMATION_KEY, "")).strip().lower() in _TRUE_ENV
    except Exception:
        logger.debug("apex_overlay: could not read apex.%s", HIDE_AUTOMATION_KEY, exc_info=True)
    return False


def persistent_profile_dir() -> str:
    """This assistant's durable Chromium user-data-dir (``<HERMES_HOME>/apex-browser-profile``)."""
    from hermes_constants import get_hermes_home

    return str(get_hermes_home() / PROFILE_DIR_NAME)


def _wrap_user_data_dir(orig):
    """Answer the persistent per-assistant profile when nothing is pinned and the Desktop window is headed."""

    @functools.wraps(orig)
    def wrapper(*args, **kwargs):
        pinned = orig(*args, **kwargs)
        if pinned:
            return pinned  # the user's own browser.user_data_dir (or the Bot Desktop's) always wins
        try:
            if _on_desktop_platform() and _headed():
                return persistent_profile_dir()
        except Exception:
            # Never let the default break a browser launch: upstream's throwaway profile instead.
            logger.debug("apex_overlay: persistent browser profile default skipped", exc_info=True)
        return pinned

    setattr(wrapper, _MARK, True)
    return wrapper


def _wrap_chromium_args(orig):
    """Add the hide-automation flag to ``browser.chromium_args`` while the switch is on (once)."""

    @functools.wraps(orig)
    def wrapper(*args, **kwargs):
        configured = orig(*args, **kwargs)
        try:
            if _hide_automation_enabled() and AUTOMATION_HIDE_ARG not in configured:
                return [*configured, AUTOMATION_HIDE_ARG]
        except Exception:
            logger.debug("apex_overlay: hide-automation arg not applied", exc_info=True)
        return configured

    setattr(wrapper, _MARK, True)
    return wrapper


def _install(module_name: str, fn_name: str, make_wrapper) -> bool:
    """Wrap ``module_name.fn_name`` once. False (not raise) when the symbol is gone."""
    import importlib

    try:
        mod = importlib.import_module(module_name)
        orig = getattr(mod, fn_name)
        if not getattr(orig, _MARK, False):
            setattr(mod, fn_name, make_wrapper(orig))
        return True
    except (ImportError, AttributeError) as exc:
        logger.error(
            "apex_overlay: could not wrap %s.%s — the Desktop browser window seam is NOT "
            "fully active. Upstream may have renamed/moved it. (%s)",
            module_name, fn_name, exc,
        )
        return False


def apply() -> bool:
    """Install the persistent-profile and hide-automation wraps. Idempotent, fail-safe.

    Returns True when both wraps are in place (or already were), False if either upstream symbol is
    missing (seam test → hard CI failure). Never raises into plugin discovery.
    """
    global _APPLIED
    if _APPLIED:
        return True

    ok_profile = _install(_CONFIG_MODULE, _USER_DATA_DIR_FN, _wrap_user_data_dir)
    ok_args = _install(_CONFIG_MODULE, _CHROMIUM_ARGS_FN, _wrap_chromium_args)

    if ok_profile and ok_args:
        _APPLIED = True
        logger.debug("apex_overlay: Desktop browser window seam applied")
        return True
    return False
