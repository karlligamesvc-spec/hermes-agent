"""Seam-test + behavior test for apex_overlay.custom_row_dedupe (hc-598).

Pins the upstream symbol the seam monkey-patches
(``hermes_cli.inventory._append_unconfigured_rows``) so an upstream
rename/move turns a silently-disarmed seam into a loud CI failure, and proves
the regression it exists for.

The regression: the managed relay is registered under the **bare** ``custom``
slug with a *named* ``custom_providers`` entry beside it, so upstream lists the
endpoint as ``custom:apex-nodes.com`` — and then, because no row is named
exactly ``custom``, synthesizes a second row for the "missing" current
provider. The user sees the same endpoint twice, the second time as the
implementation word "Custom endpoint" (shouted by the desktop's uppercase
section-label styling) carrying ``authenticated: false`` and a "run `hermes
model` to reactivate" warning that is false on its face.
"""

from __future__ import annotations

import inspect

import pytest

from apex_overlay import custom_row_dedupe
from apex_overlay.custom_row_dedupe import (
    bare_custom_row_is_alias,
    drop_aliased_bare_custom,
)
from hermes_cli.inventory import ConfigContext


MANAGED_SLUG = "custom:apex-nodes.com"
MANAGED_NAME = "Apex-nodes.com"
RELAY_URL = "https://apex-nodes.com/relay/v1"
MANAGED_MODEL = "deepseek-v4-pro-APEX"

CUSTOM_PROVIDERS = [
    {
        "name": MANAGED_NAME,
        "base_url": RELAY_URL,
        "api_key": "sk-relay-test",
        "model": MANAGED_MODEL,
    }
]

# The row upstream really emits for the named entry (shape verified against
# hermes_cli.model_switch.list_authenticated_providers section 4).
MANAGED_ROW = {
    "slug": MANAGED_SLUG,
    "name": MANAGED_NAME,
    "api_url": RELAY_URL,
    "models": [MANAGED_MODEL],
    "is_user_defined": True,
    "authenticated": True,
    "source": "user-config",
}

# …and the row `_append_unconfigured_rows(current_only=True)` synthesizes for
# the bare `custom` slug on top of it.
STUB_ROW = {
    "slug": "custom",
    "name": "Custom endpoint",
    "models": [MANAGED_MODEL],
    "is_user_defined": False,
    "authenticated": False,
    "auth_type": "api_key",
    "key_env": "",
    "source": "configured-current",
    "warning": (
        "Configured provider is not authenticated; run `hermes model` to "
        "reactivate. Showing the saved model only."
    ),
}

DEEPSEEK_ROW = {
    "slug": "deepseek",
    "name": "DeepSeek",
    "models": ["deepseek-chat"],
    "authenticated": True,
    "source": "hermes",
}


def _ctx(*, provider="custom", base_url=RELAY_URL, custom_providers=None):
    return ConfigContext(
        current_provider=provider,
        current_model=MANAGED_MODEL,
        current_base_url=base_url,
        user_providers={},
        custom_providers=(
            CUSTOM_PROVIDERS if custom_providers is None else custom_providers
        ),
        excluded_providers=[],
    )


# ---------------------------------------------------------------------------
# Seam assertion — pin the patched symbol's existence + call shape
# ---------------------------------------------------------------------------

def test_seam_target_append_unconfigured_rows_exists():
    """apex_overlay patches hermes_cli.inventory._append_unconfigured_rows.

    It is a private symbol, so pin both the name and the call shape the wrapper
    relies on: ``(rows, ctx, *, current_only=...)``. If upstream renames or
    reorders it the duplicate "CUSTOM ENDPOINT" row comes back silently — fail
    loudly here instead.
    """
    from hermes_cli import inventory

    fn = getattr(inventory, custom_row_dedupe._TARGET_APPEND_FN, None)
    assert fn is not None, (
        "hermes_cli.inventory._append_unconfigured_rows is gone — the custom "
        "row dedupe seam can no longer attach. Update "
        "apex_overlay.custom_row_dedupe._TARGET_APPEND_FN and the wrapper."
    )
    params = list(inspect.signature(fn).parameters.values())
    positional = [
        p.name for p in params if p.kind is inspect.Parameter.POSITIONAL_OR_KEYWORD
    ]
    assert positional[:2] == ["rows", "ctx"], (
        "the seam calls through as (rows, ctx, **kwargs) — upstream now starts "
        f"with {positional[:2]}"
    )


