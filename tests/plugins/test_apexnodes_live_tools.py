"""hc-918 Desktop live recording plugin (apexnodes-live-tools).

Pure helpers are table-tested; the lifecycle runs the real plugin against a fake
ffmpeg executable (records argv/env, writes a segment, then waits for ``q`` on
stdin or exits early to simulate the stream dropping) with the gateway resolve
mocked. Nothing here touches the network or a real stream.
"""

from __future__ import annotations

import importlib.util
import json
import stat
import sys
import textwrap
import time
import types
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
PLUGIN_DIR = REPO_ROOT / "plugins" / "apexnodes-live-tools"
AUDIO_URL = "https://pull-flv.example.test/stage/stream-1.flv?only_audio=1&k=1"
VIDEO_URL = "https://pull-flv.example.test/stage/stream-1_uhd.flv?k=1"
LIVE = {"live": True, "platform": "douyin", "title": "测试直播", "anchor": "主播A", "audio_url": AUDIO_URL, "video_url": VIDEO_URL}
OFFLINE = {"live": False, "platform": "douyin", "title": "测试直播", "anchor": "主播A", "audio_url": None, "video_url": None}

FAKE_FFMPEG = textwrap.dedent(
    """
    import json, os, sys, time
    argv = sys.argv[1:]
    with open(os.environ["FAKE_FFMPEG_LOG"], "a", encoding="utf-8") as log:
        log.write(json.dumps({"argv": argv, "http_proxy": os.environ.get("http_proxy")}) + "\\n")
    if "concat" in argv:
        listing = argv[argv.index("-i") + 1]
        target = argv[-1]
        with open(target, "wb") as out:
            for line in open(listing, encoding="utf-8"):
                name = line.strip()[len("file '"):-1]
                out.write(open(name, "rb").read())
        sys.exit(0)
    pattern = argv[-1]
    with open(pattern.replace("%03d", "000"), "wb") as segment:
        segment.write(("seg:" + os.path.basename(pattern)).encode())
    if os.environ.get("FAKE_FFMPEG_MODE") == "exit":
        sys.exit(0)
    while sys.stdin.read(1) != "q":
        time.sleep(0.01)
    with open(os.environ["FAKE_FFMPEG_LOG"], "a", encoding="utf-8") as log:
        log.write(json.dumps({"quit": "q"}) + "\\n")
    sys.exit(0)
    """
)


