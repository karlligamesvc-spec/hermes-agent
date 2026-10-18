"""Every slice's fresh durations reach the next run's cache (.github/workflows/tests.yml).

Each test slice restores the duration cache, the runner writes the slice's fresh timings over the
restored entries (scripts/run_tests_parallel.py), and the main-only save-durations job merges the
slices into the next cache. Two faults there turned fork main red or threw timings away:

- download-artifact with merge-multiple extracted every slice's same-named file into one path at
  the same time: one slice survived a green run, and interleaved writes left invalid JSON;
- every slice's file also carries the restored (older) timings of the other slices' files, so
  merging whole copies let the last slice overwrite the other slices' fresh timings.

The test replays the real steps for two slices: bash steps run as written, the runner's own
_save_durations writes each slice's file, and only the cache and the artifacts are models.
"""

from __future__ import annotations

import fnmatch
import importlib.util
import json
from functools import cache
from pathlib import Path

import pytest

from tests.ci import _gha_expr as gha
from tests.ci import workflow_steps

_REPO = Path(__file__).resolve().parents[2]

# The cache a previous main push saved. No slice runs test_gone.
PREVIOUS = {"tests/test_a.py": 10.0, "tests/test_b.py": 20.0, "tests/test_flaky.py": 30.0, "tests/test_gone.py": 5.0}
# What each slice's run measured. test_flaky passed on its retry: its summed wall time must not
# replace its last healthy duration.
RUNS = {
    1: {"tests/test_a.py": 11.5, "tests/test_new_1.py": 1.25},
    2: {"tests/test_b.py": 18.25, "tests/test_new_2.py": 2.5, "tests/test_flaky.py": 95.0},
}
FLAKY = {"tests/test_flaky.py"}


