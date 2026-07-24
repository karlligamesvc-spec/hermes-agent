"""Seam-test + behavior test for apex_overlay.moa_picker_probe.

Pins the upstream symbol the seam monkey-patches
(``hermes_cli.model_switch.list_authenticated_providers``) so an upstream
rename/move turns a silently-disarmed seam into a loud CI failure, and proves
the regression it exists for:

Composing a multi-model selection assigns the main model to the **virtual**
provider ``moa`` (``{scope: main, provider: moa, model: __auto__}``). On the
picker's normal-open probe policy (``probe_custom_providers=False``,
``probe_current_custom_provider=True``) upstream then finds no custom row
matching "the current provider", probes nothing, and the ApexNodes relay row
falls back to the single model id declared in ``custom_providers`` — the
picker collapses to one model and no further model can be selected.
"""

from __future__ import annotations

import inspect
from unittest.mock import patch

import pytest

from apex_overlay import moa_picker_probe
from apex_overlay.moa_picker_probe import probe_flags_for


MANAGED_SLUG = "custom:apex-nodes.com"
RELAY_URL = "https://api.apex-nodes.com/relay/v1"

# What the relay's live ``GET /models`` returns — the catalog the user picks
# from. Only the *count* matters to these tests.
LIVE_CATALOG = [
    "deepseek-v4-pro",
    "glm-5.2",
    "qwen3.7-max",
    "doubao-seed-2.1-pro",
    "kimi-k3",
]

# The desktop seeds exactly ONE model id into the relay's custom_providers
# entry (apps/desktop/electron/apex-managed.cjs buildManagedModelBlock), so
# without a live probe the row can only offer that single id.
CUSTOM_PROVIDERS = [
    {
        "name": "Apex-nodes.com",
        "base_url": RELAY_URL,
        "api_key": "sk-relay-test",
        "model": "deepseek-v4-pro-APEX",
    }
]


# ---------------------------------------------------------------------------
# Seam assertion — pin the patched symbol's existence + call shape
# ---------------------------------------------------------------------------

def test_seam_target_list_authenticated_providers_exists():
    """apex_overlay patches hermes_cli.model_switch.list_authenticated_providers.

    If upstream renames/moves it, a composed multi-model selection silently
    collapses the platform model list again. Fail loudly here instead.
    """
    from hermes_cli import model_switch

    fn = getattr(model_switch, moa_picker_probe._TARGET_LIST_FN, None)
    assert fn is not None, (
        "hermes_cli.model_switch.list_authenticated_providers is gone — the "
        "virtual-'moa' picker probe seam can no longer attach. Update "
        "apex_overlay.moa_picker_probe._TARGET_LIST_FN and the wrapper."
    )
    params = inspect.signature(fn).parameters
    # The seam rewrites these three by name; a rename upstream would make the
    # wrapper a silent no-op.
    for name in ("current_provider", "probe_custom_providers", "probe_current_custom_provider"):
        assert name in params, (
            f"upstream dropped/renamed `{name}` — the moa_picker_probe seam "
            "rewrites it by keyword and would silently stop working."
        )


# ---------------------------------------------------------------------------
# Pure rule — which probe flags a given current provider resolves to
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "current_provider,broad_in,current_in,expected",
    [
        # The picker's normal-open policy under a composed selection: widen.
        ("moa", False, True, (True, True)),
        ("MOA", False, True, (True, True)),
        ("  moa  ", False, True, (True, True)),
        # Explicit "Refresh Models" already probes everything — nothing to do.
        ("moa", True, False, (True, False)),
        ("moa", True, True, (True, True)),
        # A caller that opted out of BOTH probes wants no network; respect it.
        ("moa", False, False, (False, False)),
        # Every real provider is left exactly as the caller asked.
        (MANAGED_SLUG, False, True, (False, True)),
        ("deepseek", False, True, (False, True)),
        ("custom", False, True, (False, True)),
        ("", False, True, (False, True)),
        (None, False, True, (False, True)),
        # "moa" must match the whole slug, not a prefix/substring.
        ("moabc", False, True, (False, True)),
    ],
)
def test_probe_flags_for(current_provider, broad_in, current_in, expected):
    assert (
        probe_flags_for(
            current_provider,
            probe_custom_providers=broad_in,
            probe_current_custom_provider=current_in,
        )
        == expected
    )


# ---------------------------------------------------------------------------
# Wrapper — rewrites only the probe kwargs, passes everything else through
# ---------------------------------------------------------------------------

def test_wrapper_widens_probe_for_virtual_moa():
    seen = {}

    def spy(*args, **kwargs):
        seen.update(kwargs)
        return []

    moa_picker_probe._wrap_list_authenticated_providers(spy)(
        current_provider="moa",
        current_model="__auto__",
        probe_custom_providers=False,
        probe_current_custom_provider=True,
    )

    assert seen["probe_custom_providers"] is True
    # Untouched pass-through.
    assert seen["probe_current_custom_provider"] is True
    assert seen["current_provider"] == "moa"
    assert seen["current_model"] == "__auto__"


def test_wrapper_reads_current_provider_from_the_first_positional_arg():
    seen = {}

    def spy(*args, **kwargs):
        seen["args"] = args
        seen.update(kwargs)
        return []

    moa_picker_probe._wrap_list_authenticated_providers(spy)(
        "moa",
        probe_custom_providers=False,
        probe_current_custom_provider=True,
    )

    assert seen["args"] == ("moa",)
    assert seen["probe_custom_providers"] is True


