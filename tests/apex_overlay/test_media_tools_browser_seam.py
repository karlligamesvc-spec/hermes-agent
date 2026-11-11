"""hc-1203: on APEX Desktop, browser_exec's Chromium is APEX's verified COS build, never pm's foreign download.

v0.23.0 removed agent-browser with its installer (``tools/browser_tool_install.py`` is now a stub), so the seam
moved to the launcher the tool really uses. These tests run that path:
``tools.browser_launcher.chromium_ready`` -> ``hermes_cli.browser_runtime.chromium_executable`` ->
``tools.browser_launcher._maybe_autoinstall_chromium``. pm's Chromium, the image's baked browser and the user's
config are pinned per test; the COS download is a file in tmp_path.
"""
from __future__ import annotations

import inspect

import pytest

from apex_overlay import media_tools


def _upstream(fn):
    return fn.__wrapped__ if getattr(fn, media_tools._BROWSER_MARK, False) else fn


@pytest.fixture
def launcher(monkeypatch, tmp_path):
    """Upstream's launcher with nothing on disk: no pm Chromium, no baked browser, no pin, lazy installs on.
    Records pm downloads and COS downloads; monkeypatch restores every upstream function afterwards."""
    import pm
    from hermes_cli import browser_runtime
    from tools import browser_launcher

    monkeypatch.setattr(browser_runtime, "chromium_executable", _upstream(browser_runtime.chromium_executable))
    monkeypatch.setattr(browser_launcher, "_maybe_autoinstall_chromium",
                        _upstream(browser_launcher._maybe_autoinstall_chromium))
    monkeypatch.setattr(browser_launcher, "_autoinstall_attempted", False, raising=False)
    monkeypatch.setattr(browser_runtime, "_pm_executable", lambda: None)
    monkeypatch.setattr(browser_runtime, "_baked_executable", lambda: None)
    monkeypatch.setattr(browser_runtime, "_configured_executable", lambda: None)
    monkeypatch.setattr(browser_launcher, "running_in_docker", lambda: False)
    monkeypatch.setattr(pm, "lazy_installs_allowed", lambda: True)
    monkeypatch.delenv(media_tools.BROWSER_ENV, raising=False)

    calls = {"pm": [], "cos": []}
    monkeypatch.setattr(pm, "ensure", lambda name, *a, **k: calls["pm"].append(name))
    cos_build = tmp_path / "cos" / "Google Chrome for Testing"
    cos_build.parent.mkdir()
    cos_build.write_text("", encoding="utf-8")

    def ensure_browser(*, render=False):
        calls["cos"].append(render)
        return cos_build
    monkeypatch.setattr(media_tools, "ensure_browser", ensure_browser)
    return browser_launcher, browser_runtime, calls, cos_build


def test_the_hooks_live_in_the_v023_launcher():
    """Fails when upstream moves them again: the seam would bind nothing and the Desktop browser would come
    from pm's download host."""
    from hermes_cli import browser_runtime
    from tools import browser_launcher, browser_tool_install

    assert callable(browser_launcher._maybe_autoinstall_chromium)
    assert callable(browser_launcher.chromium_ready)
    assert "allow_override" in inspect.signature(_upstream(browser_runtime.chromium_executable)).parameters
    assert not hasattr(browser_tool_install, "_maybe_autoinstall_chromium")  # the agent-browser era's home


def test_browser_exec_gets_the_cos_browser_and_pm_downloads_nothing(launcher):
    browser_launcher, _browser_runtime, calls, cos_build = launcher
    assert media_tools.install_browser_seam() is True

    assert browser_launcher.chromium_ready() == (True, "")
    assert browser_launcher._resolve_executable() == str(cos_build)
    assert browser_launcher.chromium_ready() == (True, "")  # installed once, then found
    assert calls == {"pm": [], "cos": [False]}


