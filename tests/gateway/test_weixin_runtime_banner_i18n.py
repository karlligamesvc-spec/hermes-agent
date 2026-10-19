"""WeChat strips the runtime's session banners in whatever language the i18n catalog renders them (hc-964).

The gateway renders the auto-reset notice (``gateway.session.auto_reset_notice``) and the ◆ session lines
of ``_format_session_info()`` (``gateway.session.info_*``) through ``t()``, so with
``display.language: zh`` they reach ``WeixinAdapter.send()`` in Chinese; the English patterns kept for
older runtimes match none of it. These tests render the banners for real and never spell out a
translation, so a catalog rewording keeps them meaningful.
"""

import asyncio
from contextlib import ExitStack, contextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import hermes_yaml as yaml
import pytest

from agent import i18n
from gateway.config import Platform, PlatformConfig
from gateway.platforms import weixin
from gateway.platforms.weixin import WeixinAdapter
from gateway.run import GatewayRunner
from gateway.session import SessionSource

MODEL = "deepseek-v4-pro"
CUSTOM_RUNTIME = {"provider": "custom", "base_url": "", "api_key": ""}
# MoA plus a local endpoint turns on the two optional ◆ lines (acting model, endpoint).
MOA_LOCAL_RUNTIME = {"provider": "moa", "base_url": "http://localhost:11434/v1", "api_key": ""}
MOA_CONFIG = {"moa": {"presets": {MODEL: {
    "reference_models": [{"provider": "openai", "model": "gpt-5.5"}],
    "aggregator": {"provider": "nous", "model": "claude-opus-4.8"},
}}}}


@pytest.fixture
def language(monkeypatch):
    def use(lang):
        monkeypatch.setenv("HERMES_LANGUAGE", lang)
        i18n.reset_language_cache()

    yield use
    i18n.reset_language_cache()


@pytest.fixture
def overlay(tmp_path, monkeypatch):
    """The profile's own wording: ``$HERMES_HOME/locales/<lang>.yaml`` over the bundled catalog."""
    home = tmp_path / "home"
    (home / "locales").mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(home))

    def write(lang, session_keys):
        (home / "locales" / f"{lang}.yaml").write_text(
            yaml.safe_dump({"gateway": {"session": session_keys}}, allow_unicode=True), encoding="utf-8")
        i18n.reset_language_cache()

    yield write
    i18n.reset_language_cache()


def _connected_adapter() -> WeixinAdapter:
    adapter = WeixinAdapter(PlatformConfig(enabled=True, token="test-token", extra={"account_id": "test-account"}))
    adapter._session = object()
    adapter._send_session = adapter._session
    adapter._token = "test-token"
    adapter._base_url = "https://weixin.example.com"
    adapter._token_store.get = lambda account_id, chat_id: "ctx-token"
    return adapter


def _bare_runner() -> GatewayRunner:
    runner = GatewayRunner.__new__(GatewayRunner)
    runner.config = SimpleNamespace(multiplex_profiles=False)
    return runner


@contextmanager
def _model_resolution(tmp_path, runtime, moa_config=None):
    """What ``_format_session_info()`` resolves, without config files or network."""
    with ExitStack() as stack:
        stack.enter_context(patch("gateway.run._hermes_home", tmp_path))
        stack.enter_context(patch("gateway.run._resolve_gateway_model", return_value=MODEL))
        stack.enter_context(patch("gateway.run._resolve_runtime_agent_kwargs", return_value=runtime))
        if moa_config is not None:
            stack.enter_context(patch("hermes_cli.config.load_config", return_value=moa_config))
        yield stack


def _session_info(tmp_path, runtime=CUSTOM_RUNTIME, moa_config=None) -> str:
    """``GatewayRunner._format_session_info()`` for real, in the active language."""
    with _model_resolution(tmp_path, runtime, moa_config):
        return _bare_runner()._format_session_info()


def _notice_rows(lang=None) -> list[str]:
    return i18n.t("gateway.session.auto_reset_notice", lang=lang).strip("\n").split("\n")


@pytest.mark.parametrize("lang", ["zh", "en"])
@patch("gateway.platforms.weixin._send_message", new_callable=AsyncMock)
def test_runtime_reset_notice_never_reaches_ilink(send_message_mock, lang, language, tmp_path):
    """The real auto-reset notice (headline, /resume line, ◆ session lines) goes out through the real
    WeixinAdapter.send() and nothing of it reaches iLink."""
    language(lang)
    adapter = _connected_adapter()
    handed_to_send: list[str] = []
    real_send = adapter.send

    async def spy_send(chat_id, content, reply_to=None, metadata=None):
        handed_to_send.append(content)
        return await real_send(chat_id, content, reply_to=reply_to, metadata=metadata)

    adapter.send = spy_send
    source = SessionSource(platform=Platform.WEIXIN, chat_id="wxid_test123", user_id="wxid_test123")
    entry = SimpleNamespace(auto_reset_reason="suspended")
    with _model_resolution(tmp_path, CUSTOM_RUNTIME) as stack:
        stack.enter_context(patch.object(GatewayRunner, "_delivery_adapter_for", return_value=adapter))
        stack.enter_context(patch.object(GatewayRunner, "_thread_metadata_for_source", return_value=None))
        asyncio.run(_bare_runner()._hmwa_deliver_auto_reset_notice(entry, source, []))

    # The runtime really rendered and sent its notice, in the chat's language, with the session lines.
    assert len(handed_to_send) == 1
    assert _notice_rows()[0] in handed_to_send[0]
    assert MODEL in handed_to_send[0]
    if lang != "en":
        assert _notice_rows("en")[0] not in handed_to_send[0]
    send_message_mock.assert_not_awaited()


