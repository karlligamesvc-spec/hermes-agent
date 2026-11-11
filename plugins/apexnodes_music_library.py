"""find_music on the APEX Desktop: one track from APEX's built-in background-music library (hc-1220).

The platform picks the track (``/tools/v1/music/pick`` in apex-nodes: the 制作设置 card's mood and the video's
scene, the publish platform's test result, what this user already had) and signs a short-lived link to its
loudness-normalised copy. This module downloads it once into ``HERMES_HOME/tool-cache/music/<sha256>.<ext>``,
keeps it only when size and SHA-256 match, and answers the local file, the caption credit and the provenance
for ``music-provenance.json``. The link itself never reaches the result; a file that does not match is deleted.
The cache is shared by every project on this computer: a track is downloaded once.

Gateway leg (the Desktop default) through ``apexnodes_gateway``; legacy leg (``TOOLS_GATEWAY_DISABLED=1``) the
``/api/v1`` base, as the hosted copy (apex-nodes ``app/runtime_plugins/apexnodes-video-tools/music_tools.py``).
``apexnodes-video-tools`` registers it; tests/contracts/plugin_tools_contract.json pins both copies.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from hermes_constants import get_hermes_home
from tools.registry import tool_error, tool_result

from plugins import apexnodes_gateway as _gateway

CHECK_PATH = "/tools/v1/music/check"
PICK_PATH = "/tools/v1/music/pick"
_REQUEST_TIMEOUT = 30
_CHECK_TIMEOUT = 5
_DOWNLOAD_TIMEOUT = 180
# The pick, then up to two downloads of a few MB each: 390 s at worst, inside the executor's default 420 s,
# so the tool registers no budget of its own.
_DOWNLOAD_ATTEMPTS = 2
_SHA_RE = re.compile(r"^[0-9a-f]{64}$")
_EXT_RE = re.compile(r"^[a-z0-9]{1,5}$")
_PLATFORMS = ["douyin", "tiktok", "xiaohongshu", "channels", "kuaishou", "bilibili", "youtube", "other"]
_MESSAGES = {
    "not_object": ("find_music 的参数必须是 JSON 对象。", "find_music expects a JSON object argument."),
    "platform_required": (
        "要先确认发布平台(platform):曲库按平台实测结果选曲。",
        "Name the publish platform (platform) first: the library picks by each platform's test result.",
    ),
    "unreachable": ("连不上平台曲库: {reason}", "Could not reach the platform music library: {reason}"),
    "unreadable": ("平台曲库的回答读不出来，这次没有曲子。", "The music library's answer could not be read; no track this time."),
    "no_reason": ("平台曲库出错了({status}),没有说明原因。", "The music library failed ({status}) without saying why."),
    "download_failed": (
        "曲子没下载下来({reason}),这次交无音乐母版，稍后可以再试。",
        "The track did not download ({reason}); deliver the music-free master and try again later.",
    ),
    "mismatch": (
        "下载的曲子和曲库登记的不一致，已删掉，没有用。这次交无音乐母版。",
        "The downloaded track does not match the library's record; it was deleted and not used. "
        "Deliver the music-free master.",
    ),
}


class _Failure(RuntimeError):
    pass


def _say(key: str, **fields: Any) -> str:
    zh, en = _MESSAGES[key]
    return (en if _gateway.ui_language() == "en" else zh).format(**fields)


def cache_dir() -> Path:
    return Path(get_hermes_home()) / "tool-cache" / "music"


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


def _legacy_call(method: str, path: str, payload: dict | None, *, timeout: float) -> dict[str, Any]:
    api_key = _gateway.agent_api_key()
    if not api_key:
        raise _Failure(str(_gateway.missing_credential_error()))
    headers = {"Authorization": f"Bearer {api_key}"}
    data = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(f"{_api_base()}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        message = _legacy_error_detail(exc.read().decode("utf-8", errors="replace"))
        raise _Failure(message or _say("no_reason", status=f"HTTP {exc.code}")) from exc
    except OSError as exc:  # URLError, a timeout, a reset
        raise _Failure(_say("unreachable", reason=getattr(exc, "reason", None) or exc)) from exc
    try:
        answer = json.loads(raw)
    except ValueError as exc:
        raise _Failure(_say("unreadable")) from exc
    if not isinstance(answer, dict):
        raise _Failure(_say("unreadable"))
    return answer


def _call(method: str, path: str, payload: dict | None = None, *, timeout: float = _REQUEST_TIMEOUT) -> dict[str, Any]:
    if not _gateway.use_gateway():
        return _legacy_call(method, path, payload, timeout=timeout)
    try:
        return _gateway.request_json(method, path, payload, timeout=timeout)
    except _gateway.GatewayError as exc:
        raise _Failure(str(exc)) from exc


def check() -> bool:
    """Listed only while the platform has the library open."""
    try:
        view = _call("GET", CHECK_PATH, timeout=_CHECK_TIMEOUT).get("music_library")
    except _Failure:  # unreachable or refused: the tool stays hidden
        return False
    return bool(isinstance(view, dict) and view.get("enabled"))


# ── the verified cache ─────────────────────────────────────────────────────────


def _matches(path: Path, sha256: str, size: int) -> bool:
    if not path.is_file() or path.stat().st_size != size:
        return False
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest() == sha256


def fetch(download: dict) -> Path:
    """The track's file in the cache: reused when its bytes match, otherwise downloaded and checked."""
    sha256, size, ext = str(download.get("sha256") or ""), download.get("bytes"), str(download.get("ext") or "")
    if not _SHA_RE.match(sha256) or not isinstance(size, int) or not _EXT_RE.match(ext) or not download.get("url"):
        raise _Failure(_say("unreadable"))
    target = cache_dir() / f"{sha256}.{ext}"
    if _matches(target, sha256, size):
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    reason: Any = None
    for _attempt in range(_DOWNLOAD_ATTEMPTS):
        handle, staged = tempfile.mkstemp(prefix="download-", dir=target.parent)
        staged_path = Path(staged)
        try:
            with os.fdopen(handle, "wb") as output, urllib.request.urlopen(download["url"], timeout=_DOWNLOAD_TIMEOUT) as response:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
            if not _matches(staged_path, sha256, size):
                raise _Failure(_say("mismatch"))
            os.replace(staged_path, target)
            return target
        except OSError as exc:  # HTTPError, URLError, a timeout, a full disk
            reason = getattr(exc, "reason", None) or getattr(exc, "code", None) or type(exc).__name__
        finally:
            staged_path.unlink(missing_ok=True)
    raise _Failure(_say("download_failed", reason=reason))