def test_seam_target_marker_source_still_stamped():
    """The stub is identified by upstream's own ``source`` marker.

    ``_append_unconfigured_rows`` tags the configured-but-unauthenticated row
    ``configured-current`` and the never-set-up skeletons ``canonical``. If that
    vocabulary changes, the seam would stop recognizing the row it must drop
    (or start dropping the wrong one).
    """
    from hermes_cli.inventory import _append_unconfigured_rows

    extras = _append_unconfigured_rows(
        [MANAGED_ROW], _ctx(), current_only=True
    )
    assert [row["slug"] for row in extras] == ["custom"], (
        "upstream no longer synthesizes a bare `custom` row for a bare `custom` "
        "current provider — re-check whether this seam is still needed"
    )
    assert extras[0]["source"] == custom_row_dedupe.CONFIGURED_CURRENT_SOURCE


# ---------------------------------------------------------------------------
# Pure rule — when is the bare `custom` row a second face of a listed row
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "rows,base_url,custom_providers,expected",
    [
        # The shipped shape: model.base_url IS the listed row's api_url.
        ([MANAGED_ROW], RELAY_URL, CUSTOM_PROVIDERS, True),
        # …compared slash- and case-blind, like upstream's own picker match.
        ([MANAGED_ROW], RELAY_URL + "/", CUSTOM_PROVIDERS, True),
        ([MANAGED_ROW], RELAY_URL.upper(), CUSTOM_PROVIDERS, True),
        # hc-592 damage shape — no URL to match on, so fall back to where
        # upstream's own resolver routes bare `custom`: the listed row.
        ([MANAGED_ROW], "", CUSTOM_PROVIDERS, True),
        ([MANAGED_ROW], "   ", CUSTOM_PROVIDERS, True),
        # Order/extra rows don't matter — only the custom family is consulted.
        ([DEEPSEEK_ROW, MANAGED_ROW], "", CUSTOM_PROVIDERS, True),
        # A DIFFERENT endpoint: the bare row is a real second endpoint, and
        # upstream's placeholder is doing exactly its job. Keep it.
        ([MANAGED_ROW], "http://127.0.0.1:11434/v1", CUSTOM_PROVIDERS, False),
        # Nothing custom is listed at all — the whole point of upstream's row.
        ([DEEPSEEK_ROW], RELAY_URL, CUSTOM_PROVIDERS, False),
        ([], "", CUSTOM_PROVIDERS, False),
        # No URL and nothing to resolve ⇒ no evidence of an alias.
        ([MANAGED_ROW], "", [], False),
        # A listed row with no api_url of its own can't prove a URL match.
        ([{"slug": MANAGED_SLUG, "name": MANAGED_NAME}], RELAY_URL, [], False),
    ],
)
def test_bare_custom_row_is_alias(rows, base_url, custom_providers, expected):
    assert (
        bare_custom_row_is_alias(
            rows, current_base_url=base_url, custom_providers=custom_providers
        )
        is expected
    )


def test_bare_custom_row_is_alias_ignores_a_bare_custom_row_in_rows():
    """A bare `custom` row already in ``rows`` is the same anonymous alias.

    It carries no endpoint identity of its own, so it can never be the evidence
    that makes a second bare row redundant.
    """
    bare_row = {"slug": "custom", "name": "Custom endpoint", "api_url": RELAY_URL}

    assert (
        bare_custom_row_is_alias(
            [bare_row], current_base_url=RELAY_URL, custom_providers=CUSTOM_PROVIDERS
        )
        is False
    )


# ---------------------------------------------------------------------------
# Filter — drops only the aliased stub, never anything else
# ---------------------------------------------------------------------------

def test_drop_aliased_bare_custom_removes_the_duplicate():
    assert drop_aliased_bare_custom([STUB_ROW], [MANAGED_ROW], _ctx()) == []


def test_drop_aliased_bare_custom_keeps_a_genuinely_missing_endpoint():
    """Upstream's contract is preserved where it applies.

    Bare `custom` pointing at an endpoint nothing else lists still gets its
    placeholder row, warning and all — otherwise the picker would look like it
    silently jumped to another provider.
    """
    kept = drop_aliased_bare_custom(
        [STUB_ROW], [DEEPSEEK_ROW], _ctx(custom_providers=[])
    )

    assert [row["slug"] for row in kept] == ["custom"]


@pytest.mark.parametrize(
    "extra",
    [
        # A never-set-up provider skeleton (include_unconfigured / TUI).
        {"slug": "custom", "name": "Custom endpoint", "source": "canonical"},
        # A different provider's configured-current row.
        {"slug": "deepseek", "name": "DeepSeek", "source": "configured-current"},
        {"slug": MANAGED_SLUG, "name": MANAGED_NAME, "source": "configured-current"},
    ],
)
def test_drop_aliased_bare_custom_touches_nothing_else(extra):
    assert drop_aliased_bare_custom([extra], [MANAGED_ROW], _ctx()) == [extra]


