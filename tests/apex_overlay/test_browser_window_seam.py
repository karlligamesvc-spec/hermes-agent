"""Seam-test + behavior test for apex_overlay.browser_window (hc-1179).

Pins the two upstream symbols the Desktop browser window rides on, so an upstream
rename turns a silently-disarmed seam into a loud CI failure:
  * tools.browser_tool._build_browser_env           — where the persistent profile is pinned
  * tools.browser_tool_session._apply_chromium_sandbox_args — where hide-automation merges

Behavior proven:
  * headed + no caller profile → a persistent AGENT_BROWSER_PROFILE is pinned;
  * a caller/Bot-Desktop/sandbox profile is never overridden; headless pins nothing;
  * apex.browser_hide_automation off → launch args untouched (the default);
  * on → the flag is appended, merged with existing sandbox args, deduped.

Run via scripts/run_tests_parallel.py (per-file fresh interpreter).
"""

from __future__ import annotations

import inspect

from apex_overlay import browser_window


# ---------------------------------------------------------------------------
# Seam assertions — pin the patched symbols
# ---------------------------------------------------------------------------

def test_seam_target_build_browser_env_exists():
    import tools.browser_tool as bt

    fn = getattr(bt, browser_window._BUILD_ENV_FN, None)
    assert callable(fn), (
        "tools.browser_tool._build_browser_env is gone — the persistent browser "
        "profile can no longer be pinned. Update browser_window._BUILD_ENV_FN."
    )
    # Upstream is zero-arg; the wrapper forwards (*args, **kwargs) for future-proofing.
    assert len(inspect.signature(fn).parameters) == 0


def test_seam_target_apply_chromium_sandbox_args_exists():
    import tools.browser_tool_session as bts

    fn = getattr(bts, browser_window._SANDBOX_ARGS_FN, None)
    assert callable(fn), (
        "tools.browser_tool_session._apply_chromium_sandbox_args is gone — the "
        "hide-automation arg can no longer merge after the sandbox decision. Update "
        "browser_window._SANDBOX_ARGS_FN."
    )
    params = list(inspect.signature(fn).parameters)
    assert params and params[0] == "browser_env"


def test_apply_wraps_both_and_is_idempotent():
    import tools.browser_tool as bt
    import tools.browser_tool_session as bts

    browser_window._APPLIED = False
    assert browser_window.apply() is True
    assert getattr(getattr(bt, browser_window._BUILD_ENV_FN), browser_window._MARK, False)
    assert getattr(getattr(bts, browser_window._SANDBOX_ARGS_FN), browser_window._MARK, False)

    build_ref = getattr(bt, browser_window._BUILD_ENV_FN)
    args_ref = getattr(bts, browser_window._SANDBOX_ARGS_FN)
    assert browser_window.apply() is True  # second apply is a no-op (no double-wrap)
    assert getattr(bt, browser_window._BUILD_ENV_FN) is build_ref
    assert getattr(bts, browser_window._SANDBOX_ARGS_FN) is args_ref


# ---------------------------------------------------------------------------
# Persistent profile — only headed, only when the caller set none
# ---------------------------------------------------------------------------

def test_headed_pins_persistent_profile_when_absent(monkeypatch):
    monkeypatch.setattr(browser_window, "_headed", lambda: True)
    monkeypatch.setattr(browser_window, "persistent_profile_dir", lambda: "/home/me/.hermes/apex-browser-profile")

    wrapped = browser_window._wrap_build_browser_env(lambda: {"PATH": "/usr/bin"})
    env = wrapped()
    assert env["AGENT_BROWSER_PROFILE"] == "/home/me/.hermes/apex-browser-profile"


def test_existing_profile_is_never_overridden(monkeypatch):
    monkeypatch.setattr(browser_window, "_headed", lambda: True)
    monkeypatch.setattr(browser_window, "persistent_profile_dir", lambda: "/ours")

    # Bot Desktop / sandbox / a user override already set one — leave it.
    wrapped = browser_window._wrap_build_browser_env(lambda: {"AGENT_BROWSER_PROFILE": "/theirs"})
    assert wrapped()["AGENT_BROWSER_PROFILE"] == "/theirs"


