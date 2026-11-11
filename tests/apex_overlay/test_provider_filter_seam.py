"""Seam-test + behavior test for the apex_overlay hc-392/hc-621 provider denylist.

This is the PILOT seam-test (see ``apex_overlay/README.md``). It pins every
upstream symbol that ``apex_overlay.provider_filter`` monkey-patches so an
upstream rename/move turns a *silently disarmed guard* into a *loud CI failure*
— the prerequisite for trusting monkey-patch.

It also proves the behavior the original +34 in-place hc-392 lines provided:

* With the denylist active, a denied provider is skipped **before** its live
  catalog fetch — the fetcher is called **zero** times and no row appears.
* With an **empty** denylist (control), the exact same setup *does* fetch and
  surface it — proving the suppression is the denylist's doing.

hc-621 adds the auth/status layer (the ``gh auth token`` storm: the desktop
shell's ~7.5s accounts poll hit ``get_auth_status("copilot")`` →
``resolve_copilot_token()`` → subprocess + warning, 2684 times in 5.5h, on a
box whose config denied copilot all along). The hc-621 tests assert on what
was spawned and on call counts, not on log strings.

hc-1203 (upstream v0.23.0): GitHub Copilot left core for the ``github-copilot``
labs plugin and core lost its ``gh auth token`` path, so the seam's wrapper on
``hermes_cli.copilot_auth.resolve_copilot_token`` was retired. The picker and
status tests now use providers that are still in core and that APEX denies or
uses (openrouter, deepseek, nous), and
``test_core_resolves_copilot_without_any_subprocess`` pins the replacement
fact: no copilot exit spawns a subprocess, denied or not.

Reverse verification (2026-07-30, hc-621; redone 2026-11-09, hc-1203) — each
gate was knocked out in turn (``if`` → ``if False and``) and the suite re-run;
every knockout turned a specific test red, and the restored file is fully green:

* gate in ``_wrap_cached_provider_model_ids``   → ``test_cached_provider_model_ids_short_circuits_disabled_only``
* row filter in ``_wrap_list_authenticated_providers`` → ``test_denylisted_provider_makes_no_catalog_fetch_and_no_row``
* gate in ``_wrap_get_auth_status``            → ``test_denied_oauth_provider_status_static_no_helper_call``
* gate in ``_wrap_get_api_key_provider_status``→ ``test_denied_api_key_provider_all_resolution_exits_static``
* gate in ``_wrap_resolve_api_key_provider_credentials`` → same test red, plus the copilot-denied case of
  ``test_core_resolves_copilot_without_any_subprocess``
* gate in ``_wrap_provider_model_ids``         → ``test_denied_provider_model_ids_short_circuits``

Run via ``scripts/run_tests_parallel.py`` (per-file fresh interpreter), not a
single in-process pytest — R3 regressed precisely because a process-wide
monkey-patch behaved differently under single-process isolation.
"""

from __future__ import annotations

import inspect
import os
from unittest.mock import MagicMock, patch

import pytest

from apex_overlay import provider_filter


# ---------------------------------------------------------------------------
# Seam assertions — pin the patched symbols' existence + signature
# ---------------------------------------------------------------------------

def test_seam_target_cached_provider_model_ids_exists_with_compatible_signature():
    """apex_overlay patches hermes_cli.models.cached_provider_model_ids.

    If upstream renames/moves it or changes the first positional param away
    from ``provider``, our short-circuit (the 'no copilot fetch' guarantee)
    silently stops working. Fail loudly here instead.
    """
    from hermes_cli import models

    fn = getattr(models, provider_filter._TARGET_CACHED_FN, None)
    assert fn is not None, (
        "hermes_cli.models.cached_provider_model_ids is gone — apex_overlay "
        "provider denylist can no longer cut the copilot fetch. Update "
        "apex_overlay.provider_filter._TARGET_CACHED_FN and the wrapper."
    )
    params = list(inspect.signature(fn).parameters)
    assert params and params[0] == "provider", (
        f"cached_provider_model_ids first param changed to {params!r}; the "
        f"apex_overlay wrapper passes provider positionally."
    )


