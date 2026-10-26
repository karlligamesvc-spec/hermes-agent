"""Long-video analysis tools on the APEX Desktop (hc-1054, VideoHighlighter plan T3).

``video_highlights`` picks the best segments of a long video (scene cuts, motion,
loudness, objects) and says why each was picked; ``video_moment_search`` finds the
moments that match an English description (CLIP). Both run as jobs on the platform
(``/tools/v1/video/{highlights,moments}/jobs``, hc-1053 in apex-nodes); the engine is
ours, on the server, with no vendor key anywhere. ``apexnodes-video-tools`` registers
them from here.

Gateway leg (the Desktop): the original never leaves this computer. A local video is
transcoded with the bundled ffmpeg into a 480p analysis proxy (same timeline, so the
picked seconds apply to the original), uploaded straight to storage through
``/tools/v1/video/analysis/upload-url``, and submitted as ``{upload_id,
duration_seconds}``. Thumbnails come back over their signed links into the local
media cache; no server path or ``media:`` handle reaches the result (hc-562).

Legacy leg (``TOOLS_GATEWAY_DISABLED=1``): what the hosted copy does
(apex-nodes ``app/runtime_plugins/apexnodes-video-tools/analysis_tools.py``): ``media:``
handles and media-space paths, from the ``/api/v1`` base.

Both legs: the submit carries an ``Idempotency-Key`` (a resend never starts a second
job), the tool follows the job while the platform expects it within a few minutes and
otherwise answers "queued" with the job id. tests/contracts/plugin_tools_contract.json
pins the schema and endpoints of both copies.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from gateway.session_context import get_session_env
from hermes_constants import get_hermes_home
from tools.registry import tool_error, tool_result

from plugins import apexnodes_gateway as _gateway

ROOT = Path(__file__).resolve().parents[1]
KIND_HIGHLIGHTS = "highlights"
KIND_MOMENTS = "moments"
CHECK_PATH = "/tools/v1/video/analysis/check"
UPLOAD_URL_PATH = "/tools/v1/video/analysis/upload-url"
JOBS_PATHS = {KIND_HIGHLIGHTS: "/tools/v1/video/highlights/jobs", KIND_MOMENTS: "/tools/v1/video/moments/jobs"}
_OPEN = frozenset({"queued", "staging", "submitted", "running", "collecting"})
# The tool follows a job the platform expects within this long; past it, "queued".
WAIT_SECONDS = 240
# hc-941: the proxy of a long video and its upload come before the wait, so the call
# reports its own budget instead of the runtime's shared tool deadline.
EXECUTION_TIMEOUT = 3600
_PROXY_TIMEOUT = 2400
_PUT_TIMEOUT = 1800
_REQUEST_TIMEOUT = 60
_CHECK_TIMEOUT = 5
_SUBMIT_RETRY_SECONDS = 60
_POLL_FLOOR, _POLL_DEFAULT, _POLL_CEILING = 3.0, 10.0, 30.0
_PROXY_LONG_SIDE = 854
_VIDEO_SUFFIX_RE = re.compile(r"^\.[A-Za-z0-9]{1,8}$")
_MESSAGES = {
    "not_object": ("{tool} 的参数必须是 JSON 对象。", "{tool} expects a JSON object argument."),
    "source_or_job_id": (
        "要给 source(要分析的视频),或者给之前那次返回的 job_id。",
        "Give source (the video to analyse), or the job_id an earlier call returned.",
    ),
    "query_required": ("要找什么画面?query 不能为空。", "What should it look for? query is empty."),
    "query_not_english": (
        "按描述找画面只认英文(画面识别模型只懂英文)。请先把要找的画面翻成简短的英文再调用。",
        "Moment search reads English only (the image model knows no other language); translate the description first.",
    ),
    "no_links": (
        "平台不直接下载网址。抖音等平台的链接先用 social_download 下载，再把它返回的 video_path 交给我。",
        "The platform does not fetch links. Download a platform link with social_download first, then pass its video_path.",
    ),
    "missing_file": ("本机找不到这个视频：{source}", "There is no such video on this computer: {source}"),
    "not_enabled": (
        "视频分析还没有对这个账号开放，这次没有分析。",
        "Video analysis is not open for this account yet; nothing was analysed.",
    ),
    "no_direct_upload": (
        "平台的直传通道暂时不可用，本机视频传不上去，这次没有分析。",
        "The platform's direct upload is unavailable, so the local video cannot go up; nothing was analysed.",
    ),
    "no_ffmpeg": (
        "没有找到 APEX 自带的 ffmpeg,没法在本机生成分析用的小样。请修复或重新安装 APEX Desktop。",
        "APEX's bundled ffmpeg is missing, so the analysis proxy cannot be made. Repair or reinstall APEX Desktop.",
    ),
    "unreadable_video": (
        "读不出这个视频(不是有效的视频文件，或文件已损坏),这次没有分析。",
        "The video cannot be read (not a valid video file, or damaged); nothing was analysed.",
    ),
    "too_long": (
        "这条视频有 {minutes} 分钟，单条最长 {cap} 分钟。可以先截取一段再分析。",
        "The video is {minutes} minutes long; the limit is {cap} minutes. Trim it first.",
    ),
    "proxy_failed": (
        "本机生成分析小样失败({reason}),这次没有分析。",
        "Making the analysis proxy failed ({reason}); nothing was analysed.",
    ),
    "proxy_too_large": (
        "分析小样有 {mb} MB,超过平台单条上限 {cap} MB。可以先截取一段再分析。",
        "The analysis proxy is {mb} MB, over the platform's {cap} MB limit. Trim the video first.",
    ),
    "upload_failed": ("分析小样上传失败({reason}),这次没有分析。", "The analysis proxy did not upload ({reason}); nothing was analysed."),
    "unreachable": ("连不上视频分析服务：{reason}", "Could not reach the video analysis service: {reason}"),
    "lost": (
        "提交后一直没收到视频分析服务的回答({reason})。可能已经在排队：过一会儿再提交同一个视频，不会重复计费。",
        "No answer from the video analysis service after submitting ({reason}). It may be queued already; "
        "submitting the same video again later is not charged twice.",
    ),
    "unreadable": ("视频分析服务的回答读不出来，这次没有结果。", "The video analysis service sent an answer that could not be read."),
    "no_reason": ("视频分析服务出错了({status}),没有说明原因。", "The video analysis service failed ({status}) without saying why."),
    "queued": (
        "已排队：前面 {ahead} 个，预计约 {minutes} 分钟出结果。{after}",
        "Queued: {ahead} ahead, the result in about {minutes} minutes. {after}",
    ),
    "after_push": ("好了会把结果直接发到这个对话里。", "The result will be posted to this chat when it is ready."),
    "after_poll": (
        "好了不会自动通知：用户问起时，用这个 job_id 再调用一次取结果。",
        "There is no automatic notice: when the user asks, call again with this job_id to fetch the result.",
    ),
    "cancelled": ("已取消，没有计费。", "Cancelled; nothing was charged."),
    "times": (
        "时间都在原片的时间轴上(秒)。缩略图的 path 可以直接交给 vision_analyze 看;要知道说了什么，用 media_transcribe 转写原片。",
        "Times are on the original's timeline (seconds). A thumbnail's path goes straight to vision_analyze; to know "
        "what is said, transcribe the source with media_transcribe.",
    ),
    "times_local": (
        "时间都在原片的时间轴上(秒),可以直接在本机原片上下刀。缩略图的 path 可以交给 vision_analyze 看;要知道说了什么，用 "
        "media_transcribe 转写原片。",
        "Times are on the original's timeline (seconds): cut the local original at them. A thumbnail's path goes to "
        "vision_analyze; to know what is said, transcribe the original with media_transcribe.",
    ),
    "preview": (
        "预览片是分析引擎自带的快速拼接，段与段的接缝处可能会卡一下：只给用户先看效果，别当成片交付。",
        "The preview is the engine's quick join and may stutter at the seams: show it as a preview, never as the finished cut.",
    ),
}


class _Failure(RuntimeError):
    pass


class _Lost(_Failure):
    """The request may have arrived, but no answer did."""


def _say(key: str, **fields: Any) -> str:
    zh, en = _MESSAGES[key]
    return (en if _gateway.ui_language() == "en" else zh).format(**fields)


def _home() -> Path:
    return Path(get_hermes_home())


# ── the two legs ───────────────────────────────────────────────────────────────


def _api_base() -> str:
    """The legacy leg's master base (the video plugin's own chain)."""
    base = (
        os.getenv("HERMES_PLATFORM_API_BASE")
        or os.getenv("HERMES_MASTER_API_BASE")
        or os.getenv("HERMES_SCHEDULER_API_BASE")
        or "http://host.docker.internal:8000/api/v1"
    )
    return base.rstrip("/")


def _legacy_error_detail(raw: str) -> str:
    try:
        body = json.loads(raw)
    except ValueError:
        return ""
    detail = body.get("detail") if isinstance(body, dict) else None
    if isinstance(detail, str):
        return detail.strip()
    return str(detail.get("message") or "").strip() if isinstance(detail, dict) else ""


def _legacy_call(method: str, path: str, payload: dict | None, *, key: str | None, timeout: float) -> dict[str, Any]:
    api_key = _gateway.agent_api_key()
    if not api_key:
        raise _Failure(str(_gateway.missing_credential_error()))
    headers = {"Authorization": f"Bearer {api_key}"}
    data = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if key:
        headers["Idempotency-Key"] = key
    request = urllib.request.Request(f"{_api_base()}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        message = _legacy_error_detail(exc.read().decode("utf-8", errors="replace"))
        raise _Failure(message or _say("no_reason", status=f"HTTP {exc.code}")) from exc
    except OSError as exc:  # URLError, a timeout, a reset: no answer
        raise _Lost(_say("unreachable", reason=getattr(exc, "reason", None) or exc)) from exc
    try:
        answer = json.loads(raw)
    except ValueError as exc:
        raise _Failure(_say("unreadable")) from exc
    if not isinstance(answer, dict):
        raise _Failure(_say("unreadable"))
    return answer


def _call(method: str, path: str, payload: dict | None = None, *, key: str | None = None, timeout: float = _REQUEST_TIMEOUT) -> dict[str, Any]:
    if not _gateway.use_gateway():
        return _legacy_call(method, path, payload, key=key, timeout=timeout)
    try:
        return _gateway.request_json(method, path, payload, timeout=timeout, headers={"Idempotency-Key": key} if key else None)
    except _gateway.GatewayError as exc:
        if exc.code == "network_unreachable":
            raise _Lost(str(exc)) from exc
        raise _Failure(str(exc)) from exc


def check_view() -> dict[str, Any] | None:
    try:
        view = _call("GET", CHECK_PATH, timeout=_CHECK_TIMEOUT).get("video_analysis")
    except _Failure:
        return None
    return view if isinstance(view, dict) else None


def check() -> bool:
    """Listed only for an account the platform opened it for (default off); an
    unreadable check (``check_view`` None) hides the tools."""
    return bool((check_view() or {}).get("enabled"))


# ── the source ─────────────────────────────────────────────────────────────────


def _no_window() -> dict[str, Any]:
    """Windows: child processes must not flash a console window."""
    return {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}


def bundled_ffmpeg() -> str | None:
    bundled = ROOT / ".runtime" / "bin" / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
    return str(bundled) if bundled.is_file() else shutil.which("ffmpeg")


_DURATION_RE = re.compile(r"Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)")


def duration_seconds(ffmpeg: str, path: Path) -> float | None:
    """The container duration: the ffprobe next to ffmpeg, else ffmpeg's own header line."""
    sibling = Path(ffmpeg).with_name("ffprobe.exe" if os.name == "nt" else "ffprobe")
    ffprobe = str(sibling) if sibling.is_file() else shutil.which("ffprobe")
    try:
        if ffprobe:
            result = subprocess.run(
                [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)],
                stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60, check=False, **_no_window(),
            )
            seconds = float(result.stdout.strip().splitlines()[0]) if result.returncode == 0 else None
        else:
            result = subprocess.run(
                [ffmpeg, "-hide_banner", "-nostdin", "-i", str(path)],
                stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60, check=False, **_no_window(),
            )
            match = _DURATION_RE.search(result.stderr or "")
            seconds = int(match[1]) * 3600 + int(match[2]) * 60 + float(match[3]) if match else None
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        return None
    return seconds if seconds and seconds > 0 else None


