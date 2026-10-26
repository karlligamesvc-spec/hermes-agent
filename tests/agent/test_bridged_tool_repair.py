"""hc-1040 (v2026.8.31 hotfix): a direct call to a tool behind the tool_call bridge is never
repaired into a different, visible tool.

Plugin and MCP tools reach the model only through tool_search / tool_describe / tool_call,
so they are not in ``agent.valid_tool_names``. The name repair matched visible names only,
and its fuzzy step (difflib, cutoff 0.7) sent such a call to the nearest visible tool. On the
cloud image a direct ``social_search`` became ``tool_search``, failed on the missing
``queries``, and the platform's search was never asked (reproduced on this revision with
the real cloud plugin set and config). ``COLLISIONS`` is every pair a census found at this
revision (built-ins plus the bundled and apex-nodes runtime plugins); ``apex_memory`` is the
Desktop ledger tool of later revisions, which would collide the same way.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

import model_tools  # registers the built-in tools
from agent.agent_runtime_helpers import repair_tool_call
from agent.bridged_tool_repair import repair_or_bridge
from tools.registry import registry
from tools.tool_search import BRIDGE_TOOL_NAMES, TOOL_CALL_NAME, is_deferrable_tool_name

ROOT = Path(__file__).resolve().parents[2]
COLLISIONS = [
    ("social_search", "tool_search"),
    ("video_analyze", "vision_analyze"),
    ("x_search", "web_search"),
    ("video_generate", "image_generate"),
    ("a2a_list", "kanban_list"),
    ("apex_memory", "memory"),
]
NAMES = [name for name, _ in COLLISIONS]


def _visible() -> set[str]:
    """The largest visible set: every registered tool the bridge never hides, plus the bridge."""
    return {n for n in registry.get_all_tool_names() if not is_deferrable_tool_name(n)} | set(BRIDGE_TOOL_NAMES)


def _call(name, arguments, call_id="c1"):
    return SimpleNamespace(id=call_id, type="function", function=SimpleNamespace(name=name, arguments=arguments))


def _stub_agent(visible):
    agent = SimpleNamespace(valid_tool_names=set(visible))
    agent._repair_tool_call = lambda name: repair_tool_call(agent, name)
    return agent


@pytest.fixture
def scope(monkeypatch):
    """Set the session's bridge scope (the deferred tools tool_call may reach)."""

    def set_scope(*names):
        monkeypatch.setattr("agent.tool_executor._tool_search_scoped_names", lambda agent: frozenset(names))

    return set_scope


@pytest.fixture
def registered():
    """Register a stand-in (in the plugin-style ``skills`` toolset) for each missing name."""
    added = []

    def register(*names):
        for name in names:
            if registry.get_entry(name) is None:
                registry.register(name=name, toolset="skills", handler=lambda args, **kw: "{}",
                                  schema={"name": name, "description": "stand-in",
                                          "parameters": {"type": "object", "properties": {}}})
                added.append(name)

    yield register
    for name in added:
        registry.deregister(name)


@pytest.mark.parametrize("name,target", COLLISIONS, ids=NAMES)
def test_the_collision_is_real_for_the_runtimes_own_repair(registered, name, target):
    registered(name)
    visible = _visible()
    assert target in visible and name not in visible
    assert repair_tool_call(SimpleNamespace(valid_tool_names=visible), name) == target


@pytest.mark.parametrize("name,target", COLLISIONS, ids=NAMES)
def test_a_direct_call_to_a_bridged_tool_becomes_that_bridge_call(scope, name, target):
    scope(name)
    tc = _call(name, '{"query": "收纳"}')
    assert repair_or_bridge(_stub_agent(_visible()), tc, None) == TOOL_CALL_NAME
    assert json.loads(tc.function.arguments) == {"name": name, "arguments": {"query": "收纳"}}


@pytest.mark.parametrize("name,target", COLLISIONS, ids=NAMES)
def test_a_registered_tool_outside_this_sessions_scope_gets_no_repair(scope, registered, name, target):
    """Platform not configured (check_fn false), toolset off: the model is told it is unavailable."""
    scope()
    registered(name)
    tc = _call(name, '{"query": "收纳"}')
    assert repair_or_bridge(_stub_agent(_visible()), tc, None) is None
    assert tc.function.arguments == '{"query": "收纳"}'


