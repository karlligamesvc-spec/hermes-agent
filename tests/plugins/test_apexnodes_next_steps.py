"""apexnodes-next-steps on the fork's real hook path (「下一步」块, apex-next/1).

The plugin is a byte-identical copy of apex-nodes ``app/runtime_plugins/apexnodes-next-steps``
(apex-nodes CI compares the two); its behaviour tables live there. Here it runs through
this runtime's own machinery, the way APEX Desktop loads it:

* registered by a real ``PluginContext`` (both hook names are known hooks);
* ``transform_llm_output`` fired by ``apply_llm_output_transform``: the Desktop chat
  (``platform="desktop"``, what tui_gateway reports under ``HERMES_DESKTOP=1``) keeps the
  block for the renderer, an IM channel on the Desktop's local gateway gets numbered text,
  api_server only loses the block;
* ``pre_llm_call`` collected by ``_collect_pre_llm_call_context``: a bare number after the
  numbered text becomes the option's sentence, and a 选题库 message gets the file under
  this runtime's ``get_hermes_home()``;
* Desktop enables it: ``cli-config.yaml.example`` lists it next to the other standalone plugins.
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
PLUGIN_DIR = REPO_ROOT / "plugins" / "apexnodes-next-steps"

REPLY = (
    "给你 5 个选题：\n1. 收纳避坑\n2. 小户型改造\n\n"
    "<!-- apex:next\n"
    "存进选题库 | 把这 5 个选题存进我的选题库\n"
    "写成脚本 | 把第 1 个选题写成 60 秒口播脚本\n"
    "做成发布包 | 把第 1 个选题做成发布包，我自己去发\n"
    "-->"
)
VISIBLE = "给你 5 个选题：\n1. 收纳避坑\n2. 小户型改造"
NUMBERED = VISIBLE + "\n\n接下来可以：\n1. 存进选题库\n2. 写成脚本\n3. 做成发布包\n回复数字就行。"


def _load_plugin():
    if "hermes_plugins" not in sys.modules:
        namespace = types.ModuleType("hermes_plugins")
        namespace.__path__ = []  # type: ignore[attr-defined]
        sys.modules["hermes_plugins"] = namespace
    name = "hermes_plugins.apexnodes_next_steps"
    spec = importlib.util.spec_from_file_location(name, PLUGIN_DIR / "__init__.py", submodule_search_locations=[str(PLUGIN_DIR)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def plugin(monkeypatch, tmp_path, caplog):
    from hermes_cli import plugins as plugins_mod
    from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest

    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    monkeypatch.delenv("NEXT_STEPS_DISABLE", raising=False)
    monkeypatch.delenv("APEX_SINGLE_THREAD_ACTIVE", raising=False)
    manager = PluginManager()
    monkeypatch.setattr(plugins_mod, "_plugin_manager", manager)
    module = _load_plugin()
    module._reset_state()
    manifest = PluginManifest(name="apexnodes-next-steps", version="0.2.0", description="test", source="bundled")
    with caplog.at_level(logging.WARNING, logger="hermes_cli.plugins"):
        module.register(PluginContext(manifest, manager))
    assert "unknown hook" not in caplog.text
    yield module
    module._reset_state()


def _agent(platform: str, session_id: str = "s1"):
    return SimpleNamespace(
        session_id=session_id, model="m", platform=platform, _persist_disabled=False,
        _parent_session_id=None, _user_id=None,
    )


def _transform(platform: str, session_id: str = "s1"):
    from agent.turn_finalizer import apply_llm_output_transform

    final, transformed, _ = apply_llm_output_transform(_agent(platform, session_id), REPLY, turn_id="t1", platform=platform)
    return final, transformed


def _pre_llm_context(platform: str, message: str, session_id: str = "s1") -> str:
    from agent.turn_context import _collect_pre_llm_call_context

    return _collect_pre_llm_call_context(
        _agent(platform, session_id), effective_task_id="task", turn_id="t2",
        original_user_message=message, messages=[], conversation_history=[],
    )


def test_both_hooks_are_known_to_this_runtime():
    from hermes_cli.plugins import VALID_HOOKS

    assert {"transform_llm_output", "pre_llm_call"} <= VALID_HOOKS


def test_desktop_chat_platform_name_is_what_the_plugin_keeps(monkeypatch):
    from tui_gateway.server import _resolve_session_platform

    monkeypatch.setenv("HERMES_DESKTOP", "1")
    monkeypatch.delenv("HERMES_DESKTOP_TERMINAL", raising=False)

    assert _resolve_session_platform() == "desktop"


def test_desktop_chat_keeps_the_block_for_the_renderer(plugin):
    assert _transform("desktop") == (REPLY, False)
    assert _pre_llm_context("desktop", "2") == ""


@pytest.mark.parametrize("platform", ("weixin", "feishu", "wecom", "dingtalk", "qqbot"))
def test_im_on_the_desktop_gateway_gets_numbered_text_and_the_number_maps_back(plugin, platform):
    assert _transform(platform) == (NUMBERED, True)

    context = _pre_llm_context(platform, "２")

    assert context.startswith("【下一步】用户回复「２」，就是选了你上一条回复末尾编号里的第 2 项「写成脚本」")
    assert "等于用户说了这句话：\n把第 1 个选题写成 60 秒口播脚本\n" in context
    assert _pre_llm_context(platform, "2") == ""


def test_api_server_only_loses_the_block(plugin):
    assert _transform("api_server") == (VISIBLE, True)
    assert _pre_llm_context("api_server", "1") == ""


def test_topic_library_path_is_under_this_runtimes_home(plugin, tmp_path):
    from hermes_constants import get_hermes_home

    context = _pre_llm_context("desktop", "把这 5 个选题存进我的选题库")

    path = Path(get_hermes_home()) / "apex" / "选题库.md"
    assert str(path).startswith(str(tmp_path / "home"))
    assert context.startswith(f"【选题库】这位用户的选题库是一个 Markdown 文件：{path}")


def test_paid_clips_the_reply_never_showed_are_listed_before_the_block(plugin):
    """hc-1036: four paid clips made and dropped (2026-10-22). The executor's terminal
    post_tool_call notes each local file; the Desktop reply then lists them above the block."""
    from agent.inline_tool_executors import emit_terminal_post_tool_call
    from agent.turn_finalizer import apply_llm_output_transform

    agent = _agent("desktop", "paid")
    for n in range(1, 5):
        path = f"/Users/u/.apexnodes/media/ai{n}.mp4"
        result = json.dumps({"video_url": f"https://apex-nodes.com/m/v{n}", "video_path": path, "media_tag": f"MEDIA:{path}"})
        emit_terminal_post_tool_call(
            agent, function_name="generate_video", function_args={"prompt": "p"}, result=result,
            effective_task_id="task", tool_call_id=f"c{n}", middleware_trace=[], status="ok", duration_ms=1,
        )
    emit_terminal_post_tool_call(
        agent, function_name="generate_video", function_args={"prompt": "p"},
        result="Error executing tool 'generate_video': timed out after 420.0s",
        effective_task_id="task", tool_call_id="c5", middleware_trace=[], status="timeout", duration_ms=420000,
    )
    reply = "成片：/Users/u/Desktop/final.mp4\n\n<!-- apex:next\n再剪一版 | 用没用上的素材再剪一版\n-->"

    final, transformed = apply_llm_output_transform(agent, reply, turn_id="t1", platform="desktop")[:2]

    assert transformed is True
    listed = [line for line in final.splitlines() if line.startswith("- 视频：")]
    assert listed == [f"- 视频：/Users/u/.apexnodes/media/ai{n}.mp4" for n in range(1, 5)]
    assert final.index("ai4.mp4") < final.index("<!-- apex:next")


# What the single-thread Desktop chat gets for two unshown clips (hc-1066); the renderer
# test apps/desktop/src/lib/chat-messages/unshown-media-cards.test.ts reads the same text.
CARDS_NOTE = (
    "这一轮还生成了下面这些素材(都已计费)，上面没给你看：\n\n"
    "MEDIA:/Users/u/.apexnodes/cache/media/竖屏口播_cf68f9ae.mp4\n\n"
    "MEDIA:/Users/u/.apexnodes/cache/media/科技空镜 b-roll_9de0fb22.mp4"
)


def test_single_thread_desktop_gets_media_cards_not_cache_paths(plugin, monkeypatch):
    """hc-1066: the 2026-10-26 reply ended in two raw ~/.apexnodes/cache/media paths. With the
    single-thread switch the main process sets before the engine starts, each unshown clip is its
    own MEDIA: paragraph, which the Desktop renderer draws as a playable card."""
    from agent.inline_tool_executors import emit_terminal_post_tool_call
    from agent.turn_finalizer import apply_llm_output_transform

    monkeypatch.setenv("APEX_SINGLE_THREAD_ACTIVE", "1")
    agent = _agent("desktop", "cards")
    for name in ("竖屏口播_cf68f9ae.mp4", "科技空镜 b-roll_9de0fb22.mp4"):
        path = f"/Users/u/.apexnodes/cache/media/{name}"
        result = json.dumps({"video_url": "", "video_path": path, "media_tag": f"MEDIA:{path}"})
        emit_terminal_post_tool_call(
            agent, function_name="generate_video", function_args={"prompt": "p"}, result=result,
            effective_task_id="task", tool_call_id=name, middleware_trace=[], status="ok", duration_ms=1,
        )
    reply = "做完了。\n\nMEDIA:/Users/u/Downloads/成片_43s.mp4\n\n<!-- apex:next\n再剪一版 | 用没用上的素材再剪一版\n-->"

    final, transformed = apply_llm_output_transform(agent, reply, turn_id="t1", platform="desktop")[:2]

    assert transformed is True
    assert f"\n\n{CARDS_NOTE}\n\n<!-- apex:next" in final
    assert "- 视频" not in final


@pytest.mark.parametrize(("platform", "switch"), (("desktop", "0"), ("desktop", "true"), ("cli", "1"), ("weixin", "1")))
def test_media_cards_need_the_desktop_chat_and_the_main_process_switch(plugin, monkeypatch, platform, switch):
    monkeypatch.setenv("APEX_SINGLE_THREAD_ACTIVE", switch)

    assert plugin.media_cards(platform) is False
    assert plugin.media_cards("desktop") is (switch == "1")


def test_desktop_config_example_enables_the_plugin():
    text = (REPO_ROOT / "cli-config.yaml.example").read_text(encoding="utf-8")
    block = text.split("\nplugins:\n  enabled:\n", 1)[1].split("\n  clone_timeout_seconds:", 1)[0]
    enabled = [line.strip()[2:] for line in block.splitlines() if line.startswith("    - ")]

    assert "apexnodes-next-steps" in enabled
    assert enabled[0] == "apex-overlay"
