"""hc-1166: one engine hosting every assistant owes the hosted profiles what an engine of their
own gave them — the account credentials Desktop injects, and serve's hourly maintenance."""

from __future__ import annotations

import contextlib
import types
from pathlib import Path

import pytest

from agent import secret_scope
from apex_overlay import cron_account_env, hosted_profiles
from hermes_constants import get_hermes_home, reset_hermes_home_override, set_hermes_home_override

ON = {"HERMES_DESKTOP": "1", "APEX_MULTI_BOT_SINGLE_ENGINE": "1"}


@pytest.mark.parametrize(
    "env, active",
    [
        (ON, True),
        ({"APEX_MULTI_BOT_SINGLE_ENGINE": "1"}, False),  # not a Desktop-spawned backend
        ({"HERMES_DESKTOP": "1"}, False),  # an engine per assistant
        ({"HERMES_DESKTOP": "1", "APEX_MULTI_BOT_SINGLE_ENGINE": "0"}, False),
        ({}, False),
    ],
)
def test_the_seam_counts_only_in_a_desktop_engine_hosting_every_assistant(env, active):
    assert hosted_profiles.single_engine_active(env) is active


def test_off_it_patches_nothing(monkeypatch):
    monkeypatch.delenv("APEX_MULTI_BOT_SINGLE_ENGINE", raising=False)
    names, environ_or = secret_scope._GLOBAL_ENV_EXACT, secret_scope._environ_or

    assert hosted_profiles.apply() is True
    assert secret_scope._GLOBAL_ENV_EXACT is names
    assert secret_scope._environ_or is environ_or


# ── account credentials ─────────────────────────────────────────────────────


@pytest.fixture
def seam(monkeypatch):
    """The account seam installed on agent.secret_scope for one test, restored after."""
    monkeypatch.setattr(secret_scope, "_GLOBAL_ENV_EXACT", secret_scope._GLOBAL_ENV_EXACT)
    monkeypatch.setattr(secret_scope, "_environ_or", secret_scope._environ_or)
    from hermes_cli import env_loader

    monkeypatch.setattr(env_loader, "_LOADED_DOTENV_KEYS", set())
    assert hosted_profiles._install_account_env(secret_scope) is True
    return env_loader._LOADED_DOTENV_KEYS


@contextlib.contextmanager
def _hosted_secondary(home: Path, own: dict[str, str]):
    """A hosted profile's turn: multiplexing on, its own secret scope stamped with its home."""
    multiplex = secret_scope.set_multiplex_context(True)
    scope = secret_scope.set_secret_scope(own, profile_home=str(home))
    home_token = set_hermes_home_override(str(home))
    try:
        yield
    finally:
        reset_hermes_home_override(home_token)
        secret_scope.reset_secret_scope(scope)
        secret_scope.reset_multiplex_context(multiplex)


ACCOUNT = {
    "TOOLS_GATEWAY_KEY": "account-key",
    "SEARXNG_URL": "https://search.invalid",
    "SEARXNG_API_KEY": "account-key",
    "FEISHU_APP_SECRET": "account-feishu",
    "WEIXIN_TOKEN": "account-weixin",
}


def test_without_the_seam_a_hosted_assistant_sees_none_of_the_account(monkeypatch, tmp_path):
    for name, value in ACCOUNT.items():
        monkeypatch.setenv(name, value)

    with _hosted_secondary(tmp_path / "profiles" / "apex-bot-2", {"DEEPSEEK_API_KEY": "its-own"}):
        assert {name: secret_scope.get_secret(name) for name in ACCOUNT} == dict.fromkeys(ACCOUNT)


