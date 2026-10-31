"""hc-1054: the Desktop's long-video analysis tools beyond the shared contract.

The contract cases (schema, endpoints, job follow, result files, English queries, the
proxy upload) are in ``test_apexnodes_plugin_contract.py``. Here:

* the 480p analysis proxy: what ffmpeg is asked for, a real run when ffmpeg is on PATH,
  the duration without ffprobe, the cache, a failed transcode;
* the account's limits are read before any transcoding (too long, not opened, no direct
  upload, a missing file);
* a thumbnail that cannot be fetched keeps its link and never a server path;
* the legacy leg: a file outside the media space is copied in, the chat is captured for
  the hc-371 push (the gateway leg sends no chat: the Desktop has no push).
"""

from __future__ import annotations

import itertools
import json
import shutil
import subprocess
import types
from pathlib import Path

import pytest

import plugins.apexnodes_video_analysis as analysis
from tests.plugins.test_apexnodes_plugin_contract import (
    _VH_JOB_PATHS,
    GatewayHarness,
    LegacyHarness,
    _analysis_answer,
)

SOURCE = "media:" + "b" * 32 + "/long.mp4"


@pytest.fixture
def gateway(monkeypatch, tmp_path) -> GatewayHarness:
    return GatewayHarness(monkeypatch, tmp_path)


@pytest.fixture
def legacy(monkeypatch, tmp_path) -> LegacyHarness:
    return LegacyHarness(monkeypatch, tmp_path)


def _answers(h, **check):
    """The platform's answers, with ``check`` overriding the account's check view."""

    def canned(path: str):
        if path.endswith("/video/analysis/check"):
            answer = _analysis_answer(path)
            answer["video_analysis"].update(check)
            return answer
        return _analysis_answer(path) if path.startswith(_VH_JOB_PATHS) else type(h)._canned(path)

    return canned


# ── the proxy ─────────────────────────────────────────────────────────────────


def test_the_proxy_keeps_the_timeline_and_shrinks_everything_else(tmp_path):
    command = analysis.proxy_command("ffmpeg", tmp_path / "in.mov", tmp_path / "out.part")
    pairs = list(itertools.pairwise(command))
    args = dict(pairs)
    assert "854" in args["-vf"] and args["-fpsmax"] == "30"
    assert (args["-c:v"], args["-crf"], args["-c:a"], args["-ac"], args["-b:a"]) == ("libx264", "30", "aac", "1", "64k")
    # The first video and audio stream; a video without audio is fine ("?").
    assert ("-map", "0:v:0") in pairs and ("-map", "0:a:0?") in pairs
    # Nothing that moves or trims the timeline: the picked seconds must cut the original.
    assert not {"-ss", "-t", "-to", "-itsoffset", "-r"} & set(command)


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg on PATH")
def test_a_real_transcode_makes_a_small_proxy_once(tmp_path, monkeypatch):
    ffmpeg = shutil.which("ffmpeg")
    source = tmp_path / "wide.mp4"
    subprocess.run(
        [ffmpeg, "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=2:size=1920x1080:rate=60",
         "-f", "lavfi", "-i", "sine=duration=2", "-c:v", "libx264", "-c:a", "aac", str(source)],
        check=True,
    )
    proxy = analysis.make_proxy(ffmpeg, source)
    assert analysis.make_proxy(ffmpeg, source) == proxy, "the same file is not transcoded twice"
    probe = subprocess.run([ffmpeg, "-hide_banner", "-i", str(proxy)], capture_output=True, text=True, check=False).stderr
    assert "854x480" in probe and "30 fps" in probe and "mono" in probe
    assert abs(analysis.duration_seconds(ffmpeg, proxy) - 2.0) < 0.2


def test_without_ffprobe_the_duration_comes_from_ffmpegs_header(tmp_path, monkeypatch):
    seen = []

    def fake_run(command, **_kwargs):
        seen.append(command)
        return types.SimpleNamespace(returncode=1, stdout="", stderr="  Duration: 01:02:03.50, start: 0.0, bitrate: 900 kb/s")

    monkeypatch.setattr(analysis.shutil, "which", lambda _name: None)
    monkeypatch.setattr(analysis.subprocess, "run", fake_run)
    assert analysis.duration_seconds(str(tmp_path / "ffmpeg"), tmp_path / "in.mp4") == 3723.5
    assert seen[0][0].endswith("ffmpeg")


def test_the_same_file_is_transcoded_once(tmp_path, monkeypatch):
    source = tmp_path / "long.mp4"
    source.write_bytes(b"v")
    runs = []

    def fake_run(command, **_kwargs):
        runs.append(command)
        Path(command[-1]).write_bytes(b"proxy")
        return types.SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(analysis.subprocess, "run", fake_run)
    monkeypatch.setattr(analysis._gateway, "media_cache_dir", lambda: tmp_path / "cache")
    first = analysis.make_proxy("ffmpeg", source)
    assert analysis.make_proxy("ffmpeg", source) == first and len(runs) == 1
    assert first.read_bytes() == b"proxy" and not list(first.parent.glob("*.part"))
    source.write_bytes(b"an edited video")  # another size: another proxy
    assert analysis.make_proxy("ffmpeg", source) != first and len(runs) == 2


