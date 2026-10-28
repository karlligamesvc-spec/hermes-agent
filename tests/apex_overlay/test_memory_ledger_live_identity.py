"""hc-1097 共用记忆实时 · golden: with the ledger unchanged, a session gets what fork main sent.

Recorded on fork main 966a3aa6, before the live seam existed. A real ``AIAgent`` runs three turns
of one conversation with a scripted chat client while the ledger mirror stays the same, and the
golden holds what the model was sent: the system prompt and every user message, byte for byte, for
APEX alone, for APEX and for a named assistant with several assistants on, and for a subagent and a
cron run. It also holds the overlay's apex tools and their schemas. The golden keeps the plugin
sections of the system prompt (the rest names this machine's temp paths); later tests compare the
whole prompt with and without a seam in the same run.

The ledger segments come from the cloud's own renderer (``__identity__/memory-ledger-live/
segments.json``), so the section is the text Desktop mirrors.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

import hermes_yaml as yaml
from apex_overlay import assistant_name, memory_ledger, single_thread_prompt
from hermes_cli import plugins
from hermes_cli.plugins import PLUGIN_SECTIONS_END, PLUGIN_SECTIONS_START, PluginContext, PluginManager, PluginManifest
from run_agent import AIAgent
from tools.registry import registry

IDENTITY = Path(__file__).parent / "__identity__" / "memory-ledger-live"
GOLDEN = IDENTITY / "before-hc1097.json"
SEGMENTS = json.loads((IDENTITY / "segments.json").read_text(encoding="utf-8"))
TURNS = ("我的账号叫什么？", "那上一条做到哪了？", "好的，谢谢")

# case → (multi-bot on, the profile the engine serves, platform, turns)
CASES = {
    "apex-alone": (False, "", "desktop", 3),
    "multi-bot-apex": (True, "", "desktop", 3),
    "multi-bot-named": (True, "cut", "desktop", 3),
    "subagent": (False, "", "subagent", 1),
    "cron": (False, "", "cron", 1),
}

# The seams this golden covers. hc-1097 adds its own to this list; the bytes must not move.
SEAMS = (memory_ledger, single_thread_prompt, assistant_name)


@pytest.fixture
def root(tmp_path, monkeypatch):
    home = tmp_path / "apexnodes"
    (home / "apex").mkdir(parents=True)
    (home / "apex" / "memory-ledger-prompt.md").write_text(SEGMENTS["base"] + "\n", encoding="utf-8")
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv(single_thread_prompt.SWITCH_ENV, "1")
    monkeypatch.delenv(assistant_name.SWITCH_ENV, raising=False)
    monkeypatch.setattr(assistant_name, "_told", {})
    monkeypatch.setattr(
        "agent.coding_context.build_coding_workspace_block",
        lambda cwd=None: "Workspace (snapshot at session start):\n- Root: /pinned",
    )
    return home


def _manager(*seams) -> PluginManager:
    manager = PluginManager()
    manager._discovered = True
    ctx = PluginContext(PluginManifest(name="apex-overlay", key="apex-overlay", source="bundled"), manager)
    for seam in seams:
        assert seam.apply(ctx) is True
    return manager


def _reply(content: str) -> SimpleNamespace:
    message = SimpleNamespace(content=content, tool_calls=None)
    return SimpleNamespace(choices=[SimpleNamespace(message=message, finish_reason="stop")], model="test/model", usage=None)


def _agent(platform: str, session_id: str) -> AIAgent:
    with (
        patch("model_tools.get_tool_definitions", return_value=[]),
        patch("model_tools.check_toolset_requirements", return_value={}),
        patch("agent.process_bootstrap.OpenAI"),
    ):
        agent = AIAgent(
            api_key="test-key-1234567890",
            base_url="https://openrouter.ai/api/v1",
            model="test/model",
            platform=platform,
            quiet_mode=True,
            skip_context_files=True,
            skip_memory=True,
            session_id=session_id,
        )
    agent.client = MagicMock()
    agent.client.chat.completions.create.side_effect = [_reply(f"好的（第 {n} 轮）") for n in range(1, 9)]
    agent._use_prompt_caching = False
    agent.compression_enabled = False
    agent.save_trajectories = False
    return agent


def run_turns(agent: AIAgent, turns: int, between=None) -> list[list[dict]]:
    """Run ``turns`` turns of one conversation; returns the messages sent on each turn's first call.

    ``between(n)`` runs after turn ``n`` (1-based) and before the next one.
    """
    history = None
    for n, text in enumerate(TURNS[:turns], start=1):
        with (
            patch.object(agent, "_persist_session"),
            patch.object(agent, "_save_trajectory"),
            patch.object(agent, "_cleanup_task_resources"),
        ):
            result = agent.run_conversation(text, conversation_history=history)
        history = result["messages"]
        if between is not None:
            between(n)
    calls = agent.client.chat.completions.create.call_args_list
    return [call.kwargs["messages"] for call in calls]


def _text(content) -> str:
    return content if isinstance(content, str) else "".join(part.get("text", "") for part in content)


def system_prompt(sent: list[list[dict]]) -> str:
    """The conversation's one system prompt: it must not change between turns."""
    systems = {_text(messages[0]["content"]) for messages in sent}
    assert len(systems) == 1, "the system prompt must not change between turns"
    return systems.pop()


