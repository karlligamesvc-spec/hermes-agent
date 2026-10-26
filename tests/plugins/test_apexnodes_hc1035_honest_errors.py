"""hc-1035: the gateway client says "暂不可用(503)" only for the platform being unable to serve.

liusession's records (2026-10-22 review) showed an incomplete link, TikHub's own 400,
「总数量不能超过30」 and an unreachable media link all as "平台能力暂不可用(503),
请稍后重试". The server (apex-nodes hc-1035) now answers those with a 4xx and a
sentence naming what helps; this client passes that sentence on as it is. A 503 is
worded by its ``vendor_code``: our own queue was full (try again in a minute), the
platform's setup is broken (retrying cannot help), or a real outage (try again in a few
minutes). A download every source refused, fresh signature included, says so instead
of "中断,请稍后重试": on 10-05 the user re-sent the same link three times.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import pytest

from plugins import apexnodes_gateway as gateway
from tests.plugins.test_apexnodes_media_download_recovery import _load_douyin_plugin

INCOMPLETE_LINK = (
    "链接不完整：这次查询要用完整的分享链接，只有作品 ID 或半截链接查不了。"
    "请把 App 里「分享 → 复制链接」得到的整段文字发过来。"
)
SOCIAL = "/tools/v1/social/douyin/content"
DOWNLOAD = "/tools/v1/social/douyin/download"
ASR = "/tools/v1/asr/transcribe"


@pytest.fixture(autouse=True)
def _chinese(monkeypatch):
    monkeypatch.setenv("HERMES_LANGUAGE", "zh")


def _response(status: int, detail) -> httpx.Response:
    return httpx.Response(status, json={"detail": detail})


@pytest.mark.parametrize(
    "status, detail, path, expected",
    [
        # The server's sentence about this call, as it is.
        (422, {"code": "provider_missing_params", "message": INCOMPLETE_LINK}, SOCIAL, INCOMPLETE_LINK),
        (400, {"code": "douyin_link_required", "message": INCOMPLETE_LINK}, SOCIAL, INCOMPLETE_LINK),
        (404, {"code": "provider_not_found", "message": "没找到这条内容：链接可能已失效。"}, SOCIAL,
         "没找到这条内容：链接可能已失效。"),
        (422, {"code": "asr_audio_unreachable", "message": "转写服务取不到这段音频，这次没有转写。"}, ASR,
         "转写服务取不到这段音频，这次没有转写。"),
        (422, "a plain string detail", SOCIAL, "a plain string detail"),
        # No sentence to pass on: the status is said, with the code as the detail.
        (422, {"code": "provider_missing_params"}, SOCIAL, "平台工具网关返回错误(HTTP 422)(详情: provider_missing_params)"),
        # 503 by vendor_code.
        (503, {"code": "vendor_unavailable", "vendor_code": "provider_busy", "message": "上游数据服务繁忙，请稍后重试。"},
         SOCIAL, "平台的数据服务这会儿排队的请求太多(503),这次没轮到；过 1 分钟再试。(详情: 上游数据服务繁忙，请稍后重试。)"),
        (503, {"code": "vendor_unavailable", "vendor_code": "provider_not_configured", "message": "平台未配置"},
         SOCIAL, "平台这项能力的配置出了问题(503),要等平台修好才能用，现在重试也不会成功。(详情: 平台未配置)"),
        (503, {"code": "vendor_unavailable", "vendor_code": "provider_request_failed", "message": "数据供应商返回错误 (HTTP 500)"},
         SOCIAL, "平台能力暂不可用(503),请过几分钟再试。(详情: 数据供应商返回错误 (HTTP 500))"),
        # Download and transcription 503s keep their own sentence and hide the vendor detail.
        (503, {"code": "vendor_unavailable", "vendor_code": "tikhub_timeout", "message": "TikHub API 请求超时"},
         DOWNLOAD, "视频链接解析/下载服务暂不可用(503),请过几分钟再试，或直接上传视频文件。"),
        (503, {"code": "vendor_unavailable", "vendor_code": "asr_failed", "message": "ASR 识别失败 (code=55000031)"},
         ASR, "视频转写服务暂不可用(503),请过几分钟再试，或先提供已有文字稿。"),
        (503, {"code": "vendor_unavailable", "vendor_code": "asr_auth_failed", "message": "火山 ASR 凭证无效或无权限"},
         ASR, "平台这项能力的配置出了问题(503),要等平台修好才能用，现在重试也不会成功。"),
    ],
)
def test_error_sentence_table(status, detail, path, expected):
    assert str(gateway._error_from_response(_response(status, detail), path=path)) == expected


@pytest.mark.parametrize("status, marker", [(402, "额度不足"), (413, "大小上限"), (429, "过于频繁")])
def test_desktop_guidance_statuses_keep_their_own_sentence(status, marker):
    """401/402/413/429 carry guidance only the Desktop can give (sign in, top up, back off)."""
    error = gateway._error_from_response(_response(status, {"code": "x", "message": "server text"}), path=SOCIAL)
    assert marker in str(error)


def test_a_4xx_never_reads_as_an_outage():
    for status in (400, 403, 404, 409, 422):
        error = gateway._error_from_response(_response(status, {"code": "x", "message": "这次查询的参数不对"}), path=SOCIAL)
        assert "暂不可用" not in str(error) and "503" not in str(error)


def test_failed_job_answers_are_read_through_the_same_table():
    """hc-978's polled jobs replay the synchronous answer; a 422 failure is its sentence."""
    answer = {"status": "failed", "error": {"status_code": 422, "detail": {"code": "asr_audio_unreachable",
                                                                          "message": "转写服务取不到这段音频。"}}}
    assert str(gateway._job_failure(answer, ASR)) == "转写服务取不到这段音频。"


