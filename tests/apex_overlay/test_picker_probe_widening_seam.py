"""Seam-test + behavior test for apex_overlay.picker_probe_widening.

Pins the upstream symbol the seam monkey-patches
(``hermes_cli.model_switch.list_authenticated_providers``) so an upstream
rename/move turns a silently-disarmed seam into a loud CI failure, and proves
the regression it exists for.

On the picker's normal-open probe policy (``probe_custom_providers=False``,
``probe_current_custom_provider=True``) upstream probes only the custom row it
can match to the main model. Two config shapes match nothing, so nothing is
probed at all and the ApexNodes relay row falls back to the single model id
declared in ``custom_providers`` — the picker collapses to one model and no
further model can be selected:

- **A** the virtual ``moa`` provider a composed multi-model selection assigns
  (``{scope: main, provider: moa, model: __auto__}``);
- **B** the bare ``custom`` provider the managed relay is registered under,
  once ``_apply_main_model_assignment`` has cleared ``model.base_url`` —
  matching by slug fails (no row is named ``custom``) and matching by URL
  needs a non-blank one.
"""

from __future__ import annotations

import inspect
from unittest.mock import patch

import pytest

from apex_overlay import picker_probe_widening
from apex_overlay.picker_probe_widening import names_no_custom_endpoint, probe_flags_for


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
# entry (apps/desktop/electron/apex-managed.ts buildManagedModelBlock), so
# without a live probe the row can only offer that single id.
MANAGED_MODEL = "deepseek-v4-pro-APEX"
CUSTOM_PROVIDERS = [
    {
        "name": "Apex-nodes.com",
        "base_url": RELAY_URL,
        "api_key": "sk-relay-test",
        "model": MANAGED_MODEL,
    }
]


# ---------------------------------------------------------------------------
# Seam assertion — pin the patched symbol's existence + call shape
# ---------------------------------------------------------------------------

def test_seam_target_list_authenticated_providers_exists():
    """apex_overlay patches hermes_cli.model_switch.list_authenticated_providers.

    If upstream renames/moves it, a main provider that names no saved custom
    endpoint silently collapses the platform model list again. Fail loudly here
    instead.
    """
    from hermes_cli import model_switch

    fn = getattr(model_switch, picker_probe_widening._TARGET_LIST_FN, None)
    assert fn is not None, (
        "hermes_cli.model_switch.list_authenticated_providers is gone — the "
        "picker probe widening seam can no longer attach. Update "
        "apex_overlay.picker_probe_widening._TARGET_LIST_FN and the wrapper."
    )
    params = inspect.signature(fn).parameters
    # The seam reads/rewrites these four by name; a rename upstream would make
    # the wrapper a silent no-op.
    for name in (
        "current_provider",
        "current_base_url",
        "probe_custom_providers",
        "probe_current_custom_provider",
    ):
        assert name in params, (
            f"upstream dropped/renamed `{name}` — the picker_probe_widening "
            "seam reads it by keyword and would silently stop working."
        )
    # ``current_provider`` / ``current_base_url`` are read positionally too.
    positional = [
        n for n, p in params.items()
        if p.kind is inspect.Parameter.POSITIONAL_OR_KEYWORD
    ]
    assert positional[:2] == ["current_provider", "current_base_url"], (
        "the seam reads args[0]/args[1] as (current_provider, current_base_url) "
        f"— upstream now starts with {positional[:2]}"
    )


# ---------------------------------------------------------------------------
# Pure rule — which selections can name no saved custom endpoint
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "current_provider,current_base_url,expected",
    [
        # A — the virtual aggregate has no endpoint of its own, at any URL.
        ("moa", "", True),
        ("MOA", "", True),
        ("  moa  ", "", True),
        # B — bare `custom` keeps its address in base_url; blank ⇒ unmatchable.
        ("custom", "", True),
        ("CUSTOM", "", True),
        ("custom", "   ", True),
        ("custom", None, True),
        # …but WITH a URL upstream matches the row by URL. Not our business.
        ("custom", RELAY_URL, False),
        # A named custom row matches by slug regardless of base_url.
        (MANAGED_SLUG, "", False),
        (MANAGED_SLUG, RELAY_URL, False),
        # Registry providers resolve their own host — never unmatchable.
        ("deepseek", "", False),
        ("", "", False),
        (None, "", False),
        # Whole-slug match only, no prefix/substring.
        ("moabc", "", False),
        ("customer", "", False),
    ],
)
def test_names_no_custom_endpoint(current_provider, current_base_url, expected):
    assert names_no_custom_endpoint(current_provider, current_base_url) is expected


