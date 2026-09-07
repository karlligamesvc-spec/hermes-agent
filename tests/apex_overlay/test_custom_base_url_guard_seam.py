"""Seam-test + behavior test for apex_overlay.custom_base_url_guard.

Pins the upstream symbol the seam monkey-patches
(``hermes_cli.web_server._apply_main_model_assignment``) so an upstream
rename/move turns a silently-disarmed seam into a loud CI failure, and proves
the regression it exists for:

the managed ApexNodes relay is the **bare** ``custom`` provider, whose only
address is ``model.base_url``. Upstream clears ``base_url`` on any provider
switch — correct for a registry provider that knows its own host, destructive
here. One round trip through the desktop's silent multi-select (relay →
virtual ``moa`` → back to a single model) erases it, and the model picker then
has no URL to match its saved ``custom_providers`` row against, so it stops
probing the live catalog and collapses to the one configured model id.
"""

from __future__ import annotations

import copy
import importlib
import inspect
import sys
import types

import pytest
import yaml

from apex_overlay import custom_base_url_guard
from apex_overlay.custom_base_url_guard import (
    blank_custom_base_url_repair,
    in_custom_family,
    routed_endpoint_url,
)


RELAY_URL = "https://apex-nodes.com/relay/v1"
MANAGED_SLUG = "custom:apex-nodes.com"
MANAGED_MODEL = "deepseek-v4-pro-APEX"

# The relay entry the desktop writes (apps/desktop/electron/apex-managed.ts
# buildManagedModelBlock) — the row Kael's machine still had intact while
# model.base_url was empty.
MANAGED_ROW = {
    "name": "Apex-nodes.com",
    "base_url": RELAY_URL,
    "api_key": "sk-relay-test",
    "model": MANAGED_MODEL,
}


@pytest.fixture
def hermes_config():
    """Write a config.yaml into the (hermetic) HERMES_HOME and read it back.

    ``tests/conftest.py`` already points HERMES_HOME at a per-test tempdir, so
    these are real on-disk round trips through the runtime's own loader/writer.
    """
    import hermes_cli.config as config_mod

    def _write(config: dict) -> dict:
        config_mod.get_config_path().write_text(
            yaml.safe_dump(config, sort_keys=False), encoding="utf-8"
        )
        return config_mod.load_config()

    return _write


@pytest.fixture
def restore_meta_path():
    """Undo any import hook a test arms, so later tests start clean."""
    before = list(sys.meta_path)
    yield
    sys.meta_path[:] = before


# ---------------------------------------------------------------------------
# Seam assertion — pin the patched symbol's existence + call shape
# ---------------------------------------------------------------------------

def test_seam_target_apply_main_model_assignment_exists():
    """apex_overlay patches hermes_cli.web_server._apply_main_model_assignment.

    It is the single chokepoint every main-slot assignment goes through
    (``/api/model/set``, custom-endpoint activate, profile writes). If upstream
    renames/moves it, custom-family switches silently start erasing
    ``model.base_url`` again.
    """
    from hermes_cli import web_server

    fn = getattr(web_server, custom_base_url_guard._TARGET_ASSIGN_FN, None)
    assert fn is not None, (
        "hermes_cli.web_server._apply_main_model_assignment is gone — the "
        "custom base_url guard can no longer attach. Update "
        "apex_overlay.custom_base_url_guard._TARGET_ASSIGN_FN and the wrapper."
    )
    positional = [
        name for name, param in inspect.signature(fn).parameters.items()
        if param.kind is inspect.Parameter.POSITIONAL_OR_KEYWORD
    ]
    assert positional[:5] == [
        "model_cfg", "provider", "model", "base_url", "api_key",
    ], (
        "the wrapper forwards these five positionally — upstream now starts "
        f"with {positional[:5]}"
    )


