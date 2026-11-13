"""hc-1222: the Desktop generate_video sends text_to_speech's voice as MiniMax H3's reference audio.

The platform side lives in apex-nodes (``app/services/media_input_audio.py``, contract
``h3-reference-audio-hc1222``): it checks the model, MP3/WAV, 2-15 s a clip, at most 3 clips
and 15 s, no first/last frame beside it, before any spend. The three cross-repo behaviors
are pinned by the shared plugin contract v18 (tests/plugins/test_apexnodes_plugin_contract.py,
both legs); the rest of the Desktop's side is pinned here:

* each ``source`` becomes what the platform takes: an ``audio_ref`` passes as it is;
  text_to_speech's ``file_path``, its ``MEDIA:`` line, a chat attachment and a link are
  uploaded first; a path that is not here fails on the Desktop and passes on the legacy leg;
* nothing goes out before the check confirms the platform takes reference audio, and a clip
  that cannot be used (too large, upload failed) fails the call instead of a request without it;
* a call without audio sends exactly what it sent before, down to its idempotency fingerprint;
* the schema tells the model what the platform takes.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import types
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
GATEWAY_BASE = "https://gw.test"
LEGACY_BASE = "http://master.test/api/v1"
AUDIO_REF = "media:" + "b" * 32 + "/ref_audio_1.mp3"
UPLOADED = "media:" + "e" * 32 + "/ref_audio_1.mp3"
UPLOAD = "/tools/v1/media/reference-audio-upload"
JOBS = "/tools/v1/video/jobs"


def _load_video_plugin():
    module_name = "hermes_plugins.apexnodes_video_tools_audio"
    plugin_dir = REPO_ROOT / "plugins" / "apexnodes-video-tools"
    if "hermes_plugins" not in sys.modules:
        namespace = types.ModuleType("hermes_plugins")
        namespace.__path__ = []  # type: ignore[attr-defined]
        sys.modules["hermes_plugins"] = namespace
    spec = importlib.util.spec_from_file_location(
        module_name, plugin_dir / "__init__.py", submodule_search_locations=[str(plugin_dir)]
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def _gateway():
    import plugins.apexnodes_gateway as gateway_module

    return gateway_module


def _audio():
    import plugins.apexnodes_reference_audio as audio_module

    return audio_module


@pytest.fixture(autouse=True)
def _env(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    for name in ("TOOLS_GATEWAY_DISABLED", "HERMES_PLATFORM_API_BASE", "API_SERVER_KEY", "MODEL_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("TOOLS_GATEWAY_BASE", GATEWAY_BASE)
    monkeypatch.setenv("TOOLS_GATEWAY_KEY", "test-agent-key")
    return home


@pytest.fixture
def video_mod(monkeypatch):
    module = _load_video_plugin()
    monkeypatch.setattr(module, "_desktop_video_model", lambda: None)
    yield module
    sys.modules.pop(module.__name__, None)


class Gateway:
    """Fake gateway leg: records request_json calls, answers like the platform."""

    def __init__(self, monkeypatch, *, supported: bool = True, upload=None):
        self.calls: list[dict] = []

        def request_json(method, path, payload=None, *, timeout=90, files=None, form_data=None, headers=None):
            self.calls.append({"method": method, "path": path, "payload": payload, "files": files})
            if path == "/tools/v1/check":
                section = {"configured": True, "serving": True, "legs": {}}
                if supported:
                    section["reference_audio"] = {"supported": True}
                return {"ok": True, "video": section}
            if path == UPLOAD:
                if isinstance(upload, BaseException):
                    raise upload
                return {"ok": True, "data": {"audio_ref": UPLOADED}}
            if path == JOBS:
                return {"job_id": "j1", "status": "done", "ok": True, "data": {}}
            return {"ok": True, "data": {}}

        monkeypatch.setattr(_gateway(), "request_json", request_json)
        monkeypatch.setattr(_gateway(), "download_media", lambda url, **_kw: Path("x"))
        monkeypatch.setattr(_audio(), "_download", lambda url, index: b"ID3-remote-voice")

    def paths(self) -> list[str]:
        return [call["path"] for call in self.calls]

    def generate(self) -> dict:
        (call,) = [c for c in self.calls if c["path"] == JOBS]
        return call["payload"]

    def uploads(self) -> list[bytes]:
        return [call["files"]["file"][1] for call in self.calls if call["path"] == UPLOAD]


def _voice(tmp_path: Path, name: str = "tts_1.mp3", content: bytes = b"ID3-local-voice") -> Path:
    path = tmp_path / "audio_cache" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return path


def _run(video_mod, **args) -> dict:
    return json.loads(video_mod._handle_generate_video({"prompt": "她看着镜头说话", "model": "MiniMax-H3", **args}))


@pytest.mark.parametrize(
    ("source", "sent", "uploaded"),
    [
        (lambda tmp: AUDIO_REF, {"ref": AUDIO_REF}, []),
        (lambda tmp: str(_voice(tmp)), {"ref": UPLOADED}, [b"ID3-local-voice"]),  # text_to_speech's file_path
        (lambda tmp: f"MEDIA:{_voice(tmp)}", {"ref": UPLOADED}, [b"ID3-local-voice"]),  # its media_tag line
        (lambda tmp: f"@file:`{_voice(tmp)}`", {"ref": UPLOADED}, [b"ID3-local-voice"]),  # a composer attachment
        (lambda tmp: _voice(tmp).as_uri(), {"ref": UPLOADED}, [b"ID3-local-voice"]),
        (lambda tmp: "https://cdn.example/voice.mp3?sig=1", {"ref": UPLOADED}, [b"ID3-remote-voice"]),
    ],
    ids=["audio-ref", "file-path", "media-tag", "attachment", "file-uri", "link"],
)
def test_desktop_audio_sources_become_what_the_platform_takes(monkeypatch, tmp_path, video_mod, source, sent, uploaded):
    fake = Gateway(monkeypatch)
    result = _run(video_mod, reference_audio=[{"source": source(tmp_path)}])
    assert "error" not in result, result
    assert fake.generate()["reference_audio"] == [sent]
    assert fake.uploads() == uploaded


def test_a_bare_string_and_an_audio_ref_key_are_taken_too(monkeypatch, video_mod):
    fake = Gateway(monkeypatch)
    _run(video_mod, reference_audio=[AUDIO_REF, {"audio_ref": AUDIO_REF}])
    assert fake.generate()["reference_audio"] == [{"ref": AUDIO_REF}, {"ref": AUDIO_REF}]


@pytest.mark.parametrize(
    ("audio", "says"),
    [
        (["/data/hermes/u/a/workspace/media/j/ref_audio_1.mp3"], "找不到第 1 段音频"),  # a master path: not here
        ("tts.mp3", "必须是列表"),
        ([{"role": "reference"}], "第 1 项没有 source"),
    ],
    ids=["not-here", "not-a-list", "no-source"],
)
def test_a_clip_that_cannot_be_used_fails_before_the_render(monkeypatch, video_mod, audio, says):
    fake = Gateway(monkeypatch)
    result = _run(video_mod, reference_audio=audio)
    assert "error" in result and says in result["error"]
    assert JOBS not in fake.paths() and UPLOAD not in fake.paths()


def test_nothing_goes_out_before_the_platform_says_it_takes_audio(monkeypatch, tmp_path, video_mod):
    fake = Gateway(monkeypatch, supported=False)
    result = _run(video_mod, reference_audio=[str(_voice(tmp_path))])
    assert "error" in result and "平台还不支持参考音频" in result["error"]
    assert all(call["method"] == "GET" for call in fake.calls), fake.paths()


def test_an_upload_failure_fails_the_call(monkeypatch, tmp_path, video_mod):
    failure = _gateway().GatewayError("媒体空间满了", status=503, code="vendor_unavailable")
    fake = Gateway(monkeypatch, upload=failure)
    result = _run(video_mod, reference_audio=[str(_voice(tmp_path))])
    assert "error" in result and "媒体空间满了" in result["error"] and "不会改成不带音频" in result["error"]
    assert JOBS not in fake.paths()


def test_a_clip_over_the_cap_is_never_uploaded(monkeypatch, tmp_path, video_mod):
    monkeypatch.setattr(_audio(), "MAX_BYTES", 8)
    fake = Gateway(monkeypatch)
    result = _run(video_mod, reference_audio=[str(_voice(tmp_path, content=b"x" * 9))])
    assert "error" in result and "超过" in result["error"]
    assert fake.uploads() == [] and JOBS not in fake.paths()


def test_an_upload_answer_without_a_handle_fails_the_call(monkeypatch, tmp_path, video_mod):
    fake = Gateway(monkeypatch)
    real = _gateway().request_json

    def no_handle(method, path, payload=None, **kwargs):
        if path == UPLOAD:
            fake.calls.append({"method": method, "path": path, "payload": payload, "files": kwargs.get("files")})
            return {"ok": True, "data": {"audio_ref": "/tmp/not-a-handle.mp3"}}
        return real(method, path, payload, **kwargs)

    monkeypatch.setattr(_gateway(), "request_json", no_handle)
    result = _run(video_mod, reference_audio=[str(_voice(tmp_path))])
    assert "error" in result and "no audio_ref" in result["error"]
    assert JOBS not in fake.paths()


def test_a_call_without_audio_sends_what_it_always_sent(monkeypatch, tmp_path, video_mod):
    """The body has no reference_audio, and the call's idempotency fingerprint (call_args) is
    the one an older build computed, so a call left pending across an upgrade still matches."""
    Gateway(monkeypatch)
    seen: list[tuple[dict, dict]] = []

    def generate_video(payload, *, call_args, timeout):
        seen.append((payload, call_args))
        return {"ok": True, "data": {}}

    monkeypatch.setattr(_gateway(), "generate_video", generate_video)
    _run(video_mod)
    payload, call_args = seen[-1]
    assert "reference_audio" not in payload
    assert set(call_args) == {"prompt", "aspect_ratio", "size", "seconds", "model", "provider", "images", "rights_confirmed"}
    clip = str(_voice(tmp_path))
    _run(video_mod, reference_audio=[clip])
    payload, call_args = seen[-1]
    assert payload["reference_audio"] == [{"ref": UPLOADED}]
    assert call_args["reference_audio"] == [clip], "the call as the agent made it, before the upload"


def test_the_legacy_leg_uploads_to_the_internal_route_and_passes_a_master_path(monkeypatch, tmp_path, video_mod):
    monkeypatch.setenv("TOOLS_GATEWAY_DISABLED", "1")
    monkeypatch.delenv("TOOLS_GATEWAY_BASE")
    monkeypatch.delenv("TOOLS_GATEWAY_KEY")
    monkeypatch.setenv("HERMES_PLATFORM_API_BASE", LEGACY_BASE)
    monkeypatch.setenv("API_SERVER_KEY", "legacy-key")
    sent: list[dict] = []
    uploads: list[tuple[str, bytes, str]] = []

    def request(method, path, payload=None, timeout=180):
        if path.endswith("/check"):
            return {"ok": True, "reference_audio": {"supported": True}, "legs": {}}
        sent.append(payload)
        return {"ok": True, "video_url": "https://x/v.mp4"}

    class _Answer:
        def __init__(self, body: dict):
            self._body = json.dumps(body).encode("utf-8")

        def read(self):
            return self._body

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def urlopen(req, timeout=None):
        uploads.append((req.full_url, req.data, req.get_header("Authorization")))
        return _Answer({"ok": True, "audio_ref": UPLOADED})

    monkeypatch.setattr(video_mod, "_request", request)
    monkeypatch.setattr(_audio().urllib.request, "urlopen", urlopen)
    master_path = "/data/hermes/u/a/workspace/media/" + "b" * 32 + "/ref_audio_1.mp3"
    _run(video_mod, reference_audio=[master_path, str(_voice(tmp_path))])
    assert sent[-1]["reference_audio"] == [{"path": master_path}, {"ref": UPLOADED}]
    ((url, body, auth),) = uploads
    assert url == LEGACY_BASE + "/media/reference-audio-upload" and b"ID3-local-voice" in body and auth == "Bearer legacy-key"


def test_the_schema_tells_the_model_what_the_platform_takes(video_mod):
    prop = video_mod.GENERATE_VIDEO_SCHEMA["parameters"]["properties"]["reference_audio"]
    assert prop["type"] == "array" and prop["maxItems"] == 3
    assert prop["items"] == {"type": "object", "properties": {"source": {"type": "string"}}, "required": ["source"]}
    for fact in ("MiniMax-H3", "text_to_speech", "file_path", "2-15 s", "15 s in all", "role=reference", "Leave seconds empty"):
        assert fact in prop["description"], fact
    assert "voice clip" in video_mod.GENERATE_VIDEO_SCHEMA["description"]


class _Stream:
    def __init__(self, status: int, chunks: list[bytes]):
        self.status_code, self._chunks = status, chunks

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def iter_bytes(self):
        yield from self._chunks


@pytest.mark.parametrize(
    ("status", "chunks", "message"),
    [(200, [b"x" * 5, b"x" * 5], "超过"), (404, [], "HTTP 404")],
    ids=["over-the-cap", "http-error"],
)
def test_a_linked_clip_is_capped_and_its_failure_named(monkeypatch, status, chunks, message):
    audio = _audio()
    monkeypatch.setattr(audio, "MAX_BYTES", 8)

    class Client:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def stream(self, method, url, headers=None):
            return _Stream(status, chunks)

    monkeypatch.setattr(audio.httpx, "Client", Client)
    with pytest.raises(audio.ReferenceAudioError) as exc:
        audio._download("https://cdn.example/voice.mp3", 1)
    assert message in str(exc.value)
