"""Seam-test + behavior test for the apex_overlay hc-392/hc-621 provider denylist.

This is the PILOT seam-test (see ``apex_overlay/README.md``). It pins every
upstream symbol that ``apex_overlay.provider_filter`` monkey-patches so an
upstream rename/move turns a *silently disarmed guard* into a *loud CI failure*
— the prerequisite for trusting monkey-patch.

It also proves the behavior the original +34 in-place hc-392 lines provided:

* With the denylist active, GitHub Copilot is skipped **before** the live
  catalog fetch — ``fetch_github_model_catalog`` is called **zero** times and
  no ``copilot`` row appears.
* With an **empty** denylist (control), the exact same setup *does* fetch and
  surface Copilot — proving the suppression is the denylist's doing, not some
  unrelated reason.

hc-621 adds the auth/status layer (the ``gh auth token`` storm: the desktop
shell's ~7.5s accounts poll hit ``get_auth_status("copilot")`` →
``resolve_copilot_token()`` → subprocess + warning, 2684 times in 5.5h, on a
box whose config denied copilot all along). The hc-621 tests assert on **call
counts** (a spy on ``hermes_cli.copilot_auth.subprocess.run``), not on log
strings:

* denied + the exact storm fixture (no env token, ``gh`` present) → repeated
  status polls, credential resolutions, direct token resolutions and pool
  seeds run **zero** subprocesses and emit **zero** warning records;
* copilot **removed** from the denylist (a different entry stays, proving the
  gate is per-entry) → the same fixture resolves through ``gh`` again —
  the guard is the *list*, not a hardcoded copilot switch.

Reverse verification (2026-07-30, hc-621) — each gate was knocked out in turn
(``if`` → ``if False and``) and the suite re-run; every knockout turned a
specific test red, and the restored file is fully green:

* gate in ``_wrap_get_auth_status``            → ``test_denied_oauth_provider_status_static_no_helper_call``
* gate in ``_wrap_get_api_key_provider_status``→ ``test_denied_copilot_all_resolution_exits_zero_subprocess``
* gate in ``_wrap_resolve_api_key_provider_credentials`` → same test red
* gate in ``_wrap_resolve_copilot_token``      → same test red — failing with
  the exact production error ("Token from `gh auth token` is a classic PAT")
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
    first positional param; ``resolve_copilot_token`` is the zero-arg
    subprocess entry. If upstream renames or reshapes any of them, the deny
    gate silently disarms — fail loudly here instead.
    """
    import inspect as _inspect

    from hermes_cli import auth, copilot_auth

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

    fn = getattr(copilot_auth, provider_filter._TARGET_COPILOT_TOKEN_FN, None)
    assert fn is not None, (
        "hermes_cli.copilot_auth.resolve_copilot_token is gone — the hc-621 "
        "gate on the `gh auth token` subprocess can no longer bind."
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
    src = (repo / "hermes_cli" / "web_server.py").read_text(encoding="utf-8")
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
    from hermes_cli import auth, copilot_auth, model_switch, models

    # Reset the module guard so this test exercises a real (re)apply even if
    # an earlier test in this file already applied.
    provider_filter._APPLIED = False
    assert provider_filter.apply() is True
    # Patched callables carry our marker — all seven targets.
    assert getattr(models.cached_provider_model_ids, provider_filter._MARK, False)
    assert getattr(model_switch.list_authenticated_providers, provider_filter._MARK, False)
    assert getattr(auth.get_auth_status, provider_filter._MARK, False)
    assert getattr(auth.get_api_key_provider_status, provider_filter._MARK, False)
    assert getattr(auth.resolve_api_key_provider_credentials, provider_filter._MARK, False)
    assert getattr(copilot_auth.resolve_copilot_token, provider_filter._MARK, False)
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


@patch.dict(os.environ, {"GH_TOKEN": "test-key"}, clear=False)
def test_copilot_denylisted_makes_no_github_fetch_and_no_row(_denylist):
    """copilot in denylist → 0 calls to fetch_github_model_catalog, no row.

    GH_TOKEN is present so copilot *would* be credentialed and fetched without
    the guard. We assert the live GitHub catalog call never happens (the
    hc-392 'no startup network call' contract) and copilot is absent.
    """
    from hermes_cli import model_switch

    _denylist("copilot")
    _apply_fresh()

    fetch_mock = MagicMock(return_value=[{"id": "gpt-5.4"}])
    with patch("agent.models_dev.fetch_models_dev", return_value={}), \
         patch("hermes_cli.models._resolve_copilot_catalog_api_key", return_value="gh-token"), \
         patch("hermes_cli.models.fetch_github_model_catalog", fetch_mock):
        providers = model_switch.list_authenticated_providers(
            current_provider="openrouter", max_models=50,
        )

    assert fetch_mock.call_count == 0, (
        "copilot is denylisted but its GitHub model catalog was still fetched "
        "— the apex_overlay short-circuit on cached_provider_model_ids didn't "
        "fire before the live fetch."
    )
    slugs = {p["slug"] for p in providers}
    assert "copilot" not in slugs, f"denylisted copilot still in picker: {slugs}"


@patch.dict(os.environ, {"GH_TOKEN": "test-key"}, clear=False)
def test_empty_denylist_control_copilot_appears(_denylist):
    """Control: empty denylist + same setup → copilot DOES surface.

    Proves the suppression in the test above is caused by the denylist (the
    apex_overlay seam), not by an unrelated reason. Mirrors the upstream
    test_copilot_in_model_list contract.
    """
    from hermes_cli import model_switch

    _denylist()  # empty denylist
    _apply_fresh()

    live_models = ["gpt-5.4", "claude-sonnet-4.6"]
    with patch("agent.models_dev.fetch_models_dev", return_value={}), \
         patch("hermes_cli.models._resolve_copilot_catalog_api_key", return_value="gh-token"), \
         patch("hermes_cli.models._fetch_github_models", return_value=live_models):
        providers = model_switch.list_authenticated_providers(
            current_provider="openrouter", max_models=50,
        )

    copilot = next((p for p in providers if p["slug"] == "copilot"), None)
    assert copilot is not None, (
        "With an empty denylist copilot must appear (GH_TOKEN is set) — if it "
        "doesn't, the test is no longer proving the denylist is the cause."
    )
    assert copilot["models"] == live_models


def test_cached_provider_model_ids_short_circuits_disabled_only(_denylist):
    """The patched cached_provider_model_ids returns [] for disabled providers
    and otherwise delegates untouched to upstream."""
    from hermes_cli import models

    _denylist("copilot")
    _apply_fresh()

    # disabled → [] without calling through (no fetch)
    with patch("hermes_cli.models.fetch_github_model_catalog") as fetch_mock:
        assert models.cached_provider_model_ids("copilot") == []
        assert fetch_mock.call_count == 0

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
def _storm_fixture(monkeypatch):
    """Reproduce the exact production storm environment, with a counting spy.

    Kael's box (2026-07-30): no COPILOT_GITHUB_TOKEN / GH_TOKEN /
    GITHUB_TOKEN in env, ``gh`` installed, ``gh auth token`` returning a
    classic PAT (``ghp_*``) — so every status probe fell through to the gh
    CLI subprocess and raised/logged. Returns the subprocess spy; assertions
    are on ``spy.call_count`` (the number of ``gh`` invocations), never on
    log text.
    """
    for var in ("COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"):
        monkeypatch.delenv(var, raising=False)

    import hermes_cli.copilot_auth as copilot_auth

    spy = MagicMock(
        return_value=MagicMock(returncode=0, stdout="ghp_classicpat0123456789\n")
    )
    monkeypatch.setattr(copilot_auth.subprocess, "run", spy)
    # Deterministic `gh` discovery — the real CI box may not have gh.
    monkeypatch.setattr(copilot_auth.shutil, "which", lambda _cmd: "/fake/bin/gh")
    return spy


def test_denied_copilot_status_poll_zero_gh_subprocess_zero_warnings(
    _denylist, _storm_fixture, caplog
):
    """THE hc-621 bug, reproduced: repeated status polls of a denied copilot
    must run **zero** ``gh`` subprocesses and emit **zero** warnings.

    Before the fix, each ``get_auth_status("copilot")`` (the fallback the
    polled ``GET /api/providers/oauth`` endpoint uses for catalog-derived
    providers) reached ``resolve_copilot_token()`` → ``gh auth token`` →
    ``ValueError`` → ``logger.warning`` — every ~7.5s, 2684 times in 5.5h,
    despite ``disabled_providers: [copilot]`` being set the whole time.
    """
    import logging

    from hermes_cli import auth

    _denylist("copilot")
    _apply_fresh()

    with caplog.at_level(logging.WARNING):
        for _ in range(3):  # simulate the shell's polling loop
            status = auth.get_auth_status("copilot")
            assert status["logged_in"] is False
            assert status["configured"] is False
            assert status["disabled"] is True
            assert status["disabled_reason"]

    assert _storm_fixture.call_count == 0, (
        f"denied copilot still spawned {_storm_fixture.call_count} gh "
        f"subprocess call(s) from the status-poll path — the hc-621 gate on "
        f"get_auth_status/resolve_copilot_token is not covering the storm exit."
    )
    hermes_warnings = [
        r for r in caplog.records
        if r.levelno >= logging.WARNING and r.name.startswith("hermes_cli")
    ]
    assert len(hermes_warnings) == 0, (
        f"denied copilot status polls emitted {len(hermes_warnings)} "
        f"warning record(s): {[r.getMessage() for r in hermes_warnings]!r}"
    )


def test_denied_copilot_all_resolution_exits_zero_subprocess(
    _denylist, _storm_fixture
):
    """Every credential-resolution exit for a denied copilot: zero subprocesses.

    Exercises each patched exit directly — the api-key status snapshot, the
    runtime credential resolver (which also owns a *second* direct
    ``resolve_copilot_token`` call for base-URL resolution), the token
    resolver itself (as imported by run_agent's 401-refresh, the auxiliary
    client's refresh, and pool seeding), and the credential-pool seed that
    every ``load_pool("copilot")`` triggers.
    """
    from agent.credential_pool import _seed_from_singletons
    from hermes_cli import auth, copilot_auth

    _denylist("copilot")
    _apply_fresh()

    status = auth.get_api_key_provider_status("copilot")
    assert status["configured"] is False and status["disabled"] is True

    creds = auth.resolve_api_key_provider_credentials("copilot")
    assert creds["api_key"] == ""
    assert creds["disabled"] is True

    token, source = copilot_auth.resolve_copilot_token()
    assert (token, source) == ("", "")

    entries: list = []
    _seed_from_singletons("copilot", entries)
    assert entries == [], "denied copilot must not seed pool entries"

    assert _storm_fixture.call_count == 0, (
        f"denied copilot resolution exits spawned "
        f"{_storm_fixture.call_count} gh subprocess call(s)"
    )


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


def test_undenied_copilot_probe_resumes_via_gh(_denylist, monkeypatch):
    """Remove copilot from the denylist → the gh probe fires again.

    The denylist is NOT empty (``nous`` stays denied), proving the gate is
    the *list entry*, not a hardcoded copilot switch: with copilot absent
    the exact same fixture resolves a token through the gh CLI subprocess
    (call_count >= 1) and returns it unchanged.
    """
    for var in ("COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"):
        monkeypatch.delenv(var, raising=False)

    import hermes_cli.copilot_auth as copilot_auth

    # v0.21 caches both successful and failed gh probes. Keep this test on the
    # uncached boundary so earlier deny-path tests cannot seed its result.
    monkeypatch.setattr(copilot_auth, "_gh_cli_token_cache", None)
    spy = MagicMock(
        return_value=MagicMock(returncode=0, stdout="gho_valid0123456789\n")
    )
    monkeypatch.setattr(copilot_auth.subprocess, "run", spy)
    monkeypatch.setattr(copilot_auth.shutil, "which", lambda _cmd: "/fake/bin/gh")

    _denylist("nous")  # non-empty list WITHOUT copilot
    _apply_fresh()

    token, source = copilot_auth.resolve_copilot_token()
    assert token == "gho_valid0123456789"
    assert source == "gh auth token"
    assert spy.call_count >= 1, (
        "with copilot NOT in the denylist the gh probe must run — if it "
        "doesn't, the wrapper is blocking unconditionally instead of "
        "consulting the list."
    )


def test_undenied_provider_status_delegates_to_upstream(_denylist, monkeypatch):
    """Status for a provider NOT in the denylist flows through to upstream.

    ``get_auth_status("copilot")`` with only ``nous`` denied must reach the
    real api-key status path and report the resolved token — the deny gate
    must not blanket-disable the status layer.
    """
    for var in ("COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"):
        monkeypatch.delenv(var, raising=False)

    import hermes_cli.copilot_auth as copilot_auth
    from hermes_cli import auth

    monkeypatch.setattr(copilot_auth, "_gh_cli_token_cache", None)
    spy = MagicMock(
        return_value=MagicMock(returncode=0, stdout="gho_valid0123456789\n")
    )
    monkeypatch.setattr(copilot_auth.subprocess, "run", spy)
    monkeypatch.setattr(copilot_auth.shutil, "which", lambda _cmd: "/fake/bin/gh")
    # Keep the copilot token exchange local — get_copilot_api_token falls
    # back to the raw token when the exchange raises.
    monkeypatch.setattr(
        copilot_auth, "exchange_copilot_token",
        MagicMock(side_effect=ValueError("offline test")),
    )

    _denylist("nous")
    _apply_fresh()

    status = auth.get_auth_status("copilot")
    assert status.get("disabled") is not True
    assert status["logged_in"] is True, (
        "un-denied copilot with a resolvable gh token must report logged_in "
        "via the real upstream status path"
    )
    assert spy.call_count >= 1


def test_denied_provider_model_ids_short_circuits(_denylist):
    """The un-cached live fan-out returns [] for a denied provider.

    ``validate_requested_model`` / ``curated_models_for_provider`` call
    ``provider_model_ids`` directly (bypassing the patched cached wrapper);
    for a denied copilot that path would otherwise still attempt the GitHub
    catalog (even unauthenticated). Denied → [] before any fetch; a
    non-denied provider still delegates to upstream.
    """
    from hermes_cli import models

    _denylist("copilot")
    _apply_fresh()

    with patch("hermes_cli.models._fetch_github_models") as fetch_mock, \
         patch("hermes_cli.models._resolve_copilot_catalog_api_key") as key_mock:
        assert models.provider_model_ids("copilot") == []
    assert fetch_mock.call_count == 0
    assert key_mock.call_count == 0

    _denylist("nous")
    with patch("hermes_cli.models._fetch_github_models", return_value=["gpt-5.4"]), \
         patch("hermes_cli.models._resolve_copilot_catalog_api_key", return_value="tok"):
        assert models.provider_model_ids("copilot") == ["gpt-5.4"]


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


def test_apex_overlay_enabled_in_config_and_discovered_before_prewarm():
    """Belt-and-suspenders on the load contract:

    1. cli-config.yaml.example enables the apex-overlay plugin (config tier).
    2. In cli.py, plugin discovery is ordered before the picker prewarm call,
       so the seam is installed before any background catalog fetch.
    """
    from pathlib import Path

    repo = Path(__file__).resolve().parents[2]

    cfg = (repo / "cli-config.yaml.example").read_text(encoding="utf-8")
    assert "apex-overlay" in cfg, (
        "cli-config.yaml.example must list apex-overlay under plugins.enabled "
        "or the seam never loads in production."
    )

    cli_src = (repo / "cli.py").read_text(encoding="utf-8")
    discover_idx = cli_src.find("discover_plugins()")
    prewarm_idx = cli_src.find("prewarm_picker_cache_async()")
    assert discover_idx != -1 and prewarm_idx != -1
    assert discover_idx < prewarm_idx, (
        "plugin discovery must run before the picker cache prewarm so the "
        "apex_overlay denylist suppresses the copilot fetch in time."
    )
