"""hc-1275, hc-1294: the engine with APEX's default-off skill list, for the names added after 0.18.2.

APEX Desktop seeds and heals ``skills.disabled`` from ``SEED_DISABLED_SKILLS``
(apps/desktop/electron/apex-managed.ts), and cli-config.yaml.example carries the same list name by name
(apex-disabled-toolsets.test.ts). These tests read the list from the example and run the engine with it:

* ``github``: upstream folded the five github-* skills into it. The engine bundles it, so the bundled-skills
  sync puts it in every home, and it was on: the list named only the five old skills.
* ``godmode`` / ``obliteratus``: the engine no longer bundles them (they sit in optional-skills/), but
  ``hermes skills install official/<category>/<name>`` installs them from the engine's own folder without
  any network, and an installed skill is on unless the list names it. On Desktop the approval rule in
  apex_overlay/install_approval.py asks before that command runs; the list keeps the skill off afterwards.
* hc-1294's five, bundled since 0.17.31 and on until now: ``blocked-page-recovery`` (archive.org and
  archive.today are blocked in mainland China), ``weekly-review-planning`` (its sources are all off here),
  ``email-inbox-triage`` (its mail connectors are off), ``meeting-action-items`` and
  ``document-to-action-items`` (the platform's meeting-summary / document-summary do the same).

Each case has a control: with an empty list, the same home lists the skill in the prompt's skill index and
skill_view loads it.

``sdlc-review`` is the one hc-1294 keeps off the list on purpose: the kanban review lane force-loads it, and a
listed skill counts as missing there. The last two tests run that lane's skill check with and without it.
"""

from __future__ import annotations

import io
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest
from rich.console import Console

import hermes_yaml as yaml
from agent.prompt_builder import build_skills_system_prompt
from gateway.session_kanban import _run_task_turns
from hermes_cli.skills_hub import do_install
from tools.skills_sync import sync_skills
from tools.skills_tool import skill_view

_EXAMPLE = Path(__file__).resolve().parents[2] / "cli-config.yaml.example"
_NAMES = (
    "github", "godmode", "obliteratus",
    "blocked-page-recovery", "weekly-review-planning", "email-inbox-triage", "meeting-action-items",
    "document-to-action-items",
)
_OFFICIAL = {"godmode": "official/security/godmode", "obliteratus": "official/mlops/obliteratus"}


def _example_disabled_skills() -> list[str]:
    return yaml.safe_load(_EXAMPLE.read_text(encoding="utf-8"))["skills"]["disabled"]


def _write_config(disabled: list[str]) -> None:
    config = {"skills": {"disabled": disabled}}
    (Path(os.environ["HERMES_HOME"]) / "config.yaml").write_text(yaml.safe_dump(config), encoding="utf-8")


def _bring_in(name: str) -> None:
    """How the skill reaches a Desktop home: the bundled-skills sync, or the official install for the two
    the engine no longer bundles."""
    if name not in _OFFICIAL:
        sync_skills(quiet=True)
        return
    assert do_install(_OFFICIAL[name], console=Console(file=io.StringIO()), skip_confirm=True) is True


def _indexed(name: str) -> bool:
    return f"- {name}:" in build_skills_system_prompt(available_tools={"skill_view", "skills_list"})


def test_the_example_lists_the_names_added_after_0182():
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


class _AskedTheModel(Exception):
    """The stub agent's answer: the lane got past its skill check."""


def _review_turn(disabled: list[str]) -> list[str]:
    """One kanban review turn (the dispatcher adds sdlc-review to every review card) up to the model call;
    returns the prompts the model was asked."""
    _write_config(disabled)
    sync_skills(quiet=True)
    prompts: list[str] = []

    def run_conversation(prompt, **_):
        prompts.append(prompt)
        raise _AskedTheModel

    agent = SimpleNamespace(session_id="review-turn", run_conversation=run_conversation)
    try:
        _run_task_turns(agent, {"text": "review t_1"}, [], {"skills": ["sdlc-review"], "context": ""})
    except _AskedTheModel:
        pass
    return prompts


def test_with_the_apex_list_a_kanban_review_turn_still_loads_sdlc_review():
    assert "sdlc-review" not in _example_disabled_skills()

    prompts = _review_turn(_example_disabled_skills())

    assert len(prompts) == 1
    assert '"sdlc-review" skill' in prompts[0]


def test_control_with_sdlc_review_listed_the_review_turn_stops_before_the_model():
    with pytest.raises(ValueError, match="kanban_skills_unavailable"):
        _review_turn([*_example_disabled_skills(), "sdlc-review"])