@pytest.mark.parametrize("called,expected", [("Social_Search", "social_search"), ("social-search", "social_search"),
                                             ("socialsearch", "social_search")])
def test_a_variant_of_a_bridged_name_reaches_that_tool(scope, called, expected):
    scope("social_search")
    tc = _call(called, "{}")
    assert repair_or_bridge(_stub_agent(_visible()), tc, None) == TOOL_CALL_NAME
    assert json.loads(tc.function.arguments)["name"] == expected


@pytest.mark.parametrize(
    "called,expected",
    [("Read_File", "read_file"), ("MEMORY", "memory"), ("web-search", "web_search"), ("Patch_tool", "patch"),
     ("no_such_capability_at_all", None)],
)
def test_repairs_onto_visible_tools_are_unchanged(scope, called, expected):
    scope("social_search")
    tc = _call(called, "{}")
    assert repair_or_bridge(_stub_agent(_visible()), tc, None) == expected
    assert tc.function.arguments == "{}"


def test_without_the_bridge_in_the_session_nothing_is_wrapped(scope, registered):
    scope("social_search")
    registered("social_search")
    tc = _call("social_search", "{}")
    assert repair_or_bridge(_stub_agent(_visible() - set(BRIDGE_TOOL_NAMES)), tc, None) is None
    assert tc.function.arguments == "{}"


@pytest.mark.parametrize(
    "arguments,expected",
    [('{"query": "x"}', {"query": "x"}), ({"query": "x"}, {"query": "x"}), ("", {}), ("  ", {}), (None, {}),
     ("[1]", [1])],
    ids=["json", "dict", "empty", "blank", "none", "non-object"],
)
def test_the_calls_own_arguments_ride_in_the_bridge_call(scope, arguments, expected):
    """A non-object is passed on as it is: the bridge refuses it in words, nothing runs."""
    scope("social_search")
    tc = _call("social_search", arguments)
    assert repair_or_bridge(_stub_agent(_visible()), tc, None) == TOOL_CALL_NAME
    assert json.loads(tc.function.arguments) == {"name": "social_search", "arguments": expected}


@pytest.mark.parametrize("arguments", ['{"platform": "douyin", "query": "收', '{"query": "x",}'],
                         ids=["truncated", "malformed"])
def test_unparsable_arguments_stay_for_the_turns_json_handling(scope, arguments):
    scope("social_search")
    tc = _call("social_search", arguments)
    assert repair_or_bridge(_stub_agent(_visible()), tc, None) == TOOL_CALL_NAME
    assert tc.function.arguments == arguments


def test_native_anthropic_blocks_replay_the_same_bridge_call(scope):
    scope("social_search")
    thinking = {"type": "thinking", "thinking": "搜一下", "signature": "sig"}
    message = SimpleNamespace(anthropic_content_blocks=[
        thinking, {"type": "tool_use", "id": "c1", "name": "social_search", "input": {"query": "x"}},
        {"type": "tool_use", "id": "other", "name": "terminal", "input": {}}])
    repair_or_bridge(_stub_agent(_visible()), _call("social_search", '{"query": "x"}'), message)
    assert message.anthropic_content_blocks == [
        thinking,
        {"type": "tool_use", "id": "c1", "name": TOOL_CALL_NAME,
         "input": {"name": "social_search", "arguments": {"query": "x"}}},
        {"type": "tool_use", "id": "other", "name": "terminal", "input": {}},
    ]


# --- End to end: real AIAgent, the real bundled social-tools plugin, real repair and executor ---


def _response(tool_calls=None, finish_reason=None):
    return SimpleNamespace(choices=[SimpleNamespace(
        message=SimpleNamespace(content="" if tool_calls else "done", tool_calls=tool_calls),
        finish_reason=finish_reason or ("tool_calls" if tool_calls else "stop"))], model="test/model", usage=None)


