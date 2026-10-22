"""hc-1012: a media send that raises must tell the user, like one that returns success=False.

Hosted WeChat assistants (image v2026.8.31) dropped every narration mp3 in silence: the
send raised, ``_deliver_media_attachments``' except branch only logged, and the assistant
went on saying the audio was sent. Main already accepts ``is_voice`` on every adapter
(pinned for Mattermost in test_send_voice_dispatch_signatures.py); this file pins the
WeChat side of that contract and the user notice on the raise path.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from gateway.config import PlatformConfig
from gateway.platforms.base import SendResult
from gateway.platforms.event import MessageEvent
from gateway.platforms.weixin import WeixinAdapter
from gateway.session import Platform, SessionSource


def _weixin() -> tuple[WeixinAdapter, list[str], AsyncMock]:
    adapter = WeixinAdapter(PlatformConfig(enabled=True, token="test-token", extra={"account_id": "test-account"}))
    adapter._session = object()
    adapter._send_session = adapter._session
    adapter._token = "test-token"
    texts: list[str] = []

    async def record_text(chat_id, content, reply_to=None, metadata=None, **_kwargs):
        texts.append(content)
        return SendResult(success=True, message_id=f"text-{len(texts)}")

    adapter.send = record_text
    upload = AsyncMock(return_value="wx-media-1")
    adapter._send_file = upload
    return adapter, texts, upload


def _event() -> MessageEvent:
    return MessageEvent(text="", source=SessionSource(platform=Platform.WEIXIN, chat_id="wxid_kael"))


async def _deliver(adapter, media_files, local_files):
    results: list[SendResult] = []
    await adapter._deliver_media_attachments(
        _event(), media_files, local_files, force_document_attachments=False, human_delay=0,
        metadata={}, record_delivery=results.append)
    return results


@pytest.fixture
def zh_gateway(monkeypatch):
    monkeypatch.setenv("HERMES_LANGUAGE", "zh")


@pytest.mark.asyncio
@pytest.mark.parametrize("is_voice", [False, True])
async def test_weixin_send_voice_takes_is_voice_from_base_dispatch(tmp_path, zh_gateway, is_voice):
    adapter, texts, upload = _weixin()
    narration = tmp_path / "tts_20261021_183745_356162.mp3"
    narration.write_bytes(b"ID3")

    results = await _deliver(adapter, [(str(narration), is_voice)], [])

    assert [r.success for r in results] == [True]
    args, kwargs = upload.call_args
    assert args[1] == str(narration) and kwargs == {"force_file_attachment": True}
    assert texts == []


@pytest.mark.asyncio
async def test_media_send_that_raises_tells_the_user(tmp_path, zh_gateway, caplog):
    adapter, texts, _upload = _weixin()
    narration = tmp_path / "narration.mp3"
    narration.write_bytes(b"ID3")
    adapter.send_voice = AsyncMock(side_effect=RuntimeError("upload exploded"))

    results = await _deliver(adapter, [(str(narration), False)], [])

    assert [(r.success, r.error) for r in results] == [(False, "upload exploded")]
    assert texts == ["⚠️ 无法发送音频附件。"]
    assert ("WARNING", "[Weixin] Error sending media: upload exploded") in [
        (r.levelname, r.getMessage()) for r in caplog.records]


@pytest.mark.asyncio
async def test_failed_result_and_raise_give_the_same_notice(tmp_path, zh_gateway):
    narration = tmp_path / "narration.mp3"
    narration.write_bytes(b"ID3")
    notices = []
    for outcome in (AsyncMock(return_value=SendResult(success=False, error="cdn 500")),
                    AsyncMock(side_effect=RuntimeError("upload exploded"))):
        adapter, texts, _upload = _weixin()
        adapter.send_voice = outcome
        await _deliver(adapter, [(str(narration), False)], [])
        notices.append(texts)

    assert notices[0] == notices[1] == ["⚠️ 无法发送音频附件。"]


@pytest.mark.asyncio
async def test_local_file_send_that_raises_tells_the_user(tmp_path, zh_gateway, caplog):
    adapter, texts, _upload = _weixin()
    script = tmp_path / "口播稿.pdf"
    script.write_bytes(b"%PDF")
    adapter.send_document = AsyncMock(side_effect=RuntimeError("upload exploded"))

    results = await _deliver(adapter, [], [str(script)])

    assert [r.success for r in results] == [False]
    assert texts == ["⚠️ 无法发送文件附件（口播稿.pdf）。"]
    assert ("ERROR", f"[Weixin] Error sending local file {script}: upload exploded") in [
        (r.levelname, r.getMessage()) for r in caplog.records]
