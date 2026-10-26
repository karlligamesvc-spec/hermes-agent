"""hc-1040: a direct call to a tool behind the tool_call bridge is never repaired into a
different, visible tool.

Plugin, MCP and deferred built-in tools reach the model only through tool_search /
tool_describe / tool_call, so they are not in ``agent.valid_tool_names``. The name repair
matched visible names only, and its fuzzy step (difflib, cutoff 0.7) sent such a call to
the nearest visible tool: APEX Desktop's ``apex_memory`` (the account memory ledger) ran
the built-in ``memory`` tool and wrote the local MEMORY.md, without an error.

``COLLISIONS`` is every pair a census found on fork main e2c2c4d4: built-in tools plus
every bundled plugin (Desktop) and every apex-nodes runtime plugin (cloud), the default
defer list, and the largest visible set (every non-deferrable tool plus the bridge).
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

import model_tools  # registers the built-in tools
from agent.agent_runtime_helpers import repair_tool_call
from agent.turn_tool_validation import _repair_or_bridge, validate_tool_calls
from tools.registry import registry
from tools.tool_search import _DEFAULT_DEFERRED_TOOLS, BRIDGE_TOOL_NAMES, TOOL_CALL_NAME, is_deferrable_tool_name

# (tool reached only through the bridge, where it comes from, visible tool the old repair picked)
COLLISIONS = [
    ("apex_memory", "apex-overlay plugin, APEX Desktop memory ledger", "memory"),
    ("social_search", "apexnodes-social-tools plugin, Desktop and cloud", "tool_search"),
    ("read_terminal", "built-in desktop_ui", "terminal"),
    ("close_terminal", "built-in desktop_ui", "terminal"),
    ("video_analyze", "built-in video", "vision_analyze"),
    ("x_search", "built-in x_search", "web_search"),
    ("kanban_schedule", "built-in kanban", "kanban_create"),
    ("a2a_list", "built-in a2a", "kanban_list"),
    ("browser_vault", "built-in browser", "browser_dialog"),
]
NAMES = [name for name, _, _ in COLLISIONS]
LEDGER_ROUTE = "/api/v1/media/memory-ledger/entries"


def _visible() -> set[str]:
    """The largest visible set: every registered tool the bridge never hides, plus the bridge."""
    return {n for n in registry.get_all_tool_names() if not is_deferrable_tool_name(n, _DEFAULT_DEFERRED_TOOLS)} | set(
        BRIDGE_TOOL_NAMES
    )


def _call(name, arguments, call_id="c1"):
    return SimpleNamespace(id=call_id, type="function", function=SimpleNamespace(name=name, arguments=arguments))


def _stub_agent(visible):
    """Only what validate_tool_calls reads, with the runtime's own repair."""
    agent = SimpleNamespace(
        provider="openrouter", model="test/model", session_id="s1", tools=[],
        valid_tool_names=set(visible), log_prefix="", _invalid_tool_retries=0, _invalid_json_retries=0,
        _uniquify_tool_call_ids=lambda calls, taken=(): None,
        _vprint=lambda *a, **k: None, _buffer_vprint=lambda *a, **k: None, _flush_status_buffer=lambda: None,
        _build_assistant_message=lambda message, finish_reason: {"role": "assistant", "content": ""},
        _persist_session=lambda *a: None, _cleanup_task_resources=lambda *a: None,
    )
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
    """Register a stand-in for each named tool the test process has not registered."""
    added = []

    def register(*names):
        for name in names:
            if registry.get_entry(name) is None:
                registry.register(name=name, toolset="hc1040_standin", handler=lambda args, **kw: "{}",
                                  schema={"name": name, "description": "stand-in",
                                          "parameters": {"type": "object", "properties": {}}})
                added.append(name)

    yield register
    for name in added:
        registry.deregister(name)


@pytest.mark.parametrize("name,owner,target", COLLISIONS, ids=NAMES)
def test_the_collision_is_real_for_the_runtimes_own_repair(name, owner, target):
    """The old path: the runtime's repair over the visible names picks a different tool."""
    visible = _visible()
    assert target in visible and name not in visible
    assert repair_tool_call(SimpleNamespace(valid_tool_names=visible), name) == target


@pytest.mark.parametrize("name,owner,target", COLLISIONS, ids=NAMES)
def test_a_direct_call_to_a_bridged_tool_becomes_that_bridge_call(scope, name, owner, target):
    scope(name)
    tc = _call(name, '{"q": "收纳"}')
    assert _repair_or_bridge(_stub_agent(_visible()), tc, None) == TOOL_CALL_NAME
    assert json.loads(tc.function.arguments) == {"calls": [{"name": name, "arguments": {"q": "收纳"}}]}