@pytest.fixture
def cloud_agent(tmp_path, monkeypatch):
    """A real agent with the social tools plugin loaded; its platform requests are recorded."""
    from hermes_cli import plugins
    from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    plugin_dir = ROOT / "plugins" / "apexnodes-social-tools"
    spec = importlib.util.spec_from_file_location("hc1040_social_tools", plugin_dir / "__init__.py",
                                                  submodule_search_locations=[str(plugin_dir)])
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, "hc1040_social_tools", module)
    spec.loader.exec_module(module)
    requests = []
    configured = {"on": True}
    monkeypatch.setattr(module, "_check", lambda: configured["on"])
    monkeypatch.setattr(module, "_request", lambda method, path, payload=None, timeout=90: (
        requests.append((method, path, payload)) or {"items": [{"title": "收纳三样"}]}))
    before = set(registry.get_all_tool_names())
    manager = PluginManager()
    manager._discovered = True
    module.register(PluginContext(PluginManifest(name="apexnodes-social-tools", key="apexnodes-social-tools",
                                                 source="bundled"), manager))
    monkeypatch.setattr(plugins, "_plugin_manager", manager)

    def build(*, platform_configured):
        from run_agent import AIAgent

        configured["on"] = platform_configured
        with patch("run_agent.OpenAI"):
            agent = AIAgent(api_key="test-key", base_url="https://openrouter.ai/api/v1", model="test/model",
                            quiet_mode=True, skip_context_files=True, skip_memory=True, max_iterations=4)
        agent.client = MagicMock()
        agent._cached_system_prompt = "You are APEX."
        agent._use_prompt_caching = False
        agent.compression_enabled = False
        agent.save_trajectories = False
        return agent, requests

    try:
        yield build
    finally:
        for name in set(registry.get_all_tool_names()) - before:
            registry.deregister(name)


def _run(agent, responses):
    executed = []

    def pre_hook(name, args, **kwargs):
        executed.append(name)
        return None, None

    agent.client.chat.completions.create.side_effect = responses
    with patch("hermes_cli.plugins._dispatch_pre_tool_call_hooks", side_effect=pre_hook):
        result = agent.run_conversation("帮我搜一下抖音上的收纳视频")
    return result, executed


def test_a_direct_social_search_call_reaches_the_platform_search(cloud_agent):
    agent, requests = cloud_agent(platform_configured=True)
    assert {"tool_search", TOOL_CALL_NAME} <= agent.valid_tool_names and "social_search" not in agent.valid_tool_names
    args = {"platform": "douyin", "query": "收纳"}

    result, executed = _run(agent, [_response([_call("social_search", json.dumps(args, ensure_ascii=False))]),
                                    _response()])

    assert executed == ["social_search"]
    assert [(m, p) for m, p, _ in requests] == [("POST", "/data/social/search")]
    assistant = next(m for m in result["messages"] if m.get("tool_calls"))
    function = assistant["tool_calls"][0]["function"]
    assert (function["name"], json.loads(function["arguments"])) == (
        TOOL_CALL_NAME, {"name": "social_search", "arguments": args})
    assert "收纳三样" in next(m for m in result["messages"] if m["role"] == "tool")["content"]
    assert result["final_response"] == "done"


def test_with_the_platform_unconfigured_a_direct_call_is_refused_not_turned_into_tool_search(cloud_agent):
    agent, requests = cloud_agent(platform_configured=False)
    assert "tool_search" in agent.valid_tool_names and "social_search" in registry.get_all_tool_names()

    result, executed = _run(agent, [_response([_call("social_search", '{"platform": "douyin", "query": "收纳"}')]),
                                    _response()])

    assert executed == [] and requests == []
    tool_result = next(m for m in result["messages"] if m["role"] == "tool")
    assert tool_result["content"].startswith("Tool 'social_search' does not exist.")
    assert result["final_response"] == "done"


def test_truncated_arguments_are_still_refused_and_nothing_runs(cloud_agent):
    agent, requests = cloud_agent(platform_configured=True)

    result, executed = _run(agent, [_response([_call("social_search", '{"platform": "douyin", "query": "收')],
                                              finish_reason="tool_calls")])

    assert executed == [] and requests == []
    assert result["completed"] is False and "truncated" in result["final_response"].lower()