def test_a_hosted_assistant_reads_the_account_credentials_desktop_injected(seam, monkeypatch, tmp_path):
    for name, value in ACCOUNT.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("OPENAI_API_KEY", "launch-profile-own-key")

    with _hosted_secondary(tmp_path / "profiles" / "apex-bot-2", {"DEEPSEEK_API_KEY": "its-own"}):
        assert {name: secret_scope.get_secret(name) for name in ACCOUNT} == ACCOUNT
        # Its own keys stay its own, and another profile's credentials stay out of reach.
        assert secret_scope.get_secret("DEEPSEEK_API_KEY") == "its-own"
        assert secret_scope.get_secret("OPENAI_API_KEY") is None


def test_an_assistants_own_value_still_wins(seam, monkeypatch, tmp_path):
    monkeypatch.setenv("FEISHU_APP_SECRET", "account-feishu")
    monkeypatch.setenv("TOOLS_GATEWAY_KEY", "account-key")

    with _hosted_secondary(tmp_path / "profiles" / "apex-bot-2", {"FEISHU_APP_SECRET": "its-own-app"}):
        assert secret_scope.get_secret("FEISHU_APP_SECRET") == "its-own-app"
        assert secret_scope._is_global_env("FEISHU_APP_SECRET") is False
        assert secret_scope.get_secret("TOOLS_GATEWAY_KEY") == "account-key"


def test_who_may_talk_to_an_assistant_and_apex_own_dotenv_values_are_never_shared(seam, monkeypatch, tmp_path):
    monkeypatch.setenv("FEISHU_ALLOWED_USERS", "ou_apex_owner")
    monkeypatch.setenv("WEIXIN_DM_POLICY", "allowlist")
    monkeypatch.setenv("FEISHU_APP_ID", "apex-own-app-from-its-env-file")
    monkeypatch.setenv("TOOLS_GATEWAY_KEY", "account-key")
    seam.add("FEISHU_APP_ID")  # APEX's own .env loaded it into the process environment

    with _hosted_secondary(tmp_path / "profiles" / "apex-bot-2", {}):
        assert secret_scope.get_secret("FEISHU_ALLOWED_USERS") is None
        assert secret_scope.get_secret("WEIXIN_DM_POLICY") is None
        assert secret_scope.get_secret("FEISHU_APP_ID") is None
        assert secret_scope.get_secret("TOOLS_GATEWAY_KEY") == "account-key"


def test_after_reload_env_drops_an_injected_name_every_profile_reads_it_as_the_engine_started(
    seam, monkeypatch, tmp_path
):
    from hermes_cli.config import reload_env
    from tui_gateway import launch_profile_policy

    root = tmp_path / "hermes"
    root.mkdir()
    (root / ".env").write_text("", encoding="utf-8")
    monkeypatch.setenv("HERMES_HOME", str(root))
    monkeypatch.setenv("SEARXNG_URL", "https://search.invalid")
    monkeypatch.setenv("FEISHU_APP_ID", "account-app")
    monkeypatch.setattr(launch_profile_policy, "_snapshot", {"SEARXNG_URL": "https://search.invalid",
                                                              "FEISHU_APP_ID": "account-app"})
    monkeypatch.setattr(secret_scope, "_MULTIPLEX_ACTIVE", True)
    seam.add("FEISHU_APP_ID")  # …but this one came from APEX's own .env, which has since dropped it

    reload_env()
    assert "SEARXNG_URL" not in __import__("os").environ  # what the onboarding / sign-in reload does

    with _hosted_secondary(tmp_path / "profiles" / "apex-bot-2", {}):
        assert secret_scope.get_secret("SEARXNG_URL") == "https://search.invalid"
        assert secret_scope.get_secret("FEISHU_APP_ID") is None
    launch = secret_scope.set_secret_scope({}, profile_home=str(root))
    try:
        assert secret_scope.get_secret("SEARXNG_URL") == "https://search.invalid"
    finally:
        secret_scope.reset_secret_scope(launch)


def test_hosted_assistants_and_cron_fires_share_one_list_of_account_names():
    """One list: a name Desktop starts injecting reaches hosted assistants and cron fires alike."""
    assert hosted_profiles.ACCOUNT_ENV_NAMES is cron_account_env.ACCOUNT_ENV_NAMES


