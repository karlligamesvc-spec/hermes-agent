"""ApexNodes hc-911: upstream-sync PRs are judged on what is new against BOTH bases.

scripts/ci/upstream_sync_baseline.py recognises a PR that merges a verified NousResearch release
(.github/apex-upstream-baseline.json changed, the tag resolves to the recorded commit upstream, and
the commit is merged). The code-health ratchet then only blocks findings that also block against
that release or that the record's reviewed health_allow does not name. Real git repos throughout:
the verdict depends on what git sees, so the tests give it real histories.
"""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
from collections.abc import Mapping
from pathlib import Path

import pytest

from scripts.code_health import cli
from scripts.code_health.model import Finding

REPO = Path(__file__).resolve().parents[2]
RECORD = ".github/apex-upstream-baseline.json"

_spec = importlib.util.spec_from_file_location("upstream_sync_baseline", REPO / "scripts/ci/upstream_sync_baseline.py")
assert _spec is not None and _spec.loader is not None
usb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(usb)

_LEGACY = "def legacy(x):\n" + "".join(f"    if x == {i}:\n        return {i}\n" for i in range(21))
_GROWN = _LEGACY + "    if x == 99:\n        return 99\n"  # upstream's growth
_UNION = _GROWN + "    if x == 77:\n        return 77\n"  # the fork's patch on top of it
_SWALLOW = "def swallow():\n    try:\n        pass\n    except Exception:\n        pass\n"


def _git(repo: Path, *args: str) -> str:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")
    proc = subprocess.run(["git", *args], cwd=repo, env=env, capture_output=True, text=True,
                          stdin=subprocess.DEVNULL, timeout=120, check=False)
    assert proc.returncode == 0, (args, proc.stdout, proc.stderr)
    return proc.stdout.strip()


def _commit(repo: Path, files: Mapping[str, str]) -> str:
    for rel, text in files.items():
        (repo / rel).parent.mkdir(parents=True, exist_ok=True)
        (repo / rel).write_text(text, encoding="utf-8")
    _git(repo, "add", "--all")
    _git(repo, "commit", "-q", "-m", "step")
    return _git(repo, "rev-parse", "HEAD")


def _record(tag: str, commit: str, allow: list[dict] | None = None) -> str:
    return json.dumps({"tag": tag, "commit": commit, "health_allow": allow or []})


@pytest.fixture
def histories(tmp_path, monkeypatch):
    """root -> fork base F and upstream release U, plus a sync merge M of U into F."""
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "config", "user.email", "t@example.com")
    _git(repo, "config", "user.name", "t")
    shutil.copy(REPO / "pyproject.toml", repo / "pyproject.toml")
    (repo / "scripts/ci").mkdir(parents=True)
    shutil.copy2(REPO / "scripts/ci/profile_scope_patterns.json", repo / "scripts/ci/")
    _commit(repo, {"pkg/a.py": _LEGACY})
    _git(repo, "checkout", "-q", "-b", "upstream")
    upstream = _commit(repo, {"pkg/a.py": _GROWN, "pkg/up.py": _SWALLOW.replace("swallow", "up_swallow")})
    _git(repo, "checkout", "-q", "main")
    fork = _commit(repo, {"pkg/fork.py": "def fork():\n    return 1\n"})
    _git(repo, "merge", "-q", "--no-ff", "--no-edit", "upstream")
    merged = _commit(repo, {RECORD: _record("v9.9.9", upstream)})
    monkeypatch.chdir(repo)
    return {"repo": repo, "fork": fork, "upstream": upstream, "merged": merged}


# --- the detector -------------------------------------------------------------------------------


def test_a_changed_verified_merged_record_is_the_sync_baseline(histories):
    found = usb.sync_baseline(histories["fork"], histories["merged"], resolve=lambda tag: histories["upstream"])
    assert found == {"tag": "v9.9.9", "commit": histories["upstream"]}


def test_an_ordinary_pr_has_no_baseline(histories):
    later = _commit(histories["repo"], {"pkg/fork.py": "def fork():\n    return 2\n"})
    assert usb.sync_baseline(histories["merged"], later, resolve=lambda tag: pytest.fail("no lookup")) is None
    assert usb.sync_baseline(histories["fork"], histories["fork"], resolve=lambda tag: pytest.fail("no lookup")) is None


def test_a_record_upstream_does_not_confirm_fails(histories):
    with pytest.raises(RuntimeError, match="not the recorded"):
        usb.sync_baseline(histories["fork"], histories["merged"], resolve=lambda tag: "0" * 40)


def test_a_record_naming_an_unmerged_commit_fails(histories):
    repo = histories["repo"]
    _git(repo, "checkout", "-q", "upstream")
    stray = _commit(repo, {"pkg/stray.py": "def stray():\n    return 1\n"})
    _git(repo, "checkout", "-q", "main")
    head = _commit(repo, {RECORD: _record("v9.9.10", stray)})
    with pytest.raises(RuntimeError, match="not merged"):
        usb.sync_baseline(histories["merged"], head, resolve=lambda tag: stray)