def test_seam_target_list_authenticated_providers_exists_with_compatible_signature():
    """apex_overlay patches hermes_cli.model_switch.list_authenticated_providers.

    The wrapper relies on the result being a list of row-dicts with a 'slug'
    key and on the call being forwardable via (*args, **kwargs). Pin the
    public keyword params the picker/prewarm depend on.
    """
    from hermes_cli import model_switch

    fn = getattr(model_switch, provider_filter._TARGET_LIST_FN, None)
    assert fn is not None, (
        "list_authenticated_providers is gone — apex_overlay can no longer "
        "drop disabled-provider rows. Update _TARGET_LIST_FN and the wrapper."
    )
    params = inspect.signature(fn).parameters
    for expected in ("current_provider", "max_models"):
        assert expected in params, (
            f"list_authenticated_providers lost the {expected!r} param the "
            f"picker/prewarm call with; apex_overlay forwarding assumptions "
            f"are now stale."
        )


def test_seam_target_auth_status_layer_exists_with_compatible_signatures():
    """hc-621 patches the auth/status funnel — pin all its upstream symbols.

    ``get_auth_status`` / ``get_api_key_provider_status`` /
    ``resolve_api_key_provider_credentials`` take the provider id as their
    first positional param. If upstream renames or reshapes any of them, the deny
    gate silently disarms — fail loudly here instead.
    """
    import inspect as _inspect

    from hermes_cli import auth

    for attr, first_param in (
        (provider_filter._TARGET_STATUS_DISPATCH_FN, "provider_id"),
        (provider_filter._TARGET_APIKEY_STATUS_FN, "provider_id"),
        (provider_filter._TARGET_RESOLVE_CREDS_FN, "provider_id"),
    ):
        fn = getattr(auth, attr, None)
        assert fn is not None, (
            f"hermes_cli.auth.{attr} is gone — the hc-621 deny gate on the "
            f"status/credential layer can no longer bind. Update "
            f"apex_overlay.provider_filter and this seam-test."
        )
        params = list(_inspect.signature(fn).parameters)
        assert params and params[0] == first_param, (
            f"hermes_cli.auth.{attr} first param changed to {params!r}; the "
            f"apex_overlay wrapper forwards the provider id positionally."
        )

    from hermes_cli import models

    fn = getattr(models, provider_filter._TARGET_PROVIDER_MODEL_IDS_FN, None)
    assert fn is not None, (
        "hermes_cli.models.provider_model_ids is gone — the un-cached live "
        "fan-out bypass (validate_requested_model) is no longer gated."
    )
    params = list(_inspect.signature(fn).parameters)
    assert params and params[0] == "provider"


def test_web_status_endpoint_funnels_through_patched_dispatcher():
    """Pin the storm funnel: the accounts-status fallback must route through
    ``get_auth_status`` (the patched symbol).

    ``GET /api/providers/oauth`` resolves catalog-derived providers (that's
    where copilot lives — ``status_fn=None``) via
    ``hauth.get_auth_status(provider_id)``. If upstream reroutes that
    dispatch around ``get_auth_status``, the hc-621 gate stops covering the
    polled endpoint that produced the 7.5s warning storm — turn that into a
    red test instead of a silent regression.
    """
    from pathlib import Path

    repo = Path(__file__).resolve().parents[2]
    src = (repo / "hermes_cli" / "web_routers" / "oauth.py").read_text(encoding="utf-8")
    assert "hauth.get_auth_status(provider_id)" in src, (
        "web_server's provider-status fallback no longer calls "
        "hauth.get_auth_status(provider_id) — the hc-621 deny gate no longer "
        "covers the polled accounts endpoint. Re-locate the funnel and "
        "re-pin it here."
    )


def test_apply_binds_all_targets_and_is_idempotent():
    """apply() must succeed (all targets bound) and be a safe no-op on repeat.

    A False return means a target was missing — which the seam asserts above
    would also catch, but apply() must surface it too so the plugin can warn.
    """
    from hermes_cli import auth, model_switch, models

    # Reset the module guard so this test exercises a real (re)apply even if
    # an earlier test in this file already applied.
    provider_filter._APPLIED = False
    assert provider_filter.apply() is True
    # Patched callables carry our marker — all six targets (hc-1203 retired the copilot token one).
    assert getattr(models.cached_provider_model_ids, provider_filter._MARK, False)
    assert getattr(model_switch.list_authenticated_providers, provider_filter._MARK, False)
    assert getattr(auth.get_auth_status, provider_filter._MARK, False)
    assert getattr(auth.get_api_key_provider_status, provider_filter._MARK, False)
    assert getattr(auth.resolve_api_key_provider_credentials, provider_filter._MARK, False)
    assert getattr(models.provider_model_ids, provider_filter._MARK, False)
    # Idempotent: second apply is a no-op (and must not double-wrap).
    assert provider_filter.apply() is True
    assert getattr(models.cached_provider_model_ids, provider_filter._MARK, False)
    assert getattr(auth.get_auth_status, provider_filter._MARK, False)


