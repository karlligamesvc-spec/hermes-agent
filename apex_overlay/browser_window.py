"""hc-1179 Desktop browser window: a persistent, visible Chromium the user can sign into.

APEX Desktop's agent drives a Chromium through agent-browser. Two gaps separate it from a
browser a person keeps open and stays logged in to:

- **No persistent profile.** Each turn's ``--session <name>`` is a random id
  (``browser_tool_session._session_record``), so a fresh Chromium profile is used and a
  sign-in never survives the turn. On Linux the Bot Desktop pins one persistent
  user-data-dir per profile (``bot_desktop/browser.py``), but Mac and Windows have no Bot
  Desktop, so nothing pins it there and every browse starts signed out.
- **Headless.** ``browser.headed`` defaults False, so no window shows and the user can
  neither watch nor take over a sign-in.

Headed is turned on for Desktop in the product-config seed (``apex-managed.ts``
``browser.headed: true``). This seam adds the other half: when headed is on and the caller
has not pinned its own ``AGENT_BROWSER_PROFILE``, point agent-browser at a persistent
per-profile directory, so a sign-in in the window is still signed in next turn. One
Chromium user-data-dir per assistant home keeps each assistant's logins its own (matching
the per-agent isolation elsewhere). Like any single persistent profile it serializes the
window — two concurrent agent-browser daemons on one user-data-dir collide — which is the
same single-window model a person works in.

It also carries an **off-by-default** switch, ``apex.browser_hide_automation``: when a
human turns it on, ``--disable-blink-features=AutomationControlled`` is appended to the
Chromium launch args. That changes how third-party sites see the browser, so it ships OFF
and enabling it is a platform-rules / legal decision, never a default. This seam only
flips a launch flag; it solves no human-verification challenge and inspects no site's
defenses.

Both wraps are idempotent (``_MARK`` sentinel) and fail-safe: a missing upstream symbol
logs and returns False (the seam-test turns that into a hard CI failure) but never raises
into plugin discovery. The persistent profile is gated on headed mode, so cloud (headless)
is untouched; the hide-automation arg is gated on its own switch, which is absent there.
"""

from __future__ import annotations

import functools
import logging
import os

logger = logging.getLogger(__name__)

# Truthy spellings, mirroring the other overlay seams (stt_no_lazy_install, region).
_TRUE_ENV = {"1", "true", "yes", "on"}

# Off-by-default config switch (apex: block in config.yaml). A human sets it to true.
HIDE_AUTOMATION_KEY = "browser_hide_automation"
# The Chromium launch flag agent-browser documents under --args; appended, never exclusive.
AUTOMATION_HIDE_ARG = "--disable-blink-features=AutomationControlled"

# Per-assistant persistent Chromium user-data-dir, under this profile's Hermes home.
PROFILE_DIR_NAME = "apex-browser-profile"

_BUILD_ENV_MODULE = "tools.browser_tool"
_BUILD_ENV_FN = "_build_browser_env"
_SANDBOX_ARGS_MODULE = "tools.browser_tool_session"
_SANDBOX_ARGS_FN = "_apply_chromium_sandbox_args"

_APPLIED = False
_MARK = "_apex_overlay_browser_window"


def _headed() -> bool:
    """True when the browser launches a window (``browser.headed`` / ``AGENT_BROWSER_HEADED``).

    Fully defensive: any error resolves to False (no persistent profile), the
    behaviour-preserving default. The Desktop product seed sets ``browser.headed: true``;
    cloud stays headless.
    """
    try:
        from tools.browser_tool_cloud import _is_headed_mode

        return bool(_is_headed_mode())
    except Exception:
        logger.debug("apex_overlay: headed-mode probe failed; falling back to env", exc_info=True)
        return (os.environ.get("AGENT_BROWSER_HEADED", "") or "").strip().lower() in _TRUE_ENV


def _hide_automation_enabled() -> bool:
    """``apex.browser_hide_automation`` from the raw profile config. Default False, defensive.

    Read fresh per command so a human flipping it in settings takes effect without a
    restart. Never raises: any error means "off", so the window keeps Chromium's default
    automation markers.
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


def _merge_launch_arg(existing: str, arg: str) -> str:
    """Append ``arg`` to a comma/newline-separated agent-browser ``--args`` list, deduped.

    agent-browser accepts comma- or newline-separated launch args; this normalises to a
    comma list and never adds a token already present (idempotent across repeated commands
    and co-existing with the sandbox-bypass flags the wrapped function may have set).
    """
    parts = [p.strip() for p in (existing or "").replace("\n", ",").split(",") if p.strip()]
    if arg not in parts:
        parts.append(arg)
    return ",".join(parts)


def _wrap_build_browser_env(orig):
    """Pin a persistent per-profile ``AGENT_BROWSER_PROFILE`` for the headed Desktop window.

    Only when headed and the caller (Bot Desktop, the sandbox, or a user override) has not
    already set one: a sign-in in the visible window is then still signed in next turn,
    instead of a throwaway profile per random ``--session``. Headless callers are unchanged.
    """

    @functools.wraps(orig)
    def wrapper(*args, **kwargs):
        env = orig(*args, **kwargs)
        try:
            if _headed() and isinstance(env, dict) and not env.get("AGENT_BROWSER_PROFILE"):
                env["AGENT_BROWSER_PROFILE"] = persistent_profile_dir()
        except Exception:
            # Never let the pin break a browser call — fall through with upstream's env.
            logger.debug("apex_overlay: persistent browser profile pin skipped", exc_info=True)
        return env

    setattr(wrapper, _MARK, True)
    return wrapper


def _wrap_apply_chromium_sandbox_args(orig):
    """After the sandbox-bypass decision, append the hide-automation flag when the switch is on.

    Runs *after* upstream has (or has not) set the sandbox-bypass args, so the flag merges
    with them instead of suppressing them. Off by default; a no-op unless a human enabled
    ``apex.browser_hide_automation``.
    """

    @functools.wraps(orig)
    def wrapper(browser_env, *args, **kwargs):
        result = orig(browser_env, *args, **kwargs)
        try:
            if _hide_automation_enabled() and isinstance(browser_env, dict):
                browser_env["AGENT_BROWSER_ARGS"] = _merge_launch_arg(
                    browser_env.get("AGENT_BROWSER_ARGS", ""), AUTOMATION_HIDE_ARG
                )
        except Exception:
            logger.debug("apex_overlay: hide-automation arg not applied", exc_info=True)
        return result

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

    Returns True when both wraps are in place (or already were), False if either upstream
    symbol is missing (seam-test → hard CI failure). Never raises into plugin discovery.
    """
    global _APPLIED
    if _APPLIED:
        return True

    ok_profile = _install(_BUILD_ENV_MODULE, _BUILD_ENV_FN, _wrap_build_browser_env)
    ok_args = _install(_SANDBOX_ARGS_MODULE, _SANDBOX_ARGS_FN, _wrap_apply_chromium_sandbox_args)

    if ok_profile and ok_args:
        _APPLIED = True
        logger.debug("apex_overlay: Desktop browser window seam applied")
        return True
    return False
