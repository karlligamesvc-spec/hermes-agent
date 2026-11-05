"""hc-1122 ChatCut: the user's own footage in, finished exports out, both through the Scheduler.

ChatCut gives APEX's account MCP only, and MCP takes a file without a browser only through an upload session that
ChatCut's own helper fills. That helper never runs on this computer. ``chatcut_upload_files`` streams each file to
the Scheduler (``/api/v1/chatcut/uploads``) with this assistant's APEX key; the Scheduler checks the project is the
user's, runs the helper in a sandbox and answers with the asset id. Nothing of the session comes back here.

The first upload is asked on a card: where the file goes (APEX's server, then ChatCut's in the United States, in the
ChatCut account APEX uses) and that it costs the user nothing. The answer is kept in this assistant's home until the
APEX account signs out or the switch goes off (``chatcut.reconcile_at_boot``).

``chatcut_save_export`` fetches a finished cloud export through the Scheduler into the Downloads folder. ChatCut's
own link to it opens without any credential, so it never reaches this computer or the model.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator, Mapping, Optional
from urllib.parse import quote, unquote

from apex_overlay import chatcut

logger = logging.getLogger(__name__)

UPLOAD_TOOL = "chatcut_upload_files"
SAVE_TOOL = "chatcut_save_export"
TOOLSET = "apex_chatcut"
UPLOADS_PATH = "/api/v1/chatcut/uploads"
EXPORTS_PATH = "/api/v1/chatcut/exports"
CONSENT_RELATIVE_PATH = ("apex", "chatcut-upload-consent.json")
MAX_FILES = 8
# The Scheduler's own limit (CHATCUT_UPLOAD_MAX_BYTES); checked here first so a large file is refused at once.
MAX_BYTES = 1024 * 1024 * 1024
CHUNK_BYTES = 1024 * 1024
UPLOAD_TIMEOUT_SECONDS = 1800.0
EXPORT_TIMEOUT_SECONDS = 600.0
UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
MEDIA_SUFFIXES = frozenset({
    ".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".mts", ".m2ts",
    ".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus",
    ".png", ".jpg", ".jpeg", ".webp", ".gif",
})

_COPY = {
    "zh": {
        "upload_question": (
            "要把{files}传到 ChatCut 剪辑吗？文件会先经过 APEX 的服务器，再存到 ChatCut 在美国的服务器上，"
            "放在 APEX 使用的 ChatCut 账号下，你不需要 ChatCut 账号。上传不花你的额度。"
            "之后上传不再询问，退出 APEX 账号后会重新询问。"
        ),
        "upload_yes": "同意上传",
        "upload_no": "先不传",
        "file_list": "「{first}」等 {count} 个文件",
    },
    "en": {
        "upload_question": (
            "Upload {files} to ChatCut for editing? Files go through APEX's server first, then to ChatCut's "
            "servers in the United States, stored in the ChatCut account APEX uses; you don't need a ChatCut "
            "account. Uploading costs you nothing. You won't be asked again until you sign out of APEX."
        ),
        "upload_yes": "Agree and upload",
        "upload_no": "Not now",
        "file_list": "“{first}” and {count} files in all",
    },
}

UPLOAD_SCHEMA = {
    "name": UPLOAD_TOOL,
    "description": (
        "Put video, audio or image files from this computer into the user's ChatCut project. The only way a local "
        "file reaches ChatCut. The first time it asks the user on a card, so do not ask first. Pass the full "
        "project_id (from create_project or list_projects) and absolute paths. Returns status: uploaded or partial "
        "(asset ids per file, not yet on the timeline), declined, or an error."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "project_id": {"type": "string", "description": "Full project UUID."},
            "paths": {"type": "array", "items": {"type": "string"},
                      "description": f"Absolute paths of the files, 1 to {MAX_FILES}."},
        },
        "required": ["project_id", "paths"],
    },
}

SAVE_SCHEMA = {
    "name": SAVE_TOOL,
    "description": (
        "Save a finished ChatCut cloud export to this computer's Downloads folder. Use after track_export says "
        "the render is complete. Pass the full project_id and the render_id from submit_export or track_export. "
        "Returns the saved file's name and size."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "project_id": {"type": "string", "description": "Full project UUID."},
            "render_id": {"type": "string", "description": "The export's renderId."},
        },
        "required": ["project_id", "render_id"],
    },
}

SIGNED_OUT = "要先登录 APEX 账号，ChatCut 才能用。"
# The Scheduler's own words for the same refusal (apex-nodes chatcut_access.NOT_ENABLED).
NOT_OPEN = "ChatCut 剪辑还没有对这个账号开放。"
NEEDS_PROJECT = "project_id 要填完整的工程 id（36 位，从 create_project 或 list_projects 拿）。"
NO_FILES = f"paths 要填 1 到 {MAX_FILES} 个本机文件的绝对路径。"
NO_CARD = "这里没有卡片能让用户确认，上传本机文件要在电脑上的 APEX 对话里做。"
DECLINED_NOTE = "用户这次不同意上传，文件没有离开这台电脑。不要再问，也不要换别的办法上传；问他想怎么做。"
UPLOADED_NOTE = (
    "素材进了工程，还没放上时间轴：用 edit_item 加上去（视频用 type video，音频 audio，图片 image），"
    "再用 track_progress（action: status, target: transcription）等转写完成，之后才能按文字剪、加字幕。"
)
PARTIAL_NOTE = "有文件没传成。把 failed 里的原因告诉用户；只重试失败的文件。"
NEEDS_RENDER = "render_id 要填 submit_export 或 track_export 给的 renderId。"
SAVED_NOTE = "告诉用户成片已经存进「下载」文件夹，说文件名就行，不用说完整路径。"
SAVE_FAILED = "成片没能存下来：{reason}"


def copy(key: str) -> str:
    """User-facing text in the conversation's language."""
    from agent.i18n import get_language

    return _COPY["zh" if str(get_language()).lower().startswith("zh") else "en"][key]


