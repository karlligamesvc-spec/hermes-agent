"""hc-941: a plugin tool's registered budget is the deadline the sequential executor arms.

APEX Desktop 0.17.58 cut media_transcribe at the executor's shared 420 s deadline although
the douyin plugin waits up to 2h10m for ASR: plugins had no way to declare their own budget.
``PluginContext.register_tool(execution_timeout=...)`` now carries it into the registry
entry, and ``execute_tool_calls_sequential`` arms that budget for the call, both when the
model calls the tool directly and through the ``tool_call`` bridge (which the executor
unwraps before the deadline is armed). A tool without a budget keeps the shared deadline.

The deadline is read where the executor arms it (``_poll_sequential_future``), so these
tests need no sleeps; tests/agent/test_sequential_tool_timeout.py covers the expiry itself.
"""

import json
from types import SimpleNamespace
from unittest.mock import patch

import hermes_yaml as yaml
import pytest

from agent import tool_executor
from agent.tool_executor import execute_tool_calls_sequential
from tests.agent.test_sequential_tool_timeout import _make_agent
from tools.registry import registry

BUDGET_PROBE = "hc941_budget_probe"
PLAIN_PROBE = "hc941_plain_probe"
PROBE_BUDGET_S = 900.0
SHARED_DEADLINE_S = 1.0

_PLUGIN_SOURCE = f'''
_SCHEMA = {{"type": "object", "properties": {{}}}}


def register(ctx):
    ctx.register_tool(
        name="{BUDGET_PROBE}",
        toolset="plugin_hc941_probe",
        schema={{"name": "{BUDGET_PROBE}", "description": "slow probe", "parameters": _SCHEMA}},
        handler=lambda args, **kw: "unused",
        execution_timeout={PROBE_BUDGET_S},
    )
    ctx.register_tool(
        name="{PLAIN_PROBE}",
        toolset="plugin_hc941_probe",
        schema={{"name": "{PLAIN_PROBE}", "description": "plain probe", "parameters": _SCHEMA}},
        handler=lambda args, **kw: "unused",
    )
'''


@pytest.fixture
def probe_plugin(tmp_path, monkeypatch):
    """Load the probe tools through a real PluginManager, the path the douyin plugin takes."""
    from hermes_cli.plugins import PluginManager

    hermes_home = tmp_path / "hermes_home"
    plugin_dir = hermes_home / "plugins" / "hc941_probe"
    plugin_dir.mkdir(parents=True)
    (plugin_dir / "plugin.yaml").write_text(yaml.safe_dump({"name": "hc941_probe"}), encoding="utf-8")
    (plugin_dir / "__init__.py").write_text(_PLUGIN_SOURCE, encoding="utf-8")
    (hermes_home / "config.yaml").write_text(
        yaml.safe_dump({"plugins": {"enabled": ["hc941_probe"]}}), encoding="utf-8"
    )
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    manager = PluginManager()
    manager.discover_and_load()
    try:
        yield manager
    finally:
        for name in (BUDGET_PROBE, PLAIN_PROBE):
            registry.deregister(name)


def test_loaded_plugin_tool_carries_its_execution_timeout(probe_plugin):
    from agent.tool_dispatch_helpers import _extend_tool_timeout

    budget_entry = registry.get_entry(BUDGET_PROBE)
    plain_entry = registry.get_entry(PLAIN_PROBE)
    assert budget_entry is not None, "probe plugin failed to load (unsupported register_tool keyword?)"
    assert plain_entry is not None
    assert budget_entry.execution_timeout == PROBE_BUDGET_S
    assert plain_entry.execution_timeout is None
    assert _extend_tool_timeout(BUDGET_PROBE, 420.0) == PROBE_BUDGET_S
    assert _extend_tool_timeout(PLAIN_PROBE, 420.0) == 420.0


def _direct_call(name: str):
    return SimpleNamespace(id=f"{name}-call", type="function",
                           function=SimpleNamespace(name=name, arguments="{}"))


def _bridged_call(name: str):
    arguments = json.dumps({"calls": [{"name": name, "arguments": {}}]})
    return SimpleNamespace(id=f"{name}-call", type="function",
                           function=SimpleNamespace(name="tool_call", arguments=arguments))


@pytest.mark.parametrize("shape", [_direct_call, _bridged_call], ids=["direct", "tool_call-bridge"])
@pytest.mark.parametrize(
    ("tool_name", "expected_window_s"),
    [(BUDGET_PROBE, PROBE_BUDGET_S), (PLAIN_PROBE, SHARED_DEADLINE_S)],
    ids=["registered-budget", "shared-deadline"],
)
def test_sequential_executor_arms_the_registered_budget(
    probe_plugin, tmp_path, monkeypatch, shape, tool_name, expected_window_s
):
    agent = _make_agent(tmp_path)
    monkeypatch.setenv("HERMES_CONCURRENT_TOOL_TIMEOUT_S", str(SHARED_DEADLINE_S))
    # The bridge unwrap only admits names the session may reach through tool_search.
    monkeypatch.setattr(tool_executor, "_tool_search_scoped_names",
                        lambda _agent: frozenset({BUDGET_PROBE, PLAIN_PROBE}))
    armed: list[tuple[str, float | None]] = []
    real_poll = tool_executor._poll_sequential_future

    def _record_armed_deadline(agent_, future, function_name, deadline, started, authorization_gate):
        armed.append((function_name, None if deadline is None else deadline - started))
        return real_poll(agent_, future, function_name, deadline, started, authorization_gate)

    monkeypatch.setattr(tool_executor, "_poll_sequential_future", _record_armed_deadline)
    dispatched: list[str] = []

    def _dispatch(name, _args, _task_id, **_kwargs):
        dispatched.append(name)
        return "probe result"

    messages: list[dict] = []
    with patch("model_tools.handle_function_call", side_effect=_dispatch):
        execute_tool_calls_sequential(agent, SimpleNamespace(tool_calls=[shape(tool_name)]), messages, "task")

    assert dispatched == [tool_name]
    assert [message["content"] for message in messages] == ["probe result"]
    assert len(armed) == 1
    armed_name, window_s = armed[0]
    assert armed_name == tool_name
    assert window_s == pytest.approx(expected_window_s, abs=0.5)