def test_the_shared_names_are_the_accounts_and_never_a_provider_or_relay_secret():
    from plugins.apexnodes_gateway import DESKTOP_SPAWN_ENV_CONTRACT

    names = set(hosted_profiles.ACCOUNT_ENV_NAMES)

    assert len(names) == len(hosted_profiles.ACCOUNT_ENV_NAMES)
    assert set(DESKTOP_SPAWN_ENV_CONTRACT) <= names
    assert not names & set(cron_account_env.PER_ASSISTANT_GATES)
    assert not names & {"API_SERVER_KEY", "MODEL_API_KEY", "HERMES_DASHBOARD_SESSION_TOKEN"}
    assert not [n for n in names if n.startswith(("GATEWAY_RELAY_", "AUXILIARY_"))]
    # Both carry the account's managed relay key for the platform's own gateways (search, and
    # since hc-1214 extraction): an account credential, not a provider's.
    assert sorted(n for n in names if n.endswith("_API_KEY")) == ["FIRECRAWL_API_KEY", "SEARXNG_API_KEY"]


def test_installing_twice_wraps_once(seam):
    names, environ_or = secret_scope._GLOBAL_ENV_EXACT, secret_scope._environ_or

    assert hosted_profiles._install_account_env(secret_scope) is True
    assert secret_scope._GLOBAL_ENV_EXACT is names
    assert secret_scope._environ_or is environ_or


# ── maintenance for every hosted profile ────────────────────────────────────


def _fake_sessions_module(calls: list):
    module = types.ModuleType("fake_web_server_sessions")

    def maintenance(started_at):
        calls.append(("curator", str(get_hermes_home()), started_at))

    def archive(profile):
        calls.append(("archive", profile, str(get_hermes_home())))

    module._maybe_run_skill_maintenance = maintenance
    module._maybe_auto_archive_for_profile = archive
    return module


@contextlib.contextmanager
def _home_scope(home):
    token = set_hermes_home_override(str(home))
    try:
        yield
    finally:
        reset_hermes_home_override(token)


def test_maintenance_runs_for_the_launch_profile_then_each_hosted_one_in_its_own_home(monkeypatch, tmp_path):
    calls: list = []
    module = _fake_sessions_module(calls)
    writer, copy = tmp_path / "profiles" / "apex-bot-2", tmp_path / "profiles" / "apex-bot-3"
    monkeypatch.setattr(hosted_profiles, "hosted_profiles", lambda: [("apex-bot-2", writer), ("apex-bot-3", copy)])
    monkeypatch.setattr(hosted_profiles, "profile_scope", _home_scope)
    launch = str(get_hermes_home())

    assert hosted_profiles._install_maintenance(module) is True
    module._maybe_run_skill_maintenance(12.0)

    assert calls == [
        ("curator", launch, 12.0),
        ("archive", "apex-bot-2", str(writer)),
        ("curator", str(writer), 12.0),
        ("archive", "apex-bot-3", str(copy)),
        ("curator", str(copy), 12.0),
    ]


def test_one_profile_failing_does_not_stop_the_others_and_installing_twice_wraps_once(monkeypatch, tmp_path):
    calls: list = []
    module = _fake_sessions_module(calls)
    broken, fine = tmp_path / "profiles" / "broken", tmp_path / "profiles" / "fine"
    monkeypatch.setattr(hosted_profiles, "hosted_profiles", lambda: [("broken", broken), ("fine", fine)])

    @contextlib.contextmanager
    def scope(home):
        if home == broken:
            raise RuntimeError("its config does not load")
        with _home_scope(home):
            yield

    monkeypatch.setattr(hosted_profiles, "profile_scope", scope)

    assert hosted_profiles._install_maintenance(module) is True
    wrapped = module._maybe_run_skill_maintenance
    assert hosted_profiles._install_maintenance(module) is True
    assert module._maybe_run_skill_maintenance is wrapped

    module._maybe_run_skill_maintenance(1.0)

    assert [c for c in calls if c[0] == "archive"] == [("archive", "fine", str(fine))]