# ---------------------------------------------------------------------------
# Pure rule — which providers have no registry default host
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "provider,expected",
    [
        # The managed relay's own slug (apex-managed.ts MANAGED_PROVIDER).
        ("custom", True),
        ("CUSTOM", True),
        ("  custom  ", True),
        # Named custom_providers rows (custom_provider_slug output).
        (MANAGED_SLUG, True),
        ("custom:my-llama", True),
        ("CUSTOM:My-Llama", True),
        # Registry providers resolve their own host.
        ("deepseek", False),
        ("openrouter", False),
        # The virtual aggregate is not an endpoint at all — upstream's clear
        # stands (that shape is handled read-side by picker_probe_widening).
        ("moa", False),
        # Near-misses must not be swept in.
        ("customer", False),
        ("local", False),
        ("", False),
        (None, False),
    ],
)
def test_in_custom_family(provider, expected):
    assert in_custom_family(provider) is expected


# ---------------------------------------------------------------------------
# Endpoint resolution — never invents a URL, only mirrors upstream's routing
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "provider,expected",
    [
        # Bare `custom` resolves through upstream's documented first-valid-entry
        # fallback (hermes_cli/providers.py resolve_custom_provider, GH #17478).
        ("custom", RELAY_URL),
        # A named row resolves to its own URL.
        (MANAGED_SLUG, RELAY_URL),
        # A raw display name is NOT in the family and is deliberately ignored:
        # upstream's _normalize_main_model_assignment canonicalizes it to
        # `custom:<slug>` before any assignment reaches the chokepoint, so a
        # bare name here would be a shape we do not actually see.
        ("Apex-nodes.com", ""),
        # Outside the family this seam has no opinion.
        ("deepseek", ""),
        ("moa", ""),
        ("", ""),
    ],
)
def test_routed_endpoint_url(provider, expected):
    assert routed_endpoint_url(provider, {"custom_providers": [MANAGED_ROW]}) == expected


def test_routed_endpoint_url_without_a_saved_endpoint():
    """No custom row ⇒ nothing to point at; the seam must stay silent."""
    assert routed_endpoint_url("custom", {"custom_providers": []}) == ""
    assert routed_endpoint_url("custom", {}) == ""


# ---------------------------------------------------------------------------
# Boot self-heal — the damage signature, and everything it must NOT touch
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "model_block,expected",
    [
        # The damage: bare custom, blank URL, relay row present.
        ({"provider": "custom", "default": MANAGED_MODEL, "base_url": ""}, RELAY_URL),
        ({"provider": "custom", "default": MANAGED_MODEL}, RELAY_URL),
        ({"provider": "custom", "base_url": "   "}, RELAY_URL),
        ({"provider": "CUSTOM", "base_url": ""}, RELAY_URL),
        # A URL the user (or a correct assignment) set is never second-guessed —
        # this is also what makes the repair idempotent.
        ({"provider": "custom", "base_url": "https://byo.example/v1"}, ""),
        ({"provider": "custom", "base_url": RELAY_URL}, ""),
        # A named slug is already matchable; not this repair's business.
        ({"provider": MANAGED_SLUG, "base_url": ""}, ""),
        # Other providers, virtual or real, are left alone.
        ({"provider": "moa", "default": "__auto__", "base_url": ""}, ""),
        ({"provider": "deepseek", "base_url": ""}, ""),
        ({}, ""),
    ],
)
def test_blank_custom_base_url_repair(model_block, expected):
    config = {"model": model_block, "custom_providers": [MANAGED_ROW]}
    assert blank_custom_base_url_repair(config) == expected


def test_blank_custom_base_url_repair_ignores_a_non_dict_model():
    assert blank_custom_base_url_repair({"model": "deepseek-v4-pro"}) == ""
    assert blank_custom_base_url_repair({}) == ""


def test_repair_config_base_url_heals_a_stranded_config(hermes_config):
    """Kael's on-disk shape: provider custom, base_url erased, relay row intact."""
    from hermes_cli.config import load_config

    hermes_config({
        "model": {"provider": "custom", "default": MANAGED_MODEL, "base_url": ""},
        "custom_providers": [MANAGED_ROW],
    })

    assert custom_base_url_guard.repair_config_base_url() is True
    assert load_config()["model"]["base_url"] == RELAY_URL

    # Idempotent: a healed config produces no second write.
    assert custom_base_url_guard.repair_config_base_url() is False
    assert load_config()["model"]["base_url"] == RELAY_URL