def test_wrapper_passes_arguments_through_untouched():
    seen = {}

    def spy(rows, ctx, **kwargs):
        seen["rows"] = rows
        seen["ctx"] = ctx
        seen["kwargs"] = kwargs
        return [STUB_ROW]

    ctx = _ctx()
    out = custom_row_dedupe._wrap_append_unconfigured_rows(spy)(
        [MANAGED_ROW], ctx, current_only=True
    )

    assert seen["rows"] == [MANAGED_ROW]
    assert seen["ctx"] is ctx
    assert seen["kwargs"] == {"current_only": True}
    assert out == []


def test_wrapper_never_breaks_the_host_path():
    """A hostile ctx must not take the picker down — upstream's rows survive."""

    class Boom:
        @property
        def current_base_url(self):
            raise RuntimeError("boom")

    out = custom_row_dedupe._wrap_append_unconfigured_rows(
        lambda rows, ctx, **kw: [STUB_ROW]
    )([MANAGED_ROW], Boom(), current_only=True)

    assert out == [STUB_ROW]


# ---------------------------------------------------------------------------
# End to end — the real payload assembly, with the seam installed
# ---------------------------------------------------------------------------

def _build_payload():
    from hermes_cli.inventory import build_models_payload

    return build_models_payload(
        _ctx(),
        explicit_only=True,
        picker_hints=True,
        probe_custom_providers=False,
        probe_current_custom_provider=False,
    )


def test_regression_fixture_unpatched_payload_lists_the_endpoint_twice(monkeypatch):
    """The bug, pinned: without the seam the directory duplicates the endpoint.

    This is the reverse validation for the test below — remove the seam and the
    "CUSTOM ENDPOINT" row is right there in the real payload. Unwraps whatever
    the process currently holds so the fixture is the same either side of a
    boot that already ran ``apply()``.
    """
    from hermes_cli import inventory

    installed = getattr(inventory, custom_row_dedupe._TARGET_APPEND_FN)
    monkeypatch.setattr(
        inventory,
        custom_row_dedupe._TARGET_APPEND_FN,
        getattr(installed, "__wrapped__", installed),
    )

    payload = _build_payload()
    custom_rows = [
        row for row in payload["providers"] if str(row["slug"]).startswith("custom")
    ]

    assert [row["slug"] for row in custom_rows] == [MANAGED_SLUG, "custom"]
    assert custom_rows[1]["name"] == "Custom endpoint"
    # …and it lies about the endpoint the row above proves is authenticated.
    assert custom_rows[1]["authenticated"] is False


def test_patched_payload_lists_the_managed_endpoint_exactly_once(monkeypatch):
    from hermes_cli import inventory

    installed = getattr(inventory, custom_row_dedupe._TARGET_APPEND_FN)
    monkeypatch.setattr(
        inventory,
        custom_row_dedupe._TARGET_APPEND_FN,
        custom_row_dedupe._wrap_append_unconfigured_rows(
            getattr(installed, "__wrapped__", installed)
        ),
    )

    payload = _build_payload()
    custom_rows = [
        row for row in payload["providers"] if str(row["slug"]).startswith("custom")
    ]

    assert [row["slug"] for row in custom_rows] == [MANAGED_SLUG]
    assert custom_rows[0]["name"] == MANAGED_NAME
    # No implementation word survives on any row the picker will render.
    assert not any(
        "custom endpoint" in str(row.get("name", "")).lower()
        for row in payload["providers"]
    )


# ---------------------------------------------------------------------------
# apply() + plugin wiring
# ---------------------------------------------------------------------------

def test_apply_is_idempotent_and_installs_one_wrapper(monkeypatch):
    from hermes_cli import inventory

    monkeypatch.setattr(custom_row_dedupe, "_APPLIED", False)
    original = getattr(inventory, custom_row_dedupe._TARGET_APPEND_FN)
    monkeypatch.setattr(inventory, custom_row_dedupe._TARGET_APPEND_FN, original)

    assert custom_row_dedupe.apply() is True
    once = getattr(inventory, custom_row_dedupe._TARGET_APPEND_FN)
    assert getattr(once, custom_row_dedupe._MARK, False) is True

    monkeypatch.setattr(custom_row_dedupe, "_APPLIED", False)
    assert custom_row_dedupe.apply() is True
    assert getattr(inventory, custom_row_dedupe._TARGET_APPEND_FN) is once


def test_apply_reports_failure_when_upstream_symbol_is_gone(monkeypatch):
    from hermes_cli import inventory

    monkeypatch.setattr(custom_row_dedupe, "_APPLIED", False)
    monkeypatch.delattr(inventory, custom_row_dedupe._TARGET_APPEND_FN)

    assert custom_row_dedupe.apply() is False


def test_plugin_register_applies_the_seam():
    from tests.apex_overlay.conftest import run_plugin_register_with_stubbed_seams

    called = run_plugin_register_with_stubbed_seams(
        "_apex_overlay_plugin_under_test_crd"
    )

    assert "custom_row_dedupe" in called
