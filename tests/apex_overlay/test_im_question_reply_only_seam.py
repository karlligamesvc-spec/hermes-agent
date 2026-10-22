"""Seam-test + behavior test for apex_overlay.im_question_reply_only (hc-1018).

Pins what the seam binds to (``gateway.run._prepare_gateway_status_message``,
``_sanitize_gateway_final_response`` and the three helpers it reads), so an upstream rename turns a
silently disarmed seam into a CI failure. Behavior is checked through the real gateway functions, with
failure texts built by the runtime's own code where it has a builder (billing, explainer, provider
errors), so the shapes are what a cloud chat would actually receive:

* switch on + Chinese IM platform: status lines dropped; billing → the relay's Chinese sentence; rate
  limit → wait; other provider failures → platform-side failure; explainer and reasoning-only →
  「回「继续」…」; ordinary answers untouched;
* switch off, or an international platform: byte-for-byte what upstream returns.

The same file runs on fork main and on the cloud image's hotfix line (v2026.8.31). Run via
``scripts/run_tests_parallel.py`` (per-file fresh interpreter).
"""

from __future__ import annotations

import pytest

from gateway import run
from agent import conversation_loop, i18n
from apex_overlay import im_question_reply_only as qro
from gateway.config import Platform
from run_agent import AIAgent

from tests.apex_overlay.conftest import run_plugin_register_with_stubbed_seams

# apex-nodes api-relay QUOTA_EXHAUSTED_MESSAGE, the sentence a cloud agent's 402 carries.
RELAY_QUOTA = (
    "本月平台模型额度已用完。你可以在「用量」页升级套餐，或等下月初额度自动重置后继续；"
    "如果现在就要用，可在「模型设置」里切换到自带 Key（BYOK），用自己的额度不受平台配额限制。"
)
CN_IM = [Platform.FEISHU, Platform.WEIXIN, Platform.WECOM, Platform.WECOM_CALLBACK, Platform.DINGTALK,
         Platform.QQBOT]
STATUS_LINES = [
    "⏳ Rate limited — retrying in 5s (attempt 2/3)",
    "❌ API failed after 3 retries — HTTP 503: upstream unavailable",
    "↻ Empty response after tool calls — using earlier content as final answer",
    "⚠️ Billing or credits exhausted — switching to fallback provider...",
]
# Image v2026.8.31 agent/conversation_loop.py reasoning-only fallback (fork main no longer has it).
REASONING_ONLY = (
    "⚠️ The model produced only internal reasoning and no final answer, despite retries. Its last "
    "reasoning, which may contain the answer:\n\n用户想要一个 30 秒脚本……"
)
ORDINARY = [
    "你问的这个接口没登录时会返回 HTTP 402，表示需要付款，所以脚本第一步要先登录。",
    "⚠️ 注意：这个视频的配乐有版权风险，发布前换成平台曲库里的音乐。",
    "好的，我把 5 个选题整理好了：\n1. ……\n2. ……",
]


def _billing(summary: str, *, unverified: bool = False) -> str:
    """What a cloud agent's turn returns when the relay answers 402 (the runtime's own builders)."""
    text = conversation_loop._billing_terminal_label(summary, unverified)
    advice = conversation_loop._billing_or_entitlement_message(
        capability="model access", provider="custom", base_url="http://host.docker.internal:7000/v1",
        model="deepseek-flash", unverified=unverified,
    )
    return f"{text}\n\n{advice}" if advice else text


def _explainer(reason: str) -> str:
    text = AIAgent._format_turn_completion_explanation(reason)
    assert text, f"the runtime has no explanation for {reason}"
    return text


@pytest.fixture
def seam(monkeypatch):
    """Install the seam onto the real gateway.run; restore upstream afterwards. Yields upstream's two
    functions so expectations can be computed from them."""
    upstream = {name: getattr(run, name) for name in qro._TARGET_FUNCTIONS}
    for name, fn in upstream.items():
        monkeypatch.setattr(run, name, fn)
    monkeypatch.setattr(qro, "_APPLIED", False)
    assert qro._install_run(run) is True
    yield upstream


