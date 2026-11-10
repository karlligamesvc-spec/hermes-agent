"""ApexNodes hc-911: upstream tests that drive upstream Desktop artifacts APEX does not carry.

apps/desktop stays on the APEX baseline (Mac arm64 releases, plus the Windows x64 NSIS build
at fixed versions; hard rule #15), so upstream's Desktop identity/packaging modules and
shared fixtures are absent from this tree. Each entry names the exact test id (or module) and
the upstream Desktop paths it needs. An entry only takes effect while ALL of its paths are
absent: once a path is ported, the skip lapses and the test runs again
(tests/apex_overlay/test_desktop_baseline_skips.py also fails on a stale entry).

Registered from pyproject.toml ``addopts`` (``-p tests._fixtures.apex_desktop_baseline``) so
upstream test files and conftest stay byte-identical.
"""

from __future__ import annotations

import itertools
import os
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]

_PRODUCT_IDENTITY = ("apps/desktop/product-identity.cjs",)
_E2E_HARNESS = (
    "apps/desktop/electron-builder.config.cjs",
    "apps/desktop/e2e/core/harness",
    "apps/desktop/e2e/update",
)
_E2E_UPDATE = ("apps/desktop/e2e/update",)
# hc-913: the suites ci.yaml's e2e-desktop-core / e2e-desktop-update jobs run. While one is absent its job is
# `if: false` and deferred in scripts/ci/required_results.py (tests/apex_overlay/test_desktop_e2e_lanes.py).
_E2E_CORE_SUITE = ("apps/desktop/e2e/core/playwright.config.ts",)
_E2E_UPDATE_SUITE = ("apps/desktop/e2e/update/playwright.config.ts",)
_MARKER_CORPUS_READERS = (
    "apps/desktop/electron/update-marker-corpus.test.ts",
    "apps/desktop/electron/remote-update-marker-programs.test.ts",
    "apps/desktop/electron/remote-lifecycle-v2-marker.test.ts",
)

