"""Execute the actual CI gate, including its shell and GitHub output contract."""

import json
import os
import subprocess
from pathlib import Path

import pytest
import yaml


WORKFLOW = Path(__file__).resolve().parents[2] / ".github/workflows/ci.yaml"


@pytest.mark.parametrize(
    ("results", "exit_code"),
    [
        ({"detect": "success", "js-tests": "success", "tests": "skipped"}, 0),
        ({"detect": "cancelled", "js-tests": "skipped"}, 1),
        ({"detect": "failure", "js-tests": "skipped"}, 1),
        ({"detect": "skipped", "js-tests": "skipped"}, 1),
        ({"js-tests": "skipped"}, 1),
        ({"detect": "success", "js-tests": "cancelled"}, 1),
        ({"detect": "success", "js-tests": "failure"}, 1),
        ({"detect": "success", "js-tests": "unknown"}, 1),
    ],
)
def test_gate_requires_completed_detection_and_no_unfinished_jobs(tmp_path, results, exit_code):
    gate = yaml.safe_load(WORKFLOW.read_text())["jobs"]["all-checks-pass"]
    assert "detect" in gate["needs"]
    assert gate["if"] == "always()"
    step = next(step for step in gate["steps"] if step.get("id") == "evaluate")
    output = tmp_path / "github-output"
    result = subprocess.run(
        ["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", step["run"]],
        env={
            **os.environ,
            "NEEDS": json.dumps({name: {"result": value} for name, value in results.items()}),
            "GITHUB_OUTPUT": str(output),
        },
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == exit_code, result.stdout + result.stderr
    # Even a rejected run must keep reporting its real results to the review UI.
    assert json.loads(output.read_text().removeprefix("needs-json=")) == results


def test_classifier_checkout_includes_both_local_action_and_script(tmp_path):
    detect = yaml.safe_load(WORKFLOW.read_text())["jobs"]["detect"]
    checkout, classify = detect["steps"]
    action = yaml.safe_load(
        (WORKFLOW.parents[2] / ".github/actions/detect-changes/action.yml").read_text()
    )
    assert set(classify["with"]) <= set(action["inputs"])
    assert 5 <= detect["timeout-minutes"] <= 10
    # Ask git to interpret the actual non-cone patterns; an action omitted from
    # a sparse checkout cannot be loaded, even if the classifier file exists.
    patterns = checkout["with"]["sparse-checkout"]
    assert checkout["with"]["sparse-checkout-cone-mode"] is False
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    subprocess.run(["git", "-C", str(tmp_path), "sparse-checkout", "set", "--no-cone", "--stdin"],
                   input=patterns, text=True, check=True)
    paths = ".github/actions/detect-changes/action.yml\nscripts/ci/classify_changes.py\napps/desktop/package.json\n"
    matched = subprocess.run(
        ["git", "-C", str(tmp_path), "sparse-checkout", "check-rules"],
        input=paths, capture_output=True, text=True, check=True,
    )
    assert matched.stdout.splitlines() == paths.splitlines()[:2]
