"""hc-1275: the engine with APEX's default-off skill list, for the three names added after 0.18.2.

APEX Desktop seeds and heals ``skills.disabled`` from ``SEED_DISABLED_SKILLS``
(apps/desktop/electron/apex-managed.ts), and cli-config.yaml.example carries the same list name by name
(apex-disabled-toolsets.test.ts). These tests read the list from the example and run the engine with it:

* ``github``: upstream folded the five github-* skills into it. The engine bundles it, so the bundled-skills
  sync puts it in every home, and it was on: the list named only the five old skills.
* ``godmode`` / ``obliteratus``: the engine no longer bundles them (they sit in optional-skills/), but
  ``hermes skills install official/<category>/<name>`` installs them from the engine's own folder without
  any network, and an installed skill is on unless the list names it. On Desktop the approval rule in
  apex_overlay/install_approval.py asks before that command runs; the list keeps the skill off afterwards.

Each case has a control: with an empty list, the same home lists the skill in the prompt's skill index and
skill_view loads it.
"""

from __future__ import annotations

import io
import json
import os
from pathlib import Path

import pytest
from rich.console import Console

import hermes_yaml as yaml
from agent.prompt_builder import build_skills_system_prompt
from hermes_cli.skills_hub import do_install
from tools.skills_sync import sync_skills
from tools.skills_tool import skill_view

_EXAMPLE = Path(__file__).resolve().parents[2] / "cli-config.yaml.example"
_NAMES = ("github", "godmode", "obliteratus")
_OFFICIAL = {"godmode": "official/security/godmode", "obliteratus": "official/mlops/obliteratus"}


def _example_disabled_skills() -> list[str]:
    return yaml.safe_load(_EXAMPLE.read_text(encoding="utf-8"))["skills"]["disabled"]


def _write_config(disabled: list[str]) -> None:
    config = {"skills": {"disabled": disabled}}
    (Path(os.environ["HERMES_HOME"]) / "config.yaml").write_text(yaml.safe_dump(config), encoding="utf-8")


def _bring_in(name: str) -> None:
    """How the skill reaches a Desktop home: the bundled-skills sync for github, the official install otherwise."""
    if name == "github":
        sync_skills(quiet=True)
        return
    assert do_install(_OFFICIAL[name], console=Console(file=io.StringIO()), skip_confirm=True) is True


def _indexed(name: str) -> bool:
    return f"- {name}:" in build_skills_system_prompt(available_tools={"skill_view", "skills_list"})


def test_the_example_lists_the_three_names():
    assert set(_NAMES) <= set(_example_disabled_skills())


@pytest.mark.parametrize("name", _NAMES)
def test_with_the_apex_list_the_skill_is_neither_indexed_nor_loaded(name):
    _write_config(_example_disabled_skills())
    _bring_in(name)

    result = json.loads(skill_view(name))

    assert not _indexed(name)
    assert result["success"] is False
    assert f"Skill '{name}' is disabled" in result["error"]


@pytest.mark.parametrize("name", _NAMES)
def test_control_with_an_empty_list_the_same_skill_is_indexed_and_loads(name):
    _write_config([])
    _bring_in(name)

    assert _indexed(name)
    assert json.loads(skill_view(name))["success"] is True
