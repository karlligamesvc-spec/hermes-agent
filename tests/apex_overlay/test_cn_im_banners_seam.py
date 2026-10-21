"""Seam-test + behavior test for apex_overlay.cn_im_banners (hc-976).

Pins what the seam binds to, so an upstream rename turns a silently disarmed filter (session banners
reaching Chinese IM users) into a loud CI failure:

* ``gateway.platforms.base.BasePlatformAdapter.__init__(self, config, platform)``, which sets
  ``self.platform``;
* ``send(self, chat_id, content, ...)`` on each filtered adapter class.

Behavior: only classes of FILTERED_PLATFORMS are instrumented, once; the platform is checked again
per call; the reset notice arrives as the plain sentence and a message left empty never reaches the
adapter; the kill switch and filter errors send the text unfiltered. The matcher cases below are hc-457's, moved from tests/gateway/test_weixin.py
with the matcher; the per-language cases are in test_cn_im_banners_i18n.py and the per-channel
delivery guards in test_cn_im_banners_channels.py.

Run via ``scripts/run_tests_parallel.py`` (per-file fresh interpreter).
"""

from __future__ import annotations

import asyncio
import importlib
import inspect

import pytest

from agent import i18n
from apex_overlay import cn_im_banners
from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import BasePlatformAdapter, SendResult

SESSION_RESET_BANNER = (
    "◐ Session automatically reset (inactive for 24h). Conversation history "
    "cleared.\nUse /resume to browse and restore a previous session.\n"
    "Adjust reset timing in config.yaml under session_reset."
)
MODEL_DEBUG_HEADER = "◆ Model: deepseek-v4-pro\n◆ Provider: custom\n◆ Context: 1.0M tokens"


def _plain() -> str:
    """The sentence that replaces the notice, as the catalog renders it in the active language."""
    return i18n.t("gateway.session.auto_reset_plain_notice")

ADAPTER_CLASSES = [
    ("gateway.platforms.weixin", "WeixinAdapter"),
    ("plugins.platforms.wecom.adapter", "WeComAdapter"),
    ("plugins.platforms.wecom.callback_adapter", "WecomCallbackAdapter"),
    ("plugins.platforms.dingtalk.adapter", "DingTalkAdapter"),
    ("gateway.platforms.qqbot.adapter", "QQAdapter"),
    ("plugins.platforms.feishu.adapter", "FeishuAdapter"),
]


class _StandIn(BasePlatformAdapter):
    """A minimal adapter whose transport is a list."""

    def __init__(self, platform: Platform):
        super().__init__(PlatformConfig(enabled=True), platform)
        self.sent: list = []

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        return True

    async def disconnect(self) -> None:
        return None

    async def send(self, chat_id, content, reply_to=None, metadata=None) -> SendResult:
        self.sent.append(content)
        return SendResult(success=True, message_id="m1")

    async def get_chat_info(self, chat_id):
        return {}


class _OtherStandIn(_StandIn):
    """Only ever built for an international platform."""

    async def send(self, chat_id, content, reply_to=None, metadata=None) -> SendResult:
        self.sent.append(content)
        return SendResult(success=True, message_id="m1")


@pytest.fixture
def seam(monkeypatch):
    """The seam applied as the apex-overlay plugin does at boot; every patched attribute is put back."""
    monkeypatch.setattr(BasePlatformAdapter, "__init__", BasePlatformAdapter.__dict__["__init__"])
    for cls in (_StandIn, _OtherStandIn):
        monkeypatch.setattr(cls, "send", cls.__dict__["send"])
    monkeypatch.setattr(cn_im_banners, "_APPLIED", False)
    assert cn_im_banners.apply() is True


def _send(adapter, content):
    return asyncio.run(adapter.send("chat-1", content))


# ---------------------------------------------------------------------------
# Seam assertions — pin the patched symbols' existence + signature
# ---------------------------------------------------------------------------