# ---------------------------------------------------------------------------
# Behavior — denylist active: copilot skipped BEFORE fetch
# ---------------------------------------------------------------------------

@pytest.fixture()
def _denylist(monkeypatch):
    """Return a setter that injects model.disabled_providers for this test.

    The hermetic test config has no denylist (so the existing
    test_copilot_in_model_list passes). We patch apex_overlay's config reader
    directly — clean, and decoupled from on-disk config layout.
    """
    def _set(*providers: str):
        wanted = {p.strip().lower() for p in providers}
        monkeypatch.setattr(
            provider_filter, "disabled_provider_set", lambda: set(wanted)
        )
    return _set


def _apply_fresh():
    """(Re)install the seam onto the current (possibly re-imported) modules."""
    provider_filter._APPLIED = False
    assert provider_filter.apply() is True


@patch.dict(os.environ, {"OPENROUTER_API_KEY": "sk-or-test"}, clear=False)
def test_denylisted_provider_makes_no_catalog_fetch_and_no_row(_denylist):
    """openrouter in the denylist → its live catalog is fetched zero times, no row.

    OPENROUTER_API_KEY is set, so openrouter *would* be credentialed and fetched
    without the guard. OpenRouter is one of the CN-mode implicit denials, so this
    is a provider APEX really denies. (hc-1203: the original example, GitHub
    Copilot, left core in v0.23.0 for the ``github-copilot`` labs plugin; the
    picker contract is the same for every provider with a live catalog.)
    """
    from hermes_cli import model_switch, models

    _denylist("openrouter")
    _apply_fresh()

    fetch_mock = MagicMock(return_value=["openai/gpt-5"])
    with patch("agent.models_dev.fetch_models_dev", return_value={}), \
         patch.dict(models._PROVIDER_CATALOG_FETCHERS, {"openrouter": fetch_mock}):
        providers = model_switch.list_authenticated_providers(
            current_provider="deepseek", max_models=50,
        )

    assert fetch_mock.call_count == 0, (
        "openrouter is denylisted but its live model catalog was still fetched "
        "— the apex_overlay short-circuit on cached_provider_model_ids didn't "
        "fire before the live fetch."
    )
    slugs = {p["slug"] for p in providers}
    assert "openrouter" not in slugs, f"denylisted openrouter still in picker: {slugs}"


@patch.dict(os.environ, {"OPENROUTER_API_KEY": "sk-or-test"}, clear=False)
def test_empty_denylist_control_provider_appears(_denylist):
    """Control: empty denylist + same setup → openrouter DOES surface, from its live catalog.

    Proves the suppression in the test above is caused by the denylist (the
    apex_overlay seam), not by an unrelated reason.
    """
    from hermes_cli import model_switch, models

    _denylist()  # empty denylist
    _apply_fresh()

    live_models = ["openai/gpt-5", "anthropic/claude-sonnet-4.5"]
    fetch_mock = MagicMock(return_value=live_models)
    with patch("agent.models_dev.fetch_models_dev", return_value={}), \
         patch.dict(models._PROVIDER_CATALOG_FETCHERS, {"openrouter": fetch_mock}):
        providers = model_switch.list_authenticated_providers(
            current_provider="deepseek", max_models=50,
        )

    row = next((p for p in providers if p["slug"] == "openrouter"), None)
    assert row is not None, (
        "With an empty denylist openrouter must appear (OPENROUTER_API_KEY is "
        "set) — if it doesn't, the test is no longer proving the denylist is the cause."
    )
    assert row["models"] == live_models
    assert fetch_mock.call_count >= 1


def test_cached_provider_model_ids_short_circuits_disabled_only(_denylist):
    """The patched cached_provider_model_ids returns [] for disabled providers
    and otherwise delegates untouched to upstream."""
    from hermes_cli import models

    _denylist("openrouter")
    _apply_fresh()

    # disabled → [] without calling through. The live fan-out below the cache is
    # replaced by an ungated spy, so only THIS gate can keep it from running (the
    # provider_model_ids gate would otherwise hide a missing cached-layer gate).
    with patch("hermes_cli.models.provider_model_ids", return_value=["openai/gpt-5"]) as live:
        assert models.cached_provider_model_ids("openrouter") == []
    assert live.call_count == 0

    # a non-disabled provider still flows through to the real implementation.
    # Patch the underlying live fetch so we assert delegation without network.
    with patch("hermes_cli.models.provider_model_ids", return_value=["m1", "m2"]) as live:
        out = models.cached_provider_model_ids("deepseek")
    assert out == ["m1", "m2"]
    assert live.called, "non-disabled provider must delegate to upstream"