@pytest.mark.parametrize("record", [{"tag": "main", "commit": "a" * 40}, {"tag": "v1.2.3", "commit": "abc"}])
def test_a_malformed_record_is_rejected(histories, record):
    head = _commit(histories["repo"], {RECORD: json.dumps(record)})
    with pytest.raises(ValueError):
        usb.sync_baseline(histories["merged"], head, resolve=lambda tag: "a" * 40)


def test_main_prints_github_output_lines(histories, monkeypatch, capsys):
    monkeypatch.setattr(usb, "resolve_upstream_tag", lambda tag: histories["upstream"])
    assert usb.main(["--base", histories["fork"], "--head", histories["merged"]]) == 0
    assert capsys.readouterr().out.splitlines() == [f"commit={histories['upstream']}", "tag=v9.9.9"]


# --- the ratchet in sync mode ------------------------------------------------------------------


def test_upstream_code_blocks_against_the_fork_base_alone(histories, capsys):
    assert cli.run(histories["repo"], histories["fork"], histories["merged"]) == 1
    out = capsys.readouterr().out
    assert "pkg/a.py" in out and "pkg/up.py" in out


def test_code_merged_as_published_does_not_block_a_sync(histories, capsys):
    assert cli.run(histories["repo"], histories["fork"], histories["merged"],
                   upstream_base=histories["upstream"]) == 0
    assert "sync baseline" in capsys.readouterr().out


def test_code_new_against_both_bases_still_blocks_a_sync(histories, capsys):
    head = _commit(histories["repo"], {"pkg/new.py": _SWALLOW})
    assert cli.run(histories["repo"], histories["fork"], head, upstream_base=histories["upstream"]) == 1
    blocking = [line for line in capsys.readouterr().out.splitlines() if line.startswith("pkg/")]
    assert any(line.startswith("pkg/new.py") for line in blocking)


def test_union_growth_needs_a_reviewed_allowance(histories, capsys):
    repo, fork, upstream = histories["repo"], histories["fork"], histories["upstream"]
    head = _commit(repo, {"pkg/a.py": _UNION})
    assert cli.run(repo, fork, head, upstream_base=upstream) == 1
    capsys.readouterr()
    allow = [{"path": "pkg/a.py", "rule": "CC", "scope": "legacy", "why": "upstream growth plus the fork's patch"}]
    allowed = _commit(repo, {RECORD: _record("v9.9.9", upstream, allow)})
    assert cli.run(repo, fork, allowed, upstream_base=upstream) == 0
    assert "sync union: upstream growth plus the fork's patch" in capsys.readouterr().out


def test_an_allowance_without_a_reason_does_not_count(histories):
    repo, fork, upstream = histories["repo"], histories["fork"], histories["upstream"]
    _commit(repo, {"pkg/a.py": _UNION})
    head = _commit(repo, {RECORD: _record("v9.9.9", upstream, [{"path": "pkg/a.py", "rule": "CC", "scope": "legacy", "why": ""}])})
    assert cli.run(repo, fork, head, upstream_base=upstream) == 1


def test_allowances_only_excuse_findings_that_also_block_upstream():
    finding = Finding(path="p.py", rule="CC", scope="f", line=3, detail="CC 30 > 20")
    upstream_same = Finding(path="p.py", rule="CC", scope="f", line=3, detail="CC 30 > 25")
    cli.excuse_upstream([finding], [upstream_same], "u" * 40, {})
    assert finding.allowed_reason is None
    cli.excuse_upstream([finding], [upstream_same], "u" * 40, {("p.py", "CC", "f"): "why"})
    assert finding.allowed_reason == "sync union: why"


# --- this tree's record -------------------------------------------------------------------------


def test_the_committed_record_is_well_formed_and_reviewed():
    record = json.loads((REPO / RECORD).read_text(encoding="utf-8"))
    assert usb._TAG.match(record["tag"]) and usb._SHA.match(record["commit"])
    for entry in record["health_allow"]:
        assert entry["why"].strip(), entry
        assert (REPO / entry["path"]).is_file(), f"health_allow names a missing file: {entry}"


def test_the_committed_record_names_a_merged_commit_when_history_has_it():
    record = json.loads((REPO / RECORD).read_text(encoding="utf-8"))
    present = subprocess.run(["git", "cat-file", "-e", f"{record['commit']}^{{commit}}"], cwd=REPO,
                             capture_output=True, timeout=60, check=False).returncode == 0
    if not present:
        pytest.skip("the recorded upstream commit is not in this clone")
    merged = subprocess.run(["git", "merge-base", "--is-ancestor", record["commit"], "HEAD"], cwd=REPO,
                            capture_output=True, timeout=60, check=False)
    assert merged.returncode == 0, f"{record['tag']} is recorded but not merged into HEAD"


def test_the_detector_runs_on_a_bare_python():
    """Workflows run it with the runner's python3 before any setup: stdlib imports only."""
    proc = subprocess.run([sys.executable, "-I", "-S", str(REPO / "scripts/ci/upstream_sync_baseline.py"), "--help"],
                          capture_output=True, text=True, timeout=60, check=False)
    assert proc.returncode == 0, proc.stderr