def test_seam_target_base_init_signature():
    init = BasePlatformAdapter.__dict__.get(cn_im_banners._TARGET_INIT_METHOD)
    assert init is not None, (
        "BasePlatformAdapter defines no __init__ of its own — the banner filter has nowhere to "
        "learn an adapter's platform. Update apex_overlay.cn_im_banners._TARGET_INIT_METHOD."
    )
    params = list(inspect.signature(init).parameters)
    assert params[:3] == ["self", "config", "platform"], (
        f"BasePlatformAdapter.__init__ params changed to {params!r}; the seam reads self.platform "
        f"after the original constructor ran."
    )
    assert _StandIn(Platform.WECOM).platform is Platform.WECOM


@pytest.mark.parametrize("module_name, class_name", ADAPTER_CLASSES, ids=[name for _, name in ADAPTER_CLASSES])
def test_seam_target_send_signature(module_name, class_name):
    adapter_cls = getattr(importlib.import_module(module_name), class_name)
    send = getattr(adapter_cls, cn_im_banners._TARGET_SEND_METHOD, None)
    assert send is not None and inspect.iscoroutinefunction(send), f"{class_name}.send is gone or not async"
    params = list(inspect.signature(send).parameters)
    assert params[:3] == ["self", "chat_id", "content"], (
        f"{class_name}.send params changed to {params!r}; the seam's wrapper forwards "
        f"(self, chat_id, content, ...) with content filtered."
    )


def test_every_filtered_platform_is_a_platform():
    for key in cn_im_banners.FILTERED_PLATFORMS:
        assert Platform(key).value == key


def test_apply_wraps_base_init_once_and_is_idempotent(seam):
    wrapped = BasePlatformAdapter.__dict__["__init__"]
    assert getattr(wrapped, cn_im_banners._MARK, False)
    cn_im_banners._APPLIED = False
    assert cn_im_banners.apply() is True
    assert BasePlatformAdapter.__dict__["__init__"] is wrapped


def test_plugin_register_applies_the_seam():
    from tests.apex_overlay.conftest import run_plugin_register_with_stubbed_seams

    called = run_plugin_register_with_stubbed_seams("_cn_im_banners_plugin_under_test")
    assert "cn_im_banners" in called


# ---------------------------------------------------------------------------
# Behavior — which adapters, which calls
# ---------------------------------------------------------------------------

def test_a_filtered_platform_adapter_class_is_wrapped_once(seam):
    _StandIn(Platform.WEIXIN)
    wrapped = _StandIn.__dict__["send"]
    assert getattr(wrapped, cn_im_banners._MARK, False)
    _StandIn(Platform.DINGTALK)
    assert _StandIn.__dict__["send"] is wrapped


def test_other_platforms_adapter_classes_are_left_alone(seam):
    adapter = _OtherStandIn(Platform.TELEGRAM)
    assert not getattr(_OtherStandIn.__dict__["send"], cn_im_banners._MARK, False)
    _send(adapter, SESSION_RESET_BANNER)
    assert adapter.sent == [SESSION_RESET_BANNER]


def test_the_platform_is_checked_on_every_call(seam):
    """One class serving a filtered and an unfiltered platform filters only the former."""
    wecom, telegram = _StandIn(Platform.WECOM), _StandIn(Platform.TELEGRAM)
    text = f"{MODEL_DEBUG_HEADER}\n\n正文"
    _send(wecom, text)
    _send(telegram, text)
    assert wecom.sent == ["正文"]
    assert telegram.sent == [text]


def test_reset_notice_reaches_the_adapter_as_the_plain_sentence(seam):
    adapter = _StandIn(Platform.FEISHU)
    _send(adapter, f"{SESSION_RESET_BANNER}\n\n{MODEL_DEBUG_HEADER}")
    assert adapter.sent == [_plain()]


def test_a_message_left_empty_never_reaches_the_adapter(seam):
    adapter = _StandIn(Platform.DINGTALK)
    result = _send(adapter, MODEL_DEBUG_HEADER)
    assert result.success is True and result.message_id is None
    assert adapter.sent == []


def test_banner_then_reply_delivers_the_sentence_and_the_reply(seam):
    adapter = _StandIn(Platform.QQBOT)
    _send(adapter, f"{SESSION_RESET_BANNER}\n\n下面是新会话的配置信息。")
    assert adapter.sent == [f"{_plain()}\n\n下面是新会话的配置信息。"]


