"""Seam-test + behavior test for apex_overlay.browser_window (hc-1179, ported to v0.23.0 in hc-1203).

Pins the two v0.23.0 accessors the Desktop browser window rides on, so an upstream rename turns a
silently-disarmed seam into a loud CI failure:
  * tools.browser_session_cloud.user_data_dir — where the persistent profile is answered
  * tools.browser_session_cloud.chromium_args — where the hide-automation flag joins

Behavior proven, through the real v0.23.0 session layer and launcher where it matters:
  * a headed Mac/Windows Desktop with no pin gets <HERMES_HOME>/apex-browser-profile, and
    tools.browser_session._launch_target runs every session on that one Chromium;
  * a pinned profile (absolute or HERMES_HOME-relative) is never overridden; headless and Linux get none;
  * apex.browser_hide_automation off → launch args untouched (the default);
  * on → the flag joins browser.chromium_args once and reaches build_chromium_argv.

Run via scripts/run_tests_parallel.py (per-file fresh interpreter).
"""

from __future__ import annotations

import pytest

from apex_overlay import browser_window


def _upstream(fn):
    return fn.__wrapped__ if getattr(fn, browser_window._MARK, False) else fn


@pytest.fixture
def cloud(monkeypatch, tmp_path):
    """Upstream's accessors unwrapped, ``browser:`` read from a dict, the raw config's ``apex:`` from another;
    monkeypatch restores every upstream function afterwards."""
    import hermes_cli.config as cfg
    from tools import browser_session_cloud as mod

    monkeypatch.setattr(mod, "user_data_dir", _upstream(mod.user_data_dir))
    monkeypatch.setattr(mod, "chromium_args", _upstream(mod.chromium_args))
    monkeypatch.setattr(mod, "_memo_slots", {})
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    section: dict = {}
    raw: dict = {}
    monkeypatch.setattr(mod, "browser_section", lambda: section)
    monkeypatch.setattr(cfg, "read_raw_config_readonly", lambda: raw)
    monkeypatch.setattr(browser_window, "_APPLIED", False)
    monkeypatch.setattr(browser_window, "_on_desktop_platform", lambda: True)
    return mod, section, raw, home


# ---------------------------------------------------------------------------
# Seam assertions — pin the patched symbols
# ---------------------------------------------------------------------------

def test_the_v023_accessors_exist():
    """Fails when upstream moves them: the seam would bind nothing and the window would lose its sign-ins."""
    from tools import browser_session_cloud as mod

    assert callable(_upstream(mod.user_data_dir))
    assert callable(_upstream(mod.chromium_args))
    assert callable(mod.is_headed_mode)


def test_apply_wraps_both_and_is_idempotent(cloud, monkeypatch):
    mod, *_ = cloud
    assert browser_window.apply() is True
    wrapped = (mod.user_data_dir, mod.chromium_args)
    assert all(getattr(fn, browser_window._MARK, False) for fn in wrapped)
    monkeypatch.setattr(browser_window, "_APPLIED", False)
    assert browser_window.apply() is True
    assert (mod.user_data_dir, mod.chromium_args) == wrapped


@pytest.mark.parametrize(("platform", "desktop"), [("darwin", True), ("win32", True), ("linux", False)])
def test_only_mac_and_windows_count_as_the_desktop(monkeypatch, platform, desktop):
    monkeypatch.setattr(browser_window.sys, "platform", platform)
    assert browser_window._on_desktop_platform() is desktop


# ---------------------------------------------------------------------------
# Persistent profile (browser.user_data_dir)
# ---------------------------------------------------------------------------

def test_a_headed_desktop_without_a_pin_gets_the_persistent_profile(cloud):
    mod, section, _raw, home = cloud
    section["headed"] = True
    assert browser_window.apply() is True
    assert mod.user_data_dir() == str(home / "apex-browser-profile")


def test_every_session_runs_on_that_one_chromium(cloud, monkeypatch):
    """The real v0.23.0 session layer keys a persistent profile by its directory: one window, not one per task."""
    from tools import browser_session

    _mod, section, _raw, home = cloud
    monkeypatch.setattr(browser_session, "_bot_desktop_target", lambda: None)
    section["headed"] = True
    browser_window.apply()
    profile = str(home / "apex-browser-profile")
    assert browser_session._launch_target("task-1") == (
        f"profile:{profile}", {"user_data_dir": profile, "ephemeral": False}, True)
    assert browser_session._launch_target("task-2")[0] == f"profile:{profile}"


@pytest.mark.parametrize(("pin", "expected"), [("/opt/my-chrome-profile", "/opt/my-chrome-profile"),
                                               ("pinned", "<home>/pinned")])
def test_a_pinned_profile_is_never_overridden(cloud, pin, expected):
    mod, section, _raw, home = cloud
    section.update(headed=True, user_data_dir=pin)
    browser_window.apply()
    assert mod.user_data_dir() == expected.replace("<home>", str(home))


def test_headless_gets_no_profile(cloud):
    mod, section, *_ = cloud
    section["headed"] = False
    browser_window.apply()
    assert mod.user_data_dir() == ""


def test_linux_keeps_upstreams_answer(cloud, monkeypatch):
    """The Bot Desktop pins its own profile through the same setting there."""
    mod, section, *_ = cloud
    monkeypatch.setattr(browser_window, "_on_desktop_platform", lambda: False)
    section["headed"] = True
    browser_window.apply()
    assert mod.user_data_dir() == ""


def test_a_failing_headed_probe_keeps_upstreams_answer(cloud, monkeypatch):
    mod, *_ = cloud

    def unreadable():
        raise RuntimeError("config unreadable")

    monkeypatch.setattr(mod, "is_headed_mode", unreadable)
    browser_window.apply()
    assert mod.user_data_dir() == ""


# ---------------------------------------------------------------------------
# Hide-automation switch (browser.chromium_args)
# ---------------------------------------------------------------------------

def test_hide_automation_off_leaves_the_args_untouched(cloud):
    mod, section, _raw, _home = cloud
    section["chromium_args"] = ["--lang=zh-CN"]
    browser_window.apply()
    assert mod.chromium_args() == ["--lang=zh-CN"]


def test_hide_automation_on_adds_the_flag_once_and_it_reaches_the_launch(cloud):
    from tools import browser_launcher

    mod, section, raw, _home = cloud
    section["chromium_args"] = ["--lang=zh-CN"]
    raw["apex"] = {"browser_hide_automation": True}
    browser_window.apply()
    assert mod.chromium_args() == ["--lang=zh-CN", browser_window.AUTOMATION_HIDE_ARG]
    argv = browser_launcher.build_chromium_argv("/x/chrome", "/x/profile", packaged=False, headed=True,
                                                sandbox_bypass=False)
    assert argv.count(browser_window.AUTOMATION_HIDE_ARG) == 1
    section["chromium_args"] = ["--lang=zh-CN", browser_window.AUTOMATION_HIDE_ARG]  # the user listed it too
    assert mod.chromium_args().count(browser_window.AUTOMATION_HIDE_ARG) == 1


def test_hide_automation_on_with_no_configured_args(cloud):
    mod, _section, raw, _home = cloud
    raw["apex"] = {"browser_hide_automation": "yes"}
    browser_window.apply()
    assert mod.chromium_args() == [browser_window.AUTOMATION_HIDE_ARG]


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