def _load_plugin():
    if "hermes_plugins" not in sys.modules:
        namespace = types.ModuleType("hermes_plugins")
        namespace.__path__ = []  # type: ignore[attr-defined]
        sys.modules["hermes_plugins"] = namespace
    name = "hermes_plugins.apexnodes_live_tools"
    spec = importlib.util.spec_from_file_location(name, PLUGIN_DIR / "__init__.py", submodule_search_locations=[str(PLUGIN_DIR)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def plugin(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    module = _load_plugin()
    monkeypatch.setattr(module, "WATCH_INTERVAL_SECONDS", 0.05)
    monkeypatch.setattr(module, "STOP_GRACE_SECONDS", 5.0)
    yield module
    module._stop_all()
    module._RECORDINGS.clear()
    module._CHECK_CACHE.clear()
    sys.modules.pop(module.__name__, None)


@pytest.fixture
def fake_ffmpeg(tmp_path, monkeypatch, plugin):
    script = tmp_path / "fake_ffmpeg"
    script.write_text(f"#!{sys.executable}\n{FAKE_FFMPEG}", encoding="utf-8")
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    log = tmp_path / "ffmpeg_calls.jsonl"
    monkeypatch.setenv("FAKE_FFMPEG_LOG", str(log))
    monkeypatch.setattr(plugin, "_bundled_ffmpeg", lambda: str(script))
    return log


def _calls(log: Path) -> list[dict]:
    return [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()] if log.exists() else []


def _wait(predicate, timeout=10.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


def _resolver(plugin, monkeypatch, responses):
    seen: list[tuple[str, str]] = []
    queue = list(responses)

    def fake_resolve(platform, url):
        seen.append((platform, url))
        return dict(queue.pop(0) if len(queue) > 1 else queue[0])

    monkeypatch.setattr(plugin, "_resolve", fake_resolve)
    return seen


def _start(plugin, **args):
    return json.loads(plugin._handle_start({"url": "https://live.douyin.com/693877538059", "rights_confirmed": True, **args}))


# ── 1. pure helpers ───────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("url", "platform"),
    [
        ("https://live.douyin.com/693877538059", "douyin"),
        ("https://www.tiktok.com/@seller/live", "tiktok"),
        ("https://vt.tiktok.com/ZSjuyJnWQ/", "tiktok"),
        ("https://v.douyin.com/abc/", None),
        ("https://live.kuaishou.com/u/x", None),
    ],
)
def test_detect_live_platform(plugin, url, platform):
    assert plugin.detect_live_platform(url) == platform


@pytest.mark.parametrize(
    ("resolved", "mode", "expected"),
    [
        ({"audio_url": AUDIO_URL, "video_url": VIDEO_URL}, "audio", AUDIO_URL),
        ({"audio_url": None, "video_url": VIDEO_URL}, "audio", VIDEO_URL),
        ({"audio_url": AUDIO_URL, "video_url": VIDEO_URL}, "video", VIDEO_URL),
        ({"audio_url": AUDIO_URL, "video_url": None}, "video", None),
    ],
    ids=["audio-prefers-audio-only", "audio-falls-back-to-av", "video-uses-av", "video-never-records-audio-only"],
)
def test_choose_source(plugin, resolved, mode, expected):
    assert plugin.choose_source(resolved, mode) == expected


@pytest.mark.parametrize(
    ("mode", "codec_args", "muxer", "ext"),
    [("audio", ["-vn", "-c:a", "copy"], "adts", "aac"), ("video", ["-c", "copy"], "mpegts", "ts")],
)
def test_build_ffmpeg_command(plugin, tmp_path, mode, codec_args, muxer, ext):
    command = plugin.build_ffmpeg_command("ffmpeg", AUDIO_URL, tmp_path, mode=mode, seconds=3600.7, part=2)
    assert command[command.index("-i") + 1] == AUDIO_URL
    assert command[command.index("-t") + 1] == "3600"
    start = command.index("-t") + 2
    assert command[start : start + len(codec_args)] == codec_args
    assert command[command.index("-segment_format") + 1] == muxer
    assert command[command.index("-segment_time") + 1] == "600"
    assert command[-1] == str(tmp_path / f"part02-%03d.{ext}")
    assert plugin.build_ffmpeg_command("ffmpeg", AUDIO_URL, tmp_path, mode=mode, seconds=-5, part=1)[command.index("-t") + 1] == "1"


@pytest.mark.parametrize(
    ("platform", "proxies", "expected"),
    [
        ("tiktok", {"https": "http://127.0.0.1:1104"}, "http://127.0.0.1:1104"),
        ("tiktok", {"http": "127.0.0.1:8080"}, "http://127.0.0.1:8080"),
        ("tiktok", {"https": "socks5://127.0.0.1:1103"}, None),
        ("tiktok", {}, None),
        ("douyin", {"https": "http://127.0.0.1:1104"}, None),
    ],
    ids=["tiktok-https-proxy", "tiktok-bare-hostport", "tiktok-socks-unsupported", "tiktok-no-proxy", "douyin-direct"],
)
def test_ffmpeg_env_passes_user_proxy_for_tiktok_only(plugin, monkeypatch, platform, proxies, expected):
    monkeypatch.delenv("http_proxy", raising=False)
    assert plugin.ffmpeg_env(platform, proxies).get("http_proxy") == expected


# ── 2. registration + visibility gate ────────────────────────────────────────


class _Ctx:
    def __init__(self):
        self.tools: dict[str, dict] = {}

    def register_tool(self, **kwargs):
        self.tools[kwargs["name"]] = kwargs


def test_registers_three_tools_with_rights_required(plugin):
    ctx = _Ctx()
    plugin.register(ctx)
    assert set(ctx.tools) == {"live_record_start", "live_record_status", "live_record_stop"}
    assert ctx.tools["live_record_start"]["schema"]["parameters"]["required"] == ["url", "rights_confirmed"]
    assert ctx.tools["live_record_start"]["check_fn"] is plugin._check_live
    assert ctx.tools["live_record_stop"]["check_fn"] is plugin._check_manage


class _GatewayError(RuntimeError):
    pass


class _Gateway:
    GatewayError = _GatewayError

    def __init__(self, *, desktop=True, enabled=True, error=None):
        self.desktop, self.enabled, self.error, self.calls = desktop, enabled, error, 0

    def use_gateway(self):
        return True

    def _is_desktop(self):
        return self.desktop

    def agent_api_key(self):
        return "key"

    def request_json(self, method, path, payload=None, timeout=90):
        self.calls += 1
        assert (method, path) == ("GET", "/tools/v1/check")
        if self.error:
            raise self.error
        return {"live": {"enabled": self.enabled}}


@pytest.mark.parametrize(
    ("gateway", "visible", "calls"),
    [
        (_Gateway(enabled=True), True, 1),
        (_Gateway(enabled=False), False, 1),
        (_Gateway(desktop=False), False, 0),
        (_Gateway(error=_GatewayError("down")), False, 1),
    ],
    ids=["enabled", "entitlement-off", "not-desktop", "check-unreachable"],
)
def test_start_tool_visible_only_when_gateway_reports_live_enabled(plugin, monkeypatch, gateway, visible, calls):
    monkeypatch.setattr(plugin, "_gateway", gateway)
    assert plugin._check_live() is visible
    assert plugin._check_live() is visible  # second call is served from the cache
    assert gateway.calls == calls


# ── 3. start gates (no gateway call, no process) ─────────────────────────────


@pytest.mark.parametrize(
    ("args", "needle"),
    [
        ({"rights_confirmed": False}, "rights_confirmed=true"),
        ({"rights_confirmed": None}, "rights_confirmed=true"),
        ({"mode": "both"}, "mode"),
        ({"url": "https://v.douyin.com/abc/"}, "live.douyin.com"),
    ],
    ids=["rights-false", "rights-missing", "bad-mode", "share-link-not-live-url"],
)
def test_start_gates_run_before_resolving(plugin, monkeypatch, fake_ffmpeg, args, needle):
    seen = _resolver(plugin, monkeypatch, [LIVE])
    result = _start(plugin, **args)
    assert needle in result["error"]
    assert seen == [] and _calls(fake_ffmpeg) == []


def test_offline_room_starts_nothing(plugin, monkeypatch, fake_ffmpeg):
    _resolver(plugin, monkeypatch, [OFFLINE])
    result = _start(plugin)
    assert result["live"] is False and "未开播" in result["message"]
    assert _calls(fake_ffmpeg) == [] and plugin._RECORDINGS == {}


def test_missing_ffmpeg_and_low_disk_refuse_to_start(plugin, monkeypatch, fake_ffmpeg):
    _resolver(plugin, monkeypatch, [LIVE])
    monkeypatch.setattr(plugin, "_bundled_ffmpeg", lambda: None)
    assert "ffmpeg" in _start(plugin)["error"]
    monkeypatch.setattr(plugin, "_bundled_ffmpeg", lambda: "/bin/true")
    monkeypatch.setattr(plugin, "MIN_FREE_BYTES", {"audio": 1 << 62, "video": 1 << 62})
    assert "磁盘" in _start(plugin)["error"]
    assert not any((Path(plugin._recordings_root())).iterdir())


# ── 4. lifecycle against a fake ffmpeg ───────────────────────────────────────


def test_user_stop_quits_ffmpeg_gracefully_and_merges_locally(plugin, monkeypatch, fake_ffmpeg):
    seen = _resolver(plugin, monkeypatch, [LIVE])
    started = _start(plugin)
    rid = started["recording_id"]
    assert started["state"] == "recording" and started["live"] is True
    assert _wait(lambda: plugin._RECORDINGS[rid].segments())
    stopped = json.loads(plugin._handle_stop({"recording_id": rid}))
    assert (stopped["state"], stopped["reason"]) == ("stopped", "user_stop")
    assert Path(stopped["merged_path"]).read_bytes() == b"seg:part01-%03d.aac"
    assert "media_transcribe" in stopped["next_step"]
    calls = _calls(fake_ffmpeg)
    record = calls[0]["argv"]
    assert record[record.index("-i") + 1] == AUDIO_URL and "-vn" in record  # audio mode uses the audio-only stream
    assert {"quit": "q"} in calls  # graceful stop, not a kill
    assert seen == [("douyin", "https://live.douyin.com/693877538059")]
    assert json.loads((Path(stopped["directory"]) / "state.json").read_text())["state"] == "stopped"


def test_stream_drop_re_resolves_then_finishes_when_streamer_goes_offline(plugin, monkeypatch, fake_ffmpeg):
    monkeypatch.setenv("FAKE_FFMPEG_MODE", "exit")
    seen = _resolver(plugin, monkeypatch, [LIVE, LIVE, OFFLINE])
    rid = _start(plugin)["recording_id"]
    rec = plugin._RECORDINGS[rid]
    assert _wait(lambda: rec.state not in ("recording", "finishing"))
    assert (rec.state, rec.reason, rec.restarts, rec.part) == ("finished", "stream_ended", 2, 2)
    assert len(seen) == 3
    assert Path(rec.merged_path).read_bytes() == b"seg:part01-%03d.aacseg:part02-%03d.aac"


def test_final_state_is_published_only_after_the_merge(plugin, monkeypatch, fake_ffmpeg):
    _resolver(plugin, monkeypatch, [LIVE])
    rec = plugin._RECORDINGS[_start(plugin)["recording_id"]]
    assert _wait(lambda: rec.segments())
    states_during_merge: list[str] = []
    real_merge = plugin._merge

    def observing_merge(target):
        states_during_merge.append(target.state)
        assert "next_step" not in target.summary()
        return real_merge(target)

    monkeypatch.setattr(plugin, "_merge", observing_merge)
    plugin._handle_stop({"recording_id": rec.id})
    assert states_during_merge == ["finishing"]
    assert rec.state == "stopped" and rec.merged_path


def test_restarts_are_bounded(plugin, monkeypatch, fake_ffmpeg):
    monkeypatch.setenv("FAKE_FFMPEG_MODE", "exit")
    monkeypatch.setattr(plugin, "MAX_RESTARTS", 2)
    seen = _resolver(plugin, monkeypatch, [LIVE])
    rec = plugin._RECORDINGS[_start(plugin)["recording_id"]]
    assert _wait(lambda: rec.state not in ("recording", "finishing"))
    assert (rec.state, rec.reason) == ("failed", "too_many_restarts")
    assert len(seen) == 1 + 2  # start + two bounded re-resolves (each is a billed TikHub call)


def test_gateway_errors_on_re_resolve_are_retried_within_the_restart_cap(plugin, monkeypatch, fake_ffmpeg):
    monkeypatch.setenv("FAKE_FFMPEG_MODE", "exit")
    outcomes = [LIVE, plugin._gateway.GatewayError("network"), OFFLINE]

    def flaky_resolve(platform, url):
        outcome = outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return dict(outcome)

    monkeypatch.setattr(plugin, "_resolve", flaky_resolve)
    rec = plugin._RECORDINGS[_start(plugin)["recording_id"]]
    assert _wait(lambda: rec.state not in ("recording", "finishing"))
    assert (rec.state, rec.reason, rec.restarts) == ("finished", "stream_ended", 2)


def test_unexpected_watchdog_error_closes_the_recording(plugin, monkeypatch, fake_ffmpeg):
    monkeypatch.setenv("FAKE_FFMPEG_MODE", "exit")
    outcomes = [LIVE, KeyError("bug")]

    def broken_resolve(platform, url):
        outcome = outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return dict(outcome)

    monkeypatch.setattr(plugin, "_resolve", broken_resolve)
    rec = plugin._RECORDINGS[_start(plugin)["recording_id"]]
    assert _wait(lambda: rec.state not in ("recording", "finishing"))
    assert (rec.state, rec.reason) == ("failed", "watchdog_error")
    assert rec.merged_path  # what was recorded before the error is still merged locally


def test_tiktok_recording_gets_the_user_proxy(plugin, monkeypatch, fake_ffmpeg):
    monkeypatch.delenv("http_proxy", raising=False)
    monkeypatch.setattr(plugin.urllib.request, "getproxies", lambda: {"https": "http://127.0.0.1:1104"})
    _resolver(plugin, monkeypatch, [{**LIVE, "platform": "tiktok"}])
    result = json.loads(plugin._handle_start({"url": "https://www.tiktok.com/@seller/live", "rights_confirmed": True, "mode": "video"}))
    assert _wait(lambda: _calls(fake_ffmpeg))
    call = _calls(fake_ffmpeg)[0]
    assert call["http_proxy"] == "http://127.0.0.1:1104"
    assert call["argv"][call["argv"].index("-i") + 1] == VIDEO_URL
    plugin._handle_stop({"recording_id": result["recording_id"]})


def test_concurrent_recordings_are_capped(plugin, monkeypatch, fake_ffmpeg):
    monkeypatch.setattr(plugin, "MAX_ACTIVE", 1)
    _resolver(plugin, monkeypatch, [LIVE])
    first = _start(plugin)
    assert "最多" in _start(plugin)["error"]
    plugin._handle_stop({"recording_id": first["recording_id"]})


def test_status_lists_recordings_and_manage_tools_stay_visible(plugin, monkeypatch, fake_ffmpeg):
    _resolver(plugin, monkeypatch, [LIVE])
    monkeypatch.setattr(plugin, "_gateway", _Gateway(enabled=False))
    rid = _start(plugin)["recording_id"]
    assert plugin._check_live() is False and plugin._check_manage() is True
    listed = json.loads(plugin._handle_status({}))["recordings"]
    assert [item["recording_id"] for item in listed] == [rid]
    assert "error" in json.loads(plugin._handle_status({"recording_id": "nope"}))
    plugin._handle_stop({"recording_id": rid})
