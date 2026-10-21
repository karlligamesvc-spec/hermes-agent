"""hc-976: every Chinese IM channel turns the runtime's session banners into one plain sentence.

For WeChat, WeCom, WeCom callback, DingTalk, QQ and Feishu, in zh and en, the gateway renders the
banners for real — ``_hmwa_deliver_auto_reset_notice`` and ``_handle_reset_command`` with the real
``t()`` and ``_format_session_info()`` — and hands them to the channel's real adapter with the
``cn_im_banners`` seam applied. Only the platform transport underneath each adapter's own ``send()``
is replaced, so ``sent`` holds exactly what would have left the process. The auto-reset notice must
arrive as ``gateway.session.auto_reset_plain_notice`` alone; no ◆ line may arrive anywhere. No
translation is spelled out, so a catalog rewording keeps these meaningful.
"""

import asyncio
import json
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from datetime import datetime
from types import SimpleNamespace
from typing import Any, Callable
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agent import i18n
from apex_overlay import cn_im_banners
from gateway.config import GatewayConfig, Platform, PlatformConfig
from gateway.platforms.base import BasePlatformAdapter
from gateway.platforms.event import MessageEvent
from gateway.run import GatewayRunner
from gateway.session import SessionEntry, SessionSource, build_session_key

MODEL = "deepseek-v4-pro"
CUSTOM_RUNTIME = {"provider": "custom", "base_url": "", "api_key": ""}
TIP = "TIP-SENTINEL"