@pytest.fixture(params=["en", "zh"])
def language(request, monkeypatch):
    """Cloud agents run display.language zh (apex-nodes hc-961); the catalog renders failures in it."""
    monkeypatch.setenv("HERMES_LANGUAGE", request.param)
    i18n.reset_language_cache()
    yield request.param
    monkeypatch.delenv("HERMES_LANGUAGE")
    i18n.reset_language_cache()


@pytest.fixture
def switch(monkeypatch):
    def set_switch(value):
        cfg = {"apex": {"im_question_reply_only": value}} if value is not None else {}
        monkeypatch.setattr(run, "_load_gateway_config", lambda *a, **k: cfg)
    set_switch(True)
    return set_switch


# ── seam binding ─────────────────────────────────────────────────────────────


def test_upstream_targets_exist():
    for name in (*qro._TARGET_FUNCTIONS, *qro._HELPERS):
        assert hasattr(run, name), f"gateway.run.{name} is gone; hc-1018 would be disarmed"


def test_install_wraps_both_functions_once(seam):
    for name in qro._TARGET_FUNCTIONS:
        wrapped = getattr(run, name)
        assert getattr(wrapped, qro._MARK, False)
        assert wrapped.__wrapped__ is seam[name]
    assert qro._install_run(run) is True
    for name in qro._TARGET_FUNCTIONS:
        assert getattr(run, name).__wrapped__ is seam[name], "installed twice"


def test_missing_target_reports_false(monkeypatch):
    monkeypatch.setattr(qro, "_APPLIED", False)
    monkeypatch.delattr(run, "_GATEWAY_RATE_LIMIT_RE")
    assert qro._install_run(run) is False


def test_plugin_register_applies_the_seam():
    assert "im_question_reply_only" in run_plugin_register_with_stubbed_seams("_hc1018_plugin_under_test")


@pytest.mark.parametrize(
    ("value", "expected"),
    [(True, True), ("true", True), ("on", True), (False, False), ("false", False), (None, False), (1, False)],
)
def test_switch_reads_config(switch, value, expected):
    switch(value)
    assert qro.switch_on(run) is expected


# ── status lines ─────────────────────────────────────────────────────────────


def test_upstream_sends_these_status_lines(seam):
    """Not vacuous: upstream delivers most of the sample lines (its own noise filter drops the rest)."""
    sent = [line for line in STATUS_LINES if seam[qro._TARGET_STATUS_FN](Platform.WEIXIN, "lifecycle", line)]
    assert len(sent) >= 3, sent


@pytest.mark.parametrize("platform", CN_IM, ids=lambda p: p.value)
@pytest.mark.parametrize("line", STATUS_LINES)
def test_status_lines_dropped_on_cn_im(seam, switch, platform, line):
    assert run._prepare_gateway_status_message(platform, "lifecycle", line) is None
    assert run._prepare_gateway_status_message(platform, "warn", line) is None


@pytest.mark.parametrize("line", STATUS_LINES)
def test_status_lines_unchanged_when_off_or_elsewhere(seam, switch, line):
    upstream = seam[qro._TARGET_STATUS_FN]
    assert run._prepare_gateway_status_message(Platform.TELEGRAM, "lifecycle", line) == upstream(
        Platform.TELEGRAM, "lifecycle", line)
    switch(False)
    for platform in CN_IM:
        assert run._prepare_gateway_status_message(platform, "lifecycle", line) == upstream(
            platform, "lifecycle", line)


# ── final replies ────────────────────────────────────────────────────────────


def _final(platform, text):
    return run._sanitize_gateway_final_response(platform, text)


@pytest.mark.parametrize("platform", CN_IM, ids=lambda p: p.value)
@pytest.mark.parametrize("unverified", [False, True], ids=["billing", "unverified"])
def test_quota_failure_keeps_only_the_relay_sentence(seam, switch, platform, unverified):
    text = _billing(f"HTTP 402: {RELAY_QUOTA}", unverified=unverified)
    upstream = seam[qro._TARGET_FINAL_FN](platform, text)
    assert "deepseek-flash" in upstream or "/model" in upstream, "the fixture lost what this test removes"

    reply = _final(platform, text)
    assert reply == f"⚠️ {RELAY_QUOTA}"
    for leak in ("deepseek", "custom", "Custom", "/model", "HTTP", "Billing", "provider"):
        assert leak not in reply