# test id or module path -> upstream Desktop paths it needs
SKIPS: dict[str, tuple[str, ...]] = {
    "tests/ci/test_channel_build_publication.py::test_receiver_allocation_uses_official_identity_only_inside_scope": _PRODUCT_IDENTITY,
    "tests/ci/test_desktop_bundle_smoke.py::test_canary_publisher_consumes_staged_bytes_and_writes_pointer_last": _PRODUCT_IDENTITY,
    "tests/ci/test_channel_build_publication.py::test_scoped_receiver_publication_preserves_existing_head_and_requires_smoke[receiver]": _PRODUCT_IDENTITY,
    # Upstream's Desktop build runs scripts/build/desktop.mjs from its electron-builder config;
    # APEX's build is apps/desktop's own package.json pipeline.
    "tests/ci/test_update_ci_routing.py::test_desktop_build_scripts_start_the_desktop_update_suite": ("apps/desktop/electron-builder.config.cjs",),
    # The e2e_desktop_update lane replays upstream's playwright suite (e2e/update/*.spec.ts),
    # and the update-marker corpus is read by upstream Desktop vitest files; APEX carries neither.
    **{f"tests/ci/test_update_ci_routing.py::{test}": _E2E_UPDATE for test in (
        "test_update_path_change_reaches_the_suites_that_consume_it[hermes_cli/web_routers/status.py-lanes0]",
        "test_update_path_change_selects_every_suite_that_exercises_it[apps/desktop/electron/update-marker-gate.ts-lanes0]",
    )},
    "tests/ci/test_update_ci_routing.py::test_every_test_that_reads_a_shared_fixture_is_routed_by_it": _MARKER_CORPUS_READERS,
    "tests/ci/test_update_ci_routing.py::test_marker_corpus_change_runs_every_language_that_reads_it": _MARKER_CORPUS_READERS,
    "tests/ci/test_classify_changes.py::test_every_slow_lane_path_matches_a_tracked_file": _E2E_HARNESS,
    "tests/ci/test_classify_changes.py::test_every_desktop_update_path_file_starts_the_desktop_update_suite[apps/desktop/electron/updater/checkout.ts]": ("apps/desktop/electron/updater/checkout.ts",),
    "tests/ci/test_classify_changes.py::test_every_desktop_update_path_file_starts_the_desktop_update_suite[apps/desktop/electron/backend-discovery.ts]": ("apps/desktop/electron/backend-discovery.ts",),
    "tests/ci/test_classify_changes.py::test_every_desktop_update_path_file_starts_the_desktop_update_suite[apps/desktop/electron/local-gateway.ts]": ("apps/desktop/electron/local-gateway.ts",),
    # hc-1203: v0.23.0's update path (hermes_cli/source_build.py) runs upstream's Webapp recipe; the APEX
    # baseline has none, and the scan of the update's JS closure stops at the first absent file.
    "tests/ci/test_update_ci_routing.py::test_build_scripts_the_update_runs_start_the_upgrade_suite": ("apps/desktop/scripts/build-webapp.mjs",),
    # hc-1203: v0.23.0's `hermes update` keeps a packaged Desktop across commits when a build at HEAD would bake
    # the same install stamp; the test copies upstream's stamp inputs into a scratch checkout. APEX's
    # write-build-stamp.mjs has no buildStampPayload, so on this tree the probe stops ("buildStampPayload is not
    # a function") and the update rebuilds (hermes_cli/desktop_build_reuse.py: anything unreadable means build).
    **{f"tests/hermes_cli/test_desktop_build_reuse.py::{test}": (
        "apps/desktop/scripts/bundle-env.mjs", "apps/desktop/product-identity.cjs")
       for test in ("test_update_reuses_the_packaged_app_until_a_desktop_input_changes",
                    "test_a_stamp_a_build_would_bake_differently_still_rebuilds")},
    # hc-913: these expect the e2e-desktop-core / e2e-desktop-update jobs to run, gate the merge, or be
    # required consumers. Each one's APEX counterpart (the job deferred while its suite is absent, every other
    # lane still routed) is in tests/apex_overlay/test_desktop_e2e_lanes.py.
    "tests/ci/test_required_results.py::test_release_exclusion_policy": _E2E_CORE_SUITE + _E2E_UPDATE_SUITE,
    "tests/ci/test_update_ci_routing.py::test_every_detect_output_a_lane_sets_is_consumed_by_some_job": _E2E_CORE_SUITE + _E2E_UPDATE_SUITE,
    **{f"tests/ci/test_required_results.py::test_selected_update_consumers_must_succeed[{result}-e2e_desktop_update-jobs4]": _E2E_UPDATE_SUITE
       for result in ("skipped", "absent")},
    "tests/ci/test_classify_changes.py::test_real_update_suites_gate_the_merge_when_their_lane_fires[ci.yaml-e2e-desktop-update-e2e-desktop-update.yml-e2e_desktop_update]": _E2E_UPDATE_SUITE,
    # Every combo of the replayed lanes with e2e_desktop_update set (upstream's id: the set lanes, "-"-joined).
    **{"tests/ci/test_update_ci_routing.py::test_every_set_lane_reaches_its_consumer_whatever_the_other_lanes_say["
       + "-".join((*(lane for lane, on in zip(("python", "desktop_updater", "e2e", "e2e_upgrade"), combo) if on),
                   "e2e_desktop_update")) + "]": _E2E_UPDATE_SUITE
       for combo in itertools.product((False, True), repeat=4)},
    **{f"tests/ci/test_update_ci_routing.py::test_update_owner_change_dispatches_its_suites_end_to_end[{case}]": _E2E_UPDATE_SUITE for case in (
        "scripts/build/desktop.mjs-lanes0",
        "scripts/build/web.mjs-lanes1",
        "hermes_cli/_subprocess_compat.py-lanes2",
        "hermes_cli/desktop_build_lock.py-lanes3",
        "hermes_cli/memory_provider_migration.py-lanes4",
        "hermes_cli/source_build.py-lanes5",
        "hermes_cli/source_completion.py-lanes6",
        "apps/desktop/electron/update-marker.ts-lanes7",
        "apps/desktop/electron/handoff-result.ts-lanes8",
    )},
    "tests/ci/test_update_ci_routing.py::test_update_path_change_selects_every_suite_that_exercises_it[hermes_cli/_launchers.py-lanes3]": _E2E_UPDATE_SUITE,
    **{f"tests/ci/test_update_transitive_routing.py::test_second_hop_update_change_dispatches_real_update_consumers[{path}]": _E2E_UPDATE_SUITE
       for path in ("hermes_cli/local_runtime/processes.py", "hermes_cli/local_runtime/__init__.py", "agent/deadline.py",
                    "agent/memory_provider.py", "pm/plugins_state.py", "pm/install.py", "hermes_cli/backup.py")},
    # The replay's sensitivity to a broken update step: there is no update step to break while the suite is absent.
    **{"tests/ci/test_update_ci_routing.py::test_replay_rejects_ineffective_required_step["
       f"{mutation}-e2e_desktop_update-.github/workflows/e2e-desktop-update.yml-update-Run the update suite under xvfb]": _E2E_UPDATE_SUITE
       for mutation in ("disabled", "advisory", "no-command", "empty-selection")},
}
# Whole modules that cannot even be collected without the upstream Desktop files.
IGNORED_MODULES: dict[str, tuple[str, ...]] = {
    "tests/ci/test_protected_canary_publication.py": _PRODUCT_IDENTITY,
    "tests/tools/test_mcp_enabled_reader.py": ("apps/desktop/src/lib/mcp-enabled-cases.json",),
}

