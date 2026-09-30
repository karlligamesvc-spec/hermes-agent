"""hc-905: named custom creation snapshots must remain runnable after a global switch.

The fixture uses real config, job storage and provider resolution. It never contacts an endpoint
or reads user credentials; a socket guard makes an accidental network request fail the test.
"""
from pathlib import Path
import socket

import pytest
import yaml

from cron import jobs, scheduler


@pytest.fixture
def runtime_home(tmp_path, monkeypatch):
    home = tmp_path / "hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setattr(scheduler, "_get_hermes_home", lambda: home)

    def forbid_network(*_args, **_kwargs):
        raise AssertionError("Snapshot fixture must never contact a model endpoint")

    monkeypatch.setattr(socket.socket, "connect", forbid_network)
    monkeypatch.setattr(socket, "create_connection", forbid_network)
    with jobs.use_cron_store(home):
        yield home


def write_config(home, style, selected="alpha", *, same_endpoint=False, cron=None):
    entries = {
        name: {"base_url": f"https://{'shared' if same_endpoint else name}.example.invalid/v1",
               "api_key": f"fixture-key-{name}", "model": f"fixture-model-{name}"}
        for name in ("alpha", "beta")
    }
    cfg = {"model": {"provider": f"custom:{selected}", "default": f"fixture-model-{selected}",
                     "base_url": entries[selected]["base_url"], "api_key": entries[selected]["api_key"]}}
    if style == "legacy":
        cfg["custom_providers"] = [{"name": name, **entry} for name, entry in entries.items()]
    else:
        cfg["providers"] = {name: {"api": entry["base_url"], "api_key": entry["api_key"],
                                  "default_model": entry["model"]} for name, entry in entries.items()}
    if cron:
        cfg["cron"] = cron
    # A fresh inode invalidates the real config cache deterministically without sleeps.
    temporary = home / "next-config.yaml"
    temporary.write_text(yaml.safe_dump(cfg))
    temporary.replace(home / "config.yaml")
    return cfg


def resolve_job(job):
    config = scheduler._load_cron_job_config(job, job["id"], job["name"])
    return scheduler._resolve_job_runtime(job, job["id"], config)


@pytest.mark.parametrize("style", ["legacy", "keyed"])
@pytest.mark.parametrize("entry", ["create", "clear-pin", "resnap-one", "resnap-all"])
def test_named_snapshot_stays_with_creation_endpoint(runtime_home, style, entry):
    write_config(runtime_home, style)
    job = jobs.create_job(prompt="fixture goal", name="fixture-only", schedule="every 1h",
                          provider="custom:beta" if entry == "clear-pin" else None)
    if entry == "clear-pin":
        job = jobs.update_job(job["id"], {"provider": None})
    elif entry == "resnap-one":
        job = jobs.resnapshot_job(job["id"])
    elif entry == "resnap-all":
        job = next(row for row in jobs.resnapshot_all_unpinned() if row["id"] == job["id"])
    assert job["provider"] is None
    assert job["provider_snapshot"] == "custom:alpha"
    assert job["model_snapshot"] == "fixture-model-alpha"
    write_config(runtime_home, style, "beta")
    runtime, model = resolve_job(jobs.get_job(job["id"]))
    assert runtime["base_url"] == "https://alpha.example.invalid/v1"
    assert runtime["api_key"] == "fixture-key-alpha"
    assert runtime["requested_provider"] == "custom:alpha"
    assert model == "fixture-model-alpha"


def test_same_endpoint_entries_keep_the_selected_credential_identity(runtime_home):
    write_config(runtime_home, "keyed", "beta", same_endpoint=True)
    job = jobs.create_job(prompt="fixture goal", name="fixture-only", schedule="every 1h")
    assert job["provider_snapshot"] == "custom:beta"
    write_config(runtime_home, "keyed", "alpha", same_endpoint=True)
    runtime, _ = resolve_job(job)
    assert runtime["requested_provider"] == "custom:beta"
    assert runtime["api_key"] == "fixture-key-beta"