def test_wrapper_leaves_a_real_provider_untouched():
    seen = {}

    def spy(*args, **kwargs):
        seen.update(kwargs)
        return []

    moa_picker_probe._wrap_list_authenticated_providers(spy)(
        current_provider=MANAGED_SLUG,
        probe_custom_providers=False,
        probe_current_custom_provider=True,
    )

    assert seen["probe_custom_providers"] is False


def test_wrapper_never_raises_into_the_host_path():
    # A caller shape the flag logic can't read must still reach upstream.
    class Hostile:
        def __str__(self):
            raise RuntimeError("boom")

    wrapped = moa_picker_probe._wrap_list_authenticated_providers(lambda *a, **k: ["ok"])
    assert wrapped(current_provider=Hostile(), probe_custom_providers=False) == ["ok"]


def test_wrapper_is_marked_for_idempotence():
    wrapped = moa_picker_probe._wrap_list_authenticated_providers(lambda: [])
    assert getattr(wrapped, moa_picker_probe._MARK) is True


def test_apply_patches_and_is_idempotent():
    from hermes_cli import model_switch

    original = model_switch.list_authenticated_providers
    saved_applied = moa_picker_probe._APPLIED
    try:
        moa_picker_probe._APPLIED = False
        with patch.object(model_switch, "list_authenticated_providers", original):
            assert moa_picker_probe.apply() is True
            patched = model_switch.list_authenticated_providers
            assert getattr(patched, moa_picker_probe._MARK, False) is True
            # Second apply is a no-op (already applied).
            assert moa_picker_probe.apply() is True
            assert model_switch.list_authenticated_providers is patched
    finally:
        moa_picker_probe._APPLIED = saved_applied


# ---------------------------------------------------------------------------
# Regression — the collapse this seam exists to prevent, end to end
# ---------------------------------------------------------------------------

def _managed_models(list_providers, current_provider, current_base_url, current_model):
    """Run the picker assembly and return the APEX row's models + probe calls."""
    probed: list[str] = []

    def fake_fetch(api_key, api_url, headers=None):
        probed.append(api_url)
        return list(LIVE_CATALOG)

    from hermes_cli import model_switch

    with patch("hermes_cli.models.fetch_api_models", fake_fetch), patch.object(
        model_switch, "_save_discovered_models_to_config", lambda *a, **k: None
    ):
        rows = list_providers(
            current_provider=current_provider,
            current_base_url=current_base_url,
            user_providers={},
            custom_providers=CUSTOM_PROVIDERS,
            current_model=current_model,
            refresh=False,
            # The picker's normal-open policy — see tui_gateway/server.py
            # model.options and hermes_cli/web_server.py /api/model/options.
            probe_custom_providers=False,
            probe_current_custom_provider=True,
            excluded_providers=[],
        )

    row = next((r for r in rows if r.get("slug") == MANAGED_SLUG), None)
    assert row is not None, "the managed relay row must always be listed"
    return row["models"], probed


@pytest.fixture
def raw_list_providers():
    """Upstream's own function, with any installed seam wrappers peeled off.

    Keeps this test independent of whether other seams have been applied in
    this interpreter (they wrap the same symbol).
    """
    from hermes_cli import model_switch

    return inspect.unwrap(model_switch.list_authenticated_providers)


def test_virtual_moa_collapses_the_platform_list_without_the_seam(raw_list_providers):
    """The bug: composing a selection strands the relay row on one model id."""
    single, single_probes = _managed_models(
        raw_list_providers, MANAGED_SLUG, RELAY_URL, "deepseek-v4-pro-APEX"
    )
    assert single_probes == [RELAY_URL]
    assert len(single) > 1

    # After the second model is checked: provider is the virtual `moa` and
    # _apply_main_model_assignment has cleared model.base_url (provider switch).
    composed, composed_probes = _managed_models(raw_list_providers, "moa", "", "__auto__")
    assert composed_probes == [], "no endpoint is probed once the provider is virtual"
    assert composed == ["deepseek-v4-pro-APEX"], (
        "regression fixture: the relay row is expected to collapse to its single "
        "configured id without the seam"
    )


def test_seam_keeps_the_platform_list_complete_under_a_composed_selection(
    raw_list_providers,
):
    """The fix: the relay is probed again, so every model stays selectable."""
    wrapped = moa_picker_probe._wrap_list_authenticated_providers(raw_list_providers)

    composed, composed_probes = _managed_models(wrapped, "moa", "", "__auto__")

    assert composed_probes == [RELAY_URL]
    assert composed == LIVE_CATALOG, (
        "with a composed selection active the picker must still offer the relay's "
        "full catalog — otherwise no further model can be selected"
    )


def test_seam_does_not_probe_for_an_unrelated_current_provider(raw_list_providers):
    """A BYO/native current provider keeps the cheap no-probe open."""
    wrapped = moa_picker_probe._wrap_list_authenticated_providers(raw_list_providers)

    collapsed, probes = _managed_models(wrapped, "deepseek", "", "deepseek-v4-pro")

    assert probes == []
    assert collapsed == ["deepseek-v4-pro-APEX"]


# ---------------------------------------------------------------------------
# Wiring — the bundled plugin's register() applies this seam
# ---------------------------------------------------------------------------

def test_plugin_register_applies_seam():
    from tests.apex_overlay.conftest import run_plugin_register_with_stubbed_seams

    called = run_plugin_register_with_stubbed_seams(
        "_moa_picker_probe_plugin_under_test"
    )
    assert "moa_picker_probe" in called, (
        "plugin.register() must call moa_picker_probe.apply()"
    )
