"""APEX Desktop live recording (hc-918).

The cloud tools gateway resolves a live-room link to signed pull URLs
(``POST /tools/v1/social/{platform}/live-resolve``: default-off ``live_recording``
entitlement, the user's rights attestation required, URLs only). This plugin
records on this machine with the bundled ffmpeg (``-c copy``, 10-minute
segments) and never uploads the recording. When a recording ends the parts are
merged locally — audio into an ``.m4a`` container, because raw ADTS carries no
duration (2026-10-18 test: ffprobe estimated 758 s for a 600 s recording and
misled the Agent) — and the file is handed to the existing ``media_transcribe``
tool for the transcript.

Lifecycle: ``live_record_start`` spawns ffmpeg and a watchdog thread. When
ffmpeg exits on its own the watchdog re-resolves the room through the gateway's
canonical ``live_url`` (a profile or share link would cost an extra lookup each
time): still live → a new part with a fresh URL (bounded restarts); offline →
finished. The time limit
and a free-disk floor also end a recording. ``live_record_stop`` asks ffmpeg to
quit with ``q`` on stdin (portable, unlike SIGINT on Windows) before escalating.
TikTok pull URLs need the user's own overseas network, so the user's HTTP proxy
is passed to ffmpeg explicitly: ffmpeg does not read the OS proxy settings.
"""

from __future__ import annotations

import atexit
import json
import logging
import os
import shutil
import subprocess
import threading
import time
import urllib.request
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from agent.memory_provider import spawn_context_thread
from hermes_constants import get_hermes_home
from tools.environments.local import served_profile_child_env
from tools.registry import tool_error, tool_result

try:  # gateway client shared by the fork's platform plugins
    from plugins import apexnodes_gateway as _gateway
except ImportError:  # pragma: no cover - only for a bare copy without the gateway module
    _gateway = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parents[2]
SEGMENT_SECONDS = 600
DEFAULT_MAX_MINUTES = 240
MAX_MINUTES = 720
MAX_RESTARTS = 5
MAX_ACTIVE = 3
WATCH_INTERVAL_SECONDS = 2.0
STOP_GRACE_SECONDS = 15.0
CHECK_TTL_SECONDS = 300.0
MIN_FREE_BYTES = {"audio": 500 * 1024**2, "video": 5 * 1024**3}
# (ffmpeg segment muxer, file extension): both formats survive a crash mid-segment.
SEGMENT_FORMATS = {"audio": ("adts", "aac"), "video": ("mpegts", "ts")}
# The merged file. ADTS has no duration field, so readers estimate it from the first
# frames' bitrate (badly, for live audio that starts quiet); MP4 stores the exact
# duration. MPEG-TS carries timestamps, so the video merge keeps its container.
MERGED_EXT = {"audio": "m4a", "video": "ts"}

# ── credential seam shared by every platform plugin (hc-604 audit) ────────────
# Live recording only exists on the /tools/v1 gateway leg; these accessors keep the
# plugin on the same Desktop-injection contract the credential audit checks.


def _api_base() -> str:
    base = (
        os.getenv("HERMES_PLATFORM_API_BASE")
        or os.getenv("HERMES_MASTER_API_BASE")
        or os.getenv("HERMES_SCHEDULER_API_BASE")
        or "http://host.docker.internal:8000/api/v1"
    )
    return base.rstrip("/")


def _agent_api_key() -> str:
    if _gateway is not None:
        return _gateway.agent_api_key()
    return (os.getenv("API_SERVER_KEY") or os.getenv("MODEL_API_KEY") or "").strip()


def _missing_credential_message() -> str:
    if _gateway is not None:
        return str(_gateway.missing_credential_error())
    return "本环境没有平台凭据,平台工具不可用:请注入 TOOLS_GATEWAY_KEY 后重启。"


RIGHTS_MESSAGE = (
    "只能录制用户本人或已获主播授权的直播间。请先问用户:是不是主播本人,或者是否已获得主播授权?"
    "得到明确确认后,再以 rights_confirmed=true 调用。"
)
TRANSCRIBE_HINT = (
    "录制已结束,录制文件只在本机。duration_seconds 是录音的准确时长,以它为准。"
    "需要逐字稿时,用 media_transcribe(video_path=merged_path) 转写一次:结果里没有 segments_path"
    "(或 segments_summary.count 为 0)就是这次拿不到时间轴,不要为了时间轴重复转写"
    "(重转也不会有时间轴,force_refresh 还会重新计费),节奏和时间分配按逐字稿篇幅估算并注明是估算。"
)
MERGE_FAILED_HINT = "分段没能合并成一个文件,原始分段仍在 directory 里,可以逐段转写。"


