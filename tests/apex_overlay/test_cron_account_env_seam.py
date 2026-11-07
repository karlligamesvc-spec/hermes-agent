"""hc-1169: once a process serves several profiles, every cron fire still gets the signed-in account's credentials.

2026-11-07, APEX Desktop dev build, production account, two assistants, no IM bound: a one-shot cron
job that searched the web logged ``web_search backend 'searxng' failed (SEARXNG_URL is not set);
one-shot keyless rescue`` in both assistants with the single-engine switch off, while interactive
searches were fine. Desktop injects the account's credentials into each process's environment only;
a fire's scope is built from the firing profile's files, and under multiplex semantics a miss never
reaches the process environment. These tests run the real upstream fire path:

  1. Upstream shape: without the seam a multiplexed fire, launch or routed, loses every account name.
  2. Every multiplexed fire gets them (the backend or gateway after activation, and a routed fire in
     a process that never activated); a fire in a single-profile process is left byte-identical.
  3. Precedence: the profile's own value wins; a name any ``.env`` loaded, a gate, an empty value
     are never lent.
  4. The values the process started with survive ``reload.env`` deleting them from ``os.environ``.
  5. Inside the fire a rebuilt scope keeps them; outside a fire no scope gains them, so a secondary
     never sees the account's Feishu app in the gateway's scope for it.
  6. End to end: the dashboard's Run now fires each profile's job with them.
  7. Wiring: register() applies the seam; apply() armed before the imports patches them, once.
"""
from __future__ import annotations

import logging
import os
import subprocess
import sys
from pathlib import Path

import pytest

from apex_overlay import cron_account_env as seam

REPO = Path(__file__).resolve().parents[2]
ACCOUNT = {name: f"account-{name.lower()}" for name in seam.ACCOUNT_ENV_NAMES}
GATES = {"FEISHU_ALLOWED_USERS": "ou_owner", "WEIXIN_ALLOWED_USERS": "wx_owner", "WEIXIN_DM_POLICY": "allowlist"}


@pytest.fixture
def homes(tmp_path, monkeypatch):
    """APEX's root profile and one more assistant; the account's credentials live only in the process env."""
    from cron import scheduler
    from hermes_cli import profiles

    launch = tmp_path / ".hermes"
    routed = launch / "profiles" / "ops"
    for home in (launch, routed):
        (home / "cron").mkdir(parents=True, exist_ok=True)
        (home / "scripts").mkdir(parents=True, exist_ok=True)
        (home / "config.yaml").write_text("model: test-model\n", encoding="utf-8")
        (home / ".env").write_text("", encoding="utf-8")
    monkeypatch.setenv("HERMES_HOME", str(launch))
    for name, value in {**ACCOUNT, **GATES}.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setattr(profiles, "_get_default_hermes_home", lambda: launch)
    monkeypatch.setattr(profiles, "_get_profiles_root", lambda: launch / "profiles")
    monkeypatch.setattr(scheduler, "_hermes_home", None)
    return launch, routed


def _unwrapped(fn):
    return fn.__wrapped__ if getattr(fn, seam._MARK, False) else fn


@pytest.fixture
def upstream_only(monkeypatch, homes):
    """Upstream's two functions as they are without the seam, whatever another test applied."""
    from agent import secret_scope
    from cron import scheduler

    monkeypatch.setattr(secret_scope, "build_profile_secret_scope", _unwrapped(secret_scope.build_profile_secret_scope))
    monkeypatch.setattr(scheduler, "_install_fire_secret_scope", _unwrapped(scheduler._install_fire_secret_scope))
    return homes


@pytest.fixture
def installed(upstream_only, monkeypatch):
    """Both patches for one test, the account's values frozen as plugin discovery freezes them at boot;
    monkeypatch puts upstream's functions back afterwards."""
    from agent import secret_scope
    from cron import scheduler

    monkeypatch.setattr(seam, "_launch", None)
    seam.launch_values()
    assert seam._install_scope_builder(secret_scope) is True
    assert seam._install_fire_scope(scheduler) is True
    return upstream_only


def _multiplexed(monkeypatch, on: bool = True) -> None:
    """The process flag the Desktop backend (two or more assistants at boot) and the gateway set."""
    from agent import secret_scope

    monkeypatch.setattr(secret_scope, "_MULTIPLEX_ACTIVE", on)


def fire(home: Path, *names: str):
    """Install ``home``'s fire scope exactly as run_one_job does; read ``names`` through it.
    Returns ``(values, the installed mapping)``."""
    from agent import secret_scope
    from cron import scheduler
    from cron.scheduler_provider import _profile_cron_scope

    with _profile_cron_scope(home):
        tokens = scheduler._install_fire_secret_scope()
        try:
            return {name: secret_scope.get_secret(name) for name in names}, dict(secret_scope.current_secret_scope() or {})
        finally:
            scheduler._reset_fire_secret_scope(tokens)