def test_explicit_pin_fleet_default_and_legacy_without_snapshot_keep_precedence(runtime_home):
    write_config(runtime_home, "legacy", "alpha")
    unpinned = jobs.create_job(prompt="fixture", name="fixture-only", schedule="every 1h")
    pinned = jobs.create_job(prompt="fixture", name="fixture-pinned", schedule="every 1h",
                             provider="custom:beta", model="fixture-model-beta")
    assert pinned["provider_snapshot"] is None
    write_config(runtime_home, "legacy", "beta")
    runtime, model = resolve_job(pinned)
    assert (runtime["requested_provider"], runtime["api_key"], model) == (
        "custom:beta", "fixture-key-beta", "fixture-model-beta")
    runtime, model = resolve_job({**unpinned, "provider_snapshot": None, "model_snapshot": None})
    assert (runtime["requested_provider"], runtime["api_key"], model) == (
        "custom:beta", "fixture-key-beta", "fixture-model-beta")
    write_config(runtime_home, "legacy", "alpha", cron={
        "model_provider": "custom:beta", "model": "fixture-model-beta"})
    runtime, model = resolve_job(unpinned)
    assert (runtime["requested_provider"], runtime["api_key"], model) == (
        "custom:beta", "fixture-key-beta", "fixture-model-beta")


def test_old_bare_custom_snapshot_is_not_guessed_from_current_global(runtime_home):
    write_config(runtime_home, "legacy", "beta")
    job = jobs.create_job(prompt="fixture", name="fixture-only", schedule="every 1h")
    old_record = {**job, "provider_snapshot": "custom"}
    runtime, _ = resolve_job(old_record)
    assert runtime["requested_provider"] == "custom"
    assert runtime["base_url"] != "https://beta.example.invalid/v1"
    assert runtime.get("api_key") != "fixture-key-beta"
    assert old_record["provider_snapshot"] == "custom"


def test_bare_custom_snapshot_and_no_agent_job_keep_their_meaning(runtime_home):
    cfg = write_config(runtime_home, "legacy")
    cfg["model"]["provider"] = "custom"
    (runtime_home / "config.yaml").write_text(yaml.safe_dump(cfg))
    job = jobs.create_job(prompt="fixture", name="fixture-only", schedule="every 1h")
    assert job["provider_snapshot"] == "custom"
    runtime, _ = resolve_job(job)
    assert runtime["base_url"] == "https://alpha.example.invalid/v1"
    assert runtime["api_key"] == "fixture-key-alpha"
    script = jobs.create_job(prompt="", script="fixture.sh", no_agent=True, schedule="every 1h")
    assert script["provider_snapshot"] is None
    assert script["model_snapshot"] is None


def test_auto_snapshots_the_concrete_provider_instead_of_future_global_choice(runtime_home, monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "fixture-key-openrouter")
    (runtime_home / "config.yaml").write_text(yaml.safe_dump({
        "model": {"provider": "auto", "default": "fixture-auto-model"}}))
    job = jobs.create_job(prompt="fixture", name="fixture-only", schedule="every 1h")
    assert job["provider_snapshot"] == "openrouter"
    assert job["model_snapshot"] == "fixture-auto-model"
    write_config(runtime_home, "keyed", "beta")
    runtime, model = resolve_job(job)
    assert runtime["provider"] == "openrouter"
    assert runtime["api_key"] == "fixture-key-openrouter"
    assert runtime["base_url"] == "https://openrouter.ai/api/v1"
    assert model == "fixture-auto-model"


def test_named_fallback_after_real_missing_oauth_keeps_provider_and_model_together(runtime_home):
    cfg = write_config(runtime_home, "keyed", "beta")
    cfg["fallback_providers"] = [{"provider": "custom:alpha", "model": "fixture-model-alpha"}]
    (runtime_home / "config.yaml").write_text(yaml.safe_dump(cfg))
    job = jobs.create_job(prompt="fixture", name="fixture-only", schedule="every 1h",
                          provider="nous", model="fixture-nonexistent-primary")
    runtime, model = resolve_job(job)
    assert runtime["provider"] == "custom:alpha"
    assert runtime["requested_provider"] == "custom:alpha"
    assert runtime["api_key"] == "fixture-key-alpha"
    assert runtime["base_url"] == "https://alpha.example.invalid/v1"
    assert model == "fixture-model-alpha"