@pytest.mark.parametrize(
    "summary",
    [
        pytest.param("Error code: 402 - {'error': {'message': '" + RELAY_QUOTA + "', 'type': 'insufficient_quota'}}",
                     id="raw-sdk-error"),
        pytest.param("HTTP 402: insufficient credits", id="english-only"),
    ],
)
def test_quota_failure_other_shapes(seam, switch, summary):
    reply = _final(Platform.WEIXIN, _billing(summary))
    if "本月" in summary:
        assert reply == f"⚠️ {RELAY_QUOTA}"
    else:
        assert reply == qro.QUOTA_REPLY


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        pytest.param("HTTP 429: Too Many Requests", qro.BUSY_REPLY, id="rate-limit"),
        pytest.param("Rate limited after 3 retries: 429 Too Many Requests", qro.BUSY_REPLY, id="rate-limit-retries"),
        pytest.param("API call failed after 3 retries: HTTP 503 Service Unavailable", qro.FAILED_REPLY, id="5xx"),
        pytest.param("⚠️ Provider authentication failed: Error code: 401 - invalid api key", qro.FAILED_REPLY,
                     id="auth"),
        pytest.param("Connection error: all connection attempts failed", qro.FAILED_REPLY, id="connection"),
    ],
)
@pytest.mark.parametrize("platform", CN_IM, ids=lambda p: p.value)
def test_provider_failures(seam, switch, language, platform, text, expected):
    upstream = seam[qro._TARGET_FINAL_FN](platform, text)
    assert upstream != text, "upstream no longer treats this as a provider failure"
    assert _final(platform, text) == expected


@pytest.mark.parametrize("reason", ["empty_response_exhausted", "all_retries_exhausted_no_response",
                                    "interrupted_during_api_call", "max_iterations_reached"])
def test_explainer_becomes_one_sentence(seam, switch, language, reason):
    explanation = _explainer(reason)
    assert _final(Platform.WEIXIN, explanation) == qro.NO_RESULT_REPLY
    partial = f"我先把脚本写好了一半\n\n{explanation}"
    assert _final(Platform.FEISHU, partial) == f"我先把脚本写好了一半\n\n{qro.NO_RESULT_REPLY}"


def test_reasoning_only_fallback(seam, switch):
    assert _final(Platform.QQBOT, REASONING_ONLY) == qro.NO_RESULT_REPLY


@pytest.mark.parametrize("text", ORDINARY)
@pytest.mark.parametrize("platform", CN_IM, ids=lambda p: p.value)
def test_ordinary_answers_untouched(seam, switch, platform, text):
    assert _final(platform, text) == seam[qro._TARGET_FINAL_FN](platform, text)


def _failure_samples():
    return [
        _billing(f"HTTP 402: {RELAY_QUOTA}"),
        "HTTP 429: Too Many Requests",
        "API call failed after 3 retries: HTTP 503 Service Unavailable",
        _explainer("empty_response_exhausted"),
        REASONING_ONLY,
        *ORDINARY,
    ]


def test_final_replies_unchanged_when_switch_off(seam, switch, language):
    upstream = seam[qro._TARGET_FINAL_FN]
    for value in (False, None):
        switch(value)
        for platform in CN_IM:
            for text in _failure_samples():
                assert _final(platform, text) == upstream(platform, text)


def test_final_replies_unchanged_on_international_platforms(seam, switch, language):
    upstream = seam[qro._TARGET_FINAL_FN]
    for platform in (Platform.TELEGRAM, Platform.SLACK, Platform.DISCORD):
        for text in _failure_samples():
            assert _final(platform, text) == upstream(platform, text)


def test_wrapper_errors_fall_back_to_upstream(seam, switch, monkeypatch):
    def boom(*_a, **_k):
        raise RuntimeError("config unreadable")

    monkeypatch.setattr(run, "_load_gateway_config", boom)
    text = "HTTP 429: Too Many Requests"
    assert _final(Platform.WEIXIN, text) == seam[qro._TARGET_FINAL_FN](Platform.WEIXIN, text)
    line = STATUS_LINES[0]
    assert run._prepare_gateway_status_message(Platform.WEIXIN, "lifecycle", line) == seam[
        qro._TARGET_STATUS_FN](Platform.WEIXIN, "lifecycle", line)
