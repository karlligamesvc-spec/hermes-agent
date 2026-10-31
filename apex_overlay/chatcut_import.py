"""hc-1122 ChatCut: bring a local file into a project, after the user agreed to the upload.

ChatCut's editor runs in the user's browser and reads a local file from a loopback URL it is handed
(``import_media`` with ``action="from_editor"``), so no bytes pass through the engine's model calls and nothing
of ChatCut's has to run on this computer. Their alternative is a script the client downloads and runs. APEX does
not run remote code on the user's machine for this; the loopback server below is APEX's own.

The server serves only the files of one call, only to the editor's origin, under an unguessable path, and stops
when the call ends. Which files, and whether they may leave at all, is decided before it starts: see ``import_files``.
"""

from __future__ import annotations

import http.server
import json
import logging
import os
import re
import secrets
import threading
import time
import uuid
import webbrowser
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Optional
from urllib.parse import parse_qsl, quote, unquote, urlencode, urlparse, urlunparse

from apex_overlay import chatcut

logger = logging.getLogger(__name__)

EDITOR_ORIGIN = "https://app.chatcut.io"
# The first path segment their editor's own tooling uses; the rest of the name is random.
ROUTE_PREFIX = "chatcut-local-media-v1"
MAX_FILES = 16
CHUNK_BYTES = 1024 * 1024
# An editor tab takes a moment to load and connect after it is opened.
EDITOR_CONNECT_SECONDS = 15
MIN_CALL_SECONDS = 120
MAX_CALL_SECONDS = 400
# Loopback is fast; this only sizes the wait for a large file.
ASSUMED_BYTES_PER_SECOND = 20 * 1024 * 1024

MEDIA_SUFFIXES = frozenset({
    ".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".mts", ".m2ts",
    ".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus",
    ".png", ".jpg", ".jpeg", ".webp", ".gif",
})

# The parameters that sign a browser in or lay out the editor: never put them in front of the user.
_PRIVATE_EDITOR_PARAMS = frozenset({"editor-boot-token", "dockviewLayout", "theme"})

IMPORT_SCHEMA = {
    "name": chatcut.IMPORT_TOOL,
    "description": (
        "Import files from this computer into a ChatCut project. The only way a local file reaches ChatCut. The "
        "first time it asks the user on a card whether the upload is OK, so do not ask first. Pass the full "
        "project_id and timeline_id (from create_project, read_project or manage_timelines) and absolute paths. "
        "Returns status: imported (asset ids; use browse_assets, then track_progress target=transcription before "
        "transcript or caption work), partial, declined, needs_editor (the editor is not open in a signed-in "
        "browser: give the user editor_url and retry when they say it is open), or an error."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "project_id": {"type": "string", "description": "Full project UUID."},
            "timeline_id": {"type": "string", "description": "Full timeline UUID."},
            "paths": {
                "type": "array",
                "items": {"type": "string"},
                "description": f"Absolute paths of the video, audio or image files to import, 1 to {MAX_FILES}.",
            },
        },
        "required": ["project_id", "timeline_id", "paths"],
    },
}

NOT_CONNECTED = "ChatCut 还没连接：先调用 chatcut_connect。"
NO_CARD = "这里没有卡片能让用户确认，导入本机文件要在电脑上的 APEX 对话里做。"
NO_FILES = f"paths 要填 1 到 {MAX_FILES} 个本机文件的绝对路径。"
IDS_REQUIRED = "project_id 和 timeline_id 都要填完整的 UUID（从 create_project、read_project 或 manage_timelines 拿）。"
DECLINED_NOTE = "用户这次不同意上传，文件没有离开这台电脑。不要再问，也不要换别的办法上传；问他想怎么做。"
NEEDS_EDITOR_NOTE = (
    "ChatCut 的编辑器要在已登录的浏览器里开着才能取到文件。把 editor_url 作为链接给用户（可能已经替他打开了），"
    "请他确认页面打开了；如果浏览器问要不要允许访问本地网络，要点允许。他说好了就再调用一次，文件名不变。"
    "还是不行就请他在编辑器里手动上传。"
)
IMPORTED_NOTE = (
    "文件已经进了编辑器。先用 browse_assets 确认，字幕和按文字剪辑要等 "
    "track_progress（action=status, target=transcription）完成。"
)
PARTIAL_NOTE = "有文件没导入成功。把 failed 里的原因告诉用户；只重试失败的文件，再调用一次即可。"


def editor_origin() -> str:
    """Where the editor runs; a loopback test server stands in together with the service."""
    if os.environ.get(chatcut.TEST_URL_ENV, "").strip() and chatcut.mcp_url() != chatcut.MCP_URL:
        return ""
    return EDITOR_ORIGIN