# ---------------------------------------------------------------------------
# hc-621 behavior — the auth/status layer never probes a denied provider
# ---------------------------------------------------------------------------

@pytest.fixture()
def _no_subprocess(monkeypatch):
    """Record (and refuse) every ``subprocess.run`` / ``subprocess.Popen`` call.

    hc-621's storm was a ``gh auth token`` subprocess per status poll. The
    assertions are on what was spawned, never on log text.
    """
    import subprocess

    spawned: list = []

    def refuse(*args, **kwargs):
        spawned.append(args[0] if args else kwargs.get("args"))
        raise OSError("subprocess refused by the hc-621 seam test")

    monkeypatch.setattr(subprocess, "run", refuse)
    monkeypatch.setattr(subprocess, "Popen", refuse)
    for var in ("COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"):
        monkeypatch.delenv(var, raising=False)
    return spawned


@pytest.mark.parametrize("denied", [("copilot",), ()], ids=["copilot-denied", "nothing-denied"])
def test_core_resolves_copilot_without_any_subprocess(_denylist, _no_subprocess, caplog, denied):
    """hc-1203: the storm exit is gone from core, denied or not.

    v0.23.0 moved Copilot to the ``github-copilot`` labs plugin (installed only
    for a profile that chose Copilot) and dropped core's ``gh auth token``
    resolution, so the hc-621 wrapper on ``resolve_copilot_token`` was retired.
    Pin the replacement fact: every status / credential / catalog exit for
    ``copilot`` returns without a subprocess and without a warning. If a later
    upstream puts a ``gh`` probe back into core, this turns red.
    """
    import logging

    from agent.credential_pool import _seed_from_singletons
    from hermes_cli import auth, models

    _denylist(*denied)
    _apply_fresh()

    with caplog.at_level(logging.WARNING):
        for _ in range(3):  # the shell's polling loop
            assert auth.get_auth_status("copilot")["logged_in"] is False
        assert auth.get_api_key_provider_status("copilot")["configured"] is False
        try:
            creds = auth.resolve_api_key_provider_credentials("copilot")
        except auth.AuthError:
            assert not denied, "a denied provider must get the static empty credentials"
        else:
            assert denied and creds["api_key"] == "" and creds["disabled"] is True
        entries: list = []
        _seed_from_singletons("copilot", entries)
        assert entries == []
        with patch("agent.models_dev.fetch_models_dev", return_value={}):
            models.provider_model_ids("copilot")

    assert _no_subprocess == [], f"copilot resolution spawned {_no_subprocess!r}"
    hermes_warnings = [
        r for r in caplog.records
        if r.levelno >= logging.WARNING and r.name.startswith("hermes_cli")
    ]
    assert hermes_warnings == [], [r.getMessage() for r in hermes_warnings]


@patch.dict(os.environ, {"DEEPSEEK_API_KEY": "sk-ds-test"}, clear=False)
def test_denied_api_key_provider_all_resolution_exits_static(_denylist, _no_subprocess):
    """Every credential-resolution exit for a denied API-key provider answers statically.

    The api-key status snapshot, the runtime credential resolver and the
    credential-pool seed every ``load_pool`` triggers: denied deepseek (key set)
    resolves no key and seeds nothing.
    """
    from agent.credential_pool import _seed_from_singletons
    from hermes_cli import auth

    _denylist("deepseek")
    _apply_fresh()

    status = auth.get_api_key_provider_status("deepseek")
    assert status["configured"] is False and status["disabled"] is True

    creds = auth.resolve_api_key_provider_credentials("deepseek")
    assert creds["api_key"] == ""
    assert creds["disabled"] is True

    entries: list = []
    _seed_from_singletons("deepseek", entries)
    assert entries == [], "denied deepseek must not seed pool entries"
    assert _no_subprocess == []


def test_denied_oauth_provider_status_static_no_helper_call(_denylist, monkeypatch):
    """Gate 3 (``get_auth_status``) is load-bearing on its own for OAuth providers.

    For api-key providers the dispatcher gate is double-covered (the
    ``get_api_key_provider_status`` gate sits below it), but OAuth providers
    — nous, which the CN-mode implicit denylist carries — are covered ONLY
    at the dispatcher. Assert the per-provider status helper is never
    invoked for a denied OAuth provider; removing the ``get_auth_status``
    gate turns exactly this test red (reverse-verified 2026-07-30).
    """
    from hermes_cli import auth

    helper_spy = MagicMock(return_value={"logged_in": True})
    monkeypatch.setattr(auth, "get_nous_auth_status", helper_spy)

    _denylist("nous")
    _apply_fresh()

    status = auth.get_auth_status("nous")
    assert status["disabled"] is True
    assert status["logged_in"] is False
    assert helper_spy.call_count == 0, (
        "denied OAuth provider's status helper was invoked — the dispatcher "
        "gate (get_auth_status) is not answering statically."
    )