# ── the tool ───────────────────────────────────────────────────────────────────


def params_for(args: Any) -> dict:
    if not isinstance(args, dict):
        raise _Failure(_say("not_object"))
    platform = str(args.get("platform") or "").strip().lower()
    if not platform:
        raise _Failure(_say("platform_required"))
    body: dict[str, Any] = {"platform": platform}
    for key in ("mood", "scene", "track_id"):
        value = str(args.get(key) or "").strip()
        if value:
            body[key] = value
    if args.get("duration_seconds"):
        body["duration_seconds"] = float(args["duration_seconds"])
    exclude = args.get("exclude")
    if isinstance(exclude, list):
        body["exclude"] = [str(x).strip() for x in exclude if str(x).strip()]
    return body


def shape(answer: dict, path: Path) -> dict:
    """What the agent mixes and credits; the signed link stays out."""
    return {
        "file": str(path),
        "track": answer.get("track"),
        "loudness_lufs": answer.get("loudness_lufs"),
        "credit": answer.get("credit"),
        "credit_short": answer.get("credit_short"),
        "credit_required": answer.get("credit_required"),
        "platform_result": answer.get("platform_result"),
        "new_pick": answer.get("new_pick"),
        "provenance": {**(answer.get("provenance") or {}), "file_sha256": (answer.get("download") or {}).get("sha256")},
    }


def run(args: Any) -> str:
    try:
        answer = _call("POST", PICK_PATH, params_for(args))
        path = fetch(answer.get("download") or {})
    except (_Failure, TypeError, ValueError) as exc:
        return tool_error(str(exc))
    return tool_result(**shape(answer, path))


FIND_MUSIC_SCHEMA = {
    "name": "find_music",
    "description": (
        "Background music from APEX's built-in library (CC BY / CC0, cleared for this use): returns a local "
        "file (loudness-normalised, ready to mix under the voice), the credit line every publish caption must carry, "
        "and its provenance. Call once per video, after the 制作设置 card: mood light = 轻快, warm = 温暖舒缓; "
        "uplifting (励志/燃) or suspense (悬疑/紧张) only when the user asked for that in words. Not for 只留现场声 "
        "or 不要配乐. Remixing the same video: pass the track_id you got. The user wants another: call again with "
        "exclude."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "mood": {
                "type": "string",
                "enum": ["light", "warm", "uplifting", "suspense"],
                "description": "The card's 配乐: 轻快 = light, 温暖舒缓 = warm; uplifting / suspense only on the user's words.",
            },
            "scene": {
                "type": "string",
                "enum": ["daily", "food", "product", "beat", "funny"],
                "description": "The video's scene (日常 vlog / 美食 / 产品 / 卡点 / 搞笑). Required for light; for warm it "
                "picks which calm tracks come after the warm bucket.",
            },
            "platform": {
                "type": "string",
                "enum": _PLATFORMS,
                "description": "Where the user will publish. Tracks a platform's test flagged are never offered there.",
            },
            "duration_seconds": {"type": "number", "description": "The video's length; a track at least this long comes first."},
            "exclude": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Track ids the user turned down in this task.",
            },
            "track_id": {
                "type": "string",
                "description": "Fetch this track again (the same video remixed); not a new pick.",
            },
        },
        "required": ["platform"],
    },
}


def register(ctx) -> None:
    """Called by ``apexnodes-video-tools``'s ``register``."""
    ctx.register_tool(
        name="find_music",
        toolset="skills",
        schema=FIND_MUSIC_SCHEMA,
        handler=lambda args, **_kwargs: run(args),
        check_fn=check,
        requires_env=[],
        description=FIND_MUSIC_SCHEMA["description"],
        emoji="🎵",
    )
