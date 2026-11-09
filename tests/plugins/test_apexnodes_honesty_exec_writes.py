"""hc-1195: what terminal / execute_code write under skills/ and memories/ goes through the hc-1036 check.

The plugin is a byte-identical copy of apex-nodes ``app/runtime_plugins/apexnodes-honesty-tools``
(apex-nodes CI compares every file; the concurrency, cache and edge cases are tested there). Here real
tools run through this runtime's own machinery, the way APEX Desktop runs them:

* ``model_tools.handle_function_call`` with the real ``terminal`` and ``execute_code`` tools (pre hook,
  post hook, then ``transform_tool_result``);
* the agent loop's order: ``agent.tool_executor._pre_tool_block``, the registry call with its post hook
  suppressed, then ``emit_terminal_post_tool_call``;
* the executor giving up (status ``timeout``) and the abandoned worker's late ``transform_tool_result``;
* a tool that raises half way (no transform at all), and ``_collect_pre_llm_call_context`` next turn.
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
SECOND_HAND_OFFICIAL = "- 出分：6月25日 12:00（✅ 官方精确值，社媒转述）"
OLD_SKILL = "---\nname: gaokao-dates\ndescription: 陕西升学时间(二手资料汇总)\n---\n\n## 时间\n- 报名：11月初（🔶 二手：机构公众号）\n"
# The 2026-09-22 shape: a whole new skill written from social_search results, no page opened.
NEW_SKILL = """---
name: shaanxi-gaokao-timeline
description: 陕西高考官方时间链路知识库
---