def _consent_path() -> Path:
    from hermes_constants import get_hermes_home

    return get_hermes_home().joinpath(*CONSENT_RELATIVE_PATH)


def has_consent() -> bool:
    return _consent_path().is_file()


def record_consent() -> None:
    from utils import atomic_json_write

    path = _consent_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_json_write(path, {"agreed_at": time.time()})


def forget_consent() -> None:
    try:
        _consent_path().unlink(missing_ok=True)
    except OSError:
        logger.warning("apex-overlay: could not remove the ChatCut upload consent", exc_info=True)


def _gateway() -> tuple[str, str]:
    return (os.environ.get(chatcut.BASE_ENV, "").strip().rstrip("/"), os.environ.get(chatcut.KEY_ENV, "").strip())


def _error_message(response: Any) -> str:
    try:
        error = response.json().get("error")
    except (ValueError, AttributeError):
        error = None
    if isinstance(error, dict) and error.get("message"):
        return str(error["message"])
    return f"服务器回了 {response.status_code}"


# ---------------------------------------------------------------------------
# Upload
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _File:
    path: Path
    size: int


def _resolve(raw: list[Any]) -> tuple[list[_File], list[dict]]:
    files: list[_File] = []
    refused: list[dict] = []
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
        elif path.stat().st_size > MAX_BYTES:
            reason = "文件太大了，一个文件最多 1 GB"
        if reason:
            refused.append({"file": path.name or str(item), "error": reason})
        else:
            files.append(_File(path, path.stat().st_size))
    return files, refused


def _chunks(path: Path) -> Iterator[bytes]:
    with path.open("rb") as handle:
        while chunk := handle.read(CHUNK_BYTES):
            yield chunk


def _send(file: _File, project_id: str, base: str, key: str) -> dict:
    import httpx

    try:
        response = httpx.post(
            f"{base}{UPLOADS_PATH}", params={"projectId": project_id, "filename": file.path.name},
            content=_chunks(file.path),
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/octet-stream",
                     "Content-Length": str(file.size)},
            timeout=httpx.Timeout(60.0, read=UPLOAD_TIMEOUT_SECONDS, write=UPLOAD_TIMEOUT_SECONDS),
        )
    except httpx.HTTPError as exc:
        logger.info("apex-overlay: ChatCut upload did not reach the Scheduler: %s", type(exc).__name__)
        return {"file": file.path.name, "error": "连不上 APEX 的服务器"}
    if response.status_code != 200:
        return {"file": file.path.name, "error": _error_message(response)}
    answer = response.json()
    return {"file": file.path.name, "asset_id": answer.get("assetId")}


def _ask(agent: Any, files: list[_File]) -> Optional[bool]:
    """True once the user agreed, now or before; False when they did not; None when nobody can be asked."""
    if has_consent():
        return True
    if getattr(agent, "clarify_callback", None) is None:
        return None
    first = files[0].path.name
    listed = f"「{first}」" if len(files) == 1 else copy("file_list").format(first=first, count=len(files))
    yes = copy("upload_yes")
    if chatcut.ask_on_card(agent, copy("upload_question").format(files=listed), yes, copy("upload_no")) != yes:
        return False
    record_consent()
    return True


def upload_files(agent: Any, args: Mapping[str, Any] | None, ctx: Any) -> str:
    """``chatcut_upload_files``, inline: the first upload is asked on the agent's card."""
    from tools.registry import tool_error, tool_result

    base, key = _gateway()
    if not chatcut.switch_on() or not base or not key:
        return tool_error(SIGNED_OUT)
    if not chatcut.entitled():
        return tool_error(NOT_OPEN)  # before the card: nothing to agree to
    args = args if isinstance(args, Mapping) else {}
    project_id = str(args.get("project_id") or "").strip().lower()
    raw = args.get("paths")
    if not UUID_RE.match(project_id):
        return tool_error(NEEDS_PROJECT)
    if not isinstance(raw, list) or not raw or len(raw) > MAX_FILES:
        return tool_error(NO_FILES)
    files, refused = _resolve(raw)
    if not files:
        return tool_result(status="partial", assets=[], failed=refused, note=PARTIAL_NOTE)
    agreed = _ask(agent, files)
    if agreed is None:
        return tool_error(NO_CARD)
    if not agreed:
        return tool_result(status="declined", note=DECLINED_NOTE)
    outcomes = [_send(file, project_id, base, key) for file in files]
    assets = [item for item in outcomes if item.get("asset_id")]
    failed = refused + [item for item in outcomes if not item.get("asset_id")]
    if assets and not failed:
        return tool_result(status="uploaded", assets=assets, note=UPLOADED_NOTE)
    return tool_result(status="partial", assets=assets, failed=failed, note=PARTIAL_NOTE)