@cache
def _runner():
    spec = importlib.util.spec_from_file_location("run_tests_parallel_durations", _REPO / "scripts/run_tests_parallel.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _Cache:
    """actions/cache for one path: the exact key, else the newest entry under each restore-keys prefix."""

    def __init__(self) -> None:
        self.saved: list[tuple[str, str, bytes]] = []  # (key, path, contents), oldest first

    def save(self, w: dict, workspace: Path) -> None:
        assert w["key"] not in {key for key, _, _ in self.saved}, f"cache key {w['key']} is taken"
        self.saved.append((w["key"], w["path"], (workspace / w["path"]).read_bytes()))

    def restore(self, w: dict, workspace: Path) -> None:
        prefixes = [line.strip() for line in (w.get("restore-keys") or "").splitlines() if line.strip()]
        for exact, wanted in [(True, w["key"]), *((False, prefix) for prefix in prefixes)]:
            for key, path, contents in reversed(self.saved):
                if path == w["path"] and (key == wanted if exact else key.startswith(wanted)):
                    (workspace / path).write_bytes(contents)
                    return


def _upload(w: dict, artifacts: dict, workspace: Path) -> None:
    """upload-artifact of one file: the artifact holds it under its own name; a missing file uploads nothing."""
    assert "\n" not in w["path"] and not set("*?[") & set(w["path"]), f"unmodelled upload path {w['path']!r}"
    path = workspace / w["path"]
    assert w["name"] not in artifacts, f"artifact {w['name']} uploaded twice"
    if path.is_file():
        artifacts[w["name"]] = {path.name: path.read_bytes()}


def _download(w: dict, artifacts: dict, workspace: Path) -> list[str]:
    """download-artifact by pattern: each artifact into <path>/<name>/, or all into <path> with merge-multiple.

    Returns the files two artifacts both extract to. The real downloads extract in parallel, so at
    best one copy survives; here the last one does.
    """
    assert set(w) <= {"pattern", "path", "merge-multiple"}, f"unmodelled download-artifact inputs {sorted(w)}"
    merge = gha.to_string(w.get("merge-multiple", False)).lower()
    assert merge in ("true", "false"), f"merge-multiple is a boolean input, not {merge!r}"
    owners: dict[Path, str] = {}
    collisions = []
    for name, files in sorted(artifacts.items()):
        if not fnmatch.fnmatchcase(name, w["pattern"]):
            continue
        folder = workspace / w["path"] if merge == "true" else workspace / w["path"] / name
        for file_name, contents in files.items():
            dest = folder / file_name
            if dest in owners:
                collisions.append(f"{owners[dest]} and {name} both extract to {dest.relative_to(workspace).as_posix()}")
            owners[dest] = name
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(contents)
    return collisions


def _ctx(temp: Path, **extra) -> dict:
    """A green push to main, the only run that saves the cache."""
    return {"github": {"event_name": "push", "ref": "refs/heads/main", "run_id": "1002"},
            "inputs": {"slice_count": len(RUNS), "commit": ""}, "needs": {"test": {"result": "success"}},
            "runner": {"temp": str(temp)}, **extra}


def _with(step: dict, ctx: dict) -> dict:
    return {key: gha.render(value, ctx) for key, value in step.get("with", {}).items()}


def _run_tests(checkout: Path, run: dict[str, float]) -> None:
    """What scripts/run_tests_parallel.py does with a slice's timings after its files ran."""
    runner = _runner()
    file_times = [(checkout / name, secs) for name, secs in run.items()]
    flaky = [(checkout / name, "passed on retry") for name in run if name in FLAKY]
    clean = runner._clean_pass_durations(file_times, [], flaky)
    if clean:
        runner._save_durations(clean, checkout)


def _test_slice(workflow: dict, index: int, cache: _Cache, artifacts: dict, tmp: Path) -> None:
    """One `test` matrix job, from its duration-cache restore to its artifact upload."""
    checkout, temp = tmp / f"slice-{index}", tmp / f"slice-{index}-temp"
    checkout.mkdir()
    temp.mkdir()
    ctx = _ctx(temp, matrix={"slice": {"index": index, "files": ":".join(RUNS[index])}})
    steps = workflow["jobs"]["test"]["steps"]
    first = next(i for i, step in enumerate(steps) if step.get("uses", "").startswith("actions/cache/restore@"))
    last = next(i for i, step in enumerate(steps) if step.get("uses", "").startswith("actions/upload-artifact@"))
    for step in steps[first:last + 1]:
        uses = step.get("uses", "")
        if uses.startswith("actions/cache/restore@"):
            cache.restore(_with(step, ctx), checkout)
        elif uses.startswith("actions/upload-artifact@"):
            _upload(_with(step, ctx), artifacts, checkout)
        elif "scripts/run_tests.sh" in step.get("run", ""):
            _run_tests(checkout, RUNS[index])
        elif "run" in step:
            workflow_steps.outputs(step, ctx, checkout, runner_temp=temp)
        else:
            raise AssertionError(f"unmodelled step between the duration restore and upload: {step.get('name')}")


def _save_durations(workflow: dict, cache: _Cache, artifacts: dict, tmp: Path) -> list[str]:
    job = workflow["jobs"]["save-durations"]
    workspace, temp = tmp / "save-durations", tmp / "save-durations-temp"
    workspace.mkdir()
    temp.mkdir()
    ctx = _ctx(temp)
    assert gha.condition(job["if"], ctx), "save-durations must run on a green push to main"
    collisions = []
    for step in job["steps"]:
        uses = step.get("uses", "")
        if uses.startswith("actions/cache/restore@"):
            cache.restore(_with(step, ctx), workspace)
        elif uses.startswith("actions/download-artifact@"):
            collisions += _download(_with(step, ctx), artifacts, workspace)
        elif uses.startswith("actions/cache/save@"):
            cache.save(_with(step, ctx), workspace)
        elif "run" in step:
            workflow_steps.outputs(step, ctx, workspace, runner_temp=temp)
        else:
            raise AssertionError(f"unmodelled save-durations step: {step.get('name')}")
    return collisions


@pytest.mark.parametrize(("previous", "expected"), [
    (PREVIOUS, {"tests/test_a.py": 11.5, "tests/test_b.py": 18.25, "tests/test_flaky.py": 30.0,
                "tests/test_gone.py": 5.0, "tests/test_new_1.py": 1.25, "tests/test_new_2.py": 2.5}),
    (None, {"tests/test_a.py": 11.5, "tests/test_b.py": 18.25, "tests/test_new_1.py": 1.25,
            "tests/test_new_2.py": 2.5}),
], ids=["previous-cache", "first-cache"])
def test_next_run_restores_every_slices_fresh_durations(tmp_path, previous, expected):
    yaml = pytest.importorskip("hermes_yaml")
    workflow = yaml.safe_load((_REPO / ".github/workflows/tests.yml").read_text(encoding="utf-8-sig"))
    cache, artifacts = _Cache(), {}
    if previous is not None:
        cache.saved.append(("test-durations-1001", "test_durations.json", json.dumps(previous).encode()))

    for index in RUNS:
        _test_slice(workflow, index, cache, artifacts, tmp_path)
    assert sorted(artifacts) == ["test-durations-slice-1", "test-durations-slice-2"]
    assert _save_durations(workflow, cache, artifacts, tmp_path) == []

    next_run = tmp_path / "next-run"
    next_run.mkdir()
    restore = next(step for step in workflow["jobs"]["test"]["steps"]
                   if step.get("uses", "").startswith("actions/cache/restore@"))
    cache.restore(_with(restore, _ctx(next_run)), next_run)
    assert json.loads((next_run / "test_durations.json").read_text(encoding="utf-8")) == expected


def test_download_model_reports_what_merge_multiple_overwrites(tmp_path):
    """The guard above relies on this model: same-named files collide only when merged into one path."""
    artifacts = {"d-1": {"f.json": b"1"}, "d-2": {"f.json": b"2"}, "other": {"f.json": b"x"}}
    assert _download({"pattern": "d-*", "path": "apart"}, artifacts, tmp_path) == []
    assert [p.relative_to(tmp_path).as_posix() for p in sorted(tmp_path.rglob("*.json"))] == [
        "apart/d-1/f.json", "apart/d-2/f.json"]
    assert _download({"pattern": "d-*", "path": "merged", "merge-multiple": True}, artifacts, tmp_path) == [
        "d-1 and d-2 both extract to merged/f.json"]
