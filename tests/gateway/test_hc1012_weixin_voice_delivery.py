"""hc-1012: hosted WeChat assistants never delivered narration audio.

Production (image v2026.8.31-fork.93446adf, 2026-10-21): the gateway's
delivery loop called ``send_voice(..., is_voice=...)``; ``WeixinAdapter.send_voice``
had no ``**kwargs``, so every audio attachment raised TypeError. The loop's
``except`` branch only logged, so neither the user nor the assistant learned
the audio was missing. Separately, ``text_to_speech`` without ``output_path``
failed on every first call because the chunk step re-checked the tool's own
default directory (``<HERMES_HOME>/cache/audio``) against
``HERMES_WRITE_SAFE_ROOT``, which hosted containers set to ``/opt/data``.

These tests drive the real delivery loop (``_process_message_background``)
with the real ``WeixinAdapter.send_voice`` and stub only the network upload
(``_send_file``) and the text sender.
"""

from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock

import pytest

from agent import tts_registry
from agent.tts_provider import TTSProvider
from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import MessageEvent, MessageType, SendResult
from gateway.platforms.weixin import WeixinAdapter
from gateway.session import SessionSource, build_session_key
from tools import tts_tool

AUDIO_NOTICE_ZH = "⚠️ 无法发送音频附件。"
VOICE_CAPTION_ZH = "[语音消息作为附件]"


def _connected_weixin() -> tuple[WeixinAdapter, list[str], AsyncMock]:
    adapter = WeixinAdapter(
        PlatformConfig(enabled=True, token="test-token", extra={"account_id": "test-account"})
    )
    adapter._session = object()
    adapter._send_session = adapter._session
    adapter._token = "test-token"
    texts: list[str] = []

    async def record_text(chat_id, content, reply_to=None, metadata=None, **_kwargs):
        texts.append(content)
        return SendResult(success=True, message_id=f"text-{len(texts)}")

    adapter.send = record_text
    adapter.send_typing = AsyncMock()
    upload = AsyncMock(return_value="wx-media-1")
    adapter._send_file = upload
    return adapter, texts, upload


def _event() -> MessageEvent:
    source = SessionSource(platform=Platform.WEIXIN, chat_id="wxid_kael", chat_type="dm")
    return MessageEvent(
        text="帮我把这句话配个音",
        message_type=MessageType.TEXT,
        source=source,
        message_id="msg-1",
    )


def _media_file(tmp_path, monkeypatch, name: str):
    root = tmp_path / "media-cache"
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"ID3\x04\x00\x00\x00\x00\x00\x00narration")
    monkeypatch.setattr("gateway.platforms.base.MEDIA_DELIVERY_SAFE_ROOTS", (root,))
    return path.resolve()


@pytest.fixture
def zh_gateway(monkeypatch):
    # Hosted assistants run with display.language: zh; the env var is the
    # resolver's first source and needs no config file.
    monkeypatch.setenv("HERMES_LANGUAGE", "zh")