@pytest.mark.parametrize("name,owner,target", COLLISIONS, ids=NAMES)
def test_a_registered_tool_outside_this_sessions_scope_gets_no_repair(scope, registered, name, owner, target):
    """Feature off (no ledger mirror), toolset not enabled: the model is told it is unavailable."""
    scope()
    registered(name)
    tc = _call(name, '{"q": "收纳"}')
    assert _repair_or_bridge(_stub_agent(_visible()), tc, None) is None
    assert tc.function.arguments == '{"q": "收纳"}'


@pytest.mark.parametrize(
    "called,expected",
    [
        ("ApexMemory", "apex_memory"),  # CamelCase: its snake form is the bridged name
        ("apex-memory", "apex_memory"),  # separator variant
        ("apexmemory", "apex_memory"),  # memory 0.75, apex_memory 0.95
        ("Social_Search", "social_search"),
    ],
)
def test_a_variant_of_a_bridged_name_reaches_that_tool(scope, called, expected):
    scope("apex_memory", "social_search")
    tc = _call(called, "{}")
    assert _repair_or_bridge(_stub_agent(_visible()), tc, None) == TOOL_CALL_NAME
    assert json.loads(tc.function.arguments)["calls"][0]["name"] == expected


@pytest.mark.parametrize(
    "called,expected",
    [("Read_File", "read_file"), ("MEMORY", "memory"), ("web-search", "web_search"), ("Patch_tool", "patch"),
     ("no_such_capability_at_all", None)],
)
def test_repairs_onto_visible_tools_are_unchanged(scope, called, expected):
    scope("apex_memory", "social_search")
    tc = _call(called, "{}")
    assert _repair_or_bridge(_stub_agent(_visible()), tc, None) == expected
    assert tc.function.arguments == "{}"


def test_without_the_bridge_in_the_session_nothing_is_wrapped(scope, registered):
    scope("apex_memory")
    registered("apex_memory")
    tc = _call("apex_memory", "{}")
    assert _repair_or_bridge(_stub_agent(_visible() - set(BRIDGE_TOOL_NAMES)), tc, None) is None
    assert tc.function.arguments == "{}"


@pytest.mark.parametrize(
    "arguments,expected",
    [('{"action": "add"}', {"action": "add"}), ({"action": "add"}, {"action": "add"}),
     ("", {}), ("  ", {}), (None, {}), ("[1]", [1])],
    ids=["json", "dict", "empty", "blank", "none", "non-object"],
)
def test_the_calls_own_arguments_ride_in_the_bridge_entry(scope, arguments, expected):
    """A non-object is passed on as it is: the bridge refuses it in words, nothing runs."""
    scope("apex_memory")
    tc = _call("apex_memory", arguments)
    assert _repair_or_bridge(_stub_agent(_visible()), tc, None) == TOOL_CALL_NAME
    assert json.loads(tc.function.arguments) == {"calls": [{"name": "apex_memory", "arguments": expected}]}


@pytest.mark.parametrize(
    "arguments,action",
    [('{"action": "add", "content": "不露', "return"), ('{"action": "add",}', "continue")],
    ids=["truncated", "malformed"],
)
def test_unparsable_arguments_keep_the_turns_json_handling(scope, arguments, action):
    """Truncated arguments are still refused and malformed ones still retried, never run."""
    scope("apex_memory")
    tc = _call("apex_memory", arguments)
    verdict = validate_tool_calls(
        _stub_agent(_visible()), SimpleNamespace(content="", tool_calls=[tc]), "tool_calls",
        messages=[], conversation_history=[], api_call_count=1, effective_task_id="t1",
    )
    assert (verdict.action, tc.function.name, tc.function.arguments) == (action, TOOL_CALL_NAME, arguments)


def test_native_block_sidecars_replay_the_same_bridge_call(scope):
    """Anthropic / Bedrock replay the ordered blocks, not tool_calls."""
    scope("apex_memory")
    thinking = {"type": "thinking", "thinking": "记一下", "signature": "sig"}
    provider_data = {
        "anthropic_content_blocks": [thinking, {"type": "tool_use", "id": "c1", "name": "apex_memory",
                                                "input": {"action": "add"}}],
        "bedrock_content_blocks": [{"toolUse": {"toolUseId": "c1", "name": "apex_memory", "input": {"action": "add"}}},
                                   {"toolUse": {"toolUseId": "other", "name": "terminal", "input": {}}}],
    }
    tc = _call("apex_memory", '{"action": "add"}')
    validate_tool_calls(
        _stub_agent(_visible()), SimpleNamespace(content="", tool_calls=[tc], provider_data=provider_data),
        "tool_calls", messages=[], conversation_history=[], api_call_count=1, effective_task_id="t1",
    )
    bridged = {"calls": [{"name": "apex_memory", "arguments": {"action": "add"}}]}
    assert provider_data["anthropic_content_blocks"] == [
        thinking, {"type": "tool_use", "id": "c1", "name": TOOL_CALL_NAME, "input": bridged}]
    assert [b["toolUse"] for b in provider_data["bedrock_content_blocks"]] == [
        {"toolUseId": "c1", "name": TOOL_CALL_NAME, "input": bridged},
        {"toolUseId": "other", "name": "terminal", "input": {}},
    ]