def test_a_failed_cos_download_never_falls_back_to_pm(launcher, monkeypatch):
    browser_launcher, _browser_runtime, calls, _cos_build = launcher

    def unreachable(*, render=False):
        calls["cos"].append(render)
        raise OSError("COS unreachable")
    monkeypatch.setattr(media_tools, "ensure_browser", unreachable)
    assert media_tools.install_browser_seam() is True

    ready, hint = browser_launcher.chromium_ready()
    assert ready is False and hint
    assert calls == {"pm": [], "cos": [False]}


def test_a_browser_the_user_pinned_is_never_downloaded_over(launcher, monkeypatch, tmp_path):
    browser_launcher, browser_runtime, calls, _cos_build = launcher
    missing = str(tmp_path / "no-such-chrome")
    monkeypatch.setattr(browser_runtime, "_configured_executable", lambda: missing)
    assert media_tools.install_browser_seam() is True

    ready, hint = browser_launcher.chromium_ready()
    assert ready is False and "browser.executable_path" in hint
    assert calls == {"pm": [], "cos": []}


def test_lazy_installs_off_downloads_nothing(launcher, monkeypatch):
    import pm

    browser_launcher, _browser_runtime, calls, _cos_build = launcher
    monkeypatch.setattr(pm, "lazy_installs_allowed", lambda: False)
    assert media_tools.install_browser_seam() is True

    assert browser_launcher.chromium_ready()[0] is False
    assert calls == {"pm": [], "cos": []}


def test_a_pm_build_or_a_pin_still_wins(launcher, monkeypatch, tmp_path):
    browser_launcher, browser_runtime, calls, _cos_build = launcher
    pm_build = tmp_path / "pm-chromium"
    pm_build.write_text("", encoding="utf-8")
    monkeypatch.setattr(browser_runtime, "_pm_executable", lambda: str(pm_build))
    assert media_tools.install_browser_seam() is True

    assert browser_launcher.chromium_ready() == (True, "")
    assert browser_launcher._resolve_executable() == str(pm_build)
    assert calls == {"pm": [], "cos": []}


def test_installing_twice_wraps_once(launcher):
    browser_launcher, browser_runtime, _calls, _cos_build = launcher
    assert media_tools.install_browser_seam() is True
    resolve, install = browser_runtime.chromium_executable, browser_launcher._maybe_autoinstall_chromium
    assert media_tools.install_browser_seam() is True
    assert (browser_runtime.chromium_executable, browser_launcher._maybe_autoinstall_chromium) == (resolve, install)
    assert getattr(resolve, media_tools._BROWSER_MARK) and getattr(install, media_tools._BROWSER_MARK)


@pytest.mark.parametrize(("system", "packaged", "installed"), [
    ("Darwin", True, True), ("Windows", True, True), ("Linux", True, False), ("Darwin", False, False),
], ids=["mac-desktop", "windows-desktop", "cloud-linux", "unpackaged-checkout"])
def test_apply_installs_the_seam_only_in_a_packaged_desktop_engine(launcher, monkeypatch, tmp_path, system,
                                                                   packaged, installed):
    browser_launcher, browser_runtime, _calls, _cos_build = launcher
    root = tmp_path / "engine"
    (root / "scripts/media-tools").mkdir(parents=True)
    (root / "scripts/media-tools/desktop-lock.json").write_text("{}", encoding="utf-8")
    if packaged:
        (root / ".runtime/node").mkdir(parents=True)
    monkeypatch.setattr(media_tools, "ROOT", root)
    monkeypatch.setattr(media_tools, "LOCK", root / "scripts/media-tools/desktop-lock.json")
    monkeypatch.setattr(media_tools.platform, "system", lambda: system)

    assert media_tools.apply() is installed
    assert getattr(browser_launcher._maybe_autoinstall_chromium, media_tools._BROWSER_MARK, False) is installed
    assert getattr(browser_runtime.chromium_executable, media_tools._BROWSER_MARK, False) is installed