# ---------------------------------------------------------------------------
# 1. Upstream shape
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("profile", ["launch", "routed"])
def test_upstream_a_multiplexed_fire_loses_every_account_name(upstream_only, monkeypatch, profile):
    launch, routed = upstream_only
    _multiplexed(monkeypatch)

    values, _scope = fire(launch if profile == "launch" else routed, *ACCOUNT)

    assert values == dict.fromkeys(ACCOUNT)


# ---------------------------------------------------------------------------
# 2. Every multiplexed fire gets them
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    ("process_multiplexed", "profile"),
    [(True, "launch"), (True, "routed"), (False, "routed")],
    ids=["activated-own-profile", "activated-other-profile", "not-activated-other-profile"],
)
def test_every_multiplexed_fire_gets_the_account_names(installed, monkeypatch, caplog, process_multiplexed, profile):
    launch, routed = installed
    _multiplexed(monkeypatch, process_multiplexed)

    with caplog.at_level(logging.INFO, logger=seam.__name__):
        values, scope = fire(launch if profile == "launch" else routed, *ACCOUNT, *GATES)

    assert {name: values[name] for name in ACCOUNT} == ACCOUNT
    # In the mapping itself: delivery's platform config and the fire's children read that, not get_secret.
    assert {name: scope.get(name) for name in ACCOUNT} == ACCOUNT
    assert {name: values[name] for name in GATES} == dict.fromkeys(GATES)
    logged = "\n".join(record.getMessage() for record in caplog.records)
    assert "SEARXNG_URL" in logged and not any(value in logged for value in ACCOUNT.values())


def test_a_single_profile_fire_is_left_alone(installed):
    launch, _routed = installed

    values, scope = fire(launch, *ACCOUNT)

    assert values == ACCOUNT  # the process environment answers a miss, as it always did
    assert not set(scope) & set(ACCOUNT)


# ---------------------------------------------------------------------------
# 3. Precedence
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    ("case", "name", "expected"),
    [
        ("own .env wins", "SEARXNG_URL", "https://own.example/searxng"),
        ("a name a .env loaded is that profile's", "SEARXNG_API_KEY", None),
        ("a gate stays the assistant's", "FEISHU_ALLOWED_USERS", None),
        ("an empty value is not lent", "WEIXIN_TOKEN", None),
    ],
)
def test_precedence_in_another_profiles_fire(installed, monkeypatch, case, name, expected):
    from hermes_cli import env_loader

    _launch, routed = installed
    _multiplexed(monkeypatch)
    if case == "own .env wins":
        (routed / ".env").write_text(f"{name}={expected}\n", encoding="utf-8")
    elif case == "a name a .env loaded is that profile's":
        monkeypatch.setattr(env_loader, "launch_dotenv_keys", lambda: frozenset({name}))
    elif case == "an empty value is not lent":
        monkeypatch.setenv(name, "")
        monkeypatch.setattr(seam, "_launch", None)
        seam.launch_values()  # the process started without it

    values, _scope = fire(routed, name)

    assert values[name] == expected


# ---------------------------------------------------------------------------
# 4. reload.env
# ---------------------------------------------------------------------------

def test_the_values_the_process_started_with_survive_reload_env(installed, monkeypatch):
    from hermes_cli.config import reload_env

    _launch, routed = installed
    _multiplexed(monkeypatch)
    reload_env()  # the real RPC body: drops declared names the root's .env lacks from os.environ
    dropped = [name for name in ACCOUNT if name not in os.environ]
    assert "SEARXNG_URL" in dropped and "FEISHU_APP_ID" in dropped

    values, _scope = fire(routed, *ACCOUNT)

    assert values == ACCOUNT


# ---------------------------------------------------------------------------
# 5. Rebuilt inside the fire, untouched outside it
# ---------------------------------------------------------------------------

def test_a_scope_rebuilt_inside_the_fire_keeps_them(installed, monkeypatch):
    """refresh_installed_secret_scope REPLACES the fire's mapping with a rebuild after a plugin
    discovery; a child the fire spawns for a profile builds its env from the same function."""
    from agent import secret_scope
    from cron import scheduler
    from cron.execution_identity import enter_cron_execution, exit_cron_execution
    from cron.scheduler_provider import _profile_cron_scope

    _launch, routed = installed
    _multiplexed(monkeypatch)
    with _profile_cron_scope(routed):
        tokens = scheduler._install_fire_secret_scope()
        identity = enter_cron_execution({"id": "job", "name": "probe"}, "execution", {"source": "builtin"})
        try:
            assert secret_scope.refresh_installed_secret_scope(routed) is True
            assert {name: secret_scope.get_secret(name) for name in ACCOUNT} == ACCOUNT
            assert {name: secret_scope.build_profile_secret_scope(routed).get(name) for name in ACCOUNT} == ACCOUNT
        finally:
            exit_cron_execution(identity)
            scheduler._reset_fire_secret_scope(tokens)