def proxy_command(ffmpeg: str, source: Path, output: Path) -> list[str]:
    """480p analysis proxy (plan §5): long side ≤ 854, ≤ 30 fps, high CRF, mono 64 kbps.
    Same timeline as the original, so the picked seconds cut the original."""
    side = _PROXY_LONG_SIDE
    scale = (
        f"scale='if(gte(iw,ih),trunc(min({side},iw)/2)*2,-2)':'if(gte(iw,ih),-2,trunc(min({side},ih)/2)*2)'"
    )
    return [
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", str(source),
        "-map", "0:v:0", "-map", "0:a:0?", "-vf", scale, "-fpsmax", "30",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-ac", "1", "-b:a", "64k", "-movflags", "+faststart", "-f", "mp4", str(output),
    ]


def make_proxy(ffmpeg: str, source: Path) -> Path:
    """The proxy of this exact file (path, size, mtime), made once and kept in the media
    cache; a call for the same video again reuses it."""
    stat = source.stat()
    digest = hashlib.sha256(f"{source.resolve()}|{stat.st_size}|{stat.st_mtime_ns}".encode()).hexdigest()[:20]
    directory = _gateway.media_cache_dir() / "analysis-proxies"
    directory.mkdir(parents=True, exist_ok=True)
    proxy = directory / f"{digest}.mp4"
    if proxy.is_file() and proxy.stat().st_size > 0:
        return proxy
    partial = directory / f"{digest}.{uuid.uuid4().hex[:8]}.part"
    try:
        result = subprocess.run(
            proxy_command(ffmpeg, source, partial),
            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=_PROXY_TIMEOUT, check=False, **_no_window(),
        )
    except (OSError, subprocess.SubprocessError) as exc:
        partial.unlink(missing_ok=True)
        raise _Failure(_say("proxy_failed", reason=exc)) from exc
    if result.returncode != 0 or not partial.is_file() or partial.stat().st_size == 0:
        partial.unlink(missing_ok=True)
        reason = (result.stderr or "").strip().splitlines()[-1:] or [f"ffmpeg exit {result.returncode}"]
        raise _Failure(_say("proxy_failed", reason=reason[0][:200]))
    os.replace(partial, proxy)
    return proxy