def test_repair_config_base_url_never_touches_an_explicit_url(hermes_config):
    from hermes_cli.config import load_config

    hermes_config({
        "model": {
            "provider": "custom",
            "default": "my-model",
            "base_url": "https://byo.example/v1",
        },
        "custom_providers": [MANAGED_ROW],
    })

    assert custom_base_url_guard.repair_config_base_url() is False
    assert load_config()["model"]["base_url"] == "https://byo.example/v1"


def test_repair_config_base_url_skips_a_managed_install(hermes_config, monkeypatch):
    """save_config refuses under managed scope — don't warn on every boot."""
    import hermes_cli.config as config_mod

    hermes_config({
        "model": {"provider": "custom", "default": MANAGED_MODEL, "base_url": ""},
        "custom_providers": [MANAGED_ROW],
    })
    monkeypatch.setattr(config_mod, "is_managed", lambda: True)

    assert custom_base_url_guard.repair_config_base_url() is False
    assert config_mod.load_config()["model"].get("base_url", "") == ""


# ---------------------------------------------------------------------------
# Assignment guard — against the real upstream function
# ---------------------------------------------------------------------------

@pytest.fixture
def raw_assign():
    """Upstream's own assignment function, with any seam wrapper peeled off."""
    from hermes_cli import web_server

    return inspect.unwrap(web_server._apply_main_model_assignment)


@pytest.fixture
def guarded_assign(raw_assign, hermes_config):
    """Upstream's function under this seam, over a config holding the relay row."""
    hermes_config({
        "model": {"provider": "custom", "default": MANAGED_MODEL, "base_url": RELAY_URL},
        "custom_providers": [MANAGED_ROW],
    })
    return custom_base_url_guard._wrap_apply_main_model_assignment(raw_assign)


# (starting model block, provider, model, explicit base_url) → expected base_url
_ASSIGNMENTS = [
    # The regression: coming back to the relay off the virtual `moa` provider.
    ({"provider": "moa", "default": "__auto__", "base_url": ""},
     "custom", MANAGED_MODEL, "", RELAY_URL),
    # …and coming back onto the relay's named slug instead.
    ({"provider": "moa", "default": "__auto__", "base_url": ""},
     MANAGED_SLUG, "glm-5.2", "", RELAY_URL),
    # Family-internal switch off a named row: the target's own URL is written.
    ({"provider": "custom:other", "default": "x", "base_url": "https://other/v1"},
     MANAGED_SLUG, "glm-5.2", "", RELAY_URL),
    # An explicit URL always wins — the caller is being specific.
    ({"provider": "moa", "default": "__auto__", "base_url": ""},
     "custom", "x", "https://byo.example/v1", "https://byo.example/v1"),
    # Same-provider re-pick: upstream already preserves, seam must not disturb.
    ({"provider": "custom", "default": MANAGED_MODEL, "base_url": RELAY_URL},
     "custom", "glm-5.2", "", RELAY_URL),
    # Leaving the custom family for a registry provider: upstream's clear is
    # correct (deepseek knows its own host) and must survive.
    ({"provider": "custom", "default": MANAGED_MODEL, "base_url": RELAY_URL},
     "deepseek", "deepseek-chat", "", ""),
    # Into the virtual aggregate: not an endpoint, upstream's clear stands.
    ({"provider": "custom", "default": MANAGED_MODEL, "base_url": RELAY_URL},
     "moa", "__auto__", "", ""),
]


