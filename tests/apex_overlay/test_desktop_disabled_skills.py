"""hc-1275 / hc-1293: the engine with APEX's default-off skill list, for the four names added after 0.18.2.

APEX Desktop seeds and heals ``skills.disabled`` from ``SEED_DISABLED_SKILLS``
(apps/desktop/electron/apex-managed.ts), and cli-config.yaml.example carries the same list name by name
(apex-disabled-toolsets.test.ts). These tests read the list from the example and run the engine with it:

* ``github``: upstream folded the five github-* skills into it. The engine bundles it, so the bundled-skills
  sync puts it in every home, and it was on: the list named only the five old skills.
* ``godmode`` / ``obliteratus``: the engine no longer bundles them (they sit in optional-skills/), but
  ``hermes skills install official/<category>/<name>`` installs them from the engine's own folder without
  any network, and an installed skill is on unless the list names it. On Desktop the approval rule in
  apex_overlay/install_approval.py asks before that command runs; the list keeps the skill off afterwards.
* ``humanizer`` (hc-1293): bundled, so in every home, and on. Upstream's 2.5.1 examples teach the model to
  add what the draft never said: a 2024 New York Times interview, a 2019 survey, founding years, a Google
  study at 55%. APEX polishes with its platform skill text-polish, whose rules forbid that. The list keeps
  humanizer off while the bundled copy still teaches it; text-polish's English rules file carries
  ``name: humanizer`` in its own frontmatter, and the list must not reach it.

Each case has a control: with an empty list, the same home lists the skill in the prompt's skill index and
skill_view loads it.
"""

from __future__ import annotations

import io
import json
import os
import re
from itertools import pairwise
from pathlib import Path

import pytest
from rich.console import Console

import hermes_yaml as yaml
from agent.prompt_builder import build_skills_system_prompt
from hermes_cli.skills_hub import do_install
from tools.skills_sync import sync_skills
from tools.skills_tool import skill_view

_ROOT = Path(__file__).resolve().parents[2]
_EXAMPLE = _ROOT / "cli-config.yaml.example"
_HUMANIZER = _ROOT / "skills" / "creative" / "humanizer" / "SKILL.md"
_NAMES = ("github", "godmode", "obliteratus", "humanizer")
_BUNDLED = {"github", "humanizer"}
_OFFICIAL = {"godmode": "official/security/godmode", "obliteratus": "official/mlops/obliteratus"}


def _example_disabled_skills() -> list[str]:
    return yaml.safe_load(_EXAMPLE.read_text(encoding="utf-8"))["skills"]["disabled"]


def _write_config(disabled: list[str]) -> None:
    config = {"skills": {"disabled": disabled}}
    (Path(os.environ["HERMES_HOME"]) / "config.yaml").write_text(yaml.safe_dump(config), encoding="utf-8")


def _bring_in(name: str) -> None:
    """How the skill reaches a Desktop home: the bundled-skills sync for github and humanizer, the official
    install otherwise."""
    if name in _BUNDLED:
        sync_skills(quiet=True)
        return
    assert do_install(_OFFICIAL[name], console=Console(file=io.StringIO()), skip_confirm=True) is True


def _indexed(name: str) -> bool:
    return f"- {name}:" in build_skills_system_prompt(available_tools={"skill_view", "skills_list"})


def test_the_example_lists_the_four_names():
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


# ── humanizer (hc-1293) ────────────────────────────────────────────────────────

_LABEL = re.compile(r"^\*\*(Before|After|Draft rewrite|Final rewrite)\b[^*]*:\*\*\s*$")
_DIGITS = re.compile(r"\d+")


def _rewrites(text: str) -> list[tuple[str, str]]:
    """(original, rewrite) for every example: each **Before** quote block with the next labelled block."""
    blocks: list[tuple[str, str]] = []
    label, quote = None, []
    for line in [*text.splitlines(), "**End:**"]:
        if line.startswith(">"):
            quote.append(line.lstrip("> ").strip())
            continue
        if not line.strip() and quote:
            continue
        if label and quote:
            blocks.append((label, " ".join(quote)))
        label, quote = None, []
        if m := _LABEL.match(line):
            label = m.group(1)
    return [(before, after) for (kind, before), (_next, after) in pairwise(blocks) if kind == "Before"]


def _added_numbers(before: str, after: str) -> list[str]:
    known = set(_DIGITS.findall(before))
    return sorted({n for n in _DIGITS.findall(after) if n not in known})


def _inventing_examples(text: str) -> dict[str, list[str]]:
    return {after[:60]: added for before, after in _rewrites(text) if (added := _added_numbers(before, after))}


def test_the_detector_flags_an_added_year_and_passes_a_faithful_rewrite():
    taught = ("**Before:**\n> It was set up sometime in the 1990s.\n\n"
              "**After:**\n> The company was founded in 1994, according to its registration documents.\n")
    faithful = ("**Before:**\n> Sales grew 12% in 2023, a pivotal testament to our vision.\n\n"
                "**After:**\n> Sales grew 12% in 2023.\n")

    assert list(_inventing_examples(taught).values()) == [["1994"]]
    assert _inventing_examples(faithful) == {}


def test_humanizer_stays_off_while_the_bundled_copy_teaches_adding_facts():
    inventing = _inventing_examples(_HUMANIZER.read_text(encoding="utf-8"))

    assert len(_rewrites(_HUMANIZER.read_text(encoding="utf-8"))) >= 20
    assert inventing, (
        "The bundled humanizer no longer adds numbers its originals lack. Re-read its examples; if they now "
        "keep to the draft, decide with the product owner whether humanizer can come off skills.disabled."
    )
    assert "humanizer" in _example_disabled_skills(), inventing


def _install_text_polish() -> Path:
    """The platform skill's shape on Desktop: its English rules file has ``name: humanizer`` frontmatter."""
    skill = Path(os.environ["HERMES_HOME"]) / "skills" / "apexnodes" / "text-polish"
    (skill / "references").mkdir(parents=True)
    (skill / "SKILL.md").write_text(
        "---\nname: text-polish\ndescription: Polish copy without adding facts.\nversion: 2.2.0\n---\n\n"
        "Read references/english.md for English copy.\n", encoding="utf-8")
    (skill / "references" / "english.md").write_text(
        "---\nname: humanizer\ndescription: English rules.\n---\n\nDo not make anything up.\n", encoding="utf-8")
    return skill


def test_with_humanizer_off_text_polish_and_its_english_rules_still_load():
    _write_config(_example_disabled_skills())
    _install_text_polish()

    skill = json.loads(skill_view("text-polish"))
    rules = json.loads(skill_view("text-polish", file_path="references/english.md"))

    assert _indexed("text-polish")
    assert skill["success"] is True, skill
    assert rules["success"] is True, rules
    assert "Do not make anything up." in rules["content"]