# ── pure helpers (table-tested) ───────────────────────────────────────────────


def detect_live_platform(url: str) -> str | None:
    """Pick the gateway platform. Which Douyin/TikTok links resolve to a live room
    (live room, profile, app share or short link) is decided by the gateway, which
    rejects anything else before any vendor call or charge."""
    text = (url or "").lower()
    if any(host in text for host in ("douyin.com", "iesdouyin.com", "amemv.com")):
        return "douyin"
    if "tiktok.com" in text:
        return "tiktok"
    return None


def choose_source(resolved: dict[str, Any], mode: str) -> str | None:
    """Audio mode prefers the audio-only stream; any A/V stream works with ``-vn``."""
    if mode == "audio":
        return resolved.get("audio_url") or resolved.get("video_url")
    return resolved.get("video_url")


def build_ffmpeg_command(ffmpeg: str, source_url: str, out_dir: Path, *, mode: str, seconds: float, part: int) -> list[str]:
    muxer, ext = SEGMENT_FORMATS[mode]
    command = [
        ffmpeg, "-hide_banner", "-nostats", "-loglevel", "warning",
        "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
        "-rw_timeout", "15000000",
        "-i", source_url,
        "-t", str(max(1, int(seconds))),
    ]
    command += ["-vn", "-c:a", "copy"] if mode == "audio" else ["-c", "copy"]
    command += [
        "-f", "segment", "-segment_time", str(SEGMENT_SECONDS), "-segment_format", muxer,
        "-reset_timestamps", "1", str(out_dir / f"part{part:02d}-%03d.{ext}"),
    ]
    return command


def build_merge_command(ffmpeg: str, listing: Path, target: Path, *, mode: str) -> list[str]:
    """Concatenate the parts with stream copy; audio is remuxed from ADTS into MP4."""
    command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(listing), "-c", "copy"]
    if mode == "audio":
        command += ["-bsf:a", "aac_adtstoasc", "-movflags", "+faststart"]
    return command + ["-y", str(target)]


def ffmpeg_env(platform: str, proxies: dict[str, str] | None = None) -> dict[str, str]:
    """The served profile's child env without credentials (ffmpeg needs none); for TikTok
    also the user's HTTP(S) proxy, because ffmpeg ignores the OS proxy settings."""
    env = served_profile_child_env()
    if platform != "tiktok":
        return env
    proxies = urllib.request.getproxies() if proxies is None else proxies
    proxy = (proxies.get("https") or proxies.get("http") or "").strip()
    if proxy and "://" not in proxy:
        proxy = f"http://{proxy}"
    if proxy.lower().startswith(("http://", "https://")):
        env["http_proxy"] = proxy
    return env


def _no_window() -> dict[str, Any]:
    """Windows: child processes must not flash a console window."""
    return {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}


def _bundled_ffmpeg() -> str | None:
    bundled = ROOT / ".runtime" / "bin" / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
    if bundled.is_file():
        return str(bundled)
    return shutil.which("ffmpeg")


def _recordings_root() -> Path:
    root = Path(get_hermes_home()) / "live-recordings"
    root.mkdir(parents=True, exist_ok=True)
    return root


# ── recordings ────────────────────────────────────────────────────────────────


@dataclass
class _Recording:
    id: str
    platform: str
    url: str
    mode: str
    directory: Path
    ffmpeg: str
    title: str
    anchor: str
    started_at: float
    deadline: float
    state: str = "recording"  # recording | finishing (merging) | finished | stopped | failed
    reason: str = ""
    resolve_url: str = ""  # the gateway's canonical live_url, used for re-resolves
    part: int = 1
    restarts: int = 0
    stop_requested: bool = False
    ended_at: float | None = None
    merged_path: str | None = None
    duration_seconds: float | None = None
    process: subprocess.Popen | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)

    def segments(self) -> list[Path]:
        return sorted(self.directory.glob(f"part*-*.{SEGMENT_FORMATS[self.mode][1]}"))

    def summary(self) -> dict[str, Any]:
        segments = self.segments()
        out = {
            "recording_id": self.id,
            "state": self.state,
            "reason": self.reason,
            "platform": self.platform,
            "mode": self.mode,
            "title": self.title,
            "anchor": self.anchor,
            "directory": str(self.directory),
            "elapsed_seconds": int((self.ended_at or time.time()) - self.started_at),
            "segments": len(segments),
            "bytes": sum(path.stat().st_size for path in segments),
            "restarts": self.restarts,
            "merged_path": self.merged_path,
        }
        if self.duration_seconds is not None:
            out["duration_seconds"] = self.duration_seconds
        if self.state not in ("recording", "finishing"):
            if self.merged_path:
                out["next_step"] = TRANSCRIBE_HINT
            else:
                out["next_step"] = MERGE_FAILED_HINT if segments else "没有可用的录制文件。"
        return out