def test_a_failed_transcode_leaves_nothing_and_says_why(tmp_path, monkeypatch):
    source = tmp_path / "broken.mp4"
    source.write_bytes(b"not a video")
    calls = []

    def fake_run(command, **_kwargs):
        calls.append(command)
        Path(command[-1]).write_bytes(b"half")
        return types.SimpleNamespace(returncode=1, stdout="", stderr="header\nInvalid data found when processing input")

    monkeypatch.setattr(analysis.subprocess, "run", fake_run)
    monkeypatch.setattr(analysis._gateway, "media_cache_dir", lambda: tmp_path / "cache")
    with pytest.raises(analysis._Failure, match="Invalid data found"):
        analysis.make_proxy("ffmpeg", source)
    assert len(calls) == 1
    assert list((tmp_path / "cache" / "analysis-proxies").iterdir()) == [], "no partial file and no cached proxy"


# ── limits before any transcoding ─────────────────────────────────────────────


@pytest.mark.parametrize(
    ("check", "seconds", "said"),
    [
        ({"max_source_minutes": 120}, 3 * 3600.0, "单条最长 120 分钟"),
        ({"enabled": False}, 60.0, "还没有对这个账号开放"),
        ({"direct_upload_available": False}, 60.0, "直传通道暂时不可用"),
    ],
    ids=["too-long", "not-opened", "no-direct-upload"],
)
def test_the_accounts_limits_are_read_before_transcoding(gateway, monkeypatch, check, seconds, said):
    monkeypatch.setattr(analysis, "duration_seconds", lambda _ffmpeg, _path: seconds)
    gateway._canned = _answers(gateway, **check)  # type: ignore[method-assign]
    result, calls = gateway.invoke("video_highlights", gateway.probe_args("video_highlights"))
    assert said in result["error"]
    assert gateway.proxied == [] and gateway.puts == []
    assert [c.path for c in calls] == ["/tools/v1/video/analysis/check"]


def test_a_missing_local_file_is_named(gateway):
    missing = gateway.tmp_path / "gone.mp4"
    result, calls = gateway.invoke("video_highlights", {"source": str(missing)})
    # A long folder path is cut from the front; the file's name stays.
    assert "gone.mp4" in result["error"] and calls == []


def test_a_server_handle_is_passed_as_it_is(gateway):
    _result, calls = gateway.invoke("video_highlights", {"source": SOURCE})
    (submit,) = [c for c in calls if c.method == "POST" and c.path.endswith("/jobs")]
    assert submit.body["source"] == {"ref": SOURCE} and gateway.proxied == []


# ── results on this machine ───────────────────────────────────────────────────


def test_a_thumbnail_that_cannot_be_fetched_keeps_its_link_only(gateway):
    gateway.download_media_fails = True
    gateway._canned = lambda path: _analysis_answer(path, eta=30) if path.startswith(_VH_JOB_PATHS) else GatewayHarness._canned(path)  # type: ignore[method-assign]
    raw, _calls = gateway.invoke_raw("video_highlights", gateway.probe_args("video_highlights"))
    result = json.loads(raw)
    (thumb,) = result["thumbnails"]
    assert thumb["path"] is None and thumb["url"].startswith("https://")
    assert "media:" not in raw and "/data/hermes" not in raw


def test_a_queued_job_is_said_with_its_wait(gateway):
    result, _calls = gateway.invoke("video_moment_search", gateway.probe_args("video_moment_search"))
    assert result["status"] == "queued" and result["job_id"] == "j1"
    assert "用这个 job_id 再调用一次" in result["note"]


# ── the legacy leg ────────────────────────────────────────────────────────────


def test_legacy_copies_a_file_outside_the_media_space(legacy, tmp_path):
    from hermes_constants import get_hermes_home

    attachment = tmp_path / "下载" / "clip.MP4"
    attachment.parent.mkdir()
    attachment.write_bytes(b"clip")
    _result, calls = legacy.invoke("video_highlights", {"source": str(attachment)})
    (submit,) = [c for c in calls if c.method == "POST" and c.path.endswith("/jobs")]
    directory, name = submit.body["source"]["ref"].removeprefix("media:").split("/")
    assert name == "clip.mp4"
    assert (Path(get_hermes_home()) / "workspace" / "media" / directory / name).read_bytes() == b"clip"


@pytest.mark.parametrize("leg", ["legacy", "gateway"])
def test_only_the_legacy_leg_captures_the_chat_for_the_push(request, leg):
    h = request.getfixturevalue(leg)
    for env, value in (("HERMES_SESSION_CHAT_ID", "c1"), ("HERMES_SESSION_PLATFORM", "weixin")):
        h.monkeypatch.setenv(env, value)
    _result, calls = h.invoke("video_highlights", {"source": SOURCE})
    (submit,) = [c for c in calls if c.method == "POST" and c.path.endswith("/jobs")]
    if leg == "legacy":
        assert submit.body["delivery_target"] == {"chat_id": "c1", "platform": "weixin"}
    else:
        assert "delivery_target" not in submit.body
