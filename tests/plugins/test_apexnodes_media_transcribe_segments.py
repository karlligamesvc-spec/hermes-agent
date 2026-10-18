"""hc-929: media_transcribe hands Doubao caption timing over as a file, on both legs.

APEX Desktop 0.17.58's gateway leg built its result without the gateway's ``segments``
(Doubao utterances with nested word timing), although the tool description and the
short-video-studio skill promise them for caption timing. The legacy leg passed them inline.
Inline is not the fix: word timing runs at about 20K characters per minute of speech, so a
long video's result crosses the runtime's per-result spill threshold and the transcript is
replaced by a preview. Both legs now write the full array to ``<stem>.segments.json`` next to
the transcript and return ``segments_path`` plus a compact ``segments_summary``.

Every exit that can carry segments is covered:

* gateway leg: (1) multipart upload, (2) the three-hop direct upload
  (upload-url → PUT → JSON), (3) the gateway fetching ``media_url`` itself;
* legacy leg: (4) ``/media/transcribe`` under ``TOOLS_GATEWAY_DISABLED=1``.

Only ``httpx.Client`` / ``urlopen`` are faked. The checks read the written file back with
``json`` and ask the runtime's own spill function whether the result stays inline, so they
do not reuse the plugin code they check.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from agent.display import _detect_tool_failure
from tests.plugins.test_apexnodes_gateway_tools import (
    _VENDOR_AND_MASTER_ENV,
    GATEWAY_BASE,
    GATEWAY_KEY,
    UPLOAD_URL_OK,
    FakeResponse,
    _gateway_module,
    _load_plugin,
)
from tools.budget_config import DEFAULT_BUDGET
from tools.tool_result_storage import maybe_persist_tool_result

ASR_PATH = "/tools/v1/asr/transcribe"
TEXT = "大家好。今天做菜。"
# The Doubao shape (show_utterances): utterance + word start_time/end_time in milliseconds.
SEGMENTS = [
    {
        "text": "大家好。",
        "start_time": 320,
        "end_time": 1180,
        "definite": True,
        "words": [
            {"text": "大", "start_time": 320, "end_time": 560, "confidence": 0},
            {"text": "家", "start_time": 560, "end_time": 800, "confidence": 0},
            {"text": "好", "start_time": 800, "end_time": 1180, "confidence": 0},
        ],
    },
    {
        "text": "今天做菜。",
        "start_time": 1500,
        "end_time": 3900,
        "definite": True,
        "words": [
            {"text": "今", "start_time": 1500, "end_time": 1800, "confidence": 0},
            {"text": "天", "start_time": 1800, "end_time": 2300, "confidence": 0},
            {"text": "做", "start_time": 2600, "end_time": 3100, "confidence": 0},
            {"text": "菜", "start_time": 3100, "end_time": 3900, "confidence": 0},
        ],
    },
]
SUMMARY = {"count": 2, "word_count": 7, "first_start_ms": 320, "last_end_ms": 3900}


@pytest.fixture(autouse=True)
def hermes_home(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    for name in _VENDOR_AND_MASTER_ENV:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("TOOLS_GATEWAY_BASE", GATEWAY_BASE)
    monkeypatch.setenv("TOOLS_GATEWAY_KEY", GATEWAY_KEY)
    return home


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


@pytest.fixture
def legacy_master(monkeypatch):
    """``TOOLS_GATEWAY_DISABLED=1``: answer ``/media/transcribe`` with the queued master body."""
    monkeypatch.setenv("TOOLS_GATEWAY_DISABLED", "1")
    monkeypatch.setenv("HERMES_PLATFORM_API_BASE", "http://master.test/api/v1")
    monkeypatch.setenv("API_SERVER_KEY", "legacy-key")
    bodies: list[dict] = []

    class _Response:
        def __init__(self, body: dict):
            self._raw = json.dumps(body, ensure_ascii=False).encode("utf-8")

        def read(self):
            return self._raw

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def urlopen(request, timeout=None):
        assert request.full_url == "http://master.test/api/v1/media/transcribe"
        return _Response(bodies.pop(0))

    monkeypatch.setattr("urllib.request.urlopen", urlopen)
    return bodies


def _clip(tmp_path: Path, name: str, size: int = 8) -> Path:
    clip = tmp_path / name
    clip.write_bytes(b"A" * size)
    return clip


def _asr_body(segments=SEGMENTS, text: str = TEXT) -> dict:
    body = {"ok": True, "text": text, "duration_seconds": 4.2, "cost_cents": 6, "cache_hit": False}
    if segments is not ...:
        body["segments"] = segments
    return body


def _exit_multipart(douyin_mod, responses, tmp_path, monkeypatch, body):
    responses.append(FakeResponse(200, body))
    return douyin_mod._handle_media_transcribe({"video_path": str(_clip(tmp_path, "talk.mp4"))})


def _exit_direct_upload(douyin_mod, responses, tmp_path, monkeypatch, body):
    monkeypatch.setenv(_gateway_module().ENV_ASR_DIRECT_UPLOAD_THRESHOLD, "16")
    clip = _clip(tmp_path, "talk_long.mp4", size=32)
    responses.extend([FakeResponse(200, UPLOAD_URL_OK), FakeResponse(200, {}), FakeResponse(200, body)])
    return douyin_mod._handle_media_transcribe({"video_path": str(clip)})


def _exit_media_url(douyin_mod, responses, tmp_path, monkeypatch, body):
    fetched = "https://cdn.example/refreshed.mp4"
    monkeypatch.setattr(douyin_mod, "_gateway_resolve_download", lambda _url: ({"title": "做菜"}, fetched))

    def local_download_exhausted(*_args):
        raise douyin_mod._ResolvedMediaDownloadError({"title": "做菜"}, fetched)

    monkeypatch.setattr(douyin_mod, "_gateway_download_resolved_media", local_download_exhausted)
    responses.append(FakeResponse(200, body))
    return douyin_mod._handle_media_transcribe({"url": "https://v.douyin.com/abc/"})


GATEWAY_EXITS = pytest.mark.parametrize(
    "exit_fn",
    [_exit_multipart, _exit_direct_upload, _exit_media_url],
    ids=["multipart", "direct-upload", "media-url"],
)


def _assert_segments_file(result: dict, hermes_home: Path, expected: list) -> Path:
    assert "segments" not in result, "the result face must not carry the timing array inline"
    path = Path(result["segments_path"])
    assert path.parent == hermes_home / "cache" / "documents"  # readable by the runtime's own tools
    assert path.name.endswith(".segments.json")
    assert json.loads(path.read_text(encoding="utf-8")) == expected  # lossless, server shape kept
    return path


@GATEWAY_EXITS
def test_every_gateway_asr_exit_hands_segments_over_as_a_file(
    exit_fn, douyin_mod, gateway_http, tmp_path, monkeypatch, hermes_home
):
    responses, urls = gateway_http
    raw = exit_fn(douyin_mod, responses, tmp_path, monkeypatch, _asr_body())
    assert urls[-1] == f"{GATEWAY_BASE}{ASR_PATH}"
    assert not responses, "every queued hop must have been used"
    result = json.loads(raw)
    assert (result["ok"], result["transcript"], result["speech"]) == (True, TEXT, True)
    assert result["segments_summary"] == SUMMARY
    path = _assert_segments_file(result, hermes_home, SEGMENTS)
    # Paired with the transcript file by name, so a later step can find both.
    assert Path(result["transcript_path"]).name == path.name.removesuffix(".segments.json") + ".txt"
    assert _detect_tool_failure("media_transcribe", raw) == (False, "")


def test_legacy_leg_moves_master_segments_into_a_local_file(legacy_master, douyin_mod, hermes_home):
    master_transcript = "/data/hermes/users/u1/agents/a1/workspace/media/j1/transcript.txt"
    # The chunked master path has already moved later chunks onto the whole-audio timeline.
    legacy_master.append(
        {"ok": True, "transcript": TEXT, "transcript_path": master_transcript, "title": "做菜",
         "audio_duration_seconds": 4.2, "segments": SEGMENTS}
    )
    raw = douyin_mod._handle_media_transcribe({"video_path": "/data/media/talk.mp4"})
    result = json.loads(raw)
    assert result["transcript"] == TEXT
    assert result["transcript_path"] == master_transcript  # the master's own file is untouched
    assert result["segments_summary"] == SUMMARY
    assert _assert_segments_file(result, hermes_home, SEGMENTS).name.startswith("做菜_转写_")
    assert _detect_tool_failure("media_transcribe", raw) == (False, "")


@pytest.mark.parametrize("segments", [None, [], ...], ids=["null", "empty", "missing"])
def test_a_response_without_timing_says_count_zero(segments, douyin_mod, gateway_http, tmp_path, hermes_home):
    """count=0 is how the agent tells "the server had no timing" (old cache) from an old client."""
    responses, _urls = gateway_http
    responses.append(FakeResponse(200, _asr_body(segments)))
    result = json.loads(douyin_mod._handle_media_transcribe({"video_path": str(_clip(tmp_path, "c.mp4"))}))
    assert result["transcript"] == TEXT
    assert result["segments_summary"] == {"count": 0}
    assert "segments_path" not in result and "segments" not in result
    assert not list((hermes_home / "cache" / "documents").glob("*.segments.json"))


def test_legacy_null_segments_say_count_zero(legacy_master, douyin_mod):
    legacy_master.append({"ok": True, "transcript": TEXT, "title": "", "segments": None})
    result = json.loads(douyin_mod._handle_media_transcribe({"video_path": "/data/media/talk.mp4"}))
    assert result["segments_summary"] == {"count": 0}
    assert "segments_path" not in result and "segments" not in result


def _long_talk(minutes: int) -> tuple[str, list[dict]]:
    """Synthetic Doubao output: about 250 spoken characters a minute, one word per character."""
    segments, text, clock = [], [], 0
    for _sentence in range(minutes * 25):
        words = []
        for _char in range(10):
            words.append({"text": "字", "start_time": clock, "end_time": clock + 200, "confidence": 0})
            clock += 240
        segments.append({"text": "字" * 10, "start_time": words[0]["start_time"],
                         "end_time": words[-1]["end_time"], "definite": True, "words": words})
        text.append("字" * 10)
    return "".join(text), segments


def test_a_long_video_result_stays_inline_with_its_whole_transcript(
    douyin_mod, gateway_http, tmp_path, hermes_home
):
    text, segments = _long_talk(minutes=30)
    threshold = DEFAULT_BUDGET.resolve_threshold("media_transcribe")
    # The fixture is meaningful: the timing alone would be spilled by the runtime.
    assert len(json.dumps(segments, ensure_ascii=False)) > threshold
    responses, _urls = gateway_http
    responses.append(FakeResponse(200, _asr_body(segments, text)))
    raw = douyin_mod._handle_media_transcribe({"video_path": str(_clip(tmp_path, "long.mp4"))})
    # The runtime keeps the result inline (no spill file, no 1.5K preview) and the agent sees it all.
    assert maybe_persist_tool_result(raw, "media_transcribe", "call_hc929") == raw
    result = json.loads(raw)
    assert result["transcript"] == text
    assert result["segments_summary"] == {
        "count": 750, "word_count": 7500, "first_start_ms": 0, "last_end_ms": segments[-1]["end_time"],
    }
    _assert_segments_file(result, hermes_home, segments)


def test_a_title_with_dots_keeps_both_file_names_whole(douyin_mod, gateway_http, tmp_path, monkeypatch):
    responses, _urls = gateway_http
    meta = {"title": "v1.2 发布会"}
    monkeypatch.setattr(douyin_mod, "_gateway_resolve_download", lambda _url: (meta, "https://cdn.example/l.mp4"))
    monkeypatch.setattr(
        douyin_mod, "_gateway_download_resolved_media", lambda *_a: (meta, _clip(tmp_path, "launch.mp4"))
    )
    responses.append(FakeResponse(200, _asr_body()))
    result = json.loads(douyin_mod._handle_media_transcribe({"url": "https://v.douyin.com/v12/"}))
    segments_name = Path(result["segments_path"]).name
    assert segments_name.startswith("v1.2 发布会_转写_") and segments_name.endswith(".segments.json")
    assert Path(result["transcript_path"]).name == segments_name.removesuffix(".segments.json") + ".txt"


def test_an_unwritable_cache_keeps_the_transcript_and_says_why_timing_is_missing(
    douyin_mod, gateway_http, tmp_path, monkeypatch
):
    responses, _urls = gateway_http

    def no_cache_dir():
        raise PermissionError("cache/documents is not writable")

    monkeypatch.setattr(douyin_mod, "_document_cache_dir", no_cache_dir)
    responses.append(FakeResponse(200, _asr_body()))
    raw = douyin_mod._handle_media_transcribe({"video_path": str(_clip(tmp_path, "d.mp4"))})
    result = json.loads(raw)
    assert (result["ok"], result["transcript"]) == (True, TEXT)
    assert result["segments_summary"] == SUMMARY  # the agent still learns the timing existed
    assert "segments_path" not in result and "segments" not in result
    assert "时间轴" in result["segments_note"]
    assert _detect_tool_failure("media_transcribe", raw) == (False, "")


# ── hc-918: say plainly whether asking again can produce timing ───────────────
# The 2026-10-18 live-recording test Agent transcribed one 10-minute recording three
# times hunting for timestamps. A result with speech but no timing must say whether a
# second call can help: only an old cached result (cache_hit) gains timing from one
# force_refresh; a fresh result without timing stays that way.


@pytest.mark.parametrize(
    ("cache_hit", "retry_helps"),
    [(False, False), (True, True), (None, False)],
    ids=["fresh-result", "old-cache-entry", "no-cache-field"],
)
def test_gateway_result_without_timing_says_whether_a_retry_can_help(
    cache_hit, retry_helps, douyin_mod, gateway_http, tmp_path
):
    responses, _urls = gateway_http
    body = _asr_body(None)
    if cache_hit is None:
        body.pop("cache_hit")
    else:
        body["cache_hit"] = cache_hit
    responses.append(FakeResponse(200, body))
    raw = douyin_mod._handle_media_transcribe({"video_path": str(_clip(tmp_path, "t.mp4"))})
    result = json.loads(raw)
    assert result["segments_summary"] == {"count": 0}
    note = result["segments_note"]
    if retry_helps:
        assert "force_refresh=true" in note and "一次" in note and "不要再试" in note
        assert result["cache_hit"] is True
    else:
        assert "拿不到时间轴" in note and "force_refresh" in note and "重复计费" in note
        assert result.get("cache_hit") in (False, None)
    assert _detect_tool_failure("media_transcribe", raw) == (False, "")


def test_legacy_result_without_timing_says_whether_a_retry_can_help(legacy_master, douyin_mod):
    legacy_master.append({"ok": True, "transcript": TEXT, "title": "", "segments": None, "cache_hit": True})
    legacy_master.append({"ok": True, "transcript": TEXT, "title": "", "segments": None})
    cached = json.loads(douyin_mod._handle_media_transcribe({"video_path": "/data/media/talk.mp4"}))
    fresh = json.loads(douyin_mod._handle_media_transcribe({"video_path": "/data/media/talk.mp4"}))
    assert "force_refresh=true" in cached["segments_note"] and "不要再试" in cached["segments_note"]
    assert "拿不到时间轴" in fresh["segments_note"] and "重复计费" in fresh["segments_note"]


@pytest.mark.parametrize(
    ("body", "expected_note"),
    [
        (_asr_body(), None),  # timing present: a file, no note
        (_asr_body(None, text=""), None),  # no speech: speech_note already says do not retry
    ],
    ids=["timing-present", "no-speech"],
)
def test_no_timing_note_only_when_speech_lacks_timing(body, expected_note, douyin_mod, gateway_http, tmp_path):
    responses, _urls = gateway_http
    responses.append(FakeResponse(200, body))
    result = json.loads(douyin_mod._handle_media_transcribe({"video_path": str(_clip(tmp_path, "n.mp4"))}))
    assert result.get("segments_note") == expected_note


def test_unwritable_cache_note_is_not_overwritten_by_the_no_timing_note(
    douyin_mod, gateway_http, tmp_path, monkeypatch
):
    """Timing existed but could not be written: re-transcribing after a fix DOES help."""
    responses, _urls = gateway_http
    monkeypatch.setattr(douyin_mod, "_document_cache_dir", lambda: (_ for _ in ()).throw(PermissionError("ro")))
    responses.append(FakeResponse(200, _asr_body()))
    result = json.loads(douyin_mod._handle_media_transcribe({"video_path": str(_clip(tmp_path, "w.mp4"))}))
    assert result["segments_note"] == douyin_mod._SEGMENTS_WRITE_FAILED_NOTE


def test_force_refresh_description_no_longer_invites_blind_retries(douyin_mod):
    text = douyin_mod.MEDIA_TRANSCRIBE_SCHEMA["parameters"]["properties"]["force_refresh"]["description"]
    assert "at most once" in text and "cache_hit=true" in text and "bills again" in text
    assert "segments_note" in douyin_mod.MEDIA_TRANSCRIBE_SCHEMA["description"]
