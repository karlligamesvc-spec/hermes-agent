"""ApexNodes hc-911: the supply-chain scan judges an upstream-sync PR on its own lines only.

Replays the workflow's real "Scan diff for critical patterns" step against fixture histories.
The detector (scripts/ci/upstream_sync_baseline.py, tested on its own) is stubbed to answer the
verified release, so this pins the step's filter: a flagged line the release brought in as
published passes, while the same pattern written by the PR itself, or any flagged line in an
ordinary PR, still fails the scan.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

import hermes_yaml as yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/supply-chain-audit.yml"
# Built in pieces so no line of THIS file matches the scan it tests (the scan runs on this PR too).
_DECODE = "base64." + "b64decode"
FLAGGED = f"exec({_DECODE}(payload))\n"


def _step_text() -> str:
    for job in yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))["jobs"].values():
        for step in job.get("steps") or []:
            if step.get("name") == "Scan diff for critical patterns":
                return step["run"]
    raise LookupError("scan step")


def _git(repo: Path, *args: str) -> str:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")
    return subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", *args], cwd=repo, env=env,
                          check=True, capture_output=True, text=True, timeout=60).stdout.strip()


def _commit(repo: Path, files: dict[str, str]) -> str:
    for rel, text in files.items():
        (repo / rel).parent.mkdir(parents=True, exist_ok=True)
        (repo / rel).write_text(text, encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "step")
    return _git(repo, "rev-parse", "HEAD")


def _scan(tmp_path: Path, repo: Path, base: str, head: str, upstream: str | None) -> str:
    detector = repo / "scripts/ci/upstream_sync_baseline.py"
    detector.parent.mkdir(parents=True, exist_ok=True)
    detector.write_text(f"print('commit={upstream}')\n" if upstream else "\n", encoding="utf-8")
    findings = tmp_path / "findings.md"
    text = (_step_text()
            .replace("${{ github.event.pull_request.base.sha }}", base)
            .replace("${{ github.event.pull_request.head.sha }}", head)
            .replace("/tmp/findings.md", str(findings)))
    script = tmp_path / "scan.sh"
    script.write_text(text, encoding="utf-8")
    output = tmp_path / "gh-output.txt"
    output.write_text("", encoding="utf-8")
    proc = subprocess.run(["bash", str(script)], cwd=repo, env={**os.environ, "GITHUB_OUTPUT": str(output)},
                          capture_output=True, text=True, timeout=120, check=False)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    return output.read_text(encoding="utf-8")


@pytest.fixture
def sync(tmp_path):
    """root -> fork base and an upstream release that adds a flagged line; head merges it."""
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-qb", "main")
    _commit(repo, {"app.py": "x = 1\n"})
    _git(repo, "checkout", "-qb", "upstream")
    upstream = _commit(repo, {"launcher.py": "import base64\n" + FLAGGED})
    _git(repo, "checkout", "-q", "main")
    base = _commit(repo, {"fork.py": "y = 1\n"})
    _git(repo, "merge", "-q", "--no-ff", "--no-edit", "upstream")
    return {"tmp": tmp_path, "repo": repo, "base": base, "upstream": upstream, "head": _git(repo, "rev-parse", "HEAD")}


def test_a_flagged_line_merged_as_published_passes_a_sync_pr(sync):
    assert "found=false" in _scan(sync["tmp"], sync["repo"], sync["base"], sync["head"], sync["upstream"])


def test_the_same_line_written_by_the_sync_pr_itself_still_fails(sync):
    # Byte-identical to the release's line, but in the PR's own file: new against the release too.
    head = _commit(sync["repo"], {"apex.py": "import base64\npayload = ''\n" + FLAGGED})
    assert "found=true" in _scan(sync["tmp"], sync["repo"], sync["base"], head, sync["upstream"])


def test_an_ordinary_pr_is_scanned_in_full(sync):
    assert "found=true" in _scan(sync["tmp"], sync["repo"], sync["base"], sync["head"], None)
