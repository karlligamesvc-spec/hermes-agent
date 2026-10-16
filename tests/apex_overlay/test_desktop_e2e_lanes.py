"""ApexNodes hc-913: ci.yaml's upstream Desktop E2E lanes stay off while their suites are absent.

apps/desktop stays on the APEX baseline (hard rule #15), which carries neither suite these jobs run:
e2e-desktop-core (apps/desktop/e2e/core) and e2e-desktop-update (apps/desktop/e2e/update). Pull
requests and main pushes force the E2E lanes off, but a release run (ci.yaml dispatched with
``release``, or stable-release.yml) forces every lane on, and both jobs would go red.

So while a suite's playwright config is absent, its job must be a bare ``if: false`` and
scripts/ci/required_results.py must defer it: tolerate its skip on release, and not require it as an
update consumer. Porting the suite turns these tests red until both are restored. The upstream tests
that expect the jobs to run are skipped by tests/_fixtures/apex_desktop_baseline.py under the same
paths; the contracts they still carry for every other lane are asserted here instead.
"""

from __future__ import annotations

import importlib.util
import itertools
import json
from pathlib import Path

import pytest

import hermes_yaml
from tests._fixtures import apex_desktop_baseline as baseline
from tests.ci import test_update_ci_routing as routing
from tests.ci import test_update_transitive_routing as transitive

REPO = Path(__file__).resolve().parents[2]

# job -> (its suite's playwright config, the detect lane that starts it, a required update consumer once ported)
LANES = {
    "e2e-desktop-core": ("apps/desktop/e2e/core/playwright.config.ts", "e2e_desktop_core", False),
    "e2e-desktop-update": ("apps/desktop/e2e/update/playwright.config.ts", "e2e_desktop_update", True),
}
# Upstream's release exclusions: the PR-only jobs and the deferred legacy Desktop E2E (e2e-desktop).
UPSTREAM_EXCLUDED = {"history-check", "lockfile-diff", "prompt-surface-diff", "supply-chain", "e2e-desktop"}

_spec = importlib.util.spec_from_file_location("required_results", REPO / "scripts/ci/required_results.py")
rr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rr)


def _absent(job: str) -> bool:
    return not (REPO / LANES[job][0]).exists()


def _deferred_lanes() -> dict[str, str]:
    """lane -> its job, for every job whose suite is absent."""
    return {lane: job for job, (_, lane, _) in LANES.items() if _absent(job)}


def _workflow(rel: str) -> dict:
    return hermes_yaml.safe_load((REPO / rel).read_text(encoding="utf-8-sig"))


def _ci() -> dict:
    return _workflow(".github/workflows/ci.yaml")


def test_skip_list_cites_the_same_suites():
    assert baseline._E2E_CORE_SUITE == (LANES["e2e-desktop-core"][0],)
    assert baseline._E2E_UPDATE_SUITE == (LANES["e2e-desktop-update"][0],)


@pytest.mark.parametrize("job", LANES)
def test_job_is_bare_if_false_exactly_while_its_suite_is_absent(job):
    suite, lane, _ = LANES[job]
    jobs = _ci()["jobs"]
    cond = jobs[job].get("if")
    if _absent(job):
        # Parsed `false`, not a `${{ false && ... }}` string: that form broke GitHub's parser (see e2e-desktop).
        assert cond is False, f"{job}: {suite} is absent, so the job must be a bare `if: false`, got {cond!r}"
    else:
        assert cond == f"needs.detect.outputs.{lane} == 'true'", f"{job}: {suite} exists; restore its lane gate"
    # Deferred, not dropped: once re-enabled it gates the merge again.
    assert job in jobs["all-checks-pass"]["needs"]


@pytest.mark.parametrize("job", LANES)
def test_gate_defers_the_job_exactly_while_its_suite_is_absent(job):
    _, lane, consumer = LANES[job]
    absent = _absent(job)
    assert (job in rr.DEFERRED_JOBS) is absent
    assert rr._UPDATE_CONSUMER_LANES.get(job) == (None if absent or not consumer else (lane,))


def test_release_exclusions_add_only_the_absent_suites():
    assert rr.EXCLUDED_JOBS == UPSTREAM_EXCLUDED | {job for job in LANES if _absent(job)}