def _upload_source(local: Path) -> dict[str, Any]:
    """Gateway: the local video → its proxy → a signed direct upload → ``{upload_id,
    duration_seconds}``. Limits are checked before any minute of transcoding."""
    view = check_view() or {}
    if not view.get("enabled"):
        raise _Failure(_say("not_enabled"))
    if not view.get("direct_upload_available"):
        raise _Failure(_say("no_direct_upload"))
    ffmpeg = bundled_ffmpeg()
    if not ffmpeg:
        raise _Failure(_say("no_ffmpeg"))
    seconds = duration_seconds(ffmpeg, local)
    if seconds is None:
        raise _Failure(_say("unreadable_video"))
    cap = int(view.get("max_source_minutes") or 0)
    if cap and seconds > cap * 60:
        raise _Failure(_say("too_long", minutes=int(seconds // 60) + 1, cap=cap))
    proxy = make_proxy(ffmpeg, local)
    size = proxy.stat().st_size
    max_bytes = int(view.get("source_max_bytes") or 0)
    if max_bytes and size > max_bytes:
        raise _Failure(_say("proxy_too_large", mb=size // (1024 * 1024), cap=max_bytes // (1024 * 1024)))
    issued = _call("POST", UPLOAD_URL_PATH, {"filename": proxy.name, "size_bytes": size})
    put_url, upload_id = str(issued.get("put_url") or ""), str(issued.get("upload_id") or "")
    if not (put_url and upload_id):
        raise _Failure(_say("unreadable"))
    try:
        _gateway._put_presigned(put_url, proxy, size, timeout=_PUT_TIMEOUT)
    except _gateway.GatewayError as exc:
        raise _Failure(_say("upload_failed", reason=exc)) from exc
    return {"upload_id": upload_id, "duration_seconds": round(seconds, 3)}


def _copy_into_media(local: Path) -> str:
    """Legacy: a video outside the media space is copied into a directory of its own there."""
    suffix = local.suffix.lower() if _VIDEO_SUFFIX_RE.match(local.suffix) else ".mp4"
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", local.stem).strip("._-")[:60] or "video"
    directory = _home() / "workspace" / "media" / uuid.uuid4().hex
    directory.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(local, directory / f"{stem}{suffix}")
    return f"media:{directory.name}/{stem}{suffix}"


def _legacy_source(source: str) -> dict[str, str]:
    local = Path(source).expanduser()
    if not local.is_file():
        return {"path": source}  # a server path from an earlier result; the platform checks it is ours
    media = (_home() / "workspace" / "media").resolve()
    try:
        relative = local.resolve().relative_to(media)
    except ValueError:
        relative = None
    except OSError as exc:
        raise _Failure(_say("unreadable_video")) from exc
    if relative is not None:
        return {"ref": "media:" + "/".join(relative.parts)} if len(relative.parts) == 2 else {"path": str(local)}
    try:
        return {"ref": _copy_into_media(local)}
    except OSError as exc:
        raise _Failure(_say("proxy_failed", reason=exc)) from exc


def source_for(raw: str) -> dict[str, Any]:
    """What the platform takes on this leg; ``source_path`` is the local original (gateway)."""
    source = _gateway.attachment_path(raw.strip())
    if source.startswith("media:"):
        return {"ref": source}
    if source.lower().startswith(("http://", "https://")):
        raise _Failure(_say("no_links"))
    if not _gateway.use_gateway():
        return _legacy_source(source)
    local = Path(source).expanduser()
    if not local.is_file():
        shown = source if len(source) <= 120 else "…" + source[-119:]
        raise _Failure(_say("missing_file", source=shown))
    return _upload_source(local)


def _session_target() -> dict | None:
    """hc-371 (legacy leg, a hosted chat): where the platform pushes the result."""
    chat_id = (get_session_env("HERMES_SESSION_CHAT_ID", "") or "").strip()
    if not chat_id:
        return None
    target = {"chat_id": chat_id}
    for key, env in (("platform", "HERMES_SESSION_PLATFORM"), ("user_id", "HERMES_SESSION_USER_ID")):
        value = (get_session_env(env, "") or "").strip()
        if value:
            target[key] = value
    return target


def params_for(kind: str, args: dict[str, Any]) -> dict[str, Any]:
    if kind == KIND_MOMENTS:
        query = str(args.get("query") or "").strip()
        if not query:
            raise _Failure(_say("query_required"))
        if not (query.isascii() and query.isprintable()):
            raise _Failure(_say("query_not_english"))
        body: dict[str, Any] = {"query": query}
        names = ("interval_seconds", "top_k", "threshold")
    else:
        body = {"outputs": ["report", "preview"] if args.get("preview") is True else ["report"]}
        names = ("target_seconds", "clip_seconds", "exact", "objects")
    for name in names:
        if args.get(name) is not None:
            body[name] = args[name]
    return body


# ── the job ────────────────────────────────────────────────────────────────────


def _submit(kind: str, body: dict[str, Any]) -> dict[str, Any]:
    key = uuid.uuid4().hex
    deadline = time.monotonic() + _SUBMIT_RETRY_SECONDS
    while True:
        try:
            return _call("POST", JOBS_PATHS[kind], body, key=key)
        except _Lost as exc:
            if time.monotonic() >= deadline:
                raise _Failure(_say("lost", reason=exc)) from exc
            time.sleep(_POLL_DEFAULT)


def _poll_gap(answer: dict[str, Any]) -> float:
    try:
        gap = float(answer.get("poll_after_seconds") or _POLL_DEFAULT)
    except (TypeError, ValueError):
        gap = _POLL_DEFAULT
    return min(max(gap, _POLL_FLOOR), _POLL_CEILING)


def _follow(kind: str, answer: dict[str, Any]) -> dict[str, Any]:
    """Read an open job again while the platform expects it within the wait budget."""
    started = time.monotonic()
    while answer.get("status") in _OPEN:
        eta = answer.get("eta_seconds")
        if not isinstance(eta, (int, float)) or eta > WAIT_SECONDS - (time.monotonic() - started):
            return answer
        time.sleep(_poll_gap(answer))
        answer = _call("GET", f"{JOBS_PATHS[kind]}/{answer['job_id']}")
    return answer


def _container_path(ref: Any) -> str | None:
    if not isinstance(ref, str) or not ref.startswith("media:"):
        return None
    return str(_home() / "workspace" / "media" / ref[len("media:"):])


def _fetch(url: Any, hint: str) -> str | None:
    """Gateway: one result file over its signed link into the local media cache."""
    if not isinstance(url, str) or not url.startswith(("http://", "https://")):
        return None
    try:
        return str(_gateway.download_media(url, filename_hint=hint))
    except _gateway.GatewayError:
        return None


def _localize(data: dict[str, Any], job_id: str) -> None:
    """Gateway: the report and thumbnails as local files; no server path or handle."""
    data.pop("report_ref", None)
    report = _gateway.media_cache_dir() / "video-analysis" / f"{re.sub(r'[^A-Za-z0-9-]', '', job_id)[:40] or 'job'}.json"
    try:
        report.parent.mkdir(parents=True, exist_ok=True)
        report.write_text(json.dumps(data.get("report"), ensure_ascii=False, indent=1), encoding="utf-8")
        data["report_path"] = str(report)
    except OSError:
        data["report_path"] = None
    for item in data.get("thumbnails") or []:
        if isinstance(item, dict):
            item.pop("ref", None)
            item["path"] = _fetch(item.get("url"), Path(str(item.get("name") or "thumb")).stem)
    preview = data.get("preview")
    if isinstance(preview, dict):
        local = _fetch(preview.get("url"), "preview")
        data["preview"] = {"url": preview.get("url"), "path": local, "media_tag": f"MEDIA:{local}" if local else None}


def _found(data: dict[str, Any]) -> int | None:
    """How many segments (highlights) or matches (moments) the report holds; the Desktop's
    step line reads it as the count."""
    report = data.get("report") if isinstance(data.get("report"), dict) else {}
    found = report.get("matches" if data.get("kind") == KIND_MOMENTS else "segments")
    return len(found) if isinstance(found, list) else None


def shape(answer: dict[str, Any], *, source_path: str | None = None) -> str:
    """The tool's answer: queued, cancelled, the error the user should hear, or the
    result with every file usable on this machine."""
    status = answer.get("status")
    if status in _OPEN:
        after = _say("after_push" if answer.get("async_delivery") else "after_poll")
        minutes = max(1, round(float(answer.get("eta_seconds") or 60) / 60))
        note = _say("queued", ahead=answer.get("queue_position") or 0, minutes=minutes, after=after)
        keep = ("job_id", "kind", "status", "queue_position", "eta_seconds", "percent", "step", "async_delivery")
        return tool_result(**{name: answer.get(name) for name in keep}, note=note)
    if status == "cancelled":
        return tool_result(job_id=answer.get("job_id"), status="cancelled", note=_say("cancelled"))
    if status != "succeeded" or not answer.get("ok"):
        error = answer.get("error") if isinstance(answer.get("error"), dict) else {}
        detail = error.get("detail") if isinstance(error.get("detail"), dict) else {}
        return tool_error(str(detail.get("message") or _say("unreadable")))
    data = dict(answer.get("data") or {})
    data.pop("preview_notice", None)
    local = _gateway.use_gateway()
    if local:
        _localize(data, str(answer.get("job_id") or ""))
    else:
        data["report_path"] = _container_path(data.get("report_ref"))
        for item in data.get("thumbnails") or []:
            if isinstance(item, dict):
                item["path"] = _container_path(item.get("ref"))
        if isinstance(data.get("preview"), dict):
            path = _container_path(data["preview"].get("ref"))
            data["preview"].update({"path": path, "media_tag": f"MEDIA:{path}"})
    notes = [_say("times_local" if local else "times")]
    if isinstance(data.get("preview"), dict):
        notes.append(_say("preview"))
    extra = {"source_path": source_path} if source_path else {}
    return tool_result(
        job_id=answer.get("job_id"), status="succeeded", source=answer.get("source"), count=_found(data), **extra, **data,
        note=" ".join(notes),
    )


def run(kind: str, tool: str, args: Any) -> str:
    """One call: read or cancel an earlier job, or submit a new one and follow it."""
    if not isinstance(args, dict):
        return tool_error(_say("not_object", tool=tool))
    job_id = str(args.get("job_id") or "").strip()
    try:
        if job_id:
            path = f"{JOBS_PATHS[kind]}/{job_id}"
            if args.get("cancel") is True:
                return shape(_call("POST", f"{path}/cancel", {}))
            return shape(_follow(kind, _call("GET", path)))
        raw = str(args.get("source") or "").strip()
        if not raw:
            return tool_error(_say("source_or_job_id"))
        body = params_for(kind, args)
        source = source_for(raw)
        body["source"] = source
        target = None if _gateway.use_gateway() else _session_target()
        if target:
            body["delivery_target"] = target
        source_path = _gateway.attachment_path(raw) if "upload_id" in source else None
        return shape(_follow(kind, _submit(kind, body)), source_path=source_path)
    except _Failure as exc:
        return tool_error(str(exc))


_SOURCE_DOC = (
    "The video: a path on this computer (a chat attachment, social_download's video_path, generate_video's "
    "video_path) or a media: handle. Links are not fetched: download platform links with social_download first."
)
_JOB_DOC = "An earlier call's job_id: read that job (waiting a little if it is about to finish) instead of starting a new one."
_CANCEL_DOC = "With job_id: cancel that job (nothing is charged)."

HIGHLIGHTS_SCHEMA = {
    "name": "video_highlights",
    "description": (
        "Pick the best segments of the user's own long video (minutes to hours). Scene cuts, motion, loudness and "
        "objects are scored on the server; each segment comes back with start/end seconds on the original's "
        "timeline, why it was picked, chapters and a thumbnail. Use it before cutting long footage into short "
        "videos; not for a few short clips (each job has about 25 s overhead plus the queue). Don't suggest it for "
        "live-stream recordings. It runs as a queued job: when it is not done within a few minutes you get a job_id; "
        "never claim a result you do not have."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "source": {"type": "string", "description": _SOURCE_DOC},
            "job_id": {"type": "string", "description": _JOB_DOC},
            "cancel": {"type": "boolean", "description": _CANCEL_DOC},
            "target_seconds": {"type": "integer", "description": "Total length of the picked segments, 5-600 s (default 60)."},
            "clip_seconds": {"type": "integer", "description": "Length of each segment, 2-30 s (default 8)."},
            "exact": {"type": "boolean", "description": "true: aim for exactly target_seconds."},
            "objects": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "Up to 10 COCO object classes in English to favour (person, car, dog, cell phone, bottle, cup, "
                    "laptop ...); map the user's words to them yourself."
                ),
            },
            "preview": {
                "type": "boolean",
                "description": "true: also make the engine's quick preview reel of the picks (a preview that may stutter at the seams, not a finished cut).",
            },
        },
        "required": [],
    },
}

MOMENTS_SCHEMA = {
    "name": "video_moment_search",
    "description": (
        "Find the moments in the user's own video that match a short ENGLISH description (CLIP image search on the "
        "server), e.g. 'a close-up of a product in someone's hand': a timestamp, a similarity score and a thumbnail "
        "each. Translate the user's words into English first. Don't suggest it for live-stream recordings. It runs "
        "as a queued job like video_highlights."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "source": {"type": "string", "description": _SOURCE_DOC},
            "job_id": {"type": "string", "description": _JOB_DOC},
            "cancel": {"type": "boolean", "description": _CANCEL_DOC},
            "query": {"type": "string", "description": "What to look for, in English (printable ASCII), up to 200 characters."},
            "interval_seconds": {"type": "number", "description": "Look at one frame every N seconds, 0.5-10 (default 1)."},
            "top_k": {"type": "integer", "description": "At most this many moments, 1-50 (default 20)."},
            "threshold": {"type": "number", "description": "Minimum similarity, 0-1 (default 0.5)."},
        },
        "required": [],
    },
}

TOOLS = ((HIGHLIGHTS_SCHEMA, KIND_HIGHLIGHTS, "✂️"), (MOMENTS_SCHEMA, KIND_MOMENTS, "🔎"))


def register(ctx) -> None:
    """Called by ``apexnodes-video-tools``'s ``register``."""
    for schema, kind, emoji in TOOLS:
        name = schema["name"]
        ctx.register_tool(
            name=name,
            toolset="skills",
            schema=schema,
            handler=lambda args, _kind=kind, _name=name, **_kwargs: run(_kind, _name, args),
            check_fn=check,
            requires_env=[],
            description=schema["description"],
            emoji=emoji,
            execution_timeout=EXECUTION_TIMEOUT,
        )
