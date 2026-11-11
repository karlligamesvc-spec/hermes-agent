"""hc-1220: find_music on the Desktop (plugins/apexnodes_music_library.py).

The verified cache on both legs is pinned by the plugin contract (music_verified_cache in
tests/plugins/test_apexnodes_plugin_contract.py). Here: the tool is listed only while the platform has the
library open; a dropped download is tried once more, then reported without a file; an answer without a usable
download is refused before anything is fetched.
"""

from __future__ import annotations

import hashlib
import json
import urllib.error
from pathlib import Path

import pytest

from plugins import apexnodes_gateway as gateway
from plugins import apexnodes_music_library as music

AUDIO = b"apex-library-track" * 64
SHA = hashlib.sha256(AUDIO).hexdigest()
ANSWER = {"ok": True, "download": {"url": "https://cos.test/a.m4a?sign=x", "sha256": SHA, "bytes": len(AUDIO), "ext": "m4a"},
          "credit": "音乐：x", "credit_required": False, "provenance": {"source_type": "apex_library"}}


@pytest.fixture(autouse=True)
def _home(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("TOOLS_GATEWAY_BASE", "https://gw.test")
    monkeypatch.setenv("TOOLS_GATEWAY_KEY", "k")
    monkeypatch.delenv("TOOLS_GATEWAY_DISABLED", raising=False)


@pytest.mark.parametrize(("answer", "listed"), [
    ({"ok": True, "music_library": {"enabled": True, "tracks": 39}}, True),
    ({"ok": True, "music_library": {"enabled": False, "tracks": 0}}, False),
    (gateway.GatewayError("down", status=503, code="vendor_unavailable"), False),
])
def test_the_tool_is_listed_only_while_the_library_is_open(monkeypatch, answer, listed):
    def request_json(method, path, payload=None, **_kwargs):
        assert (method, path) == ("GET", "/tools/v1/music/check")
        if isinstance(answer, BaseException):
            raise answer
        return answer

    monkeypatch.setattr(gateway, "request_json", request_json)
    assert music.check() is listed


class _Body:
    def __init__(self, data: bytes):
        self._data, self._sent = data, False

    def read(self, _size=-1):
        if self._sent:
            return b""
        self._sent = True
        return self._data

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_a_dropped_download_is_tried_once_more(monkeypatch):
    monkeypatch.setattr(gateway, "request_json", lambda *_a, **_k: ANSWER)
    attempts = []

    def urlopen(url, timeout=None):
        attempts.append(url)
        if len(attempts) == 1:
            raise urllib.error.URLError("connection reset")
        return _Body(AUDIO)

    monkeypatch.setattr("urllib.request.urlopen", urlopen)
    result = json.loads(music.run({"platform": "douyin", "mood": "warm"}))
    assert len(attempts) == 2 and Path(result["file"]).read_bytes() == AUDIO


def test_two_failed_downloads_report_and_leave_no_file(monkeypatch):
    monkeypatch.setattr(gateway, "request_json", lambda *_a, **_k: ANSWER)

    def urlopen(url, timeout=None):
        raise urllib.error.URLError("connection reset")

    monkeypatch.setattr("urllib.request.urlopen", urlopen)
    result = json.loads(music.run({"platform": "douyin", "mood": "warm"}))
    assert "error" in result and "connection reset" in result["error"] and "sign=" not in result["error"]
    assert not list(music.cache_dir().iterdir())


@pytest.mark.parametrize("download", [
    {},
    {**ANSWER["download"], "sha256": "not-a-hash"},
    {**ANSWER["download"], "ext": "../x"},
    {**ANSWER["download"], "bytes": "big"},
])
def test_an_answer_without_a_usable_download_is_refused_before_any_fetch(monkeypatch, download):
    monkeypatch.setattr(gateway, "request_json", lambda *_a, **_k: {**ANSWER, "download": download})
    monkeypatch.setattr("urllib.request.urlopen", lambda *_a, **_k: pytest.fail("nothing is fetched"))
    assert "error" in json.loads(music.run({"platform": "douyin", "mood": "warm"}))


def test_the_pick_carries_only_what_the_caller_gave(monkeypatch):
    sent = []
    monkeypatch.setattr(gateway, "request_json", lambda method, path, payload=None, **_k: sent.append(payload) or ANSWER)
    monkeypatch.setattr("urllib.request.urlopen", lambda *_a, **_k: _Body(AUDIO))
    music.run({"platform": " TikTok ", "mood": "light", "scene": "beat", "exclude": ["T36", " "], "duration_seconds": 0})
    assert sent == [{"platform": "tiktok", "mood": "light", "scene": "beat", "exclude": ["T36"]}]
