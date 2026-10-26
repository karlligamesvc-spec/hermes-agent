"""hc-1036 guards of apexnodes-honesty-tools on the fork's real hook path.

The plugin is a byte-identical copy of apex-nodes ``app/runtime_plugins/apexnodes-honesty-tools``
(apex-nodes CI compares the two; the rule tables are tested there). Here the hooks run through
this runtime's own machinery, the way APEX Desktop loads them:

* the turn boundary is ``_collect_pre_llm_call_context`` (one call per user message);
* the agent loop asks ``agent.tool_executor._pre_tool_block`` before a tool runs, and reports the
  outcome through ``emit_terminal_post_tool_call``, including the 420 s timeout path;
* a refused skill save goes through ``model_tools.handle_function_call`` with the real
  ``skill_manage`` tool: nothing is written, and the honest version is saved.
"""

from __future__ import annotations

import importlib.util
import json
import logging
import sys
import types
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
PLUGIN_DIR = REPO_ROOT / "plugins" / "apexnodes-honesty-tools"
FAST = "doubao-seedance-2-0-fast-260128"
TIMEOUT = "Error executing tool 'generate_video': timed out after 420.0s"

# The 2026-09-21 skill save (public exam dates, no personal data): every source was social_search.
GAOKAO_SKILL = """---
name: shaanxi-gaokao-timeline
description: 陕西高考/单招/强基/志愿填报官方时间链路与规则知识库。用于陕西升学规划相关问题。
version: 1.0.0
---

# 陕西高考时间链路

## 全年关键时间链路（2027届，✅=官方口径）
- **6月25日12:00**：出分（✅ 2026年口径）
"""
HONEST_SKILL = GAOKAO_SKILL.replace("官方时间链路与规则知识库", "时间链路知识库(二手资料汇总)").replace(
    "（2027届，✅=官方口径）", "（2027届，🔶=二手，以考试院当年通知为准）"
).replace("（✅ 2026年口径）", "（🔶 二手：抖音博主，2026年口径）")


def _load_plugin():
    if "hermes_plugins" not in sys.modules:
        namespace = types.ModuleType("hermes_plugins")
        namespace.__path__ = []  # type: ignore[attr-defined]
        sys.modules["hermes_plugins"] = namespace
    name = "hermes_plugins.apexnodes_honesty_tools"
    spec = importlib.util.spec_from_file_location(name, PLUGIN_DIR / "__init__.py", submodule_search_locations=[str(PLUGIN_DIR)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def plugin(monkeypatch, tmp_path, caplog):
    from hermes_cli import plugins as plugins_mod
    from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest
    from tools.registry import registry

    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    monkeypatch.delenv("HONESTY_GUARDS_DISABLE", raising=False)
    manager = PluginManager()
    monkeypatch.setattr(plugins_mod, "_plugin_manager", manager)
    module = _load_plugin()
    module._guard_sessions.clear()
    manifest = PluginManifest(name="apexnodes-honesty-tools", version="0.3.0", description="test", source="bundled")
    with caplog.at_level(logging.WARNING, logger="hermes_cli.plugins"):
        module.register(PluginContext(manifest, manager))
    assert "unknown hook" not in caplog.text
    yield module
    module._guard_sessions.clear()
    registry.deregister("honesty_verify", scope=manager.scope_key)


def _agent(session_id: str):
    return SimpleNamespace(
        session_id=session_id, model="m", platform="desktop", _persist_disabled=False,
        _parent_session_id=None, _user_id=None, _current_turn_id="t", _current_api_request_id="",
    )


def _new_turn(agent) -> None:
    from agent.turn_context import _collect_pre_llm_call_context

    _collect_pre_llm_call_context(
        agent, effective_task_id="task", turn_id="t", original_user_message="继续", messages=[], conversation_history=[],
    )


def _pre(agent, name: str, args: dict):
    from agent.tool_executor import _pre_tool_block, _ToolCallRef

    block, _args = _pre_tool_block(agent, _ToolCallRef(name=name, args=args, task_id="task", call_id="c", trace=[]))
    return block


def _post(agent, name: str, args: dict, result: str, status: str) -> None:
    from agent.inline_tool_executors import emit_terminal_post_tool_call

    emit_terminal_post_tool_call(
        agent, function_name=name, function_args=args, result=result, effective_task_id="task",
        tool_call_id="c", middleware_trace=[], status=status, duration_ms=420000,
    )


def test_the_three_hooks_are_known_to_this_runtime():
    from hermes_cli.plugins import VALID_HOOKS

    assert {"pre_llm_call", "pre_tool_call", "post_tool_call"} <= VALID_HOOKS


def test_after_the_420s_timeout_the_same_turn_cannot_switch_to_fast(plugin):
    agent = _agent("v")
    _new_turn(agent)
    first = {"prompt": "奶茶店宣传片", "aspect_ratio": "portrait"}
    assert _pre(agent, "generate_video", first) is None
    _post(agent, "generate_video", first, TIMEOUT, "timeout")

    block = _pre(agent, "generate_video", {**first, "model": FAST, "seconds": 5})

    assert block is not None and FAST in block and "先告诉用户上次没成功" in block
    assert _pre(agent, "generate_video", first) is None
    _new_turn(agent)
    assert _pre(agent, "generate_video", {**first, "model": FAST}) is None


def test_a_cancelled_call_is_not_a_failure(plugin):
    agent = _agent("c")
    _new_turn(agent)
    assert _pre(agent, "text_to_speech", {"text": "t", "provider": "doubao"}) is None
    _post(agent, "text_to_speech", {"text": "t", "provider": "doubao"}, '{"status": "cancelled"}', "cancelled")
    assert _pre(agent, "text_to_speech", {"text": "t", "provider": "edge"}) is None


def test_a_skill_that_raises_the_evidence_level_is_not_written(plugin, tmp_path):
    import model_tools
    import tools.skill_manager_tool  # registers skill_manage
    from hermes_constants import get_hermes_home

    agent = _agent("k")
    _new_turn(agent)
    create = {"operations": [{"action": "create", "category": "research", "name": "shaanxi-gaokao-timeline", "content": GAOKAO_SKILL}]}

    refused = model_tools.handle_function_call("skill_manage", create, task_id="task", session_id="k")

    assert "没存" in refused and "这次一个网页都没打开过" in refused
    skills = Path(get_hermes_home()) / "skills"
    assert not list(skills.rglob("shaanxi-gaokao-timeline"))

    honest = {"operations": [{**create["operations"][0], "content": HONEST_SKILL}]}
    saved = json.loads(model_tools.handle_function_call("skill_manage", honest, task_id="task", session_id="k"))
    assert saved.get("success") is True, saved
    assert list(skills.rglob("shaanxi-gaokao-timeline"))