@pytest.mark.parametrize("lang", i18n.SUPPORTED_LANGUAGES)
def test_every_catalog_language_loses_the_banner_and_keeps_the_reply(lang, language, tmp_path):
    language(lang)
    info = _session_info(tmp_path, MOA_LOCAL_RUNTIME, MOA_CONFIG)
    assert "nous:claude-opus-4.8" in info and "localhost:11434" in info  # both optional lines rendered
    text = f"{i18n.t('gateway.session.auto_reset_notice')}\n\n{info}\n\n正文"
    assert weixin._strip_runtime_banners_for_weixin(text) == "正文"


@pytest.mark.parametrize("lang", i18n.SUPPORTED_LANGUAGES)
def test_notice_continuation_line_alone_is_left_alone(lang, language):
    """Without its ◐ headline the "/resume" line may be the agent explaining a real command."""
    language(lang)
    for row in _notice_rows()[1:]:
        text = f"{row}\n\n正文"
        assert weixin._strip_runtime_banners_for_weixin(text) == text


@pytest.mark.parametrize(
    "translated, english_key",
    [
        # The notice is translated; every session line, including acting model and endpoint, falls back.
        ({"auto_reset_notice": "◐ Sesja została zresetowana.\nUżyj /resume, aby wrócić do poprzedniej.\n"},
         "gateway.session.info_acting_model"),
        # The session lines are translated; the notice falls back.
        ({"info_model": "◆ Model AI: `{model}`", "info_provider": "◆ Dostawca: {provider}",
          "info_context": "◆ Kontekst: {tokens} tokenów ({source})",
          "info_acting_model": "◆ Model wykonujący: {provider}:{model}", "info_endpoint": "◆ Punkt końcowy: {url}"},
         "gateway.session.auto_reset_notice"),
    ],
)
def test_partly_translated_language_mixes_with_english_and_both_go(translated, english_key, language, overlay, tmp_path):
    """A language with only some keys translated renders the rest in English: both are stripped."""
    overlay("pl", translated)
    language("pl")
    notice, info = i18n.t("gateway.session.auto_reset_notice"), _session_info(tmp_path, MOA_LOCAL_RUNTIME, MOA_CONFIG)
    text = f"{notice}\n\n{info}\n\n正文"
    own = next(iter(translated.values())).split("\n")[0].split("{")[0]
    english = i18n.t(english_key, lang="en").strip("\n").split("\n")[0].split("{")[0]
    assert own in text and english in text  # really mixed: part translated, part fallen back to English
    assert weixin._strip_runtime_banners_for_weixin(text) == "正文"


@pytest.mark.parametrize(
    "safe_text",
    [
        "◆ 第一点：先写脚本\n◆ 第二点：再剪辑",
        "模型：deepseek-v4-pro，提供方：自建，上下文很长。",
        "你好！◆ 模型：`deepseek-v4-pro` 写在句子中间。",
        "◐ 这只是一个符号。",
        "会话在停止后已重置，这句话是在解释重置是什么意思。",
    ],
)
def test_chinese_lookalike_prose_is_left_alone(safe_text, language):
    language("zh")
    assert weixin._strip_runtime_banners_for_weixin(safe_text) == safe_text


def test_profile_overlay_rewording_is_followed(language, overlay):
    """A cloud ``locales/zh.yaml`` overlay may reword the banner; the filter follows the catalog."""
    overlay("zh", {
        "auto_reset_notice": "◐ 新会话已开始，之前的对话已归档。\n发送 /resume 可以找回之前的会话。\n",
        "info_provider": "◆ 服务方：{provider}",
    })
    language("zh")
    notice = i18n.t("gateway.session.auto_reset_notice")
    provider_line = i18n.t("gateway.session.info_provider", provider="custom")
    assert "归档" in notice and "服务方" in provider_line  # the overlay is what rendered
    text = f"{notice}\n{provider_line}\n正文"
    assert weixin._strip_runtime_banners_for_weixin(text) == "正文"


def test_label_less_overlay_template_never_strips_agent_bullets(language, overlay):
    """``◆ {model}`` has no label to anchor on; it must not turn into "strip every ◆ line"."""
    overlay("zh", {"info_model": "◆ {model}"})
    language("zh")
    bullets = "◆ 第一点：先写脚本\n◆ 第二点：再剪辑"
    assert weixin._strip_runtime_banners_for_weixin(bullets) == bullets