@dataclass(frozen=True)
class _File:
    path: Path
    size: int
    name: str
    asset_id: str
    route: str

    def wire(self, base: str) -> dict:
        return {"assetId": self.asset_id, "url": f"{base}{self.route}", "filename": self.name, "sizeBytes": self.size}


def _resolve_files(raw: Any, project_id: str) -> tuple[list[_File], list[dict]]:
    """Files that may be served, and the ones refused with why. A retry of the same file keeps its asset id."""
    files: list[_File] = []
    refused: list[dict] = []
    token = secrets.token_urlsafe(18)
    names: set[str] = set()
    for item in raw:
        path = Path(str(item)).expanduser()
        reason = None
        if not path.is_absolute():
            reason = "不是绝对路径"
        elif not path.is_file():
            reason = "找不到这个文件"
        elif path.suffix.lower() not in MEDIA_SUFFIXES:
            reason = "不是视频、音频或图片文件"
        elif path.stat().st_size <= 0:
            reason = "文件是空的"
        if reason:
            refused.append({"file": str(item), "error": reason})
            continue
        stat = path.stat()
        name = path.name
        index = 2
        while name in names:
            name = f"{path.stem} ({index}){path.suffix}"
            index += 1
        names.add(name)
        identity = f"{project_id}|{path.resolve()}|{stat.st_size}|{stat.st_mtime_ns}"
        files.append(_File(path, stat.st_size, name, str(uuid.uuid5(uuid.NAMESPACE_URL, identity)),
                           f"/{ROUTE_PREFIX}/{token}-{quote(name)}"))
    return files, refused


class _MediaServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, files: list[_File], origin: str):
        self.by_route = {file.route: file for file in files}
        self.origin = origin
        super().__init__(("127.0.0.1", 0), _MediaHandler)

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.server_address[1]}"


class _MediaHandler(http.server.BaseHTTPRequestHandler):
    server: _MediaServer
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):
        return

    def _common_headers(self) -> None:
        if self.server.origin:
            self.send_header("Access-Control-Allow-Origin", self.server.origin)
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Expose-Headers", "Accept-Ranges, Content-Length, Content-Range")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-store")

    def _empty(self, status: int, **headers: str) -> None:
        self.send_response(status)
        self._common_headers()
        for name, value in headers.items():
            self.send_header(name.replace("_", "-"), value)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _origin_refused(self) -> bool:
        origin = self.headers.get("Origin")
        return bool(origin and self.server.origin and origin != self.server.origin)

    def do_OPTIONS(self):
        self._empty(403 if self._origin_refused() else 204)

    def do_GET(self):
        if self._origin_refused():
            self._empty(403)
            return
        file = self.server.by_route.get(self.path.split("?", 1)[0])
        if file is None:
            self._empty(404)
            return
        requested = self.headers.get("Range")
        start, status = 0, 200
        if requested is not None:
            match = re.fullmatch(r"bytes=(\d+)-(\d*)", requested.strip())
            # Any satisfiable range gets a 206, even from byte 0: a 200 makes a range-probing reader stream it all.
            if match is None or int(match.group(1)) >= file.size:
                self._empty(416, Content_Range=f"bytes */{file.size}")
                return
            start, status = int(match.group(1)), 206
        end = file.size - 1
        if requested is not None and match.group(2):
            end = min(int(match.group(2)), end)
        length = end - start + 1
        self.send_response(status)
        self._common_headers()
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(length))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{file.size}")
        self.end_headers()
        with file.path.open("rb") as stream:
            stream.seek(start)
            left = length
            while left > 0:
                chunk = stream.read(min(CHUNK_BYTES, left))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except OSError:
                    self.close_connection = True
                    return
                left -= len(chunk)


def _call_mcp(tool: str, arguments: dict, timeout: float) -> dict:
    """One ChatCut tool, through the engine's handler (auth recovery, session recovery). ``{}`` shapes on failure."""
    from tools.mcp_tool_handlers import _make_tool_handler

    raw = _make_tool_handler(chatcut.SERVER_NAME, tool, timeout)(arguments)
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return {"error": str(raw)}
    return parsed if isinstance(parsed, dict) else {"result": parsed}


def _import_payload(result: Mapping[str, Any]) -> dict:
    """``import_media``'s answer: ``structuredContent`` when the server sent it, else its JSON text."""
    if isinstance(result.get("structuredContent"), dict):
        return result["structuredContent"]
    text = result.get("result")
    if isinstance(text, dict):
        return text
    try:
        parsed = json.loads(str(text))
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def clean_editor_url(url: str) -> str:
    """The link for a person: without the parameters that sign a browser in or lay out the editor."""
    parts = urlparse(url)
    kept = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if k not in _PRIVATE_EDITOR_PARAMS]
    return urlunparse(parts._replace(query=urlencode(kept)))


