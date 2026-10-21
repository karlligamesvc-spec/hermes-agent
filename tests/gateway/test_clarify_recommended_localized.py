"""A Chinese chat reads the agent's pick as 「（推荐）」, never as "(Recommended)", and a question
with no better answer (``recommended: false``) shows no label at all.

``clarify_tool`` tags the first choice with an English wire marker, and every messaging adapter
renders whatever choices the gateway hands it. Real ``clarify_tool`` + real
``TurnRunner._clarify_callback_sync`` + real ``tools.clarify_gateway`` on a gateway loop thread.
The adapters are the inherited numbered-text prompt (what Feishu, WeCom, DingTalk, QQ, WeChat and
Yuanbao all send) and a native card whose button press returns the text it showed.
"""

import asyncio
import json
import threading
from types import SimpleNamespace

import pytest

from agent import i18n
from gateway.platforms.base import BasePlatformAdapter, SendResult
from tools import clarify_gateway as cm
from tools.clarify_tool import clarify_tool

SESSION = "sk-clarify-zh"
QUESTION = [{"question": "你手上有什么素材？", "choices": ["先出样片", "只要脚本"]}]
SITUATION = [{"question": "你主要拍什么内容？", "choices": ["口播", "剧情", "带货"], "recommended": False}]


class _TextAdapter(BasePlatformAdapter):
    """No native card, so the base numbered-text prompt goes out; ``reply`` is what the user types."""

    def __init__(self, reply):
        self.reply = reply
        self.sent_text: list[str] = []

    def pause_typing_for_chat(self, chat_id):
        return None

    def resume_typing_for_chat(self, chat_id):
        return None

    async def send(self, chat_id, content, reply_to=None, metadata=None):
        self.sent_text.append(content)
        cm.resolve_text_response_for_session(SESSION, self.reply)  # answered once the prompt is seen
        return SendResult(success=True, message_id="t1")

    async def connect(self):
        return True

    async def disconnect(self):
        return None

    async def get_chat_info(self, chat_id):
        return {}


class _CardAdapter(_TextAdapter):
    """A native card; pressing its first button resolves with that button's text, as shown."""

    def __init__(self):
        super().__init__(reply="")
        self.card_choices: list[list[str]] = []

    async def send_clarify(self, **kwargs):
        self.card_choices.append(list(kwargs["choices"]))
        cm.resolve_gateway_clarify(kwargs["clarify_id"], kwargs["choices"][0])
        return SendResult(success=True, message_id="c1")

    async def retire_clarify_card(self, clarify_id, notice):
        return None


@pytest.fixture
def loop():
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    yield loop
    loop.call_soon_threadsafe(loop.stop)
    thread.join(timeout=5)


@pytest.fixture
def language(monkeypatch):
    def use(lang):
        monkeypatch.setenv("HERMES_LANGUAGE", lang)
        i18n.reset_language_cache()

    yield use
    i18n.reset_language_cache()


def _ask(adapter, loop, monkeypatch, questions=QUESTION):
    from gateway.run_turn_runner import TurnRunner

    runner = object.__new__(TurnRunner)
    runner._ctx = SimpleNamespace(
        _status_adapter=adapter, _status_chat_id="42", _status_thread_metadata=None,
        session_key=SESSION, stream_consumer_holder=[None], _loop_for_step=loop)
    runner._close_native_stream_boundary = lambda *a, **k: None
    monkeypatch.setattr(cm, "get_clarify_timeout", lambda: 5)
    return json.loads(clarify_tool(questions, callback=runner._clarify_callback_sync))["responses"][0]


def test_text_prompt_shows_the_label_in_chinese_and_the_pick_comes_back_bare(language, loop, monkeypatch):
    language("zh")
    adapter = _TextAdapter(reply="1")
    response = _ask(adapter, loop, monkeypatch)
    assert "1. 先出样片（推荐）" in adapter.sent_text[0]
    assert "Recommended" not in adapter.sent_text[0]
    assert response["user_response"] == "先出样片"


def test_typing_the_option_exactly_as_shown_answers_it(language, loop, monkeypatch):
    language("zh")
    response = _ask(_TextAdapter(reply="先出样片（推荐）"), loop, monkeypatch)
    assert response["status"] == "answered"
    assert response["user_response"] == "先出样片"


def test_native_card_shows_the_chinese_label_and_its_press_answers_bare(language, loop, monkeypatch):
    language("zh")
    adapter = _CardAdapter()
    response = _ask(adapter, loop, monkeypatch)
    assert adapter.card_choices == [["先出样片（推荐）", "只要脚本"]]
    assert response["user_response"] == "先出样片"


def test_text_prompt_for_a_question_with_no_better_answer_labels_nothing(language, loop, monkeypatch):
    language("zh")
    adapter = _TextAdapter(reply="1")
    response = _ask(adapter, loop, monkeypatch, SITUATION)
    assert "  1. 口播\n  2. 剧情\n  3. 带货\n" in adapter.sent_text[0]
    assert "推荐" not in adapter.sent_text[0]
    assert "Recommended" not in adapter.sent_text[0]
    assert response["user_response"] == "口播"


def test_native_card_for_a_question_with_no_better_answer_labels_nothing(language, loop, monkeypatch):
    language("zh")
    adapter = _CardAdapter()
    response = _ask(adapter, loop, monkeypatch, SITUATION)
    assert adapter.card_choices == [["口播", "剧情", "带货"]]
    assert response["user_response"] == "口播"


def test_english_chat_keeps_the_english_label(language, loop, monkeypatch):
    language("en")
    adapter = _TextAdapter(reply="1")
    response = _ask(adapter, loop, monkeypatch, [{"question": "Which way?", "choices": ["Rebase", "Merge"]}])
    assert "1. Rebase (Recommended)" in adapter.sent_text[0]
    assert response["user_response"] == "Rebase"
