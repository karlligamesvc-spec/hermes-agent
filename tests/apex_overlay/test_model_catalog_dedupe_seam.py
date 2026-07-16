"""Seam-test + behavior test for apex_overlay.model_catalog_dedupe (hc-512).

Pins the upstream symbol the seam monkey-patches
(``hermes_cli.model_switch.list_authenticated_providers``) so an upstream
rename/move turns a silently-disarmed dedupe into a loud CI failure, and
proves the behavior:

* Within one provider row, a bare id and its ``-APEX`` sentinel
  (``deepseek-v4-pro`` + ``deepseek-v4-pro-APEX``) merge into a single entry
  that keeps the SENTINEL id — the collision-free config anchor the managed
  desktop path writes (see apps/desktop/electron/apex-managed.cjs).
* Ids without a sentinel counterpart (``deepseek-v4-flash``, ``kimi-k2.6``,
  ``glm-5.2``, …) pass through untouched, order preserved.
* Rows without any pair are returned unchanged.
"""

from __future__ import annotations

import inspect
from unittest.mock import patch

from apex_overlay import model_catalog_dedupe
from apex_overlay.model_catalog_dedupe import dedupe_sentinel_pairs


# ---------------------------------------------------------------------------
# Seam assertion — pin the patched symbol's existence + call shape
# ---------------------------------------------------------------------------

def test_seam_target_list_authenticated_providers_exists():
    """apex_overlay patches hermes_cli.model_switch.list_authenticated_providers.

    If upstream renames/moves it, the picker silently regresses to showing the
    sentinel and the live bare id as two rows. Fail loudly here instead.
    """
    from hermes_cli import model_switch

    fn = getattr(model_switch, model_catalog_dedupe._TARGET_LIST_FN, None)
    assert fn is not None, (
        "hermes_cli.model_switch.list_authenticated_providers is gone — the "
        "hc-512 sentinel dedupe can no longer attach. Update "
        "apex_overlay.model_catalog_dedupe._TARGET_LIST_FN and the wrapper."
    )
    # The wrapper passes *args/**kwargs through untouched, so any signature
    # works — but the return contract (list of provider-row dicts with a
    # ``models`` list) is what the dedupe edits. Pin that it's a function.
    assert callable(fn)
    assert inspect.signature(fn).parameters is not None


# ---------------------------------------------------------------------------
# Pure dedupe rules
# ---------------------------------------------------------------------------

def test_pair_merges_to_sentinel_at_first_occurrence():
    # Injected-current shape: sentinel first (config current model), live list after.
    assert dedupe_sentinel_pairs(
        ["deepseek-v4-pro-APEX", "deepseek-v4-pro", "deepseek-v4-flash", "kimi-k2.6"]
    ) == ["deepseek-v4-pro-APEX", "deepseek-v4-flash", "kimi-k2.6"]


def test_pair_merges_when_bare_id_comes_first():
    # No-injection shape (sentinel not current): bare live id leads.
    assert dedupe_sentinel_pairs(
        ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-pro-APEX"]
    ) == ["deepseek-v4-pro-APEX", "deepseek-v4-flash"]


def test_unpaired_ids_pass_through_unchanged():
    models = ["deepseek-v4-flash", "kimi-k2.6", "glm-5.2"]
    assert dedupe_sentinel_pairs(models) == models


def test_lone_sentinel_passes_through():
    # Live probe failed → only the config sentinel remains. Must survive.
    assert dedupe_sentinel_pairs(["deepseek-v4-pro-APEX"]) == ["deepseek-v4-pro-APEX"]


def test_suffix_match_is_case_insensitive_but_keeps_stored_spelling():
    assert dedupe_sentinel_pairs(["deepseek-v4-pro", "deepseek-v4-pro-apex"]) == [
        "deepseek-v4-pro-apex"
    ]


def test_generic_rule_covers_future_sentinels():
    # A staging APEXNODES_MANAGED_MODEL override derives `<model>-APEX`; any
    # such pair dedupes without a code change.
    assert dedupe_sentinel_pairs(
        ["deepseek-v4-flash-APEX", "deepseek-v4-pro", "deepseek-v4-flash"]
    ) == ["deepseek-v4-flash-APEX", "deepseek-v4-pro"]


# ---------------------------------------------------------------------------
# Wrapper behavior on provider rows
# ---------------------------------------------------------------------------

def _fake_rows():
    return [
        {
            "slug": "custom:apex-nodes.com",
            "name": "Apex-nodes.com",
            "is_current": True,
            "is_user_defined": True,
            "models": [
                "deepseek-v4-pro-APEX",
                "deepseek-v4-pro",
                "deepseek-v4-flash",
                "kimi-k2.6",
            ],
            "total_models": 4,
            "source": "user-config",
        },
        {
            "slug": "deepseek",
            "name": "DeepSeek",
            "is_current": False,
            "is_user_defined": False,
            "models": ["deepseek-v4-pro", "deepseek-v4-flash"],
            "total_models": 2,
            "source": "built-in",
        },
    ]


def test_wrapper_dedupes_apex_row_and_leaves_native_row_alone():
    wrapped = model_catalog_dedupe._wrap_list_authenticated_providers(
        lambda *a, **k: _fake_rows()
    )
    rows = wrapped()

    apex = rows[0]
    assert apex["models"] == ["deepseek-v4-pro-APEX", "deepseek-v4-flash", "kimi-k2.6"]
    assert apex["total_models"] == 3

    # The native DeepSeek row (a DIFFERENT provider/route) is untouched —
    # dedupe is strictly per-row, never cross-provider.
    native = rows[1]
    assert native["models"] == ["deepseek-v4-pro", "deepseek-v4-flash"]
    assert native["total_models"] == 2


def test_wrapper_never_raises_into_the_host_path():
    # A malformed row (models is not a list) must not break the picker.
    wrapped = model_catalog_dedupe._wrap_list_authenticated_providers(
        lambda *a, **k: [{"slug": "x", "models": None}, {"slug": "y"}, "junk"]
    )
    rows = wrapped()
    assert rows[0]["models"] is None
    assert rows[2] == "junk"


def test_wrapper_is_marked_for_idempotence():
    wrapped = model_catalog_dedupe._wrap_list_authenticated_providers(lambda: [])
    assert getattr(wrapped, model_catalog_dedupe._MARK) is True


def test_apply_patches_and_is_idempotent():
    from hermes_cli import model_switch

    original = model_switch.list_authenticated_providers
    saved_applied = model_catalog_dedupe._APPLIED
    try:
        model_catalog_dedupe._APPLIED = False
        with patch.object(model_switch, "list_authenticated_providers", original):
            assert model_catalog_dedupe.apply() is True
            patched = model_switch.list_authenticated_providers
            assert getattr(patched, model_catalog_dedupe._MARK, False) is True
            # Second apply is a no-op (already applied).
            assert model_catalog_dedupe.apply() is True
            assert model_switch.list_authenticated_providers is patched
    finally:
        model_catalog_dedupe._APPLIED = saved_applied


# ---------------------------------------------------------------------------
# Wiring — the bundled plugin's register() applies this seam
# ---------------------------------------------------------------------------

def test_plugin_register_applies_seam():
    from tests.apex_overlay.conftest import run_plugin_register_with_stubbed_seams

    called = run_plugin_register_with_stubbed_seams(
        "_model_catalog_dedupe_plugin_under_test"
    )
    assert "model_catalog_dedupe" in called, (
        "plugin.register() must call model_catalog_dedupe.apply()"
    )
