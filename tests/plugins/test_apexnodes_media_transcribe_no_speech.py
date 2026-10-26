"""hc-926: a clip with no speech is a transcription result, not a tool failure.

APEX Desktop 0.17.58 cut a vlog from 49 local clips. Three ambient-only clips each came
back from ``media_transcribe`` as a tool error (gateway 422 ``asr_no_speech``), and the
third one tripped the runtime's ``same_tool_failure`` loop warning.

Every ASR exit of ``media_transcribe`` is covered here:

* gateway leg: (1) multipart upload, (2) the three-hop direct upload
  (upload-url → PUT → JSON), (3) the gateway fetching ``media_url`` itself;
* legacy leg: (4) ``/media/transcribe`` under ``TOOLS_GATEWAY_DISABLED=1``.

A 200 with an empty transcript (every chunk of a long silent video) is the same verdict.
The HTTP → ``GatewayError`` mapping runs for real (fake ``httpx.Client`` only), so these
tests do not reuse the code they check.
"""

from __future__ import annotations

import io
import json
import sys
import urllib.error
from pathlib import Path

import pytest

from agent.display import _detect_tool_failure
from agent.tool_guardrails import ToolCallGuardrailController, classify_tool_failure
from tests.plugins.test_apexnodes_gateway_tools import (
    _VENDOR_AND_MASTER_ENV,
    ASR_JOB_POLL_URL,
    ASR_JOBS_URL,
    GATEWAY_BASE,
    GATEWAY_KEY,
    UPLOAD_URL_OK,
    FakeResponse,
    asr_job_done,
    asr_job_failed,
    _gateway_module,
    _load_plugin,
)

NO_SPEECH_DETAIL = {
    "detail": {
        "code": "asr_no_speech",
        "message": "音频中未检测到人声（45000003）",
        "terminal_fallback_allowed": False,
    }
}
ASR_PATH = "/tools/v1/asr/transcribe"