# Upstream live tests that assume upstream's CI runner, not this fork's standard GitHub-hosted pool.
# Skipped ONLY in GitHub Actions; on any developer machine they run, which is where each open entry
# gets investigated. The signal is GITHUB_ACTIONS because scripts/run_tests.sh starts pytest under
# `env -i` and forwards only an allowlist (GITHUB_REPOSITORY never arrives); this plugin exists only
# in the fork, so a GitHub Actions run of it is the fork's CI. Not a Desktop-baseline skip: no path
# lapses it, so every entry names its follow-up and goes once that is resolved.
FORK_CI_SIGNAL = ("GITHUB_ACTIONS", "true")
_GIT_CORE_ON_RUNNER = (
    "hc-911 follow-up (upstream fix): _locate_real_git() probes only <arch>\\libexec\\git-core\\git.exe, which "
    "current Git for Windows no longer ships (the fork's windows-2025-vs2026 runner has 2.56.0; MinGit 2.54 keeps "
    "the real binary at mingw64\\bin\\git.exe); APEX's Windows installs (COS archive, no .git) never take this path")
_COMPACTION_EDGE_ON_RUNNER = (
    "hc-1203 follow-up (upstream report): the outcome hangs on the system prompt's length, which carries tmp_path four "
    "times plus the date. On upstream v0.23.0 itself (fork ubuntu runner, diag runs 42901981913 and 42904107258), plain "
    "pytest with a 30- or 48-char --basetemp compacts at the fourth pressure turn and passes; at 64 chars or more "
    "(scripts/run_tests.sh's /var/tmp/hermes-pytest-<uid>/r-<id>/pytest-of-runner/pytest-0 is 64) it compacts one turn "
    "early, PRESSURE_1 stays verbatim and both cases fail. Report it upstream (size the pressure from the measured "
    "prompt), then drop these entries")
FORK_RUNNER_SKIPS: dict[str, str] = {
    "tests/hermes_cli/test_git_trampoline_windows_live.py::TestGitTrampolineLive::test_locate_real_git_finds_runner_git_core": _GIT_CORE_ON_RUNNER,
    "tests/hermes_cli/test_git_trampoline_windows_live.py::TestGitTrampolineLive::test_ensure_non_trampoline_git_swaps_live": _GIT_CORE_ON_RUNNER,
    **{"tests/gateway/test_journey_compress_restart_fifo.py::"
       f"test_followers_survive_compression_and_restart_in_order_exactly_once[{restart}]": _COMPACTION_EDGE_ON_RUNNER
       for restart in ("graceful", "crash")},
}
_SLOW_BROWSE_ON_MACOS_RUNNER = (
    "hc-1203 follow-up (upstream report): upstream runs its macOS lane on 12-vCPU Blacksmith runners; on the fork's "
    "GitHub-hosted macos-latest the slowed DDL comes back as the generic 'schema is unavailable or corrupt' 503, not "
    "the browse budget's 'nothing was changed' one (dd6ba36b96 and 55b26f01ef, in-job retry included). A developer "
    "Mac passes, and on its efficiency cores boot's 5 s wait runs out instead. Find which error escapes the budget")
# Fork-runner skips that only the fork's macOS runner trips: the fork's Linux runner passes them, so they keep
# running there. Same rules as FORK_RUNNER_SKIPS otherwise.
FORK_MACOS_RUNNER_SKIPS: dict[str, str] = {
    "tests/hermes_cli/test_browse_schema_drift.py::test_slow_browse_reconcile_gives_up_inside_its_budget_and_boot_waits_it_out[ddl]": _SLOW_BROWSE_ON_MACOS_RUNNER,
}


def _absent(paths: tuple[str, ...]) -> bool:
    return all(not (REPO / path).exists() for path in paths)


def _reason(paths: tuple[str, ...]) -> str:
    return "ApexNodes hc-911: needs upstream Desktop " + ", ".join(paths)


class _SkippedModule(pytest.Module):
    """A module whose import needs absent upstream Desktop files: skip it at collection.

    ``pytest_ignore_collect`` is not consulted for paths given on the command line, and the
    per-file runner (scripts/run_tests_parallel.py) passes every file explicitly.
    """

    apex_reason = ""

    def _getobj(self):
        pytest.skip(self.apex_reason, allow_module_level=True)


@pytest.hookimpl(tryfirst=True)
def pytest_pycollect_makemodule(module_path, parent):
    try:
        rel = Path(module_path).resolve().relative_to(REPO).as_posix()
    except ValueError:
        return None
    paths = IGNORED_MODULES.get(rel)
    if not paths or not _absent(paths):
        return None
    module = _SkippedModule.from_parent(parent, path=Path(module_path))
    module.apex_reason = _reason(paths)
    return module


def pytest_collection_modifyitems(config, items):
    on_fork_ci = os.environ.get(FORK_CI_SIGNAL[0]) == FORK_CI_SIGNAL[1]
    runner_skips = FORK_RUNNER_SKIPS | (FORK_MACOS_RUNNER_SKIPS if sys.platform == "darwin" else {})
    for item in items:
        paths = SKIPS.get(item.nodeid)
        if paths and _absent(paths):
            item.add_marker(pytest.mark.skip(reason=_reason(paths)))
        elif on_fork_ci and item.nodeid in runner_skips:
            item.add_marker(pytest.mark.skip(reason=f"ApexNodes {runner_skips[item.nodeid]}"))