@pytest.mark.parametrize(
    "start,provider,model,base_url,expected_url",
    _ASSIGNMENTS,
    ids=["off-moa-bare", "off-moa-named", "named-to-named", "explicit-url",
         "same-provider", "leaves-family", "into-moa"],
)
def test_guarded_assignment_base_url(
    guarded_assign, start, provider, model, base_url, expected_url
):
    result = guarded_assign(copy.deepcopy(start), provider, model, base_url)

    assert result.get("base_url", "") == expected_url
    # Upstream's own effects are untouched.
    assert result["provider"] == provider
    assert result["default"] == model


def test_upstream_erases_the_relay_url_without_the_guard(raw_assign):
    """Regression fixture: the exact behavior this seam exists to correct."""
    model_cfg = raw_assign(
        {"provider": "moa", "default": "__auto__", "base_url": ""},
        "custom", MANAGED_MODEL,
    )
    assert model_cfg.get("base_url", "") == "", (
        "upstream is expected to leave the bare custom provider with no address"
    )


def test_guard_does_nothing_without_a_saved_endpoint(raw_assign, hermes_config):
    """No custom row to point at ⇒ no invented URL."""
    hermes_config({"model": {"provider": "moa"}, "custom_providers": []})
    guarded = custom_base_url_guard._wrap_apply_main_model_assignment(raw_assign)

    result = guarded({"provider": "moa", "base_url": ""}, "custom", "x")

    assert result.get("base_url", "") == ""


def test_guard_never_raises_into_the_host_path(monkeypatch):
    """A resolution failure must still return upstream's own assignment."""
    sentinel = {"provider": "custom", "base_url": ""}
    guarded = custom_base_url_guard._wrap_apply_main_model_assignment(
        lambda *a, **k: sentinel
    )

    def boom(*_args, **_kwargs):
        raise RuntimeError("config exploded")

    monkeypatch.setattr(custom_base_url_guard, "routed_endpoint_url", boom)

    assert guarded({}, "custom", "x") is sentinel


def test_guard_passes_through_a_non_dict_result():
    guarded = custom_base_url_guard._wrap_apply_main_model_assignment(
        lambda *a, **k: "not-a-dict"
    )
    assert guarded({}, "custom", "x") == "not-a-dict"


def test_wrapper_is_marked_for_idempotence():
    wrapped = custom_base_url_guard._wrap_apply_main_model_assignment(lambda *a: {})
    assert getattr(wrapped, custom_base_url_guard._MARK) is True


# ---------------------------------------------------------------------------
# Kael's machine, end to end: damaged config → boot repair → intact picker
# ---------------------------------------------------------------------------

def test_boot_repair_restores_the_full_picker_catalog(hermes_config):
    """The stranded config alone collapses the picker; the repair un-collapses it.

    Runs upstream's real picker assembly with NO probe seam installed, so this
    proves the write-side repair stands on its own rather than leaning on
    apex_overlay.picker_probe_widening.
    """
    from unittest.mock import patch

    from hermes_cli import model_switch
    from hermes_cli.config import load_config

    live_catalog = ["deepseek-v4-pro", "glm-5.2", "qwen3.7-max", "kimi-k3"]
    raw_list_providers = inspect.unwrap(model_switch.list_authenticated_providers)

    def relay_models():
        config = load_config()
        model = config["model"]
        with patch.object(
            model_switch,
            "_fetch_picker_live_models",
            lambda *args, **kwargs: list(live_catalog),
        ), patch.object(model_switch, "_save_discovered_models_to_config", lambda *a, **k: None):
            rows = raw_list_providers(
                current_provider=model.get("provider", ""),
                current_base_url=model.get("base_url", ""),
                current_model=model.get("default", ""),
                user_providers={},
                custom_providers=[MANAGED_ROW],
                probe_custom_providers=False,
                probe_current_custom_provider=True,
                excluded_providers=[],
            )
        row = next(r for r in rows if r.get("slug") == MANAGED_SLUG)
        return row["models"]

    hermes_config({
        "model": {"provider": "custom", "default": MANAGED_MODEL, "base_url": ""},
        "custom_providers": [MANAGED_ROW],
    })

    assert relay_models() == [MANAGED_MODEL], (
        "precondition: the stranded config collapses the APEX group to one id"
    )

    assert custom_base_url_guard.repair_config_base_url() is True

    healed = relay_models()
    assert set(live_catalog).issubset(healed), (
        "after the boot repair the picker must offer the relay's live catalog"
    )
    assert len(healed) > 1