@patch.dict(os.environ, {"DEEPSEEK_API_KEY": "sk-ds-test"}, clear=False)
def test_undenied_provider_status_delegates_to_upstream(_denylist):
    """Status for a provider NOT in the denylist flows through to upstream.

    ``get_auth_status("deepseek")`` with only ``nous`` denied must reach the
    real api-key status path and report the configured key — the deny gate is
    the *list entry*, not a blanket switch on the status layer.
    """
    from hermes_cli import auth

    _denylist("nous")
    _apply_fresh()

    status = auth.get_auth_status("deepseek")
    assert status.get("disabled") is not True
    assert status["logged_in"] is True, (
        "un-denied deepseek with DEEPSEEK_API_KEY set must report logged_in "
        "via the real upstream status path"
    )


def test_denied_provider_model_ids_short_circuits(_denylist):
    """The un-cached live fan-out returns [] for a denied provider.

    ``validate_requested_model`` / ``curated_models_for_provider`` call
    ``provider_model_ids`` directly (bypassing the patched cached wrapper);
    for a denied provider that path would otherwise still reach its live
    fetcher. Denied → [] before any fetch; a non-denied provider still
    delegates to upstream.
    """
    from hermes_cli import models

    _denylist("openrouter")
    _apply_fresh()

    fetch_mock = MagicMock(return_value=["openai/gpt-5"])
    with patch.dict(models._PROVIDER_CATALOG_FETCHERS, {"openrouter": fetch_mock}):
        assert models.provider_model_ids("openrouter") == []
    assert fetch_mock.call_count == 0

    _denylist("nous")
    with patch.dict(models._PROVIDER_CATALOG_FETCHERS, {"openrouter": fetch_mock}):
        assert models.provider_model_ids("openrouter") == ["openai/gpt-5"]
    assert fetch_mock.call_count == 1


# ---------------------------------------------------------------------------
# Wiring / load-timing — the seam loads via the plugin, before picker prewarm
# ---------------------------------------------------------------------------

def test_plugin_register_applies_seam():
    """The bundled apex-overlay plugin's register() applies this seam too."""
    from tests.apex_overlay.conftest import run_plugin_register_with_stubbed_seams

    called = run_plugin_register_with_stubbed_seams("_apex_overlay_plugin_under_test")
    assert "provider_filter" in called, (
        "plugin.register() must call provider_filter.apply()"
    )


def test_apex_overlay_enabled_in_config_and_discovered_before_prewarm(monkeypatch):
    """Belt-and-suspenders on the load contract:

    1. cli-config.yaml.example enables the apex-overlay plugin (config tier).
    2. The picker prewarm worker finishes plugin discovery before it lists providers,
       so the seam is installed before any background catalog fetch. (hc-911: v0.22
       moved the prewarm into the TUI mixin and discovers plugins on a background
       thread, so source order in cli.py no longer says anything.)
    """
    from pathlib import Path

    from hermes_cli import inventory, model_switch, model_switch_providers, plugins

    repo = Path(__file__).resolve().parents[2]
    cfg = (repo / "cli-config.yaml.example").read_text(encoding="utf-8")
    assert "apex-overlay" in cfg, (
        "cli-config.yaml.example must list apex-overlay under plugins.enabled "
        "or the seam never loads in production."
    )

    order = []
    monkeypatch.setattr(plugins, "discover_plugins", lambda *a, **k: order.append("discover"))
    monkeypatch.setattr(inventory, "load_picker_context", lambda: order.append("context") or _PickerContext())
    monkeypatch.setattr(model_switch, "list_authenticated_providers", lambda **k: order.append("list"))
    monkeypatch.setattr(model_switch_providers, "_picker_prewarm_done", __import__("threading").Event())
    thread = model_switch_providers.prewarm_picker_cache_async()
    assert thread is not None
    thread.join(10)
    assert order == ["discover", "context", "list"], (
        "plugin discovery must finish before the picker prewarm lists providers so the "
        "apex_overlay denylist suppresses the copilot fetch in time."
    )


class _PickerContext:
    current_provider = current_base_url = current_model = ""
    user_providers = custom_providers = excluded_providers = None