# --- End to end: real AIAgent, real registry, real repair, real executor ---------------------


def _response(tool_calls=None, content="done"):
    return SimpleNamespace(choices=[SimpleNamespace(
        message=SimpleNamespace(content="" if tool_calls else content, tool_calls=tool_calls),
        finish_reason="tool_calls" if tool_calls else "stop")], model="test/model", usage=None)


class _FakeLedger:
    def __init__(self):
        from plugins import apexnodes_gateway

        self.GatewayError = apexnodes_gateway.GatewayError
        self.calls = []

    def request_json(self, method, path, payload=None, **kwargs):
        self.calls.append((method, path, payload))
        return {"entry": {"id": "3f2a9c1d-0000-4000-8000-000000000001", "ref": "3f2a9c1d", "kind": "about_you",
                          "content": payload["content"]}, "created": True}


@pytest.fixture
def desktop_agent(tmp_path, monkeypatch):
    """A real agent with the apex-overlay memory ledger seam, as APEX Desktop builds it."""
    from apex_overlay import memory_ledger
    from hermes_cli import plugins
    from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest
    from run_agent import AIAgent

    home = tmp_path / "apexnodes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    ledger = _FakeLedger()
    monkeypatch.setattr(memory_ledger, "_gateway", lambda: ledger)
    manager = PluginManager()
    manager._discovered = True
    assert memory_ledger.apply(PluginContext(
        PluginManifest(name="apex-overlay", key="apex-overlay", source="bundled"), manager))
    monkeypatch.setattr(plugins, "_plugin_manager", manager)

    def build(*, ledger_on):
        if ledger_on:
            (home / "apex").mkdir(exist_ok=True)
            (home / "apex" / "memory-ledger-prompt.md").write_text("【APEX 记得的】\n关于你：\n（还没有）\n", encoding="utf-8")
        with patch("agent.process_bootstrap.OpenAI"), patch("agent.model_metadata.fetch_model_metadata", return_value={}):
            agent = AIAgent(model="test/model", api_key="test-key", base_url="http://127.0.0.1:1/v1", platform="cli",
                            quiet_mode=True, skip_context_files=True, skip_memory=True, max_iterations=4)
        agent.client = MagicMock()
        agent._cached_system_prompt = "You are APEX."
        agent._use_prompt_caching = False
        agent.compression_enabled = False
        agent.save_trajectories = False
        return agent, ledger

    try:
        yield build
    finally:
        registry.deregister(memory_ledger.TOOL_NAME)


def _run(agent, call):
    executed = []

    def pre_hook(name, args, **kwargs):
        executed.append(name)
        return None, None

    agent.client.chat.completions.create.side_effect = [_response([call]), _response()]
    with patch("hermes_cli.plugins._dispatch_pre_tool_call_hooks", side_effect=pre_hook):
        result = agent.run_conversation("记住：我拍视频不露脸。")
    return result, executed


def test_a_direct_apex_memory_call_writes_the_ledger_never_local_memory(desktop_agent):
    agent, ledger = desktop_agent(ledger_on=True)
    assert {"memory", TOOL_CALL_NAME} <= agent.valid_tool_names and "apex_memory" not in agent.valid_tool_names
    args = {"action": "add", "kind": "about_you", "content": "拍视频不露脸"}

    result, executed = _run(agent, _call("apex_memory", json.dumps(args, ensure_ascii=False)))

    assert executed == ["apex_memory"]
    assert ledger.calls == [("POST", LEDGER_ROUTE, {"kind": "about_you", "content": "拍视频不露脸"})]
    assistant = next(m for m in result["messages"] if m.get("tool_calls"))
    function = assistant["tool_calls"][0]["function"]
    assert function["name"] == TOOL_CALL_NAME
    assert json.loads(function["arguments"]) == {"calls": [{"name": "apex_memory", "arguments": args}]}
    tool_result = next(m for m in result["messages"] if m["role"] == "tool")
    assert json.loads(tool_result["content"])["entry"]["content"] == "拍视频不露脸"
    assert result["final_response"] == "done"


def test_with_the_ledger_off_a_direct_call_is_refused_not_turned_into_memory(desktop_agent):
    agent, ledger = desktop_agent(ledger_on=False)
    assert "memory" in agent.valid_tool_names and "apex_memory" in registry.get_all_tool_names()

    result, executed = _run(agent, _call("apex_memory", '{"action": "add", "kind": "recent", "content": "交付了成片"}'))

    assert executed == [] and ledger.calls == []
    tool_result = next(m for m in result["messages"] if m["role"] == "tool")
    assert tool_result["content"].startswith("Tool 'apex_memory' does not exist.")
    assert result["final_response"] == "done"
