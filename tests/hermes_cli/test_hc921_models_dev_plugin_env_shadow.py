"""hc-921: a models.dev listing must not take a plugin provider's own credential env vars away.

models.dev started listing CommandCode under ``CMD_API_KEY``. The plugin profile, config
defaults, doctor, dump and the docs all name ``COMMANDCODE_API_KEY``. ``get_provider`` builds a
models.dev-backed ``ProviderDef`` from the catalog's env list plus the Hermes overlay, so until
the ``commandcode`` overlay existed the plugin's key and base-URL var vanished from
``resolve_provider_full`` (and ``test_resolve_provider_full`` went red against the live catalog).

Runtime credential lookup reads ``PROVIDER_REGISTRY`` (mirrored from the plugin profiles), not
that ``ProviderDef``, so users kept their key. That contract is pinned separately here, for every
api_key plugin profile: listing a provider in models.dev under another env var and endpoint must
not change which key or endpoint the runtime resolves.

Both tests stub the catalog, so they do not depend on what models.dev serves today.
"""

from __future__ import annotations

import os

import pytest


def _split_env_vars(env_vars) -> tuple[list[str], list[str]]:
    """(key vars, URL vars) as the profile declares them; written out here, not imported."""
    url_vars = [v for v in env_vars if v.endswith("_URL")]
    return [v for v in env_vars if v not in url_vars], url_vars


_COMMANDCODE_CATALOG_ENTRY = {
    "id": "commandcode", "name": "CommandCode", "env": ["CMD_API_KEY"],
    "api": "https://api.commandcode.ai/provider/v1", "doc": "https://commandcode.ai/docs/provider",
    "models": {},
}


@pytest.mark.parametrize("catalog", [
    pytest.param({"commandcode": _COMMANDCODE_CATALOG_ENTRY}, id="models.dev lists CMD_API_KEY"),
    pytest.param({"commandcode": {**_COMMANDCODE_CATALOG_ENTRY, "api": "https://moved.commandcode.invalid/v1"}},
                 id="models.dev lists another endpoint"),
    pytest.param({}, id="models.dev omits commandcode"),
])
def test_commandcode_provider_def_keeps_plugin_env_vars(monkeypatch, catalog):
    monkeypatch.setattr("agent.models_dev.fetch_models_dev", lambda *a, **k: catalog)
    import model_tools  # registers the plugin profiles, as the profile tests do
    import providers
    from hermes_cli.providers import get_label, get_provider, resolve_provider_full

    profile = providers.get_provider_profile("commandcode")
    key_vars, url_vars = _split_env_vars(profile.env_vars)
    assert key_vars == ["COMMANDCODE_API_KEY"] and url_vars == ["COMMANDCODE_BASE_URL"]
    # Once the overlay exists it owns the ProviderDef in every catalog state, so the label the
    # /model switch and the picker show must not fall back to the raw id when models.dev omits it.
    assert get_label("commandcode") == profile.display_name

    for pdef in (get_provider("commandcode"), resolve_provider_full("commandcode", {}, [])):
        assert pdef is not None and pdef.id == "commandcode"
        assert pdef.name == profile.display_name
        assert set(key_vars) <= set(pdef.api_key_env_vars)
        assert pdef.base_url_env_var == url_vars[0]
        assert pdef.base_url == profile.base_url
        assert pdef.transport == "openai_chat"


def test_plugin_api_key_survives_a_models_dev_decoy_listing(monkeypatch):
    import model_tools
    import providers
    import agent.models_dev as md
    from hermes_cli.providers import normalize_provider
    from hermes_cli.runtime_provider import resolve_runtime_provider

    profiles = sorted((p for p in providers.list_providers() if p.auth_type == "api_key"), key=lambda p: p.name)
    catalog = {}
    for p in profiles:
        for catalog_id in {p.name, normalize_provider(p.name), md.PROVIDER_TO_MODELS_DEV.get(p.name, p.name)}:
            catalog[catalog_id] = {"id": catalog_id, "name": catalog_id, "env": ["HC921_DECOY_API_KEY"],
                                   "api": "https://decoy.hc921.invalid/v1", "models": {}}
    monkeypatch.setattr(md, "fetch_models_dev", lambda *a, **k: catalog)
    for var in [v for v in os.environ if v.endswith(("_API_KEY", "_BASE_URL", "_TOKEN"))]:
        monkeypatch.delenv(var)
    monkeypatch.setenv("HC921_DECOY_API_KEY", "sk-decoy-" + "d" * 24)

    checked, failures = [], []
    for p in profiles:
        key_vars, url_vars = _split_env_vars(p.env_vars or ())
        if not key_vars:
            continue
        key = f"sk-hc921-{p.name.replace('-', '')}-" + "k" * 20
        monkeypatch.setenv(key_vars[0], key)
        # Profiles without a fixed endpoint (azure-foundry) are configured by their URL var.
        own_url = "" if p.base_url else "https://own.hc921.invalid/v1"
        if own_url and url_vars:
            monkeypatch.setenv(url_vars[0], own_url)
        try:
            runtime = resolve_runtime_provider(requested=p.name)
        except Exception as exc:  # a refusal is a failure too: the user's own key was set
            failures.append(f"{p.name}: {type(exc).__name__}: {exc}")
        else:
            base = runtime.get("base_url") or ""
            if runtime.get("api_key") != key:
                failures.append(f"{p.name}: {key_vars[0]} not resolved (got {str(runtime.get('api_key'))[:12]!r})")
            if "decoy.hc921.invalid" in base:
                failures.append(f"{p.name}: endpoint taken from the models.dev listing ({base})")
            checked.append(p.name)
        finally:
            monkeypatch.delenv(key_vars[0])
            if own_url and url_vars:
                monkeypatch.delenv(url_vars[0])

    assert {"commandcode", "commandcode-anthropic"} <= set(checked)
    assert not failures, "\n".join(failures)