@pytest.mark.parametrize("release", [False, True])
@pytest.mark.parametrize("job", LANES)
def test_selected_lane_skip_passes_the_gate_exactly_while_deferred(job, release):
    """A release run forces every lane on: the deferred job's skip must not fail the gate."""
    ci = _ci()
    needs = {name: {"result": "success"} for name in ci["jobs"]["all-checks-pass"]["needs"]}
    needs["detect"] = {"result": "success", "outputs": {k: "true" for k in ci["jobs"]["detect"]["outputs"]}}
    for skipped in ("e2e-desktop", job):
        needs[skipped] = {"result": "skipped"}
    consumer = LANES[job][2]
    expected = _absent(job) or (not release and not consumer)
    assert rr.evaluate_gate(needs, release=release)["ok"] is expected
    # Deferring tolerates a skip only: a run that fails still fails the gate.
    needs[job] = {"result": "failure"}
    assert rr.evaluate_gate(needs, release=release)["failed"] == [job]


def test_every_other_detect_output_is_still_consumed():
    """Upstream's lane-consumption check, less the lanes whose job is deferred."""
    ci = _ci()
    text = json.dumps({k: v for k, v in ci["jobs"].items() if k != "detect"})
    ignored = {"event_name", "python_prod", *_deferred_lanes()}
    unread = [k for k in ci["jobs"]["detect"]["outputs"]
              if k not in ignored and f"needs.detect.outputs.{k}" not in text]
    assert unread == []


def test_suites_run_only_through_the_gated_ci_jobs():
    """No other workflow, trigger or job can start a deferred suite."""
    callers = []
    for path in sorted((REPO / ".github/workflows").glob("*.y*ml")):
        for name, body in (_workflow(path.relative_to(REPO).as_posix()).get("jobs") or {}).items():
            uses = body.get("uses", "") if isinstance(body, dict) else ""
            if uses in {f"./.github/workflows/{job}.yml" for job in LANES}:
                callers.append((path.name, name, uses))
    assert sorted(callers) == sorted(("ci.yaml", job, f"./.github/workflows/{job}.yml") for job in LANES)
    for job in LANES:
        triggers = routing._on(_workflow(f".github/workflows/{job}.yml"))
        assert set(triggers) == {"workflow_call"}, f"{job}.yml has its own trigger(s): {sorted(triggers)}"


# -- replays (bash >= 4, as the upstream routing replays: Linux and native Windows) ----------------

_OTHER_LANES = ("python", "desktop_updater", "e2e", "e2e_upgrade")


@routing._NATIVE_WINDOWS_TOO
@pytest.mark.parametrize("combo", list(itertools.product((False, True), repeat=len(_OTHER_LANES))),
                         ids=lambda c: "-".join(n for n, on in zip(_OTHER_LANES, c) if on) or "none")
def test_release_lanes_skip_the_deferred_jobs_and_reach_every_other_consumer(combo):
    """Upstream's every-set-lane replay with both Desktop lanes on, as a release run sets them."""
    lanes = {k: False for k in routing.cc.classify(["README.md"])}
    lanes.update(zip(_OTHER_LANES, combo))
    lanes.update(e2e_desktop_core=True, e2e_desktop_update=True)
    run = routing._ci_run(lanes)
    for job in LANES:
        if _absent(job):
            assert job not in run, f"{job} ran while its suite is absent"
    for lane in ("desktop_updater", "e2e", "e2e_upgrade"):
        reached = routing._consumers_reached(run, lane)
        if lanes[lane]:
            assert all(reached.values()), f"{lane}=true but not dispatched: {reached}"
        elif lane != "desktop_updater":
            assert not any(reached.values()), f"{lane}=false but ran anyway: {reached}"


def _update_route_cases() -> dict[str, tuple[str, ...]]:
    """The update-path files whose upstream routing tests expect e2e_desktop_update to run."""
    second_hop = next(m.args[1] for m in transitive.test_second_hop_update_change_dispatches_real_update_consumers.pytestmark
                      if m.name == "parametrize")
    return {
        **routing._R15_CASES,
        "hermes_cli/_launchers.py": routing._R6_CASES["hermes_cli/_launchers.py"],
        **{path: ("e2e_upgrade", "e2e_desktop_update") for path in second_hop},
    }


@routing._NATIVE_WINDOWS_TOO
@pytest.mark.parametrize("path,lanes", list(_update_route_cases().items()))
def test_update_path_keeps_its_routes_while_the_desktop_lane_is_deferred(path, lanes):
    """The classifier still selects every lane (ready for the port); every live one still reaches its suite."""
    classified = routing._real_classifier([path])
    run = routing._ci_run(classified)
    for lane in lanes:
        assert classified[lane], f"{path}: classifier leaves {lane} off"
        if lane in _deferred_lanes():
            assert _deferred_lanes()[lane] not in run, f"{path}: {lane}'s deferred job ran"
        else:
            assert all(routing._consumers_reached(run, lane).values()), f"{path}: {lane} never reaches its suite"
