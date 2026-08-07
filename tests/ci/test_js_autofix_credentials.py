from __future__ import annotations

from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "js-autofix.yml"


def test_privileged_autofix_steps_require_an_app_token() -> None:
    workflow = yaml.safe_load(WORKFLOW_PATH.read_text(encoding="utf-8"))
    steps = workflow["jobs"]["apply-patch"]["steps"]
    by_name = {step["name"]: step for step in steps if "name" in step}

    assert (
        by_name["Skip publishing without GitHub App credentials"]["if"]
        == "steps.app-token.outputs.using-app-token != 'true'"
    )
    for name in (
        "Download patch",
        "Apply patch and push to bot branch",
        "Create/update PR and enable auto-merge",
        "Wait for merge, auto-close on failure or stale",
    ):
        assert by_name[name]["if"] == "steps.app-token.outputs.using-app-token == 'true'"