# ---------------------------------------------------------------------------
# Pure rule — which probe flags a given selection resolves to
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "current_provider,current_base_url,broad_in,current_in,expected",
    [
        # The picker's normal-open policy under an unmatchable selection: widen.
        ("moa", "", False, True, (True, True)),
        ("custom", "", False, True, (True, True)),
        ("custom", "  ", False, True, (True, True)),
        # Explicit "Refresh Models" already probes everything — nothing to do.
        ("moa", "", True, False, (True, False)),
        ("custom", "", True, False, (True, False)),
        ("moa", "", True, True, (True, True)),
        # A caller that opted out of BOTH probes wants no network; respect it.
        ("moa", "", False, False, (False, False)),
        ("custom", "", False, False, (False, False)),
        # Every matchable selection is left exactly as the caller asked.
        (MANAGED_SLUG, "", False, True, (False, True)),
        ("custom", RELAY_URL, False, True, (False, True)),
        ("deepseek", "", False, True, (False, True)),
        ("", "", False, True, (False, True)),
        (None, "", False, True, (False, True)),
        ("moabc", "", False, True, (False, True)),
    ],
)
def test_probe_flags_for(
    current_provider, current_base_url, broad_in, current_in, expected
):
    assert (
        probe_flags_for(
            current_provider,
            probe_custom_providers=broad_in,
            probe_current_custom_provider=current_in,
            current_base_url=current_base_url,
        )
        == expected
    )


# ---------------------------------------------------------------------------
# Wrapper — rewrites only the probe kwargs, passes everything else through
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("current_provider", ["moa", "custom"])
def test_wrapper_widens_probe_for_an_unmatchable_selection(current_provider):
    seen = {}

    def spy(*args, **kwargs):
        seen.update(kwargs)
        return []

    picker_probe_widening._wrap_list_authenticated_providers(spy)(
        current_provider=current_provider,
        current_base_url="",
        current_model="__auto__",
        probe_custom_providers=False,
        probe_current_custom_provider=True,
    )

    assert seen["probe_custom_providers"] is True
    # Untouched pass-through.
    assert seen["probe_current_custom_provider"] is True
    assert seen["current_provider"] == current_provider
    assert seen["current_model"] == "__auto__"


def test_wrapper_reads_current_provider_from_the_first_positional_arg():
    seen = {}

    def spy(*args, **kwargs):
        seen["args"] = args
        seen.update(kwargs)
        return []

    picker_probe_widening._wrap_list_authenticated_providers(spy)(
        "moa",
        probe_custom_providers=False,
        probe_current_custom_provider=True,
    )

    assert seen["args"] == ("moa",)
    assert seen["probe_custom_providers"] is True


def test_wrapper_reads_current_base_url_from_the_second_positional_arg():
    """Positional bare ``custom`` + a real URL is matchable — do NOT widen."""
    seen = {}

    def spy(*args, **kwargs):
        seen["args"] = args
        seen.update(kwargs)
        return []

    picker_probe_widening._wrap_list_authenticated_providers(spy)(
        "custom",
        RELAY_URL,
        probe_custom_providers=False,
        probe_current_custom_provider=True,
    )

    assert seen["args"] == ("custom", RELAY_URL)
    assert seen["probe_custom_providers"] is False