def test_serves_hourly_ticker_reaches_every_hosted_profile(monkeypatch, tmp_path):
    """The ticker looks its chores up by module global at call time, so the wrapper is what it runs."""
    import asyncio

    from hermes_cli import web_server_sessions as sessions

    calls: list = []
    home = tmp_path / "profiles" / "apex-bot-2"
    monkeypatch.setattr(
        sessions, "_maybe_auto_archive_for_profile", lambda profile: calls.append(("archive", profile, str(get_hermes_home())))
    )
    monkeypatch.setattr(sessions, "_maybe_run_skill_maintenance", lambda _at: calls.append(("curator", str(get_hermes_home()))))
    monkeypatch.setattr(hosted_profiles, "hosted_profiles", lambda: [("apex-bot-2", home)])
    monkeypatch.setattr(hosted_profiles, "profile_scope", _home_scope)
    launch = str(get_hermes_home())
    assert hosted_profiles._install_maintenance(sessions) is True

    async def one_tick():
        ticker = asyncio.create_task(sessions._auto_archive_ticker_loop(interval_s=3600, initial_delay_s=0))
        for _ in range(200):
            await asyncio.sleep(0.01)
            if len(calls) >= 4:
                break
        ticker.cancel()

    asyncio.run(one_tick())

    assert calls == [
        ("archive", None, launch),
        ("curator", launch),
        ("archive", "apex-bot-2", str(home)),
        ("curator", str(home)),
    ]


def test_a_hosted_profiles_scope_binds_its_home_and_its_own_secrets(tmp_path):
    """Upstream's build scope is what each hosted pass runs under; a rename must fail here, not log hourly."""
    home = tmp_path / "profiles" / "apex-bot-2"
    home.mkdir(parents=True)
    (home / ".env").write_text("DEEPSEEK_API_KEY=its-own\n", encoding="utf-8")

    with hosted_profiles.profile_scope(home):
        assert get_hermes_home() == home
        assert secret_scope.current_secret_scope_home() == str(home)
        assert secret_scope.get_secret("DEEPSEEK_API_KEY") == "its-own"


def test_under_the_real_turn_scope_the_account_credentials_appear_only_with_the_seam(monkeypatch, tmp_path):
    monkeypatch.setattr(secret_scope, "_GLOBAL_ENV_EXACT", secret_scope._GLOBAL_ENV_EXACT)
    monkeypatch.setattr(secret_scope, "_environ_or", secret_scope._environ_or)
    monkeypatch.setenv("TOOLS_GATEWAY_KEY", "account-key")
    monkeypatch.setenv("HERMES_PLATFORM_API_BASE", "https://platform.invalid")
    home = tmp_path / "profiles" / "apex-bot-2"
    home.mkdir(parents=True)

    with hosted_profiles.profile_scope(home):
        assert secret_scope.get_secret("TOOLS_GATEWAY_KEY") is None

    hosted_profiles._install_account_env(secret_scope)

    with hosted_profiles.profile_scope(home):
        assert secret_scope.get_secret("TOOLS_GATEWAY_KEY") == "account-key"
        assert secret_scope.get_secret("HERMES_PLATFORM_API_BASE") == "https://platform.invalid"


def test_the_hosted_profiles_are_every_live_profile_but_the_one_the_engine_started_as(monkeypatch, tmp_path):
    root = tmp_path / "hermes"
    for name in ("apex-bot-2", "apex-bot-3"):
        (root / "profiles" / name).mkdir(parents=True)
        (root / "profiles" / name / "config.yaml").write_text("model: {}\n", encoding="utf-8")
    monkeypatch.setenv("HERMES_HOME", str(root))

    names = [name for name, _home in hosted_profiles.hosted_profiles()]

    assert "default" not in names
    assert sorted(names) == ["apex-bot-2", "apex-bot-3"]