# ---------------------------------------------------------------------------
# apply() — patches an already-loaded module, arms an import hook otherwise
# ---------------------------------------------------------------------------

def test_apply_patches_an_already_loaded_web_server(monkeypatch, restore_meta_path):
    from hermes_cli import web_server

    original = web_server._apply_main_model_assignment
    monkeypatch.setattr(custom_base_url_guard, "_APPLIED", False)
    try:
        assert custom_base_url_guard.apply() is True
        patched = web_server._apply_main_model_assignment
        assert getattr(patched, custom_base_url_guard._MARK, False) is True

        # Second apply is a no-op (already applied).
        monkeypatch.setattr(custom_base_url_guard, "_APPLIED", False)
        assert custom_base_url_guard.apply() is True
        assert web_server._apply_main_model_assignment is patched
    finally:
        web_server._apply_main_model_assignment = original


def test_apply_arms_an_import_hook_instead_of_importing(
    monkeypatch, tmp_path, restore_meta_path
):
    """The dashboard module must not be dragged into gateway/CLI processes."""
    module_name = "_apex_overlay_fake_dashboard_under_test"
    (tmp_path / f"{module_name}.py").write_text(
        "def _apply_main_model_assignment(model_cfg, provider, model, "
        "base_url='', api_key=''):\n"
        "    return {'provider': provider, 'base_url': base_url}\n",
        encoding="utf-8",
    )
    monkeypatch.syspath_prepend(str(tmp_path))
    monkeypatch.setattr(custom_base_url_guard, "_TARGET_WEB_MODULE", module_name)
    monkeypatch.setattr(custom_base_url_guard, "_APPLIED", False)
    monkeypatch.delitem(sys.modules, module_name, raising=False)

    hooks_before = len(sys.meta_path)
    assert custom_base_url_guard.apply() is True
    assert module_name not in sys.modules, "apply() must not import the target"
    assert len(sys.meta_path) == hooks_before + 1, "apply() must arm the import hook"

    try:
        module = importlib.import_module(module_name)
        assert getattr(
            module._apply_main_model_assignment, custom_base_url_guard._MARK, False
        ) is True, "the hook must patch the module as it loads"
        assert len(sys.meta_path) == hooks_before, (
            "the hook is one-shot and must unhook itself after firing"
        )
        # The patched function still behaves like the module's own.
        assert module._apply_main_model_assignment({}, "custom", "x")["provider"] == "custom"
    finally:
        sys.modules.pop(module_name, None)


def test_apply_reports_failure_when_the_symbol_is_missing(
    monkeypatch, tmp_path, restore_meta_path
):
    """A renamed/moved upstream symbol must fail loudly, not silently no-op."""
    module_name = "_apex_overlay_symbolless_dashboard_under_test"
    sys.modules[module_name] = types.ModuleType(module_name)
    monkeypatch.setattr(custom_base_url_guard, "_TARGET_WEB_MODULE", module_name)
    monkeypatch.setattr(custom_base_url_guard, "_APPLIED", False)
    try:
        assert custom_base_url_guard.apply() is False
    finally:
        sys.modules.pop(module_name, None)


# ---------------------------------------------------------------------------
# Wiring — the bundled plugin's register() applies this seam
# ---------------------------------------------------------------------------

def test_plugin_register_applies_seam():
    from tests.apex_overlay.conftest import run_plugin_register_with_stubbed_seams

    called = run_plugin_register_with_stubbed_seams(
        "_custom_base_url_guard_plugin_under_test"
    )
    assert "custom_base_url_guard" in called, (
        "plugin.register() must call custom_base_url_guard.apply()"
    )