def test_wrapper_leaves_a_matchable_provider_untouched():
    seen = {}

    def spy(*args, **kwargs):
        seen.update(kwargs)
        return []

    picker_probe_widening._wrap_list_authenticated_providers(spy)(
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

    wrapped = picker_probe_widening._wrap_list_authenticated_providers(
        lambda *a, **k: ["ok"]
    )
    assert wrapped(current_provider=Hostile(), probe_custom_providers=False) == ["ok"]


def test_wrapper_is_marked_for_idempotence():
    wrapped = picker_probe_widening._wrap_list_authenticated_providers(lambda: [])
    assert getattr(wrapped, picker_probe_widening._MARK) is True


def test_apply_patches_and_is_idempotent():
    from hermes_cli import model_switch

    original = model_switch.list_authenticated_providers
    saved_applied = picker_probe_widening._APPLIED
    try:
        picker_probe_widening._APPLIED = False
        with patch.object(model_switch, "list_authenticated_providers", original):
            assert picker_probe_widening.apply() is True
            patched = model_switch.list_authenticated_providers
            assert getattr(patched, picker_probe_widening._MARK, False) is True
            # Second apply is a no-op (already applied).
            assert picker_probe_widening.apply() is True
            assert model_switch.list_authenticated_providers is patched
    finally:
        picker_probe_widening._APPLIED = saved_applied


# ---------------------------------------------------------------------------
# Regression — the collapse this seam exists to prevent, end to end
# ---------------------------------------------------------------------------

def _managed_models(list_providers, current_provider, current_base_url, current_model):
    """Run the picker assembly and return the APEX row's models + probe calls."""
    probed: list[str] = []

    def fake_fetch(
        api_key,
        api_url,
        native_catalog_provider,
        preserve_native_models,
        headers=None,
        timeout=5.0,
        api_mode=None,
    ):
        probed.append(api_url)
        return list(LIVE_CATALOG)

    from hermes_cli import model_switch

    # v0.21 routes every picker probe through this helper so native catalogs
    # and the generic discovery cache share one boundary. Patch that
    # authoritative boundary: patching models.fetch_api_models directly no
    # longer observes a picker probe and can be masked by a warm cache.
    with patch.object(
        model_switch, "_fetch_picker_live_models", fake_fetch
    ), patch.object(
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


@pytest.mark.parametrize(
    "current_provider,current_model",
    [
        # A — composed multi-model selection pins the virtual provider.
        ("moa", "__auto__"),
        # B — the managed relay's own bare `custom` slug, base_url erased by
        #     _apply_main_model_assignment on the switch back off `moa`.
        ("custom", MANAGED_MODEL),
    ],
)
def test_unmatchable_selection_collapses_the_platform_list_without_the_seam(
    raw_list_providers, current_provider, current_model
):
    """The bug: an unmatchable selection strands the relay row on one model id."""
    # Baseline: cleanly current ⇒ probed, full catalog.
    healthy, healthy_probes = _managed_models(
        raw_list_providers, MANAGED_SLUG, RELAY_URL, MANAGED_MODEL
    )
    assert healthy_probes == [RELAY_URL]
    assert len(healthy) > 1

    collapsed, probes = _managed_models(
        raw_list_providers, current_provider, "", current_model
    )
    assert probes == [], "no endpoint is probed once the selection matches no row"
    assert collapsed == [MANAGED_MODEL], (
        "regression fixture: the relay row is expected to collapse to its single "
        "configured id without the seam"
    )


@pytest.mark.parametrize(
    "current_provider,current_model",
    [("moa", "__auto__"), ("custom", MANAGED_MODEL)],
)
def test_seam_keeps_the_platform_list_complete(
    raw_list_providers, current_provider, current_model
):
    """The fix: the relay is probed again, so every model stays selectable."""
    wrapped = picker_probe_widening._wrap_list_authenticated_providers(
        raw_list_providers
    )

    models, probes = _managed_models(wrapped, current_provider, "", current_model)

    assert probes == [RELAY_URL]
    assert models == LIVE_CATALOG, (
        "with an unmatchable selection active the picker must still offer the "
        "relay's full catalog — otherwise no further model can be selected"
    )


def test_seam_does_not_probe_for_an_unrelated_current_provider(raw_list_providers):
    """A BYO/native current provider keeps the cheap no-probe open."""
    wrapped = picker_probe_widening._wrap_list_authenticated_providers(
        raw_list_providers
    )

    collapsed, probes = _managed_models(wrapped, "deepseek", "", "deepseek-v4-pro")

    assert probes == []
    assert collapsed == [MANAGED_MODEL]


# ---------------------------------------------------------------------------
# Wiring — the bundled plugin's register() applies this seam
# ---------------------------------------------------------------------------

def test_plugin_register_applies_seam():
    from tests.apex_overlay.conftest import run_plugin_register_with_stubbed_seams

    called = run_plugin_register_with_stubbed_seams(
        "_picker_probe_widening_plugin_under_test"
    )
    assert "picker_probe_widening" in called, (
        "plugin.register() must call picker_probe_widening.apply()"
    )
