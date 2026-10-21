"""The runtime banner matcher follows the i18n catalog in every language (hc-964, shared by hc-976).

The gateway renders the auto-reset notice (``gateway.session.auto_reset_notice``) and the ◆ session lines
of ``_format_session_info()`` (``gateway.session.info_*``) through ``t()``, so with
``display.language: zh`` they reach the adapters in Chinese; the English patterns kept for older
runtimes match none of it. These tests render the banners for real and never spell out a translation,
so a catalog rewording keeps them meaningful. The per-channel delivery guards live in
``test_cn_im_banners_channels.py``.
"""

from contextlib import ExitStack, contextmanager
from types import SimpleNamespace
from unittest.mock import patch

import hermes_yaml as yaml
import pytest

from agent import i18n
from apex_overlay import cn_im_banners
from gateway.run import GatewayRunner

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


def _plain(lang=None) -> str:
    return i18n.t("gateway.session.auto_reset_plain_notice", lang=lang)


@pytest.mark.parametrize("lang", i18n.SUPPORTED_LANGUAGES)
def test_every_catalog_language_gets_its_plain_sentence_and_keeps_the_reply(lang, language, tmp_path):
    language(lang)
    info = _session_info(tmp_path, MOA_LOCAL_RUNTIME, MOA_CONFIG)
    assert "nous:claude-opus-4.8" in info and "localhost:11434" in info  # both optional lines rendered
    text = f"{i18n.t('gateway.session.auto_reset_notice')}\n\n{info}\n\n正文"
    assert cn_im_banners.strip_runtime_banners(text) == f"{_plain()}\n\n正文"
    if lang != "en":  # the catalog's own wording, not the English fallback
        assert _plain() != _plain("en")


@pytest.mark.parametrize("lang", i18n.SUPPORTED_LANGUAGES)
def test_notice_continuation_line_alone_is_left_alone(lang, language):
    """Without its ◐ headline the "/resume" line may be the agent explaining a real command."""
    language(lang)
    for row in _notice_rows()[1:]:
        text = f"{row}\n\n正文"
        assert cn_im_banners.strip_runtime_banners(text) == text


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
    """A language with only some keys translated renders the rest in English: both are taken out."""
    overlay("pl", translated)
    language("pl")
    notice, info = i18n.t("gateway.session.auto_reset_notice"), _session_info(tmp_path, MOA_LOCAL_RUNTIME, MOA_CONFIG)
    text = f"{notice}\n\n{info}\n\n正文"
    own = next(iter(translated.values())).split("\n")[0].split("{")[0]
    english = i18n.t(english_key, lang="en").strip("\n").split("\n")[0].split("{")[0]
    assert own in text and english in text  # really mixed: part translated, part fallen back to English
    assert cn_im_banners.strip_runtime_banners(text) == f"{_plain()}\n\n正文"


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
    assert cn_im_banners.strip_runtime_banners(safe_text) == safe_text


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
    assert cn_im_banners.strip_runtime_banners(text) == f"{_plain()}\n\n正文"


def test_label_less_overlay_template_never_strips_agent_bullets(language, overlay):
    """``◆ {model}`` has no label to anchor on; it must not turn into "strip every ◆ line"."""
    overlay("zh", {"info_model": "◆ {model}"})
    language("zh")
    bullets = "◆ 第一点：先写脚本\n◆ 第二点：再剪辑"
    assert cn_im_banners.strip_runtime_banners(bullets) == bullets
