"""hc-1071 the whole chain with a scripted model: the card, the buttons, the IM numbers.

The section only tells the model what to do; everything after the model already
existed. These tests play the turn the rules ask for through the real pieces:
``AIAgent.run_conversation`` with a fake chat client, the real clarify tool, the
Desktop bridge ``tui_gateway.server._clarify_block`` (its request is what draws the
card), the base IM adapter's numbered clarify text, and apexnodes-next-steps'
real hooks registered on the plugin manager.

1. Desktop, single-thread mode on: the model's first request carries the section;
   it asks one question on a card (no recommended mark for a taste question); the
   answer reaches the model; the reply's offer block survives for the renderer and
   parses to 「做吧」 then 「先不用」.
2. An IM chat: the same question goes out as a numbered list, the reply's block
   becomes 「接下来可以：1. 做吧 2. 先不用 回复数字就行。」, and answering 「1」 hands
   the model the 「做吧」 sentence, so the offered job starts only on that yes.
3. Switch off: the model gets no section, and the rest of the chain is unchanged.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from apex_overlay import proactive_prompt, single_thread_prompt
from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import BasePlatformAdapter, SendResult
from hermes_cli import plugins
from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest
from run_agent import AIAgent
from tools import clarify_gateway
from tools.clarify_tool import CLARIFY_SCHEMA
from tui_gateway import server, server_requests

ROOT = Path(__file__).resolve().parents[2]

QUESTION = "成片要配背景音乐吗？"
CHOICES = ["配轻快的纯音乐", "不配，只留人声", "我发一首给你"]
OFFER = (
    "成片好了：43 秒竖屏，字幕已加，配的是轻快的纯音乐。\n"
    "另外你说过也发小红书，要不要我顺手把小红书版做了？竖图加笔记文案。"
)
OFFER_REPLY = f"{OFFER}\n\n<!-- apex:next\n做吧 | 好，把小红书版也做了\n先不用 | 先不用，就到这\n-->"


@pytest.fixture(autouse=True)
def _env(monkeypatch, tmp_path):
    monkeypatch.delenv(single_thread_prompt.SWITCH_ENV, raising=False)
    monkeypatch.delenv("NEXT_STEPS_DISABLE", raising=False)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "apexnodes"))
    monkeypatch.setattr(
        "agent.coding_context.build_coding_workspace_block",
        lambda cwd=None: "Workspace (snapshot at session start):\n- Root: /pinned",
    )


def _next_steps_module():
    spec = importlib.util.spec_from_file_location(
        "hc1071_chain_next_steps", ROOT / "plugins" / "apexnodes-next-steps" / "__init__.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def next_steps(monkeypatch):
    """The overlay's two prompt sections plus apexnodes-next-steps' real hooks, on one manager."""
    module = _next_steps_module()
    manager = PluginManager()
    manager._discovered = True
    overlay = PluginContext(PluginManifest(name="apex-overlay", key="apex-overlay", source="bundled"), manager)
    assert single_thread_prompt.apply(overlay) and proactive_prompt.apply(overlay)
    module.register(
        PluginContext(PluginManifest(name="apexnodes-next-steps", key="apexnodes-next-steps", source="bundled"), manager)
    )
    monkeypatch.setattr(plugins, "_plugin_manager", manager)
    return module


def _clarify_call() -> SimpleNamespace:
    args = {"questions": [{"question": QUESTION, "choices": CHOICES, "recommended": False}]}
    return SimpleNamespace(
        id="call-clarify",
        type="function",
        function=SimpleNamespace(name="clarify", arguments=json.dumps(args, ensure_ascii=False)),
    )


def _response(content: str, tool_calls=None) -> SimpleNamespace:
    message = SimpleNamespace(content=content, tool_calls=tool_calls)
    choice = SimpleNamespace(message=message, finish_reason="tool_calls" if tool_calls else "stop")
    return SimpleNamespace(choices=[choice], model="test/model", usage=None)


def _agent(platform: str, session_id: str) -> AIAgent:
    with (
        patch("model_tools.get_tool_definitions", return_value=[{"type": "function", "function": CLARIFY_SCHEMA}]),
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
    agent._use_prompt_caching = False
    agent.compression_enabled = False
    agent.save_trajectories = False
    return agent


def _run(agent: AIAgent, message: str) -> dict:
    with (
        patch.object(agent, "_persist_session"),
        patch.object(agent, "_save_trajectory"),
        patch.object(agent, "_cleanup_task_resources"),
    ):
        return agent.run_conversation(message)


def _sent(agent: AIAgent, call: int) -> list[dict]:
    return agent.client.chat.completions.create.call_args_list[call].kwargs["messages"]


def _system(agent: AIAgent) -> str:
    content = _sent(agent, 0)[0]["content"]
    return content if isinstance(content, str) else "".join(part.get("text", "") for part in content)


def _answer(agent: AIAgent) -> str:
    """The clarify tool result the model got back in its second request."""
    tool = next(m for m in _sent(agent, 1) if m.get("role") == "tool" and m.get("tool_call_id") == "call-clarify")
    return json.loads(tool["content"])["responses"][0]["user_response"]


@pytest.mark.parametrize("switch", ["1", ""], ids=["single-thread-on", "switch-off"])
def test_desktop_card_then_the_offer_buttons(monkeypatch, next_steps, switch):
    if switch:
        monkeypatch.setenv(single_thread_prompt.SWITCH_ENV, switch)
    cards = []

    def send(method, sid, params, timeout=None, qids=None):
        cards.append((method, sid, params["questions"]))
        # The user clicks the first choice on the card.
        return {"answers": {q["qid"]: q["choices"][0] for q in params["questions"]}, "outcome": "submitted"}

    monkeypatch.setattr(server_requests, "send", send)
    agent = _agent("desktop", "desktop-chain")
    agent.clarify_callback = lambda questions: server._clarify_block("sid-desktop", questions)
    agent.client.chat.completions.create.side_effect = [
        _response("", [_clarify_call()]),
        _response(OFFER_REPLY),
    ]

    result = _run(agent, "这 4 段素材剪成 1 分钟内的竖屏 vlog")

    assert (proactive_prompt.PROACTIVE_PROMPT in _system(agent)) is bool(switch)
    assert ("## Plugin Context: apex.proactive" in _system(agent)) is bool(switch)
    # One card, one question, the choices as the model wrote them: a taste question carries no mark.
    assert [(method, [(q["question"], q["choices"]) for q in questions]) for method, _, questions in cards] == [
        ("clarify", [(QUESTION, CHOICES)])
    ]
    assert _answer(agent) == "配轻快的纯音乐"
    # Desktop keeps the block: the renderer draws it, the first button filled.
    assert result["final_response"] == OFFER_REPLY
    assert next_steps.parse_next_steps(result["final_response"]) == (
        OFFER,
        {"failed": None, "options": [("做吧", "好，把小红书版也做了"), ("先不用", "先不用，就到这")]},
    )


class _ImAdapter(BasePlatformAdapter):
    def __init__(self):
        super().__init__(PlatformConfig(enabled=True, token="***"), Platform.WEIXIN)
        self.sent: list[str] = []

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        return True

    async def disconnect(self) -> None:
        return None

    async def send(self, chat_id, content, reply_to=None, metadata=None) -> SendResult:
        self.sent.append(content)
        return SendResult(success=True, message_id=f"m-{len(self.sent)}")

    async def get_chat_info(self, chat_id: str):
        return {"id": chat_id}


def test_im_question_is_numbered_text():
    adapter = _ImAdapter()
    clarify_gateway.register("im-q", "im-session", QUESTION, CHOICES)
    try:
        asyncio.run(adapter.send_clarify("chat-1", QUESTION, CHOICES, "im-q", "im-session"))
    finally:
        clarify_gateway.clear_session("im-session")

    [text] = adapter.sent
    lines = [line.strip() for line in text.splitlines()]
    assert lines[0].endswith(QUESTION)
    assert [line for line in lines if line[:2] in ("1.", "2.", "3.")] == [
        "1. 配轻快的纯音乐",
        "2. 不配，只留人声",
        "3. 我发一首给你",
    ]


def test_im_offer_is_numbered_and_answering_1_hands_over_the_yes(monkeypatch, next_steps):
    monkeypatch.setenv(single_thread_prompt.SWITCH_ENV, "1")
    agent = _agent("weixin", "weixin-chain")
    # The gateway resolves the numbered question from the user's text reply.
    agent.clarify_callback = lambda questions: {"answers": {questions[0]["qid"]: CHOICES[1]}, "outcome": "submitted"}
    agent.client.chat.completions.create.side_effect = [
        _response("", [_clarify_call()]),
        _response(OFFER_REPLY),
        _response("好，小红书版做好了：竖图 3 张加一篇笔记文案。"),
    ]

    first = _run(agent, "这 4 段素材剪成 1 分钟内的竖屏 vlog")

    assert _answer(agent) == "不配，只留人声"
    assert first["final_response"] == f"{OFFER}\n\n接下来可以：\n1. 做吧\n2. 先不用\n回复数字就行。"
    assert "<!--" not in first["final_response"]

    _run(agent, "1")

    user = [m for m in _sent(agent, 2) if m.get("role") == "user"][-1]["content"]
    text = user if isinstance(user, str) else "".join(part.get("text", "") for part in user)
    assert text.startswith("1")
    assert "第 1 项「做吧」" in text
    assert "等于用户说了这句话：\n好，把小红书版也做了\n直接照这句话做" in text


def test_im_reply_other_than_a_number_starts_nothing(monkeypatch, next_steps):
    monkeypatch.setenv(single_thread_prompt.SWITCH_ENV, "1")
    agent = _agent("weixin", "weixin-chain-no")
    agent.clarify_callback = lambda questions: {"answers": {questions[0]["qid"]: CHOICES[0]}, "outcome": "submitted"}
    agent.client.chat.completions.create.side_effect = [
        _response("", [_clarify_call()]),
        _response(OFFER_REPLY),
        _response("好，就到这。"),
    ]

    _run(agent, "这 4 段素材剪成 1 分钟内的竖屏 vlog")
    _run(agent, "先不用了")

    user = [m for m in _sent(agent, 2) if m.get("role") == "user"][-1]["content"]
    text = user if isinstance(user, str) else "".join(part.get("text", "") for part in user)
    assert "【下一步】" not in text
    assert "好，把小红书版也做了" not in text