_RECORDINGS: dict[str, _Recording] = {}
_REGISTRY_LOCK = threading.Lock()
_CHECK_CACHE: dict[str, tuple[float, bool]] = {}


def _resolve(platform: str, url: str) -> dict[str, Any]:
    body = _gateway.request_json(
        "POST", f"/tools/v1/social/{platform}/live-resolve", {"url": url, "rights_attested": True}, timeout=60
    )
    return _gateway.unwrap(body)


def _spawn(rec: _Recording, source_url: str) -> None:
    command = build_ffmpeg_command(
        rec.ffmpeg, source_url, rec.directory, mode=rec.mode, seconds=rec.deadline - time.time(), part=rec.part
    )
    with open(rec.directory / "ffmpeg.log", "ab") as log:
        rec.process = subprocess.Popen(
            command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=log, env=ffmpeg_env(rec.platform), **_no_window()
        )


def _stop_process(rec: _Recording) -> None:
    process = rec.process
    if process is None or process.poll() is not None:
        return
    try:
        process.stdin.write(b"q")
        process.stdin.flush()
    except (OSError, ValueError):
        pass
    try:
        process.wait(timeout=STOP_GRACE_SECONDS)
    except subprocess.TimeoutExpired:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def _merge(rec: _Recording) -> str | None:
    """Concatenate the parts locally (ffmpeg concat demuxer, stream copy)."""
    segments = rec.segments()
    if not segments:
        return None
    target = rec.directory / f"recording.{MERGED_EXT[rec.mode]}"
    listing = rec.directory / "parts.txt"
    listing.write_text("".join(f"file '{path.name}'\n" for path in segments), encoding="utf-8")
    result = subprocess.run(
        build_merge_command(rec.ffmpeg, listing, target, mode=rec.mode),
        cwd=rec.directory,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        timeout=900,
        check=False,
        **_no_window(),
    )
    return str(target) if result.returncode == 0 and target.is_file() and target.stat().st_size > 0 else None


def _probe_duration(ffmpeg: str, path: str) -> float | None:
    """The merged file's container duration (exact for .m4a; .ts from timestamps), via
    the ffprobe shipped next to the bundled ffmpeg. None when it cannot be read."""
    sibling = Path(ffmpeg).with_name("ffprobe.exe" if os.name == "nt" else "ffprobe")
    ffprobe = str(sibling) if sibling.is_file() else shutil.which("ffprobe")
    if not ffprobe:
        return None
    try:
        result = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
            **_no_window(),
        )
        return round(float(result.stdout.strip()), 1) if result.returncode == 0 else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def _write_state(rec: _Recording) -> None:
    state = {key: value for key, value in rec.summary().items() if key != "next_step"}
    (rec.directory / "state.json").write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def _finish(rec: _Recording, state: str, reason: str) -> None:
    """Publish the final state only after the merge, so a status read never sees an
    ended recording without its merged file."""
    with rec.lock:
        if rec.state != "recording":
            return
        rec.state = "finishing"
        rec.ended_at = time.time()
    rec.merged_path = _merge(rec)
    if rec.merged_path:
        rec.duration_seconds = _probe_duration(rec.ffmpeg, rec.merged_path)
    rec.state, rec.reason = state, reason
    _write_state(rec)


def _disk_low(rec: _Recording) -> bool:
    return shutil.disk_usage(rec.directory).free < MIN_FREE_BYTES[rec.mode]


def _watch(rec: _Recording) -> None:
    """Thread boundary: an unexpected error must not leave a recording stuck in
    ``recording`` with no watchdog, so it is logged and the recording is closed."""
    try:
        _watch_loop(rec)
    except Exception:
        logger.exception("live recording %s watchdog crashed", rec.id)
        _stop_process(rec)
        _finish(rec, "failed", "watchdog_error")