## 全年关键时间链路（✅=官方口径）
- 高考报名：11月1日-7日（✅ 往年口径）
- 出分：6月25日（✅ 2026年口径）
"""
HONEST_SKILL = NEW_SKILL.replace("官方时间链路知识库", "时间链路知识库(二手资料汇总)").replace(
    "（✅=官方口径）", "（🔶=二手，以考试院当年通知为准）"
).replace("（✅ 往年口径）", "（🔶 二手：机构公众号）").replace("（✅ 2026年口径）", "（🔶 二手：抖音博主）")


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
def home(monkeypatch, tmp_path, caplog):
    from hermes_cli import plugins as plugins_mod
    from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest
    from tools.registry import registry

    home = tmp_path / "home"
    (home / "logs").mkdir(parents=True)
    (home / "skills" / "research" / "gaokao-dates").mkdir(parents=True)
    (home / "skills" / "research" / "gaokao-dates" / "SKILL.md").write_text(OLD_SKILL, encoding="utf-8")
    (home / "memories").mkdir()
    (home / "memories" / "MEMORY.md").write_text("用户在西安，孩子明年高考\n", encoding="utf-8")
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.delenv("HONESTY_GUARDS_DISABLE", raising=False)
    manager = PluginManager()
    monkeypatch.setattr(plugins_mod, "_plugin_manager", manager)
    module = _load_plugin()
    module._guard_sessions.clear()
    manifest = PluginManifest(name="apexnodes-honesty-tools", version="0.4.0", description="test", source="bundled")
    with caplog.at_level(logging.WARNING, logger="hermes_cli.plugins"):
        module.register(PluginContext(manifest, manager))
    assert "unknown hook" not in caplog.text
    yield home
    registry.deregister("honesty_verify", scope=manager.scope_key)


def _call(name: str, args: dict, call_id: str, session: str = "s") -> dict:
    import model_tools
    import tools.code_execution_tool  # registers execute_code
    import tools.file_tools  # registers read_file

    return json.loads(model_tools.handle_function_call(name, args, task_id="task", session_id=session, tool_call_id=call_id))


def _agent(session_id: str = "s"):
    return SimpleNamespace(
        session_id=session_id, model="m", platform="desktop", _persist_disabled=False,
        _parent_session_id=None, _user_id=None, _current_turn_id="t", _current_api_request_id="",
    )


def test_the_hook_this_guard_needs_is_known_to_this_runtime():
    from hermes_cli.plugins import VALID_HOOKS

    assert {"pre_llm_call", "pre_tool_call", "post_tool_call", "transform_tool_result"} <= VALID_HOOKS


def test_an_echo_of_a_second_hand_official_line_into_a_skill_is_undone_and_told(home):
    skill = home / "skills" / "research" / "gaokao-dates" / "SKILL.md"
    before = skill.read_bytes()

    result = _call("terminal", {"command": f"echo '{SECOND_HAND_OFFICIAL}' >> '{skill}'"}, "c1")

    assert skill.read_bytes() == before
    message = result["error"]
    assert message.startswith("没存：这次终端命令运行期间写进技能或记忆文件的内容里，有资料的证据等级写高了，这些改动已撤回")
    assert "- skills/research/gaokao-dates/SKILL.md(已恢复成运行前的样子)" in message
    line_no = len(OLD_SKILL.splitlines()) + 1
    assert f"- skills/research/gaokao-dates/SKILL.md 第 {line_no} 行：出分：6月25日 12:00（✅ 官方精确值，社媒转述）" in message
    assert "转述的标 🔶 二手" in message  # the reason a refused skill_manage gets
    assert result["exit_code"] == 0  # the command's own result is still there


def test_a_new_skill_copied_in_by_a_command_is_removed_with_its_directory_and_the_honest_one_stays(home, tmp_path):
    draft = tmp_path / "draft.md"
    target = home / "skills" / "research" / "shaanxi-gaokao-timeline"
    draft.write_text(NEW_SKILL, encoding="utf-8")

    result = _call("terminal", {"command": f"mkdir -p '{target}' && cp '{draft}' '{target}/SKILL.md'"}, "c2")

    assert not target.exists()
    assert "skills/research/shaanxi-gaokao-timeline/SKILL.md(新建的，已删掉)" in result["error"]
    assert "这次一个网页都没打开过" in result["error"]
    assert result["error"].count("skills/research/shaanxi-gaokao-timeline/SKILL.md 第 ") == 3

    draft.write_text(HONEST_SKILL, encoding="utf-8")
    kept = _call("terminal", {"command": f"mkdir -p '{target}' && cp '{draft}' '{target}/SKILL.md'"}, "c3")
    assert not kept.get("error")
    assert (target / "SKILL.md").read_text(encoding="utf-8") == HONEST_SKILL


def test_execute_code_writing_a_memory_file_directly_is_undone(home):
    memory = home / "memories" / "MEMORY.md"
    code = f"open({str(memory)!r}, 'a', encoding='utf-8').write('陕西出分 6月25日（官方口径）\\n')\nprint('written')"

    result = _call("execute_code", {"code": code}, "c4")

    assert memory.read_text(encoding="utf-8") == "用户在西安，孩子明年高考\n"
    assert result["error"].startswith("没存：这次代码运行期间")
    assert "- memories/MEMORY.md 第 2 行：陕西出分 6月25日（官方口径）" in result["error"]
    assert result["output"].strip() == "written"


def test_on_the_agent_loop_path_the_model_reads_the_message_once(home):
    import model_tools
    from agent.inline_tool_executors import emit_terminal_post_tool_call
    from agent.tool_executor import _pre_tool_block, _ToolCallRef

    agent = _agent()
    skill = home / "skills" / "research" / "gaokao-dates" / "SKILL.md"
    args = {"command": f"echo '{SECOND_HAND_OFFICIAL}' >> '{skill}'"}
    block, _ = _pre_tool_block(agent, _ToolCallRef(name="terminal", args=args, task_id="task", call_id="c5", trace=[]))
    assert block is None  # the command itself is never refused up front
    with model_tools.suppress_post_tool_call_hook():
        result = model_tools.handle_function_call(
            "terminal", args, "task", tool_call_id="c5", session_id="s", skip_pre_tool_call_hook=True,
        )
    emit_terminal_post_tool_call(agent, function_name="terminal", function_args=args, result=result, effective_task_id="task", tool_call_id="c5", status="ok")

    assert json.loads(result)["error"].startswith("没存：这次终端命令")
    assert skill.read_text(encoding="utf-8") == OLD_SKILL
    after = _call("read_file", {"path": str(skill)}, "c6")
    assert "earlier_write_check" not in after and "没存" not in json.dumps(after, ensure_ascii=False)


def test_after_a_timeout_the_write_and_the_abandoned_workers_late_write_are_undone_and_the_next_turn_hears(home):
    import model_tools
    from agent.inline_tool_executors import emit_terminal_post_tool_call
    from agent.tool_executor import _pre_tool_block, _ToolCallRef
    from agent.turn_context import _collect_pre_llm_call_context

    agent = _agent()
    memory = home / "memories" / "MEMORY.md"
    args = {"command": "python3 long_job.py"}
    _pre_tool_block(agent, _ToolCallRef(name="terminal", args=args, task_id="task", call_id="c7", trace=[]))
    with memory.open("a", encoding="utf-8") as fh:  # what the command wrote before the executor gave up
        fh.write("官方数据：陕西一本线 450 分\n")
    emit_terminal_post_tool_call(
        agent, function_name="terminal", function_args=args, result="Error executing tool 'terminal': timed out after 420.0s",
        effective_task_id="task", tool_call_id="c7", status="timeout",
    )
    assert memory.read_text(encoding="utf-8") == "用户在西安，孩子明年高考\n"

    with memory.open("a", encoding="utf-8") as fh:  # the abandoned worker keeps going, then finishes
        fh.write("【官方】二本线 380 分\n")
    late = model_tools._apply_transform_tool_result_hook("terminal", args, '{"output": "", "exit_code": 0}', 1, model_tools._CallIds("task", "s", "c7"))
    assert memory.read_text(encoding="utf-8") == "用户在西安，孩子明年高考\n"
    assert late == '{"output": "", "exit_code": 0}'  # nobody reads an abandoned worker's result

    context = _collect_pre_llm_call_context(
        agent, effective_task_id="task", turn_id="t2", original_user_message="存好了吗", messages=[], conversation_history=[],
    )
    assert "补一句先前的事：没存：这次终端命令运行期间" in context
    assert "官方数据：陕西一本线 450 分" in context and "【官方】二本线 380 分" in context


def test_a_tool_that_raises_half_way_is_still_undone_and_the_next_result_says_so(home, monkeypatch):
    import model_tools

    skill = home / "skills" / "research" / "gaokao-dates" / "SKILL.md"

    def write_then_raise(*_args, **_kwargs):
        with skill.open("a", encoding="utf-8") as fh:
            fh.write(SECOND_HAND_OFFICIAL + "\n")
        raise RuntimeError("backend went away")

    with monkeypatch.context() as patched:
        patched.setattr(model_tools, "_execute_tool", write_then_raise)
        failed = _call("terminal", {"command": "echo hi"}, "c8")

    assert "backend went away" in failed["error"]
    assert skill.read_text(encoding="utf-8") == OLD_SKILL
    following = _call("read_file", {"path": str(skill)}, "c9")
    assert following["earlier_write_check"].startswith("补一句先前的事：没存：这次终端命令运行期间")
    assert "error" not in following  # the read itself did not fail