def _payload(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def _weixin(monkeypatch, sent: list[str]):
    from gateway.platforms import weixin

    async def transport(_session, *, text, **_kwargs):
        sent.append(text)
        return {"ret": 0}

    monkeypatch.setattr(weixin, "_send_message", transport)
    adapter = weixin.WeixinAdapter(PlatformConfig(enabled=True, token="test-token", extra={"account_id": "test-account"}))
    adapter._session = adapter._send_session = object()
    adapter._token = "test-token"
    adapter._base_url = "https://weixin.example.com"
    adapter._token_store.get = lambda account_id, chat_id: "ctx-token"
    adapter._send_chunk_delay_seconds = 0
    return adapter


def _wecom(monkeypatch, sent: list[str]):
    from plugins.platforms.wecom.adapter import WeComAdapter

    async def transport(_target, body, *_args, **_kwargs):
        sent.append(_payload(body))
        return {"errcode": 0, "headers": {"req_id": "req-1"}}

    adapter = WeComAdapter(PlatformConfig(enabled=True))
    adapter._send_request = transport
    adapter._send_reply_request = transport
    return adapter


def _wecom_callback(monkeypatch, sent: list[str]):
    from plugins.platforms.wecom.callback_adapter import WecomCallbackAdapter

    app = {"name": "test-app", "corp_id": "ww1234567890", "corp_secret": "test-secret", "agent_id": "1000002",
           "token": "test-callback-token", "encoding_aes_key": "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"}

    class _Client:
        async def post(self, _url, json=None, **_kwargs):
            sent.append(_payload(json))
            return SimpleNamespace(json=lambda: {"errcode": 0, "msgid": "msg-1"})

    adapter = WecomCallbackAdapter(PlatformConfig(
        enabled=True, extra={"mode": "callback", "host": "127.0.0.1", "port": 0, "apps": [app]}))
    adapter._access_tokens["test-app"] = {"token": "tok", "expires_at": 9999999999}
    adapter._user_app_map["ww1234567890:alice"] = "test-app"
    adapter._http_client = _Client()
    return adapter


def _dingtalk(monkeypatch, sent: list[str]):
    from plugins.platforms.dingtalk.adapter import DingTalkAdapter

    async def post(_url, json=None, **_kwargs):
        sent.append(_payload(json))
        return SimpleNamespace(status_code=200, text="OK")

    adapter = DingTalkAdapter(PlatformConfig(enabled=True))
    adapter._http_client = SimpleNamespace(post=post)
    # The session webhook an inbound message leaves behind; a reply cannot go out without one.
    adapter._session_webhooks["cid-ding"] = ("https://dingtalk.example/webhook", 0)
    return adapter


def _qqbot(monkeypatch, sent: list[str]):
    from gateway.platforms.qqbot import QQAdapter

    async def api_request(_method, _path, body=None, *_args, **_kwargs):
        sent.append(_payload(body))
        return {"id": "msg-1"}

    adapter = QQAdapter(PlatformConfig(enabled=True, extra={"app_id": "a", "client_secret": "b"}))
    adapter._running = True
    adapter._ws = SimpleNamespace(closed=False)
    adapter._http_client = MagicMock()
    adapter._api_request = api_request
    adapter._ensure_token = AsyncMock()
    return adapter


def _feishu(monkeypatch, sent: list[str]):
    from plugins.platforms.feishu.adapter import FeishuAdapter

    async def send_with_retry(*, chat_id, msg_type, payload, reply_to, metadata):
        sent.append(payload)
        return SimpleNamespace(success=lambda: True, data=SimpleNamespace(message_id="om_1"))

    adapter = FeishuAdapter(PlatformConfig())
    adapter._client = object()
    adapter._feishu_send_with_retry = send_with_retry
    return adapter


@dataclass(frozen=True)
class Channel:
    key: str
    platform: Platform
    chat_id: str
    build: Callable[[pytest.MonkeyPatch, list[str]], BasePlatformAdapter]


CHANNELS = [
    Channel("weixin", Platform.WEIXIN, "wxid_test123", _weixin),
    Channel("wecom", Platform.WECOM, "wecom-user-1", _wecom),
    Channel("wecom_callback", Platform.WECOM_CALLBACK, "ww1234567890:alice", _wecom_callback),
    Channel("dingtalk", Platform.DINGTALK, "cid-ding", _dingtalk),
    Channel("qqbot", Platform.QQBOT, "qq-openid-1", _qqbot),
    Channel("feishu", Platform.FEISHU, "oc_chat", _feishu),
]
ids = [channel.key for channel in CHANNELS]


def _adapter_classes() -> list[type]:
    from gateway.platforms.qqbot import QQAdapter
    from gateway.platforms.weixin import WeixinAdapter
    from plugins.platforms.dingtalk.adapter import DingTalkAdapter
    from plugins.platforms.feishu.adapter import FeishuAdapter
    from plugins.platforms.wecom.adapter import WeComAdapter
    from plugins.platforms.wecom.callback_adapter import WecomCallbackAdapter

    return [WeixinAdapter, WeComAdapter, WecomCallbackAdapter, DingTalkAdapter, QQAdapter, FeishuAdapter]


@pytest.fixture
def seam(monkeypatch):
    """The seam applied as the apex-overlay plugin does at boot; every patched attribute is put back."""
    monkeypatch.setattr(BasePlatformAdapter, "__init__", BasePlatformAdapter.__dict__["__init__"])
    for cls in _adapter_classes():
        monkeypatch.setattr(cls, "send", cls.__dict__["send"])
    monkeypatch.setattr(cn_im_banners, "_APPLIED", False)
    assert cn_im_banners.apply() is True


@pytest.fixture
def language(monkeypatch):
    def use(lang):
        monkeypatch.setenv("HERMES_LANGUAGE", lang)
        i18n.reset_language_cache()

    yield use
    i18n.reset_language_cache()


@contextmanager
def _model_resolution(tmp_path):
    """What ``_format_session_info()`` resolves, without config files or network."""
    with ExitStack() as stack:
        stack.enter_context(patch("gateway.run._hermes_home", tmp_path))
        stack.enter_context(patch("gateway.run._resolve_gateway_model", return_value=MODEL))
        stack.enter_context(patch("gateway.run._resolve_runtime_agent_kwargs", return_value=CUSTOM_RUNTIME))
        stack.enter_context(patch("hermes_cli.tips.get_random_tip", return_value=TIP))
        yield stack


def _source(channel: Channel) -> SessionSource:
    return SessionSource(platform=channel.platform, chat_id=channel.chat_id, user_id="u1", chat_type="dm")


def _deliver_auto_reset_notice(channel: Channel, adapter, tmp_path) -> list[str]:
    """Run the runtime's own auto-reset delivery to ``adapter``; returns what it handed to ``send()``."""
    handed: list[str] = []
    real_send = adapter.send

    async def spy_send(chat_id, content, reply_to=None, metadata=None):
        handed.append(content)
        return await real_send(chat_id, content, reply_to=reply_to, metadata=metadata)

    adapter.send = spy_send
    runner = GatewayRunner.__new__(GatewayRunner)
    runner.config = SimpleNamespace(multiplex_profiles=False)
    entry = SimpleNamespace(auto_reset_reason="suspended")
    with _model_resolution(tmp_path) as stack:
        stack.enter_context(patch.object(GatewayRunner, "_delivery_adapter_for", return_value=adapter))
        stack.enter_context(patch.object(GatewayRunner, "_thread_metadata_for_source", return_value=None))
        asyncio.run(runner._hmwa_deliver_auto_reset_notice(entry, _source(channel), []))
    return handed


def _reset_runner(source: SessionSource) -> GatewayRunner:
    """A runner that can run the real ``/new`` handler for ``source`` (recipe of test_session_model_reset)."""
    runner = object.__new__(GatewayRunner)
    runner.config = GatewayConfig(platforms={source.platform: PlatformConfig(enabled=True)})
    runner.adapters = {}
    runner._voice_mode = {}
    runner.hooks = SimpleNamespace(emit=AsyncMock(), loaded_hooks=False)
    runner._session_model_overrides = {}
    runner._session_reasoning_overrides = {}
    runner._pending_model_notes = {}
    runner._background_tasks = set()
    session_key = build_session_key(source)
    entry = SessionEntry(session_key=session_key, session_id="sess-1", created_at=datetime.now(),
                         updated_at=datetime.now(), platform=source.platform, chat_type="dm")
    runner.session_store = MagicMock()
    runner.session_store.get_or_create_session.return_value = entry
    runner.session_store.reset_session.return_value = entry
    runner.session_store._entries = {session_key: entry}
    runner.session_store._generate_session_key.return_value = session_key
    runner._running_agents = {}
    runner._pending_messages = {}
    runner._pending_approvals = {}
    runner._session_db = None
    runner._agent_cache_lock = None
    runner._is_user_authorized = lambda _source: True
    return runner


@pytest.mark.parametrize("lang", ["zh", "en"])
@pytest.mark.parametrize("channel", CHANNELS, ids=ids)
def test_auto_reset_notice_arrives_as_the_plain_sentence(channel, lang, seam, language, monkeypatch, tmp_path):
    language(lang)
    sent: list[str] = []
    adapter = channel.build(monkeypatch, sent)

    handed = _deliver_auto_reset_notice(channel, adapter, tmp_path)

    # The runtime really rendered its notice, with the ◆ session lines, in the chat's language.
    notice_rows = i18n.t("gateway.session.auto_reset_notice").strip("\n").split("\n")
    assert len(handed) == 1 and notice_rows[0] in handed[0] and MODEL in handed[0]
    if lang != "en":
        assert i18n.t("gateway.session.auto_reset_notice", lang="en").split("\n")[0] not in handed[0]
    # One message went out: the plain sentence, in that language, and nothing of the banners.
    assert len(sent) == 1
    assert i18n.t("gateway.session.auto_reset_plain_notice") in sent[0]
    assert not any(row in sent[0] for row in notice_rows)
    assert MODEL not in sent[0] and "◆" not in sent[0] and "◐" not in sent[0]


@pytest.mark.parametrize("lang", ["zh", "en"])
@pytest.mark.parametrize("channel", CHANNELS, ids=ids)
def test_new_reply_keeps_its_header_and_loses_the_session_lines(channel, lang, seam, language, monkeypatch, tmp_path):
    language(lang)
    sent: list[str] = []
    adapter = channel.build(monkeypatch, sent)
    source = _source(channel)
    with _model_resolution(tmp_path):
        reply = asyncio.run(_reset_runner(source)._handle_reset_command(
            MessageEvent(text="/new", source=source, message_id="m1")))
    assert MODEL in reply  # the runtime put its ◆ lines into the /new reply

    result = asyncio.run(adapter._send_with_retry(chat_id=channel.chat_id, content=str(reply)))

    delivered = "\n".join(sent)
    assert result.success
    assert i18n.t("gateway.reset.header_default") in delivered
    assert TIP in delivered
    assert MODEL not in delivered and "◆" not in delivered


@pytest.mark.parametrize("channel", CHANNELS, ids=ids)
def test_kill_switch_lets_the_platform_banners_through(channel, seam, language, monkeypatch, tmp_path):
    """``<PLATFORM>_FILTER_RUNTIME_BANNERS=false`` restores the unfiltered send, and proves the
    transport stub above really sees what ``send()`` delivers."""
    language("zh")
    monkeypatch.setenv(f"{channel.key.upper()}_FILTER_RUNTIME_BANNERS", "false")
    sent: list[str] = []
    adapter = channel.build(monkeypatch, sent)

    _deliver_auto_reset_notice(channel, adapter, tmp_path)

    assert MODEL in "\n".join(sent)