def test_custom_alias_preserves_its_requested_identity(runtime_home):
    # A saved provider can use a resolver alias without a custom: prefix.
    cfg = write_config(runtime_home, "keyed")
    cfg["providers"] = {"ollama": cfg["providers"]["alpha"], "beta": cfg["providers"]["beta"]}
    cfg["model"]["provider"] = "ollama"
    (runtime_home / "config.yaml").write_text(yaml.safe_dump(cfg))
    job = jobs.create_job(prompt="fixture", name="fixture-only", schedule="every 1h")
    assert job["provider_snapshot"] == "ollama"
    cfg["model"] = {"provider": "custom:beta", "default": "fixture-model-beta"}
    (runtime_home / "config.yaml").write_text(yaml.safe_dump(cfg))
    runtime, model = resolve_job(job)
    assert runtime["requested_provider"] == "ollama"
    assert runtime["api_key"] == "fixture-key-alpha"
    assert runtime["base_url"] == "https://alpha.example.invalid/v1"
    assert model == "fixture-model-alpha"


def test_older_resolver_without_requested_identity_keeps_concrete_provider(runtime_home, monkeypatch):
    # Compatibility with the prior resolver return shape; the actual modern
    # resolver is exercised by the named, bare, alias and auto cases above.
    write_config(runtime_home, "keyed")
    monkeypatch.setattr("hermes_cli.runtime_provider.resolve_runtime_provider",
                        lambda **kwargs: {"provider": "openrouter"})
    job = jobs.create_job(prompt="fixture", name="fixture-only", schedule="every 1h")
    assert job["provider_snapshot"] == "openrouter"


def test_named_snapshot_uses_the_job_owning_profile_credentials(runtime_home, monkeypatch):
    from hermes_constants import get_hermes_home, reset_hermes_home_override, set_hermes_home_override

    monkeypatch.setattr(scheduler, "_get_hermes_home", get_hermes_home)
    for owner in ("owner-a", "owner-b"):
        profile_home = runtime_home / owner
        profile_home.mkdir()
        cfg = write_config(profile_home, "keyed")
        cfg["providers"]["alpha"]["api"] = f"https://{owner}.example.invalid/v1"
        cfg["providers"]["alpha"]["api_key"] = f"fixture-key-{owner}"
        (profile_home / "config.yaml").write_text(yaml.safe_dump(cfg))
        token = set_hermes_home_override(str(profile_home))
        try:
            with jobs.use_cron_store(profile_home):
                job = jobs.create_job(prompt="fixture", name="fixture-only", schedule="every 1h")
                assert job["provider_snapshot"] == "custom:alpha"
                runtime, _ = resolve_job(job)
                assert runtime["base_url"] == f"https://{owner}.example.invalid/v1"
                assert runtime["api_key"] == f"fixture-key-{owner}"
        finally:
            reset_hermes_home_override(token)


def test_model_impact_compares_the_named_snapshot_instead_of_its_billing_class(runtime_home):
    from hermes_cli.config import cron_model_drift_axes, resolve_cron_model_drift_defaults

    cfg = write_config(runtime_home, "keyed")
    job = jobs.create_job(prompt="fixture", name="fixture-only", schedule="every 1h")
    provider, model = resolve_cron_model_drift_defaults(cfg)
    assert cron_model_drift_axes(job, current_provider=provider, current_model=model, config=cfg) == []
    cfg = write_config(runtime_home, "keyed", "beta")
    provider, model = resolve_cron_model_drift_defaults(cfg)
    assert cron_model_drift_axes(job, current_provider=provider, current_model=model, config=cfg) == ["provider", "model"]


def test_auto_custom_does_not_store_auto_as_a_named_identity(runtime_home):
    (runtime_home / "config.yaml").write_text(yaml.safe_dump({
        "model": {"provider": "auto", "default": "fixture-local-model",
                  "base_url": "http://127.0.0.1:1234/v1", "api_key": "fixture-key-local"}}))
    job = jobs.create_job(prompt="fixture", name="fixture-only", schedule="every 1h")
    assert job["provider_snapshot"] == "custom"
    assert job["model_snapshot"] == "fixture-local-model"