def test_outside_a_cron_fire_no_scope_gains_them(installed, monkeypatch):
    """Every gateway turn, adapter and config load builds its scope this way: a secondary that gained the
    account's Feishu app here would start a second adapter on it."""
    from agent import secret_scope
    from gateway.config import _getenv
    from gateway.run import _profile_runtime_scope

    launch, routed = installed
    _multiplexed(monkeypatch)
    fire(routed, *ACCOUNT)  # a finished fire leaves nothing behind in this context

    for home in (launch, routed):
        assert not set(secret_scope.build_profile_secret_scope(home)) & set(ACCOUNT)
    with _profile_runtime_scope(routed):
        assert _getenv("FEISHU_APP_ID") is None
        assert secret_scope.get_secret("SEARXNG_URL") is None


# ---------------------------------------------------------------------------
# 6. End to end
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("profile", ["default", "ops"])
def test_run_now_fires_each_profiles_job_with_the_account_names(installed, monkeypatch, profile):
    """The dashboard's Run now (the same run_one_job the ticker calls), in a backend serving two profiles."""
    from agent import secret_scope
    from cron import scheduler
    from cron.jobs import create_job
    from cron.scheduler_provider import InProcessCronScheduler
    from hermes_cli import web_server_cron
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    launch, routed = installed
    home = launch if profile == "default" else routed
    _multiplexed(monkeypatch)
    monkeypatch.setattr("cron.scheduler_provider.resolve_cron_scheduler", lambda: InProcessCronScheduler())
    seen: dict = {}

    def run_job(job, **_kwargs):
        seen.update({name: secret_scope.get_secret(name) for name in (*ACCOUNT, *GATES)})
        seen["child"] = {name: secret_scope.build_profile_secret_scope(home).get(name) for name in ACCOUNT}
        return True, "output", "final", None

    monkeypatch.setattr(scheduler, "run_job", run_job)
    (home / "scripts" / "probe.sh").write_text("#!/usr/bin/env bash\ntrue\n", encoding="utf-8")
    token = set_hermes_home_override(str(home))
    try:
        job_id = create_job(prompt=None, schedule="every 1h", script="probe.sh", no_agent=True, deliver="local")["id"]
    finally:
        reset_hermes_home_override(token)

    assert web_server_cron._fire_cron_job_for_profile(profile, job_id) is True

    assert {name: seen[name] for name in ACCOUNT} == ACCOUNT
    assert {name: seen[name] for name in GATES} == dict.fromkeys(GATES)
    assert seen["child"] == ACCOUNT


# ---------------------------------------------------------------------------
# 7. Wiring
# ---------------------------------------------------------------------------

def test_plugin_register_applies_the_seam():
    from tests.apex_overlay.conftest import run_plugin_register_with_stubbed_seams

    assert "cron_account_env" in run_plugin_register_with_stubbed_seams("_apex_overlay_plugin_hc1169")


def test_apply_before_the_imports_patches_them_when_they_load():
    """Production order: plugin discovery arms the seam, the cron scheduler loads later (hc-989)."""
    script = (
        "import sys\n"
        "from apex_overlay import cron_account_env as seam\n"
        "assert 'cron.scheduler' not in sys.modules\n"
        "assert seam.apply() is True\n"
        "import agent.secret_scope as scope\n"
        "import cron.scheduler as scheduler\n"
        "patched = (scheduler._install_fire_secret_scope, scope.build_profile_secret_scope)\n"
        "assert all(getattr(fn, seam._MARK, False) for fn in patched)\n"
        "assert seam.apply() is True\n"
        "assert (scheduler._install_fire_secret_scope, scope.build_profile_secret_scope) == patched\n"
        "print('ok')\n"
    )
    done = subprocess.run([sys.executable, "-c", script], cwd=REPO, capture_output=True, text=True, timeout=120, check=False)
    assert done.returncode == 0 and done.stdout.strip().endswith("ok"), done.stderr[-2000:]


def test_apply_freezes_what_the_process_started_with_and_never_imports_cron():
    """apply() runs in plugin discovery at boot, before any ``reload.env``: it keeps the values Desktop
    injected. Neither it nor a scope build outside a fire imports cron; a build before cron has loaded
    (a gateway turn or adapter during boot) lends nothing."""
    script = (
        "import os, sys\n"
        "os.environ['SEARXNG_URL'] = 'https://account.example/searxng'\n"
        "from apex_overlay import cron_account_env as seam\n"
        "assert seam.apply() is True\n"
        "del os.environ['SEARXNG_URL']  # what reload.env does to a declared name the root's .env lacks\n"
        "assert seam.account_values().get('SEARXNG_URL') == 'https://account.example/searxng'\n"
        "import agent.secret_scope as scope\n"
        "scope.set_multiplex_active(True)\n"
        "built = scope.build_profile_secret_scope(os.environ['HERMES_HOME'])\n"
        "assert 'SEARXNG_URL' not in built, sorted(built)\n"
        "assert 'cron.execution_identity' not in sys.modules and 'cron.scheduler' not in sys.modules\n"
        "print('ok')\n"
    )
    done = subprocess.run([sys.executable, "-c", script], cwd=REPO, capture_output=True, text=True, timeout=120, check=False)
    assert done.returncode == 0 and done.stdout.strip().endswith("ok"), done.stderr[-2000:]