def test_weixin_send_voice_accepts_is_voice(tmp_path):
    adapter, _texts, upload = _connected_weixin()
    audio = tmp_path / "narration.mp3"
    audio.write_bytes(b"ID3")

    result = asyncio.run(
        adapter.send_voice(chat_id="wxid_kael", audio_path=str(audio), metadata=None, is_voice=True)
    )

    assert result.success is True
    upload.assert_awaited_once_with(
        "wxid_kael", str(audio), "[voice message as attachment]", force_file_attachment=True
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("voice_marker", ["", "[[audio_as_voice]]\n"])
async def test_reply_mp3_reaches_weixin_upload(tmp_path, monkeypatch, zh_gateway, voice_marker):
    """The 2026-10-21 failure: a doubao mp3 in the reply must be uploaded, with no failure notice."""
    adapter, texts, upload = _connected_weixin()
    audio = _media_file(tmp_path, monkeypatch, "tts_20261021_183745_356162.mp3")
    adapter._message_handler = AsyncMock(return_value=f"已配好音。\n{voice_marker}MEDIA:{audio}")

    await adapter._process_message_background(_event(), build_session_key(_event().source))

    upload.assert_awaited_once_with("wxid_kael", str(audio), VOICE_CAPTION_ZH, force_file_attachment=True)
    assert texts == ["已配好音。"]


@pytest.mark.asyncio
async def test_voice_send_that_raises_tells_the_user(tmp_path, monkeypatch, zh_gateway):
    adapter, texts, upload = _connected_weixin()
    audio = _media_file(tmp_path, monkeypatch, "narration.mp3")
    adapter._message_handler = AsyncMock(return_value=f"已配好音。\nMEDIA:{audio}")
    adapter.send_voice = AsyncMock(side_effect=RuntimeError("upload exploded"))

    await adapter._process_message_background(_event(), build_session_key(_event().source))

    adapter.send_voice.assert_awaited_once()
    upload.assert_not_awaited()
    assert texts == ["已配好音。", AUDIO_NOTICE_ZH]


@pytest.mark.asyncio
async def test_voice_send_failure_result_and_exception_share_one_notice(tmp_path, monkeypatch, zh_gateway):
    """success=False already notified before hc-1012; the raise path now says the same words."""
    adapter, texts, _upload = _connected_weixin()
    audio = _media_file(tmp_path, monkeypatch, "narration.mp3")
    adapter._message_handler = AsyncMock(return_value=f"已配好音。\nMEDIA:{audio}")
    adapter.send_voice = AsyncMock(return_value=SendResult(success=False, error="cdn 500"))

    await adapter._process_message_background(_event(), build_session_key(_event().source))

    assert texts == ["已配好音。", AUDIO_NOTICE_ZH]


@pytest.mark.asyncio
async def test_local_file_send_that_raises_tells_the_user(tmp_path, monkeypatch, zh_gateway):
    adapter, texts, _upload = _connected_weixin()
    report = _media_file(tmp_path, monkeypatch, "口播稿.pdf")
    adapter._message_handler = AsyncMock(return_value=f"稿子在这里：{report}")
    adapter.send_document = AsyncMock(side_effect=RuntimeError("upload exploded"))

    await adapter._process_message_background(_event(), build_session_key(_event().source))

    adapter.send_document.assert_awaited_once()
    assert texts[-1] == "⚠️ 无法发送文件附件（口播稿.pdf）。"


# ---------------------------------------------------------------------------
# text_to_speech: first call without output_path succeeds when HERMES_HOME is
# outside HERMES_WRITE_SAFE_ROOT (hosted layout: /home/hermes/.hermes vs /opt/data)
# ---------------------------------------------------------------------------


class _RecordingProvider(TTSProvider):
    def __init__(self):
        self.paths: list[str] = []

    @property
    def name(self) -> str:
        return "hc1012narration"

    def synthesize(self, text, output_path, **_kwargs):
        self.paths.append(output_path)
        with open(output_path, "wb") as handle:
            handle.write(b"ID3\x04\x00\x00\x00\x00\x00\x00" + text.encode("utf-8"))
        return output_path


@pytest.fixture
def hosted_layout(tmp_path, monkeypatch):
    home = tmp_path / "home" / ".hermes"
    data = tmp_path / "opt-data"
    (home / "cache" / "audio").mkdir(parents=True)
    data.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_WRITE_SAFE_ROOT", str(data))
    monkeypatch.setattr(tts_tool, "DEFAULT_OUTPUT_DIR", str(home / "cache" / "audio"))
    monkeypatch.setattr(tts_tool, "_load_tts_config", lambda: {"provider": "hc1012narration"})
    tts_registry._reset_for_tests()
    provider = _RecordingProvider()
    tts_registry.register_provider(provider)
    yield home, data, provider
    tts_registry._reset_for_tests()


def test_tts_default_path_succeeds_outside_write_safe_root(hosted_layout):
    home, _data, provider = hosted_layout

    result = json.loads(tts_tool.text_to_speech_tool(text="今天聊聊短视频的前三秒怎么抓人。"))

    assert result.get("success") is True, result
    assert len(provider.paths) == 1
    assert provider.paths[0].startswith(str(home / "cache" / "audio") + "/")
    assert result["media_tag"].endswith(f"MEDIA:{result['file_path']}")


def test_tts_caller_path_outside_write_safe_root_is_still_refused(hosted_layout):
    home, _data, provider = hosted_layout

    result = json.loads(
        tts_tool.text_to_speech_tool(
            text="配一句话。", output_path=str(home / "workspace" / "media" / "voice1.mp3")
        )
    )

    assert result.get("success") is False
    assert "protected credential or system path" in result["error"]
    assert provider.paths == []


def test_tts_caller_path_inside_write_safe_root_succeeds(hosted_layout):
    _home, data, provider = hosted_layout

    result = json.loads(tts_tool.text_to_speech_tool(text="配一句话。", output_path=str(data / "voice1.mp3")))

    assert result.get("success") is True, result
    assert provider.paths == [str(data / "voice1.mp3")]