def _editor_url(project_id: str) -> Optional[str]:
    result = _call_mcp("get_editor_url", {"projectId": project_id}, 30)
    if "error" in result:
        return None
    blob = json.dumps(result, ensure_ascii=False)
    match = re.search(r"https?://[^\s\"'\\]+/editor/[^\s\"'\\]+", blob)
    return clean_editor_url(unquote(match.group(0)) if "%2Feditor%2F" in match.group(0) else match.group(0)) if match else None


def _open_browser(url: str) -> bool:
    try:
        return bool(webbrowser.open(url))
    except Exception:
        logger.warning("apex-overlay: could not open the ChatCut editor", exc_info=True)
        return False


def _call_seconds(files: list[_File]) -> float:
    total = sum(file.size for file in files)
    return float(min(MAX_CALL_SECONDS, MIN_CALL_SECONDS + total / ASSUMED_BYTES_PER_SECOND))


def _send(files: list[_File], base: str, project_id: str, timeline_id: str) -> dict:
    return _call_mcp("import_media", {
        "action": "from_editor",
        "projectId": project_id,
        "timelineId": timeline_id,
        "files": [file.wire(base) for file in files],
    }, _call_seconds(files))


def _wait_for_editor() -> None:
    from tools.interrupt import is_interrupted

    until = time.monotonic() + EDITOR_CONNECT_SECONDS
    while time.monotonic() < until and not is_interrupted():
        time.sleep(0.5)


def _outcome(files: list[_File], refused: list[dict], payload: Mapping[str, Any], editor: Optional[str]) -> str:
    from tools.registry import tool_result

    by_id = {file.asset_id: file for file in files}
    imported: list[dict] = []
    failed: list[dict] = list(refused)
    for entry in payload.get("results") or []:
        if not isinstance(entry, dict):
            continue
        name = getattr(by_id.get(str(entry.get("assetId"))), "name", str(entry.get("filename") or ""))
        if entry.get("ok"):
            imported.append({"file": name, "asset_id": entry.get("assetId"), "status": entry.get("status")})
        else:
            failed.append({"file": name, "error": str(entry.get("error") or "导入失败")})
    extra = {"editor_url": editor} if editor else {}
    if imported and not failed:
        return tool_result(status="imported", assets=imported, note=IMPORTED_NOTE, **extra)
    return tool_result(status="partial", assets=imported, failed=failed, note=PARTIAL_NOTE, **extra)


def import_files(agent: Any, args: Mapping[str, Any] | None, ctx: Any) -> str:
    """``chatcut_import_files``, inline: the upload consent is asked on the agent's card."""
    from tools.registry import tool_error, tool_result

    if not chatcut.switch_on():
        return tool_error(chatcut.SWITCH_OFF)
    if not chatcut.is_connected():
        return tool_error(NOT_CONNECTED)
    args = args if isinstance(args, Mapping) else {}
    project_id, timeline_id = str(args.get("project_id") or "").strip(), str(args.get("timeline_id") or "").strip()
    raw = args.get("paths")
    if not project_id or not timeline_id:
        return tool_error(IDS_REQUIRED)
    if not isinstance(raw, list) or not raw or len(raw) > MAX_FILES:
        return tool_error(NO_FILES)
    files, refused = _resolve_files(raw, project_id)
    if not files:
        return tool_result(status="partial", assets=[], failed=refused, note=PARTIAL_NOTE)

    if not chatcut.has_upload_consent():
        if getattr(agent, "clarify_callback", None) is None:
            return tool_error(NO_CARD)
        listed = f"「{files[0].name}」" if len(files) == 1 else chatcut.copy("file_list").format(
            first=files[0].name, count=len(files))
        yes = chatcut.copy("upload_yes")
        question = chatcut.copy(chatcut.account().upload_question_key).format(files=listed)
        answer = chatcut.ask_on_card(agent, question, yes, chatcut.copy("upload_no"))
        if answer != yes:
            return tool_result(status="declined", note=DECLINED_NOTE, user_said=answer)
        chatcut.record_upload_consent()

    server = _MediaServer(files, editor_origin())
    threading.Thread(target=server.serve_forever, daemon=True, name="apex-chatcut-media").start()
    try:
        result = _send(files, server.base, project_id, timeline_id)
        editor = None
        if "error" in result:
            # Most often no signed-in browser has the editor open. Open it once, give it a moment, try once more.
            editor = _editor_url(project_id)
            if editor and _open_browser(editor):
                _wait_for_editor()
                result = _send(files, server.base, project_id, timeline_id)
        if "error" in result:
            logger.info("apex-overlay: ChatCut import did not start: %s", result.get("error"))
            return tool_result(status="needs_editor", note=NEEDS_EDITOR_NOTE, editor_url=editor,
                               detail=str(result.get("error")), refused=refused)
        return _outcome(files, refused, _import_payload(result), editor)
    finally:
        server.shutdown()
        server.server_close()
