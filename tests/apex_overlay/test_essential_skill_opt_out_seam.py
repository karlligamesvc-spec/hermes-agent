"""hc-1275: with the seam, an essential skill that config.yaml lists in skills.disabled is not listed either.

APEX Desktop lists hermes-agent among its default-off skills, and cli-config.yaml.example carries the same
list as the Desktop seed. The engine alone keeps listing hermes-agent (it is essential) while skill_view
refuses it. apex_overlay/essential_skill_opt_out.py makes the listings agree with the refusal. Each
behaviour has a control: the engine alone, or a config that does not name the skill, which is the cloud's
shape.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

import hermes_yaml as yaml
from agent import curator, prompt_builder, skill_utils
from apex_overlay import essential_skill_opt_out
from hermes_cli import skills_config
from hermes_cli.config import load_config
from tools.skills_sync import sync_skills
from tools.skills_tool import skill_view

_EXAMPLE = Path(__file__).resolve().parents[2] / "cli-config.yaml.example"
_NAME = "hermes-agent"
_POINTER = "skill_view(name='hermes-agent')"
_REPLACED = ((skill_utils, "get_disabled_skill_names"), (prompt_builder, "get_disabled_skill_names"),
             (curator, "get_disabled_skill_names"), (skills_config, "get_disabled_skills"),
             (skills_config, "save_disabled_skills"))


def _example_disabled() -> list[str]:
    return yaml.safe_load(_EXAMPLE.read_text(encoding="utf-8"))["skills"]["disabled"]


def _write_skills_config(skills: dict) -> None:
    (Path(os.environ["HERMES_HOME"]) / "config.yaml").write_text(yaml.safe_dump({"skills": skills}), encoding="utf-8")


def _indexed() -> bool:
    return f"- {_NAME}:" in prompt_builder.build_skills_system_prompt(available_tools={"skill_view", "skills_list"})


def _loads() -> bool:
    return json.loads(skill_view(_NAME))["success"] is True


def _help_tier() -> str:
    """The stable tier of a Desktop session that has the skills toolset, as the engine builds it."""
    from agent.system_prompt import build_system_prompt_parts
    from run_agent import AIAgent

    agent = AIAgent(api_key="test-key", base_url="https://openrouter.ai/api/v1", model="test/model",
                    provider="openrouter", platform="desktop", quiet_mode=True, skip_memory=True,
                    enabled_toolsets=["skills"], session_id="hc-1275-help")
    return build_system_prompt_parts(agent)["stable"]


@pytest.fixture
def restored(monkeypatch):
    """Whatever the seam replaces comes back after the test."""
    for module, name in _REPLACED:
        monkeypatch.setattr(module, name, getattr(module, name))


@pytest.fixture
def applied(restored):
    assert essential_skill_opt_out.apply() is True


@pytest.fixture
def synced():
    sync_skills(quiet=True)


def test_the_example_lists_hermes_agent():
    assert _NAME in _example_disabled()


def test_control_the_engine_alone_lists_it_and_points_at_it_while_skill_view_refuses(synced):
    _write_skills_config({"disabled": _example_disabled()})

    assert _indexed()
    assert not _loads()
    assert _POINTER in _help_tier()


def test_with_the_seam_the_desktop_list_keeps_it_out_of_the_index_and_the_help_line(applied, synced):
    _write_skills_config({"disabled": _example_disabled()})

    assert _NAME in skill_utils.get_disabled_skill_names()
    assert not _indexed()
    assert not _loads()
    assert _POINTER not in _help_tier()


def test_the_copies_bound_at_import_are_the_patched_function(applied):
    assert prompt_builder.get_disabled_skill_names is skill_utils.get_disabled_skill_names
    assert curator.get_disabled_skill_names is skill_utils.get_disabled_skill_names


def test_control_a_list_without_it_the_cloud_shape_keeps_it_listed_and_loadable(applied, synced):
    _write_skills_config({"disabled": [name for name in _example_disabled() if name != _NAME]})

    assert _indexed()
    assert _loads()
    assert _POINTER in _help_tier()


@pytest.mark.parametrize(("platform", "listed"), [("desktop", False), ("cli", True)])
def test_a_platform_list_counts_for_that_platform_only_as_the_refusal_does(applied, synced, monkeypatch,
                                                                           platform, listed):
    monkeypatch.setenv("HERMES_PLATFORM", platform)
    _write_skills_config({"disabled": [], "platform_disabled": {"desktop": [_NAME]}})

    assert _indexed() is listed
    assert _loads() is listed


def test_settings_reports_it_off_and_toggling_another_skill_keeps_it_in_config(applied):
    _write_skills_config({"disabled": _example_disabled()})
    config = load_config()

    disabled = skills_config.get_disabled_skills(config)
    disabled.discard("notion")
    skills_config.save_disabled_skills(config, disabled)

    saved = load_config()["skills"]["disabled"]
    assert _NAME in disabled
    assert _NAME in saved
    assert "notion" not in saved


def test_control_the_engine_alone_drops_it_from_config_on_any_toggle():
    _write_skills_config({"disabled": _example_disabled()})
    config = load_config()

    disabled = skills_config.get_disabled_skills(config)
    disabled.discard("notion")
    skills_config.save_disabled_skills(config, disabled)

    assert _NAME not in disabled
    assert _NAME not in load_config()["skills"]["disabled"]


def test_turning_it_on_in_settings_still_works(applied):
    _write_skills_config({"disabled": _example_disabled()})
    config = load_config()

    disabled = skills_config.get_disabled_skills(config)
    disabled.discard(_NAME)
    skills_config.save_disabled_skills(config, disabled)

    assert _NAME not in load_config()["skills"]["disabled"]


def test_applying_twice_wraps_once(applied):
    first = skill_utils.get_disabled_skill_names
    assert essential_skill_opt_out.apply() is True

    assert skill_utils.get_disabled_skill_names is first
    engine_function = getattr(first, essential_skill_opt_out._ORIGINAL)
    assert getattr(engine_function, essential_skill_opt_out._ORIGINAL, None) is None


def test_a_missing_engine_helper_reports_false_and_keeps_the_engine_list(restored, monkeypatch):
    monkeypatch.delattr(skill_utils, "_skills_cfg")
    before = {(module.__name__, name): getattr(module, name) for module, name in _REPLACED}

    assert essential_skill_opt_out.apply() is False
    assert skill_utils.get_disabled_skill_names is before[("agent.skill_utils", "get_disabled_skill_names")]
    assert prompt_builder.get_disabled_skill_names is before[("agent.prompt_builder", "get_disabled_skill_names")]


def test_plugin_register_applies_the_seam():
    from tests.apex_overlay.conftest import run_plugin_register_with_stubbed_seams

    assert "essential_skill_opt_out" in run_plugin_register_with_stubbed_seams("_essential_opt_out_plugin_under_test")