# ── a download the source refused every time ──────────────────────────────────


class _Source(BaseHTTPRequestHandler):
    """A media CDN: /forbidden refuses (403), /failing is down (503), anything else is gone (404)."""

    counts: dict[str, int] = {}

    def log_message(self, _format, *_args):
        return

    def do_GET(self):
        self.counts[self.path] = self.counts.get(self.path, 0) + 1
        self.send_response({"/forbidden": 403, "/failing": 503}.get(self.path, 404))
        self.send_header("Content-Length", "0")
        self.end_headers()
        self.close_connection = True


@pytest.fixture
def source(monkeypatch):
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")
    _Source.counts = {}
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Source)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", _Source.counts
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def _exhaust(module, base, monkeypatch, tmp_path, *, first: str, refreshed: str):
    monkeypatch.setattr(gateway, "media_cache_dir", lambda: tmp_path)
    monkeypatch.setattr(
        module, "_gateway_resolve_download", lambda _source: ({"download_url": f"{base}{refreshed}"}, f"{base}{refreshed}")
    )
    with pytest.raises(gateway.GatewayError) as caught:
        module._gateway_download_resolved_media(
            "https://v.douyin.com/x/", {"download_url": f"{base}{first}", "fallback_urls": [f"{base}/gone"]}, f"{base}{first}"
        )
    return caught.value


def test_every_attempt_refused_says_resending_will_not_help(source, tmp_path, monkeypatch):
    base, counts = source
    module = _load_douyin_plugin()
    error = _exhaust(module, base, monkeypatch, tmp_path, first="/forbidden", refreshed="/forbidden")
    assert error.code == "media_download_exhausted"
    assert error.status == 403
    assert str(error).startswith("源站拒绝了这个视频的下载(HTTP 403)")
    assert "重发同一条链接大概率还是一样" in str(error)
    assert "请稍后重试" not in str(error)
    # Primary, fallback (404), then the fresh link: the refresh really happened.
    assert counts["/forbidden"] == 2 and counts["/gone"] == 1


@pytest.mark.parametrize(
    "first, refreshed",
    [("/forbidden", "/failing"), ("/failing", "/forbidden")],
    ids=["refused-then-down", "down-then-refused"],
)
def test_a_dropped_or_failing_source_still_says_try_again(source, tmp_path, monkeypatch, first, refreshed):
    """One attempt that was not a refusal (the source was down) is enough to keep "try again"."""
    base, _counts = source
    module = _load_douyin_plugin()
    error = _exhaust(module, base, monkeypatch, tmp_path, first=first, refreshed=refreshed)
    assert error.code == "media_download_exhausted"
    assert error.status is None
    assert str(error).startswith("视频直链下载中断")


def test_download_tool_shows_the_refusal(source, tmp_path, monkeypatch):
    base, _counts = source
    module = _load_douyin_plugin()
    monkeypatch.setattr(gateway, "media_cache_dir", lambda: tmp_path)
    monkeypatch.setattr(
        module, "_gateway_resolve_download", lambda _source: ({"download_url": f"{base}/forbidden"}, f"{base}/forbidden")
    )
    result = json.loads(module._gateway_social_download("https://v.douyin.com/x/"))
    assert result["error"].startswith("视频下载失败: 源站拒绝了这个视频的下载(HTTP 403)")
