from __future__ import annotations

import os
from pathlib import Path
import subprocess

import pytest
import yaml


REPO_ROOT = Path(__file__).resolve().parents[2]
ACTION_PATH = REPO_ROOT / ".github" / "actions" / "get-app-token" / "action.yml"


def _credential_check_step() -> dict:
    action = yaml.safe_load(ACTION_PATH.read_text(encoding="utf-8"))
    return next(
        step
        for step in action["runs"]["steps"]
        if step.get("name") == "Check if App credentials exist"
    )


@pytest.mark.parametrize(
    ("client_id", "private_key", "expected"),
    [
        ("client-id", "private-key", "true"),
        ("client-id", "", "false"),
        ("", "private-key", "false"),
        ("", "", "false"),
    ],
)
def test_app_token_requires_complete_credential_pair(
    tmp_path: Path, client_id: str, private_key: str, expected: str
) -> None:
    step = _credential_check_step()
    assert set(step["env"]) >= {"CLIENT_ID", "PRIVATE_KEY"}

    output_path = tmp_path / "github-output"
    env = {
        **os.environ,
        "CLIENT_ID": client_id,
        "PRIVATE_KEY": private_key,
        "GITHUB_OUTPUT": str(output_path),
    }
    subprocess.run(
        ["bash", "-eu", "-o", "pipefail", "-c", step["run"]],
        check=True,
        cwd=REPO_ROOT,
        env=env,
    )

    assert output_path.read_text(encoding="utf-8") == f"has_app={expected}\n"