def _watch_loop(rec: _Recording) -> None:
    while True:
        time.sleep(WATCH_INTERVAL_SECONDS)
        if rec.state != "recording" or rec.stop_requested:
            return
        if rec.process is not None and rec.process.poll() is None:
            if _disk_low(rec):
                _stop_process(rec)
                _finish(rec, "finished", "disk_low")
                return
            continue
        if rec.stop_requested:
            return
        if time.time() >= rec.deadline - 5:
            _finish(rec, "finished", "max_duration")
            return
        if rec.restarts >= MAX_RESTARTS:
            _finish(rec, "failed", "too_many_restarts")
            return
        rec.restarts += 1
        try:
            resolved = _resolve(rec.platform, rec.resolve_url or rec.url)
        except _gateway.GatewayError:
            continue  # counted as a restart attempt; the next tick retries
        rec.resolve_url = str(resolved.get("live_url") or rec.resolve_url or rec.url)
        if not resolved.get("live"):
            _finish(rec, "finished", "stream_ended")
            return
        source = choose_source(resolved, rec.mode)
        if not source:
            _finish(rec, "failed", "no_stream_url")
            return
        rec.part += 1
        _spawn(rec, source)


def _stop_all() -> None:
    for rec in list(_RECORDINGS.values()):
        if rec.state == "recording":
            rec.stop_requested = True
            _stop_process(rec)
            _finish(rec, "stopped", "app_exit")


atexit.register(_stop_all)


# ── tools ─────────────────────────────────────────────────────────────────────


def _handle_start(args: dict, **_kwargs) -> str:
    url = str(args.get("url") or "").strip()
    mode = str(args.get("mode") or "audio").strip().lower()
    if args.get("rights_confirmed") is not True:
        return tool_error(RIGHTS_MESSAGE)
    if mode not in SEGMENT_FORMATS:
        return tool_error("mode 只能是 audio 或 video。")
    platform = detect_live_platform(url)
    if platform is None:
        return tool_error("只支持抖音和 TikTok:直播间链接、主播主页链接或 App 分享的短链。")
    ffmpeg = _bundled_ffmpeg()
    if not ffmpeg:
        return tool_error("没有找到 APEX 自带的 ffmpeg,请修复或重新安装 APEX Desktop。")
    with _REGISTRY_LOCK:
        if sum(rec.state == "recording" for rec in _RECORDINGS.values()) >= MAX_ACTIVE:
            return tool_error(f"同时最多录制 {MAX_ACTIVE} 个直播间,请先结束一个。")
    try:
        resolved = _resolve(platform, url)
    except _gateway.GatewayError as exc:
        return tool_error(f"直播间解析失败: {exc}")
    if not resolved.get("live"):
        return tool_result(ok=True, live=False, title=resolved.get("title"), anchor=resolved.get("anchor"), message="主播当前未开播,没有开始录制。")
    source = choose_source(resolved, mode)
    if not source:
        return tool_error("平台没有返回可用的拉流地址,没有开始录制。")
    directory = _recordings_root() / f"{time.strftime('%Y%m%d-%H%M%S')}-{platform}-{uuid.uuid4().hex[:6]}"
    directory.mkdir(parents=True)
    if shutil.disk_usage(directory).free < MIN_FREE_BYTES[mode]:
        shutil.rmtree(directory, ignore_errors=True)
        return tool_error("磁盘剩余空间不足,没有开始录制。")
    minutes = max(1, min(MAX_MINUTES, int(args.get("max_minutes") or DEFAULT_MAX_MINUTES)))
    now = time.time()
    rec = _Recording(
        id=uuid.uuid4().hex[:12], platform=platform, url=url, mode=mode, directory=directory, ffmpeg=ffmpeg,
        title=str(resolved.get("title") or ""), anchor=str(resolved.get("anchor") or ""),
        started_at=now, deadline=now + minutes * 60, resolve_url=str(resolved.get("live_url") or url),
    )
    _spawn(rec, source)
    with _REGISTRY_LOCK:
        _RECORDINGS[rec.id] = rec
    spawn_context_thread(_watch, name=f"live-record-{rec.id}", args=(rec,)).start()
    _write_state(rec)
    return tool_result(
        ok=True, live=True, max_minutes=minutes, **rec.summary(),
        note="录制在后台进行,文件只保存在本机。用 live_record_status 查看进度,用 live_record_stop 结束。",
    )