def test_headless_pins_nothing(monkeypatch):
    monkeypatch.setattr(browser_window, "_headed", lambda: False)
    monkeypatch.setattr(browser_window, "persistent_profile_dir", lambda: "/ours")

    wrapped = browser_window._wrap_build_browser_env(lambda: {"PATH": "/usr/bin"})
    assert "AGENT_BROWSER_PROFILE" not in wrapped()


def test_build_env_wrapper_never_raises(monkeypatch):
    def _boom():
        raise RuntimeError("hermes home unavailable")

    monkeypatch.setattr(browser_window, "_headed", lambda: True)
    monkeypatch.setattr(browser_window, "persistent_profile_dir", _boom)

    wrapped = browser_window._wrap_build_browser_env(lambda: {"PATH": "/usr/bin"})
    assert wrapped() == {"PATH": "/usr/bin"}  # upstream env passes through unchanged


# ---------------------------------------------------------------------------
# Hide-automation — off by default; merges when the switch is on
# ---------------------------------------------------------------------------

def test_hide_automation_off_leaves_args_untouched(monkeypatch):
    monkeypatch.setattr(browser_window, "_hide_automation_enabled", lambda: False)

    def _orig(env):
        env["AGENT_BROWSER_ARGS"] = "--no-sandbox,--disable-dev-shm-usage"

    wrapped = browser_window._wrap_apply_chromium_sandbox_args(_orig)
    env = {}
    wrapped(env)
    assert env["AGENT_BROWSER_ARGS"] == "--no-sandbox,--disable-dev-shm-usage"
    assert browser_window.AUTOMATION_HIDE_ARG not in env["AGENT_BROWSER_ARGS"]


def test_hide_automation_on_appends_and_merges(monkeypatch):
    monkeypatch.setattr(browser_window, "_hide_automation_enabled", lambda: True)

    # Upstream set the sandbox-bypass args first; the flag must merge, not replace them.
    def _orig(env):
        env["AGENT_BROWSER_ARGS"] = "--no-sandbox,--disable-dev-shm-usage"

    wrapped = browser_window._wrap_apply_chromium_sandbox_args(_orig)
    env = {}
    wrapped(env)
    parts = env["AGENT_BROWSER_ARGS"].split(",")
    assert "--no-sandbox" in parts
    assert "--disable-dev-shm-usage" in parts
    assert browser_window.AUTOMATION_HIDE_ARG in parts


def test_hide_automation_on_with_no_existing_args(monkeypatch):
    monkeypatch.setattr(browser_window, "_hide_automation_enabled", lambda: True)

    wrapped = browser_window._wrap_apply_chromium_sandbox_args(lambda env: None)
    env = {}
    wrapped(env)
    assert env["AGENT_BROWSER_ARGS"] == browser_window.AUTOMATION_HIDE_ARG


def test_merge_launch_arg_dedupes_and_normalises():
    assert browser_window._merge_launch_arg("", "--x") == "--x"
    assert browser_window._merge_launch_arg("--a,--b", "--x") == "--a,--b,--x"
    assert browser_window._merge_launch_arg("--a,--x", "--x") == "--a,--x"  # no duplicate
    assert browser_window._merge_launch_arg("--a\n--b", "--x") == "--a,--b,--x"  # newlines normalise


# ---------------------------------------------------------------------------
# Config switch defaults off
# ---------------------------------------------------------------------------

def test_hide_automation_enabled_defaults_off(monkeypatch):
    import hermes_cli.config as cfg

    monkeypatch.setattr(cfg, "read_raw_config_readonly", dict, raising=False)
    assert browser_window._hide_automation_enabled() is False

    monkeypatch.setattr(cfg, "read_raw_config_readonly", lambda: {"apex": {"browser_hide_automation": True}}, raising=False)
    assert browser_window._hide_automation_enabled() is True

    for falsey in ({"apex": {}}, {"apex": {"browser_hide_automation": False}}, {"apex": {"browser_hide_automation": "no"}}):
        monkeypatch.setattr(cfg, "read_raw_config_readonly", lambda v=falsey: v, raising=False)
        assert browser_window._hide_automation_enabled() is False


# ---------------------------------------------------------------------------
# Plugin wiring
# ---------------------------------------------------------------------------

def test_plugin_register_applies_seam():
    from tests.apex_overlay.conftest import run_plugin_register_with_stubbed_seams

    called = run_plugin_register_with_stubbed_seams("_browser_window_plugin_under_test")
    assert "browser_window" in called, "plugin.register() must call browser_window.apply()"