@pytest.fixture(autouse=True)
def _desktop_env(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    for name in _VENDOR_AND_MASTER_ENV:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("TOOLS_GATEWAY_BASE", GATEWAY_BASE)
    monkeypatch.setenv("TOOLS_GATEWAY_KEY", GATEWAY_KEY)


@pytest.fixture
def douyin_mod():
    module = _load_plugin("apexnodes-douyin-tools")
    yield module
    sys.modules.pop(module.__name__, None)


@pytest.fixture
def gateway_http(monkeypatch):
    """Queue responses for the gateway module's ``httpx.Client``; record request URLs."""
    gateway_module = _gateway_module()
    responses: list[FakeResponse] = []
    urls: list[str] = []

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def request(self, method, url, **kwargs):
            urls.append(url)
            return responses.pop(0)

    monkeypatch.setattr(gateway_module.httpx, "Client", FakeClient)
    monkeypatch.setattr(gateway_module.time, "sleep", lambda _s: None)
    monkeypatch.setattr(gateway_module, "extract_audio_for_asr", lambda _p, **_kw: None)
    return responses, urls


def _clip(tmp_path: Path, name: str, size: int = 8) -> Path:
    clip = tmp_path / name
    clip.write_bytes(b"A" * size)
    return clip


def _assert_silent_success(raw: str) -> dict:
    result = json.loads(raw)
    assert "error" not in result, result
    assert result["ok"] is True
    assert result["speech"] is False
    assert result["transcript"] == ""
    assert "未检测到人声" in result["speech_note"]
    assert "transcript_path" not in result  # nothing to write for an empty transcript
    # The executor's failure test (agent.display) and the guardrail fallback must agree.
    assert _detect_tool_failure("media_transcribe", raw) == (False, "")
    assert classify_tool_failure("media_transcribe", raw) == (False, "")
    return result


def test_gateway_error_carries_the_server_code():
    gateway_module = _gateway_module()
    error = gateway_module._error_from_response(FakeResponse(422, NO_SPEECH_DETAIL), path=ASR_PATH)
    assert (error.status, error.code) == (422, "asr_no_speech")
    assert "45000003" in str(error)  # the message is unchanged

    plain = gateway_module._error_from_response(FakeResponse(503, {"detail": "down"}), path=ASR_PATH)
    assert plain.code is None

    class NotJson(FakeResponse):
        def json(self):
            raise ValueError("not json")

    assert gateway_module._error_from_response(NotJson(502, {}), path=ASR_PATH).code is None


def _exit_multipart(douyin_mod, responses, tmp_path, monkeypatch):
    clip = _clip(tmp_path, "ambient.mp4")
    responses.extend(asr_job_failed(422, NO_SPEECH_DETAIL))
    return douyin_mod._handle_media_transcribe({"video_path": str(clip)}), str(clip)


def _exit_direct_upload(douyin_mod, responses, tmp_path, monkeypatch):
    monkeypatch.setenv(_gateway_module().ENV_ASR_DIRECT_UPLOAD_THRESHOLD, "16")
    clip = _clip(tmp_path, "ambient_long.mp4", size=32)
    responses.extend(
        [FakeResponse(200, UPLOAD_URL_OK), FakeResponse(200, {}), *asr_job_failed(422, NO_SPEECH_DETAIL)]
    )
    return douyin_mod._handle_media_transcribe({"video_path": str(clip)}), str(clip)


def _exit_media_url(douyin_mod, responses, tmp_path, monkeypatch):
    fetched = "https://cdn.example/refreshed.mp4"
    monkeypatch.setattr(
        douyin_mod, "_gateway_resolve_download", lambda _url: ({"title": "现场"}, fetched)
    )

    def local_download_exhausted(*_args):
        raise douyin_mod._ResolvedMediaDownloadError({"title": "现场"}, fetched)

    monkeypatch.setattr(douyin_mod, "_gateway_download_resolved_media", local_download_exhausted)
    responses.extend(asr_job_failed(422, NO_SPEECH_DETAIL))
    return douyin_mod._handle_media_transcribe({"url": "https://v.douyin.com/abc/"}), None


@pytest.mark.parametrize(
    "exit_fn",
    [_exit_multipart, _exit_direct_upload, _exit_media_url],
    ids=["multipart", "direct-upload", "media-url"],
)
def test_no_speech_is_success_on_every_gateway_asr_exit(
    exit_fn, douyin_mod, gateway_http, tmp_path, monkeypatch
):
    responses, urls = gateway_http
    raw, video_path = exit_fn(douyin_mod, responses, tmp_path, monkeypatch)
    assert urls[-2:] == [ASR_JOBS_URL, ASR_JOB_POLL_URL]  # the 422 came back through the ASR job
    assert not responses, "every queued hop must have been used"
    result = _assert_silent_success(raw)
    assert result["video_path"] == video_path


def _legacy_http_error(body: dict) -> urllib.error.HTTPError:
    return urllib.error.HTTPError(
        "http://master.test/api/v1/media/transcribe", 422, "Unprocessable Entity", {},
        io.BytesIO(json.dumps(body, ensure_ascii=False).encode("utf-8")),
    )


@pytest.fixture
def legacy_env(monkeypatch):
    monkeypatch.setenv("TOOLS_GATEWAY_DISABLED", "1")
    monkeypatch.setenv("HERMES_PLATFORM_API_BASE", "http://master.test/api/v1")
    monkeypatch.setenv("API_SERVER_KEY", "legacy-key")


def test_legacy_leg_no_speech_is_success(legacy_env, douyin_mod, monkeypatch, tmp_path):
    def urlopen(request, timeout=None):
        assert request.full_url == "http://master.test/api/v1/media/transcribe"
        raise _legacy_http_error(NO_SPEECH_DETAIL)

    monkeypatch.setattr("urllib.request.urlopen", urlopen)
    clip = _clip(tmp_path, "ambient.mp4")
    result = _assert_silent_success(douyin_mod._handle_media_transcribe({"video_path": str(clip)}))
    assert result["video_path"] == str(clip)


def test_other_422_verdicts_stay_tool_errors(legacy_env, douyin_mod, gateway_http, monkeypatch, tmp_path):
    """Only ``asr_no_speech`` is a verdict about the clip; any other 422 is still an error."""
    other = {"detail": {"code": "unsupported_audio_format", "message": "不支持的音频格式"}}

    def urlopen(request, timeout=None):
        raise _legacy_http_error(other)

    monkeypatch.setattr("urllib.request.urlopen", urlopen)
    legacy = json.loads(douyin_mod._handle_media_transcribe({"video_path": str(_clip(tmp_path, "a.mp4"))}))
    assert "不支持的音频格式" in legacy["error"]

    monkeypatch.delenv("TOOLS_GATEWAY_DISABLED")
    responses, _urls = gateway_http
    responses.append(FakeResponse(422, other))
    gateway = json.loads(douyin_mod._handle_media_transcribe({"video_path": str(_clip(tmp_path, "b.mp4"))}))
    # hc-1035: a 4xx is said in the server's own sentence, no longer wrapped in "HTTP 422".
    assert gateway["error"] == "视频转写失败: 不支持的音频格式"


@pytest.mark.parametrize(
    ("text", "speech"),
    [("大家好，今天做三道菜。", True), ("", False)],
    ids=["speech", "empty-200"],
)
def test_speech_flag_follows_the_transcript(text, speech, douyin_mod, gateway_http, tmp_path):
    responses, _urls = gateway_http
    responses.extend(asr_job_done({"text": text, "duration_seconds": 4.5}))
    raw = douyin_mod._handle_media_transcribe({"video_path": str(_clip(tmp_path, "c.mp4"))})
    if speech:
        result = json.loads(raw)
        assert (result["speech"], result["transcript"]) == (True, text)
        assert "speech_note" not in result
    else:
        assert _assert_silent_success(raw)["audio_duration_seconds"] == 4.5


def test_three_silent_clips_do_not_trip_the_failure_loop_warning(douyin_mod, gateway_http, tmp_path):
    """The 0.17.58 repro: three ambient clips in one turn warned on the third."""
    responses, _urls = gateway_http
    guard = ToolCallGuardrailController()
    for index in range(3):
        responses.extend(asr_job_failed(422, NO_SPEECH_DETAIL))
        args = {"video_path": str(_clip(tmp_path, f"ambient_{index}.mp4"))}
        raw = douyin_mod._handle_media_transcribe(args)
        failed, _suffix = _detect_tool_failure("media_transcribe", raw)
        decision = guard.after_call("media_transcribe", args, raw, failed=failed)
        assert not failed
        assert decision.code != "same_tool_failure_warning", decision.message