def _handle_status(args: dict, **_kwargs) -> str:
    recording_id = str(args.get("recording_id") or "").strip()
    if recording_id:
        rec = _RECORDINGS.get(recording_id)
        return tool_result(**rec.summary()) if rec else tool_error(f"没有找到录制 {recording_id}。")
    recordings = sorted(_RECORDINGS.values(), key=lambda rec: rec.started_at, reverse=True)
    return tool_result(ok=True, recordings=[rec.summary() for rec in recordings])


def _handle_stop(args: dict, **_kwargs) -> str:
    recording_id = str(args.get("recording_id") or "").strip()
    rec = _RECORDINGS.get(recording_id)
    if rec is None:
        return tool_error(f"没有找到录制 {recording_id}。")
    if rec.state == "recording":
        rec.stop_requested = True
        _stop_process(rec)
        _finish(rec, "stopped", "user_stop")
    return tool_result(ok=True, **rec.summary())


def _check_live() -> bool:
    """Visible only on a signed-in Desktop whose gateway reports live.enabled (cached)."""
    if _gateway is None or not _gateway.use_gateway() or not _gateway._is_desktop() or not _gateway.agent_api_key():
        return False
    now = time.monotonic()
    cached = _CHECK_CACHE.get("live")
    if cached and now - cached[0] < CHECK_TTL_SECONDS:
        return cached[1]
    try:
        enabled = bool((_gateway.request_json("GET", "/tools/v1/check", timeout=5).get("live") or {}).get("enabled"))
    except _gateway.GatewayError:
        enabled = False
    _CHECK_CACHE["live"] = (now, enabled)
    return enabled


def _check_manage() -> bool:
    """Status/stop stay available while a recording exists, even if the gate closes mid-recording."""
    return bool(_RECORDINGS) or _check_live()


LIVE_RECORD_START_SCHEMA = {
    "name": "live_record_start",
    "description": (
        "在本机录制抖音或 TikTok 直播,默认只录音频。只能录用户本人或已获主播授权的直播间:调用前必须先问用户并得到明确确认,"
        "再把 rights_confirmed 设为 true。录制文件只保存在本机,不上传。录制在后台进行:用 live_record_status 查看进度,"
        "用 live_record_stop 结束;结束后用 media_transcribe(video_path=merged_path) 生成逐字稿(转写一次即可)。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "url": {
                "type": "string",
                "description": (
                    "用户给的链接原样传入即可:抖音直播间 live.douyin.com/数字、主播主页链接或 App 分享的 v.douyin.com 短链;"
                    "TikTok 为 tiktok.com/@账号 或 tiktok.com/@账号/live。"
                ),
            },
            "rights_confirmed": {"type": "boolean", "description": "用户已明确确认自己是主播本人或已获主播授权。未确认时不要调用。"},
            "mode": {"type": "string", "enum": ["audio", "video"], "description": "audio(默认,体积小,用于逐字稿和话术分析)或 video(画面加声音,每小时可达数 GB)。"},
            "max_minutes": {"type": "integer", "description": f"最长录制分钟数,默认 {DEFAULT_MAX_MINUTES},上限 {MAX_MINUTES}。"},
        },
        "required": ["url", "rights_confirmed"],
    },
}
LIVE_RECORD_STATUS_SCHEMA = {
    "name": "live_record_status",
    "description": "查看本机直播录制的进度和结果。不给 recording_id 时列出本次会话的全部录制。",
    "parameters": {
        "type": "object",
        "properties": {"recording_id": {"type": "string", "description": "live_record_start 返回的 recording_id。"}},
        "required": [],
    },
}
LIVE_RECORD_STOP_SCHEMA = {
    "name": "live_record_stop",
    "description": "结束一个本机直播录制并合并分段,返回 merged_path(音频为 .m4a)和准确时长 duration_seconds;需要逐字稿时再交给 media_transcribe。",
    "parameters": {
        "type": "object",
        "properties": {"recording_id": {"type": "string", "description": "live_record_start 返回的 recording_id。"}},
        "required": ["recording_id"],
    },
}


def register(ctx):
    for schema, handler, check, emoji in (
        (LIVE_RECORD_START_SCHEMA, _handle_start, _check_live, "🔴"),
        (LIVE_RECORD_STATUS_SCHEMA, _handle_status, _check_manage, "📡"),
        (LIVE_RECORD_STOP_SCHEMA, _handle_stop, _check_manage, "⏹️"),
    ):
        ctx.register_tool(
            name=schema["name"],
            toolset="skills",
            schema=schema,
            handler=handler,
            check_fn=check,
            requires_env=[],
            description=schema["description"],
            emoji=emoji,
        )