# ---------------------------------------------------------------------------
# Save an export
# ---------------------------------------------------------------------------


def _downloads() -> Path:
    return Path.home() / "Downloads"


def _name_from(disposition: str, render_id: str) -> str:
    found = re.search(r"filename\*=UTF-8''([^;]+)", disposition or "")
    name = os.path.basename(unquote(found.group(1)).replace("\\", "/")) if found else ""
    return name if name and not name.startswith(".") else f"chatcut-{render_id[:8]}.mp4"


def _free_path(folder: Path, name: str) -> Path:
    target = folder / name
    stem, suffix = os.path.splitext(name)
    index = 2
    while target.exists():
        target = folder / f"{stem} ({index}){suffix}"
        index += 1
    return target


def save_export(args: Mapping[str, Any] | None, **_kwargs: Any) -> str:
    """``chatcut_save_export``: fetch through the Scheduler, write next to the target, then move it in place."""
    import httpx
    from tools.registry import tool_error, tool_result

    base, key = _gateway()
    if not chatcut.switch_on() or not base or not key:
        return tool_error(SIGNED_OUT)
    if not chatcut.entitled():
        return tool_error(NOT_OPEN)
    args = args if isinstance(args, Mapping) else {}
    project_id = str(args.get("project_id") or "").strip().lower()
    render_id = str(args.get("render_id") or "").strip()
    if not UUID_RE.match(project_id):
        return tool_error(NEEDS_PROJECT)
    if not re.fullmatch(r"[0-9a-fA-F][0-9a-fA-F-]{7,35}", render_id):
        return tool_error(NEEDS_RENDER)
    folder = _downloads()
    folder.mkdir(parents=True, exist_ok=True)
    partial = folder / f".chatcut-{uuid.uuid4().hex}.part"
    try:
        with httpx.stream("GET", f"{base}{EXPORTS_PATH}/{quote(render_id)}", params={"projectId": project_id},
                          headers={"Authorization": f"Bearer {key}"},
                          timeout=httpx.Timeout(60.0, read=EXPORT_TIMEOUT_SECONDS)) as response:
            if response.status_code != 200:
                response.read()
                return tool_error(SAVE_FAILED.format(reason=_error_message(response)))
            expected = response.headers.get("x-chatcut-size")
            name = _name_from(response.headers.get("content-disposition", ""), render_id)
            written = 0
            with partial.open("wb") as handle:
                for chunk in response.iter_bytes(CHUNK_BYTES):
                    handle.write(chunk)
                    written += len(chunk)
        if written <= 0 or (expected and expected.isdigit() and int(expected) != written):
            return tool_error(SAVE_FAILED.format(reason="文件不完整"))
        target = _free_path(folder, name)
        os.replace(partial, target)
    except httpx.HTTPError as exc:
        logger.info("apex-overlay: ChatCut export did not come through: %s", type(exc).__name__)
        return tool_error(SAVE_FAILED.format(reason="下载中断了"))
    finally:
        partial.unlink(missing_ok=True)
    return tool_result(status="saved", file=target.name, path=str(target), bytes=written, note=SAVED_NOTE)


def install_inline(module: Any) -> bool:
    """The upload runs inline: it needs the agent's card callback, which registry dispatch does not forward."""
    module.INLINE_TOOL_EXECUTORS[UPLOAD_TOOL] = upload_files
    return True


def register(ctx: Any) -> None:
    from tools.registry import no_cache_check_fn

    # Read each time (chatcut.entitled keeps the Scheduler's answer for a minute): the account may be opened or
    # closed while Desktop runs.
    available = no_cache_check_fn(lambda: chatcut.switch_on() and chatcut.signed_in() and chatcut.entitled())
    ctx.register_tool(
        name=UPLOAD_TOOL, toolset=TOOLSET, schema=UPLOAD_SCHEMA,
        # Registry dispatch has no card callback; the inline table runs it in a conversation.
        handler=lambda _args, **_kw: json.dumps({"error": NO_CARD}, ensure_ascii=False),
        check_fn=available, description=UPLOAD_SCHEMA["description"], emoji="🎬",
    )
    ctx.register_tool(
        name=SAVE_TOOL, toolset=TOOLSET, schema=SAVE_SCHEMA, handler=save_export,
        check_fn=available, description=SAVE_SCHEMA["description"], emoji="🎬",
    )
