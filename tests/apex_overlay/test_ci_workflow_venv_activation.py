"""ApexNodes hc-911: a workflow step may only activate a .venv that its own job created.

v0.22's setup-pm exports the test environment (HERMES_PYTHON / VIRTUAL_ENV) and no longer
creates .venv. The fork's sliced test job still ran `source .venv/bin/activate`, so every slice
exited before running a single test (PR #390's first CI run). This walks every job in every
workflow: each activation needs an earlier step of the same job that builds the .venv.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

import hermes_yaml as yaml

WORKFLOWS = Path(__file__).resolve().parents[2] / ".github/workflows"
_CREATES = re.compile(r"(uv venv|python3? -m venv|virtualenv)\s+\S*\.venv|uv sync|UV_PROJECT_ENVIRONMENT=\.venv")


def _step_text(step: dict) -> str:
    return f"{step.get('run', '')}\n{(step.get('with') or {}).get('command', '')}"


def _activations() -> list[tuple[str, str, int, bool]]:
    found = []
    for path in sorted(WORKFLOWS.glob("*.y*ml")):
        doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        for job_name, job in (doc.get("jobs") or {}).items():
            created = False
            for index, step in enumerate((job or {}).get("steps") or []):
                text = _step_text(step)
                created = created or bool(_CREATES.search(text))
                if ".venv/bin/activate" in text:
                    found.append((path.name, job_name, index, created))
    return found


def test_the_walk_sees_the_upstream_jobs_that_build_their_own_venv():
    assert any(name == "tests.yml" and job == "e2e-upgrade" for name, job, _, _ in _activations())


@pytest.mark.parametrize("workflow, job, index, created", _activations(), ids=lambda v: str(v))
def test_every_activation_follows_a_step_that_builds_the_venv(workflow, job, index, created):
    assert created, f"{workflow}:{job} step {index} activates .venv, which nothing in the job creates"
