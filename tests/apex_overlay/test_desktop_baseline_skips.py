"""Guard the hc-911 Desktop-baseline skip list (tests/_fixtures/apex_desktop_baseline.py).

The list may only hold upstream tests that need upstream Desktop files this tree does not
carry. Each entry must point at a real test, and every path it cites must still be absent:
a ported path means the upstream test can run again, so the entry has to go.
"""

from __future__ import annotations

import re
import tomllib
from pathlib import Path

from tests._fixtures import apex_desktop_baseline as baseline

REPO = Path(__file__).resolve().parents[2]


def _entries():
    yield from baseline.SKIPS.items()
    yield from baseline.IGNORED_MODULES.items()


def test_every_entry_names_an_existing_upstream_test():
    for nodeid, _paths in _entries():
        module, _, test = nodeid.partition("::")
        source = REPO / module
        assert source.is_file(), f"{module} no longer exists; drop the entry"
        if test:
            name = re.sub(r"\[.*\]$", "", test)
            assert re.search(rf"^\s*(async )?def {re.escape(name)}\(", source.read_text(encoding="utf-8"), re.MULTILINE), (
                f"{nodeid} no longer exists; drop the entry")


def test_every_cited_upstream_desktop_path_is_still_absent():
    for nodeid, paths in _entries():
        assert paths and all(p.startswith("apps/desktop/") for p in paths), nodeid
        present = [p for p in paths if (REPO / p).exists()]
        assert not present, f"{nodeid}: {present} now exist, so the upstream test runs again; drop the entry"


def test_fork_runner_skips_name_real_tests_and_their_follow_up():
    for nodeid, reason in baseline.FORK_RUNNER_SKIPS.items():
        module, _, test = nodeid.partition("::")
        name = test.rsplit("::", 1)[-1]
        assert re.search(rf"^\s*def {re.escape(name)}\(", (REPO / module).read_text(encoding="utf-8"), re.MULTILINE), nodeid
        assert "follow-up" in reason, f"{nodeid}: a fork-runner skip must name the follow-up that removes it"


def test_fork_runner_skips_apply_only_in_the_fork_s_github_actions(monkeypatch):
    class Item:
        def __init__(self, nodeid):
            self.nodeid, self.markers = nodeid, []

        def add_marker(self, marker):
            self.markers.append(marker)

    name, value = baseline.FORK_CI_SIGNAL

    def skipped(signal):
        if signal is None:
            monkeypatch.delenv(name, raising=False)
        else:
            monkeypatch.setenv(name, signal)
        items = [Item(nodeid) for nodeid in baseline.FORK_RUNNER_SKIPS]
        baseline.pytest_collection_modifyitems(None, items)
        return [bool(item.markers) for item in items]

    assert skipped(value) == [True] * len(baseline.FORK_RUNNER_SKIPS)
    assert not any(skipped(None)), "a developer's own run must exercise them"
    assert not any(skipped("false")), "only GitHub Actions' own value counts"


def test_fork_ci_signal_reaches_pytest_through_the_hermetic_runner():
    """scripts/run_tests.sh runs pytest under `env -i`: a signal it does not forward never arrives.

    The first version read GITHUB_REPOSITORY, which the runner drops, so the skips never fired in CI
    while the in-process check above (which sets the variable itself) stayed green.
    """
    text = (REPO / "scripts/run_tests.sh").read_text(encoding="utf-8-sig")
    allow = re.search(r"for _test_var in (.*?); do", text, re.DOTALL)
    assert allow, "run_tests.sh no longer forwards test variables through one allowlist loop"
    forwarded = allow.group(1).split()
    assert baseline.FORK_CI_SIGNAL[0] in forwarded, f"{baseline.FORK_CI_SIGNAL[0]} is not forwarded: {forwarded}"


def test_plugin_is_registered_for_every_pytest_run():
    addopts = tomllib.loads((REPO / "pyproject.toml").read_text(encoding="utf-8"))["tool"]["pytest"]["ini_options"]["addopts"]
    assert "-p tests._fixtures.apex_desktop_baseline" in addopts