@pytest.mark.parametrize("content", ["你好！很高兴为你服务。", "", None])
def test_other_content_reaches_the_adapter_unchanged(content, seam):
    adapter = _StandIn(Platform.WECOM_CALLBACK)
    _send(adapter, content)
    assert adapter.sent == [content]


@pytest.mark.parametrize("key", sorted(cn_im_banners.FILTERED_PLATFORMS))
def test_kill_switch_per_platform(key, seam, monkeypatch):
    adapter = _StandIn(Platform(key))
    monkeypatch.setenv(f"{key.upper()}_FILTER_RUNTIME_BANNERS", "false")
    _send(adapter, SESSION_RESET_BANNER)
    monkeypatch.delenv(f"{key.upper()}_FILTER_RUNTIME_BANNERS")
    _send(adapter, SESSION_RESET_BANNER)
    assert adapter.sent == [SESSION_RESET_BANNER, _plain()]  # the second send is filtered (default on)


def test_filter_error_sends_unfiltered(seam, monkeypatch):
    def broken(_text):
        raise RuntimeError("boom")

    monkeypatch.setattr(cn_im_banners, "strip_runtime_banners", broken)
    adapter = _StandIn(Platform.WEIXIN)
    _send(adapter, SESSION_RESET_BANNER)
    assert adapter.sent == [SESSION_RESET_BANNER]


# ---------------------------------------------------------------------------
# Matcher — hc-457's English cases (pre-i18n runtimes, v2026.8.31 image)
# ---------------------------------------------------------------------------

def test_session_reset_banner_becomes_the_plain_sentence():
    result = cn_im_banners.strip_runtime_banners(f"{SESSION_RESET_BANNER}\n\n用户可见的真实回答内容。")
    assert result == f"{_plain()}\n\n用户可见的真实回答内容。"


def test_model_debug_header_stripped():
    result = cn_im_banners.strip_runtime_banners(f"{MODEL_DEBUG_HEADER}\n\n你好！这是我的回答正文。")
    assert result == "你好！这是我的回答正文。"


def test_both_banners_together_leave_the_sentence_and_the_reply():
    result = cn_im_banners.strip_runtime_banners(f"{SESSION_RESET_BANNER}\n{MODEL_DEBUG_HEADER}\n\n真实回答内容。")
    assert result == f"{_plain()}\n\n真实回答内容。"


def test_notice_only_message_becomes_the_plain_sentence():
    assert cn_im_banners.strip_runtime_banners(SESSION_RESET_BANNER) == _plain()


def test_session_lines_only_message_collapses_to_empty():
    assert cn_im_banners.strip_runtime_banners(MODEL_DEBUG_HEADER) == ""


def test_without_the_plain_sentence_the_notice_is_dropped(monkeypatch):
    """A catalog without the key renders the bare key; that must never reach a user."""
    monkeypatch.setattr(cn_im_banners, "_PLAIN_NOTICE_KEY", "gateway.session.no_such_key")
    assert cn_im_banners.strip_runtime_banners(f"{SESSION_RESET_BANNER}\n\n正文") == "正文"


def test_glyph_only_removed_at_line_start_not_mid_sentence():
    text = "你好！◆ Model: deepseek-v4-pro ◆ Provider: custom ◆ Context: 1.0M tokens\n\n正文"
    assert cn_im_banners.strip_runtime_banners(text) == text


def test_empty_and_none_safe():
    assert cn_im_banners.strip_runtime_banners("") == ""
    assert cn_im_banners.strip_runtime_banners(None) is None


@pytest.mark.parametrize(
    "safe_text",
    [
        "你的 Session 已经保存，如果想 reset 可以联系管理员。",
        "我们的 Model 是 deepseek，Provider 是自建，这次 Context 比较长。",
        "请使用 /resume 命令查看历史会话。",
        "◐ 这是一个圆圈符号，不代表任何系统消息。",
        "Model: gpt-4 是很强的模型，这里没有系统横幅前缀。",
        "Use /resume to browse your previous conversations.",
        "正常的微信回复内容，不含任何系统横幅。",
    ],
)
def test_lookalike_organic_text_never_touched(safe_text):
    assert cn_im_banners.strip_runtime_banners(safe_text) == safe_text