def snapshot(sent: list[list[dict]]) -> dict:
    """What the model saw that does not depend on this machine: the plugin sections and each turn's message.

    The rest of the system prompt names temp paths and the host, so the golden keeps the sections; the
    whole prompt is compared live, with and without a seam, in the same environment.
    """
    system = system_prompt(sent)
    start = system.index(PLUGIN_SECTIONS_START)
    end = system.index(PLUGIN_SECTIONS_END) + len(PLUGIN_SECTIONS_END)
    return {
        "plugin_sections": system[start:end],
        "user": [_text([m for m in messages if m["role"] == "user"][-1]["content"]) for messages in sent],
    }


def setup_case(root: Path, monkeypatch, case: str) -> tuple[str, int]:
    """Point the engine at the case's profile and switches; returns its platform and turn count."""
    multi, profile, platform, turns = CASES[case]
    if multi:
        monkeypatch.setenv(assistant_name.SWITCH_ENV, "1")
    if profile:
        home = root / "profiles" / profile
        home.mkdir(parents=True)
        (home / "SOUL.md").write_text(
            assistant_name.SOUL_NAME_LINE.format(name="小剪") + "\n", encoding="utf-8"
        )
        (home / "profile.yaml").write_text(
            yaml.safe_dump({"ui_meta": {"apex": {"name": "小剪", "shape": "circle", "color": "violet"}}}),
            encoding="utf-8",
        )
        monkeypatch.setenv("HERMES_HOME", str(home))
    return platform, turns


@pytest.fixture
def seams(monkeypatch):
    import model_tools

    def install(*modules):
        model_tools._clear_tool_defs_cache()
        manager = _manager(*modules)
        monkeypatch.setattr(plugins, "_plugin_manager", manager)
        monkeypatch.setattr(plugins, "_plugin_managers_by_home", {})
        return manager

    try:
        yield install
    finally:
        for name in (memory_ledger.TOOL_NAME, assistant_name.TOOL_NAME):
            registry.deregister(name)
        model_tools._clear_tool_defs_cache()


def capture(root, monkeypatch, seams, modules) -> dict:
    """Every case's conversation with ``modules`` registered, plus the overlay's apex tool schemas."""
    import model_tools

    cases = {}
    for case in CASES:
        with monkeypatch.context() as scoped:
            platform, turns = setup_case(root, scoped, case)
            scoped.setattr(assistant_name, "_told", {})
            seams(*modules)
            cases[case] = snapshot(run_turns(_agent(platform, f"20261028_090700_{case}"), turns))
        model_tools._clear_tool_defs_cache()
    apex = sorted(name for name in registry.get_all_tool_names() if name.startswith("apex_"))
    return {"cases": cases, "apex_tool_schemas": {name: registry.get_entry(name).schema for name in apex}}


def test_unchanged_ledger_sends_what_main_sent(root, monkeypatch, seams):
    with monkeypatch.context() as scoped:
        scoped.setenv(assistant_name.SWITCH_ENV, "1")
        seams(*SEAMS)  # registers every apex tool, apex_rename included, for the schema half
    assert capture(root, monkeypatch, seams, SEAMS) == json.loads(GOLDEN.read_text(encoding="utf-8"))
