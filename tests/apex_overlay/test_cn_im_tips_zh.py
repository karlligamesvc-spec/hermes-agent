"""The gateway's first-time tips reach Chinese IM users in Chinese.

APEX cloud agents run with ``display.language: zh``. The tips used to be hardcoded English in
``agent/onboarding.py``; ``apex_overlay.cn_im_messages`` translated three of them on
wecom/weixin/dingtalk/wecom_callback/qqbot and missed two, the ``redirect`` busy tip and the
tool-progress tip, so those reached users in English whatever the language said. The tips now
come from catalog keys (``gateway.onboarding.*``).

* Busy tips: composed into the busy-ack by the real ``_compose_busy_ack_message`` and delivered
  through the overlay's ``_send_with_retry`` wrapper, as ``_send_busy_reply`` does.
* Tool-progress tip: queued by the real ``_progress_onboarding_hint``. It goes out as a progress
  bubble (``adapter.send`` / ``edit_message``), which the overlay never sees; of the CN-IM
  platforms only DingTalk can edit messages, so only DingTalk receives it.
* Under ``en`` the overlay still maps the busy tips to Chinese on CN-IM, from the same keys.
"""

from __future__ import annotations

import asyncio
import os
import queue
import re
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from agent import i18n
from agent.i18n import t
from agent.onboarding import BUSY_INPUT_HINT_KEYS_GATEWAY, TOOL_PROGRESS_HINT_KEY_GATEWAY
from apex_overlay import cn_im_messages
from gateway.platforms.base import Platform, SessionSource
from gateway.platforms.event import MessageEvent, MessageType

_CN_IM = ("wecom", "weixin", "dingtalk", "wecom_callback", "qqbot")
# hint mode -> the flags _handle_active_session_busy_message passes to _compose_busy_ack_message
_MODE_FLAGS = {
    "queue": {"is_steer_mode": False, "is_queue_mode": True, "is_redirect_mode": False},
    "steer": {"is_steer_mode": True, "is_queue_mode": False, "is_redirect_mode": False},
    "redirect": {"is_steer_mode": False, "is_queue_mode": False, "is_redirect_mode": True},
    "interrupt": {"is_steer_mode": False, "is_queue_mode": False, "is_redirect_mode": False},
}
_CODE_SPAN = re.compile(r"`[^`]*`")
# Three ASCII words in a row: an English phrase. Commands sit in code spans, which are dropped first.
_ENGLISH_RUN = re.compile(r"[A-Za-z][A-Za-z']*(?:\s+[A-Za-z][A-Za-z']*){2,}")


def _english_runs(text: str) -> list[str]:
    return _ENGLISH_RUN.findall(_CODE_SPAN.sub(" ", text))


@pytest.fixture
def set_language(monkeypatch):
    """Write ``display.language`` into this test's HERMES_HOME config, as hc-961 does for cloud agents."""
    monkeypatch.delenv("HERMES_LANGUAGE", raising=False)

    def _set(lang: str) -> None:
        Path(os.environ["HERMES_HOME"], "config.yaml").write_text(f"display:\n  language: {lang}\n", encoding="utf-8")
        i18n.reset_language_cache()
        assert i18n.get_language() == lang

    yield _set
    i18n.reset_language_cache()


def _deliver_busy_ack(monkeypatch, tmp_path: Path, platform: str, mode: str) -> str:
    """Compose the first busy-ack of an install and send it through the overlay's wrapper."""
    import gateway.run as gateway_run
    from gateway.run import GatewayRunner

    monkeypatch.setattr(gateway_run, "_hermes_home", tmp_path)  # mark_seen writes here
    gateway_config = {"display": {"platforms": {platform: {"busy_ack_detail": True}}}}
    monkeypatch.setattr(gateway_run, "_load_gateway_config", lambda: gateway_config)

    source = SessionSource(platform=Platform(platform), chat_id="c1", chat_type="dm", user_id="u1")
    event = MessageEvent(text="hi", message_type=MessageType.TEXT, source=source, message_id="m1")
    agent = MagicMock()
    agent.get_activity_summary.return_value = {"api_call_count": 3, "max_iterations": 60, "current_tool": "terminal"}
    now = time.time()
    busy_state = SimpleNamespace(turn=SimpleNamespace(started_ts=now - 185))
    message = GatewayRunner._compose_busy_ack_message(
        object.__new__(GatewayRunner), event, now, busy_state, agent,
        demoted_for_subagents=False, demoted_for_compression=False, **_MODE_FLAGS[mode],
    )

    sent: list[str] = []

    async def _send_with_retry(self, chat_id, content, *args, **kwargs):
        sent.append(content)

    send = cn_im_messages._wrap_send_with_retry(_send_with_retry)
    asyncio.run(send(SimpleNamespace(platform=Platform(platform)), source.chat_id, message))
    assert len(sent) == 1
    return sent[0]


