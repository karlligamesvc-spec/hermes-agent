"""hc-1171: with several profiles, the IM 入口's Feishu and WeChat apps still connect, for one profile.

2026-11-07, fork main: Desktop puts the IM 入口's credentials into the messaging gateway's environment
only. With one profile the gateway configured Feishu and WeChat; with two it multiplexes, loads each
profile's platform config inside that profile's file-only secret scope, and configured neither, so the
bound bot never connected. These tests run the real upstream config loads:

  1. Upstream shape: two profiles, credentials only in the environment -> neither platform.
  2. Started for the root profile: its config has both apps; no other profile's scope sees them.
  3. Started for a named profile: that profile's config has both (it starts them as a secondary);
     the root's primary config stays without them, so nothing connects twice.
  4. The profile's own value wins; its allowlists and home channels come along.
  5. One profile: nothing added (the environment already answers); reload.env cannot take them away.
  6. Wiring: register() applies the seam; apply() armed before the import patches it, once.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

from apex_overlay import im_launch_profile as seam
from gateway.config import Platform

REPO = Path(__file__).resolve().parents[2]
IM = {name: f"desktop-{name.lower()}" for name in seam.IM_ENV_NAMES}
IM.update(FEISHU_DOMAIN="feishu", WEIXIN_DM_POLICY="allowlist", WEIXIN_BASE_URL="https://ilinkai.weixin.qq.com")


@pytest.fixture(autouse=True)
def _multiplex_off_around_each_test():
    from agent import secret_scope

    secret_scope.set_multiplex_active(False)
    yield
    secret_scope.set_multiplex_active(False)


def _home(path: Path, *, multiplex: bool) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    (path / "config.yaml").write_text("gateway:\n  multiplex_profiles: true\n" if multiplex else "model: m\n",
                                      encoding="utf-8")
    (path / ".env").write_text("", encoding="utf-8")
    return path


@pytest.fixture
def homes(tmp_path, monkeypatch):
    """APEX's root profile and one more assistant; Desktop's IM credentials only in the environment."""
    root = _home(tmp_path / "root", multiplex=True)
    ops = _home(root / "profiles" / "ops", multiplex=True)
    monkeypatch.setenv("HERMES_HOME", str(root))
    for name, value in IM.items():
        monkeypatch.setenv(name, value)
    return root, ops


def _unwrapped(fn):
    return fn.__wrapped__ if getattr(fn, seam._MARK, False) else fn


@pytest.fixture
def upstream_only(monkeypatch):
    from agent import secret_scope

    monkeypatch.setattr(secret_scope, "build_profile_secret_scope", _unwrapped(secret_scope.build_profile_secret_scope))


@pytest.fixture
def installed(upstream_only, monkeypatch):
    """The patch for one test, the IM names frozen as plugin discovery freezes them at boot."""
    from agent import secret_scope

    monkeypatch.setattr(seam, "_launch", None)
    monkeypatch.setattr(seam, "_announced", set())
    seam.launch_values()
    assert seam._install_scope_builder(secret_scope) is True


def _platforms(cfg) -> dict:
    out = {}
    feishu, weixin = cfg.platforms.get(Platform.FEISHU), cfg.platforms.get(Platform.WEIXIN)
    out["feishu"] = None if feishu is None else bool(feishu.enabled and (feishu.extra or {}).get("app_id"))
    out["weixin"] = None if weixin is None else bool(weixin.enabled)
    return out


def _secondary_config(home: Path):
    """What the gateway loads to start a served profile's own adapters (_load_secondary_profile_config),
    after the open dm/group policy check that would refuse that profile."""
    from gateway.config import load_gateway_config
    from gateway.run import _own_policy_open_startup_violation, _profile_runtime_scope

    with _profile_runtime_scope(home, hydrate_secrets=False):
        cfg = load_gateway_config()
        assert not _own_policy_open_startup_violation(cfg)
        return cfg


def _im_names(scope) -> set:
    return set(scope) & set(IM)


# ---------------------------------------------------------------------------
# 1. Upstream shape
# ---------------------------------------------------------------------------

def test_upstream_two_profiles_the_launch_profile_configures_both_apps(homes, upstream_only):
    """hc-1203: since v0.23.0 upstream builds the launch profile's scope from its own process environment
    (``tui_gateway.launch_profile_policy.owner_secret_scope`` → ``launch_secret_scope``), so the root
    profile configures both apps without this seam. (Before, with two profiles neither app was configured,
    which is what hc-1171 fixed.) The seam stays: the profile's own value still wins, and no other profile
    gains the apps."""
    from agent.secret_scope import build_profile_secret_scope
    from gateway.run import load_gateway_config_for_runner

    _root, ops = homes
    cfg = load_gateway_config_for_runner()

    assert cfg.multiplex_profiles is True
    assert _platforms(cfg) == {"feishu": True, "weixin": True}
    assert _im_names(build_profile_secret_scope(ops)) == set()


# ---------------------------------------------------------------------------
# 2. / 3. Started for the root profile, or for a named one
# ---------------------------------------------------------------------------

def test_started_for_the_root_profile_its_config_has_both_apps(homes, installed):
    from agent.secret_scope import build_profile_secret_scope
    from gateway.run import load_gateway_config_for_runner

    _root, ops = homes
    cfg = load_gateway_config_for_runner()

    assert _platforms(cfg) == {"feishu": True, "weixin": True}
    assert _im_names(build_profile_secret_scope(ops)) == set()  # the other assistant starts no second adapter
    assert _platforms(_secondary_config(ops)) == {"feishu": None, "weixin": None}


def test_started_for_a_named_profile_that_profile_starts_them_as_a_secondary(homes, installed, monkeypatch):
    from agent.secret_scope import build_profile_secret_scope
    from gateway.run import load_gateway_config_for_runner

    root, ops = homes
    monkeypatch.setenv("HERMES_HOME", str(ops))  # `hermes --profile ops gateway run`

    primary = load_gateway_config_for_runner()

    assert _platforms(primary) == {"feishu": None, "weixin": None}  # the root keeps its own: nothing twice
    assert _im_names(build_profile_secret_scope(root)) == set()
    assert _platforms(_secondary_config(ops)) == {"feishu": True, "weixin": True}


# ---------------------------------------------------------------------------
# 4. Precedence, gates
# ---------------------------------------------------------------------------

def test_the_profiles_own_value_wins_and_its_gates_come_along(homes, installed):
    from agent.secret_scope import build_profile_secret_scope, set_multiplex_active
    from gateway.run import load_gateway_config_for_runner

    root, _ops = homes
    (root / ".env").write_text("FEISHU_APP_ID=cli_own\n", encoding="utf-8")

    cfg = load_gateway_config_for_runner()
    set_multiplex_active(True)
    scope = build_profile_secret_scope(root)

    assert cfg.platforms[Platform.FEISHU].extra["app_id"] == "cli_own"
    assert scope["FEISHU_APP_ID"] == "cli_own"
    gates = ("FEISHU_ALLOWED_USERS", "FEISHU_HOME_CHANNEL", "WEIXIN_ALLOWED_USERS", "WEIXIN_DM_POLICY", "WEIXIN_HOME_CHANNEL")
    assert {name: scope.get(name) for name in gates} == {name: IM[name] for name in gates}


def test_an_empty_value_is_not_lent(homes, installed, monkeypatch):
    from agent.secret_scope import build_profile_secret_scope, set_multiplex_active

    root, _ops = homes
    monkeypatch.setenv("FEISHU_HOME_CHANNEL", "")
    monkeypatch.setattr(seam, "_launch", None)
    seam.launch_values()  # the process started without one
    set_multiplex_active(True)

    assert "FEISHU_HOME_CHANNEL" not in build_profile_secret_scope(root)
    assert build_profile_secret_scope(root)["FEISHU_APP_ID"] == IM["FEISHU_APP_ID"]


# ---------------------------------------------------------------------------
# 5. One profile, reload.env
# ---------------------------------------------------------------------------

def test_one_profile_is_left_alone(tmp_path, monkeypatch, installed):
    from agent.secret_scope import build_profile_secret_scope
    from gateway.run import load_gateway_config_for_runner

    root = _home(tmp_path / "solo", multiplex=False)
    monkeypatch.setenv("HERMES_HOME", str(root))
    for name, value in IM.items():
        monkeypatch.setenv(name, value)

    cfg = load_gateway_config_for_runner()

    assert cfg.multiplex_profiles is False
    assert _platforms(cfg) == {"feishu": True, "weixin": True}  # the environment answers, as it always did
    assert _im_names(build_profile_secret_scope(root)) == set()


def test_reload_env_cannot_take_them_away(homes, installed):
    from gateway.run import load_gateway_config_for_runner
    from hermes_cli.config import reload_env

    reload_env()  # the real RPC body: drops declared names the root's .env lacks from os.environ
    assert "FEISHU_APP_ID" not in os.environ and "WEIXIN_TOKEN" not in os.environ

    assert _platforms(load_gateway_config_for_runner()) == {"feishu": True, "weixin": True}


# ---------------------------------------------------------------------------
# 6. Wiring
# ---------------------------------------------------------------------------

def test_plugin_register_applies_the_seam():
    from tests.apex_overlay.conftest import run_plugin_register_with_stubbed_seams

    assert "im_launch_profile" in run_plugin_register_with_stubbed_seams("_apex_overlay_plugin_hc1171")


def test_apply_before_the_import_patches_it_once_and_freezes_the_names():
    """Production order: plugin discovery arms the seam at boot, before any reload.env."""
    script = (
        "import os, sys\n"
        "os.environ['FEISHU_APP_ID'] = 'cli_boot'\n"
        "from apex_overlay import im_launch_profile as seam\n"
        "assert 'agent.secret_scope' not in sys.modules\n"
        "assert seam.apply() is True\n"
        "del os.environ['FEISHU_APP_ID']\n"
        "assert seam.im_values().get('FEISHU_APP_ID') == 'cli_boot'\n"
        "import agent.secret_scope as scope\n"
        "patched = scope.build_profile_secret_scope\n"
        "assert getattr(patched, seam._MARK, False)\n"
        "assert seam.apply() is True and scope.build_profile_secret_scope is patched\n"
        "print('ok')\n"
    )
    done = subprocess.run([sys.executable, "-c", script], cwd=REPO, capture_output=True, text=True, timeout=120, check=False)
    assert done.returncode == 0 and done.stdout.strip().endswith("ok"), done.stderr[-2000:]
