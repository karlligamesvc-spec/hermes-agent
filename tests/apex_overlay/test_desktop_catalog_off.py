"""hc-1275: with APEX's config, a Desktop session carries no manage_catalog.

APEX Desktop seeds and heals ``agent.disabled_toolsets: [catalog]``
(apps/desktop/electron/apex-disabled-toolsets.ts), and cli-config.yaml.example carries the same list
for the CLI path. These tests read the list from the example and run the engine's real Desktop
toolset resolution with it: the tui_gateway fold-in with the tools the agent is built with, and the
gateway session policy for a GUI client. Each has a control showing the same probe sees
manage_catalog when nothing disables it.
"""

from __future__ import annotations

import os
from pathlib import Path

from gateway import session_policy
import hermes_yaml as yaml
import model_tools
import tui_gateway.agent_factory as factory
from hermes_cli.config import load_config

_EXAMPLE = Path(__file__).resolve().parents[2] / "cli-config.yaml.example"
_SURFACE = ["memory", "web"]


def _example_disabled_toolsets() -> list[str]:
    return yaml.safe_load(_EXAMPLE.read_text(encoding="utf-8"))["agent"]["disabled_toolsets"]


def _write_config(disabled: list[str]) -> None:
    config = {"agent": {"disabled_toolsets": disabled}}
    (Path(os.environ["HERMES_HOME"]) / "config.yaml").write_text(yaml.safe_dump(config), encoding="utf-8")


def _tool_names(enabled, disabled) -> set[str]:
    tools = model_tools.get_tool_definitions(enabled_toolsets=enabled, disabled_toolsets=disabled,
                                             quiet_mode=True, skip_tool_search_assembly=True)
    return {tool["function"]["name"] for tool in tools}


def test_the_example_disables_the_catalog_toolset():
    assert _example_disabled_toolsets() == ["catalog"]


def test_the_desktop_session_built_from_that_config_has_no_manage_catalog():
    _write_config(_example_disabled_toolsets())

    disabled = factory._load_disabled_toolsets()
    enabled = factory._with_session_toolsets(_SURFACE, "desktop")

    assert disabled == ["catalog"]
    assert "catalog" not in enabled
    assert "manage_catalog" not in _tool_names(enabled, disabled)


def test_control_nothing_disabled_the_desktop_session_carries_manage_catalog():
    _write_config([])

    enabled = factory._with_session_toolsets(_SURFACE, "desktop")

    assert "catalog" in enabled
    assert "manage_catalog" in _tool_names(enabled, factory._load_disabled_toolsets())


def test_a_gui_session_through_the_gateway_policy_drops_it_too():
    _write_config(_example_disabled_toolsets())
    assert "catalog" not in session_policy._resolve_toolsets({}, load_config(), "gui", False)

    _write_config([])
    assert "catalog" in session_policy._resolve_toolsets({}, load_config(), "gui", False)