def _queue_tool_progress_tip(monkeypatch, tmp_path: Path) -> str:
    """Run the first-time tool-progress hook for a long tool and return what it queued."""
    import gateway.run as gateway_run
    from gateway.run import GatewayRunner
    from gateway.run_turn_runner import TurnRunner
    from gateway.turn_context import TurnContext

    monkeypatch.setattr(gateway_run, "_hermes_home", tmp_path)
    monkeypatch.setattr(gateway_run, "_load_gateway_config", lambda: {"display": {"tool_progress_command": True}})
    ctx = TurnContext(progress_mode="all", progress_queue=queue.Queue())
    TurnRunner(object.__new__(GatewayRunner), ctx)._progress_onboarding_hint({"duration": ctx._LONG_TOOL_THRESHOLD_S + 1})
    assert ctx.long_tool_hint_fired == [True]
    return ctx.progress_queue.get_nowait()


@pytest.mark.parametrize("platform", _CN_IM)
@pytest.mark.parametrize("mode", list(_MODE_FLAGS))
def test_busy_tip_reaches_cn_im_in_chinese_under_zh(platform, mode, set_language, monkeypatch, tmp_path):
    set_language("zh")
    content = _deliver_busy_ack(monkeypatch, tmp_path, platform, mode)
    assert "terminal" in content  # the iteration / elapsed / running-tool detail is part of what is checked
    assert content.endswith("\n\n" + t(BUSY_INPUT_HINT_KEYS_GATEWAY[mode], lang="zh"))
    assert _english_runs(content) == []


def test_tool_progress_tip_is_chinese_under_zh(set_language, monkeypatch, tmp_path):
    set_language("zh")
    tip = _queue_tool_progress_tip(monkeypatch, tmp_path)
    assert tip == t(TOOL_PROGRESS_HINT_KEY_GATEWAY, lang="zh")
    assert _english_runs(tip) == []


@pytest.mark.parametrize("mode", list(_MODE_FLAGS))
def test_busy_tip_under_en_is_mapped_to_chinese_on_cn_im(mode, set_language, monkeypatch, tmp_path):
    set_language("en")
    content = _deliver_busy_ack(monkeypatch, tmp_path, "weixin", mode)
    tip = content.rsplit("\n\n", 1)[1]
    assert tip == t(BUSY_INPUT_HINT_KEYS_GATEWAY[mode], lang="zh")
    assert _english_runs(tip) == []


def test_busy_tip_under_en_stays_english_on_feishu(set_language, monkeypatch, tmp_path):
    set_language("en")
    content = _deliver_busy_ack(monkeypatch, tmp_path, "feishu", "redirect")
    assert content.endswith("\n\n" + t(BUSY_INPUT_HINT_KEYS_GATEWAY["redirect"], lang="en"))


def test_overlay_maps_every_busy_tip_key():
    assert set(cn_im_messages._HC228_ZH_CATALOG_KEYS) == set(BUSY_INPUT_HINT_KEYS_GATEWAY.values())


def test_overlay_skips_a_blank_english_rendering(monkeypatch):
    """A locale overlay that blanks a tip must not make the overlay splice Chinese between every character."""
    monkeypatch.setattr(i18n, "t", lambda key, lang=None, **_: "" if lang == "en" else "中文")
    assert cn_im_messages._catalog_rows() == []
    assert cn_im_messages._hc228_localize("weixin", "Here is your report.") == "Here is your report."


@pytest.mark.parametrize("lang", [lang for lang in i18n.SUPPORTED_LANGUAGES if lang != "en"])
def test_every_locale_translates_the_tips_and_keeps_the_commands(lang):
    keys = [*BUSY_INPUT_HINT_KEYS_GATEWAY.values(), TOOL_PROGRESS_HINT_KEY_GATEWAY]
    for key in keys:
        english, translated = t(key, lang="en"), t(key, lang=lang)
        assert translated != english, f"{lang}: {key} is not translated"
        assert sorted(_CODE_SPAN.findall(translated)) == sorted(_CODE_SPAN.findall(english)), f"{lang}: {key}"
