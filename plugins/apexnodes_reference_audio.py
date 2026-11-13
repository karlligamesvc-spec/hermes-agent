"""hc-1222: ``generate_video``'s reference audio, as the APEX Desktop sends it.

MiniMax H3 (on the platform's default leg) takes a voice clip with the prompt and makes the
person in the clip speak it, lip-synced: give it ``text_to_speech``'s audio and the presenter
says exactly that voiceover. The platform checks everything (which model, MP3/WAV, 2-15 s a
clip, at most 3 clips and 15 s, no first/last frame beside it) before any spend
(apex-nodes ``app/services/media_input_audio.py``); this module only turns the tool's sources
into what the platform takes, the way ``apexnodes_gateway.input_images`` does for images:

* an ``audio_ref`` (``media:<job>/<file>``) passes as it is;
* a local file (``text_to_speech``'s ``file_path``, its ``MEDIA:`` line, a chat attachment) or a
  link is uploaded first: ``/tools/v1/media/reference-audio-upload`` on the gateway leg,
  ``/media/reference-audio-upload`` on the legacy leg (``TOOLS_GATEWAY_DISABLED=1``);
* nothing goes out unless the leg's video check says ``reference_audio.supported`` (an older
  platform drops the unknown field and renders without the voice), and a clip that cannot be
  used fails the whole call: never a request without it.

The hosted copy is apex-nodes ``app/runtime_plugins/apexnodes-video-tools/reference_audio.py``;
the ``reference_audio`` schema text in both plugins is the same.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Callable

import httpx

# Through the module, not its names: the client's request and credential helpers are looked
# up at call time (tests replace them, and the gateway client stays the one place they live).
from plugins import apexnodes_gateway as _gateway

UPLOAD_PATH = "/tools/v1/media/reference-audio-upload"
LEGACY_UPLOAD_PATH = "/media/reference-audio-upload"
# MiniMax's per-clip limit; the platform refuses a bigger one anyway.
MAX_BYTES = 15 * 1024 * 1024
_DOWNLOAD_TIMEOUT = 30
_UPLOAD_TIMEOUT = 120
# text_to_speech's delivery line: ``MEDIA:<path>``.
_MEDIA_TAG = "MEDIA:"


class ReferenceAudioError(RuntimeError):
    """A clip that cannot be used: the call fails and nothing is generated."""


def _agent_api_key() -> str:
    """The platform credential: the shared gateway client's resolver (the one the Desktop
    injects, hc-604; the credential audit in ``electron/apex-platform-tools.ts`` reads it)."""
    return _gateway.agent_api_key()


def takes_reference_audio(section: dict[str, Any] | None) -> bool:
    """Does this video check section say the platform takes ``reference_audio``?"""
    view = section.get("reference_audio") if isinstance(section, dict) else None
    return bool(isinstance(view, dict) and view.get("supported"))


def _too_large(index: int) -> ReferenceAudioError:
    return ReferenceAudioError(_gateway.say("reference_audio_too_large", index=index, mb=MAX_BYTES // (1024 * 1024)))


def _safe_name(filename: str) -> str:
    cleaned = "".join(ch if ch.isascii() and (ch.isalnum() or ch in "._-") else "_" for ch in filename)
    return cleaned[-64:] or "audio"


def _uploaded_ref(answer: Any, index: int) -> str:
    ref = answer.get("audio_ref") if isinstance(answer, dict) else None
    if not isinstance(ref, str) or not ref.startswith("media:"):
        raise ReferenceAudioError(_gateway.say("reference_audio_upload_failed", index=index, reason="no audio_ref"))
    return ref


def _download(url: str, index: int) -> bytes:
    data = bytearray()
    try:
        with httpx.Client(timeout=_DOWNLOAD_TIMEOUT, follow_redirects=True) as client:
            with client.stream("GET", url, headers={"User-Agent": "Mozilla/5.0 (compatible; APEX)"}) as response:
                if response.status_code >= 400:
                    reason = f"HTTP {response.status_code}"
                    raise ReferenceAudioError(_gateway.say("reference_audio_download_failed", index=index, reason=reason))
                for chunk in response.iter_bytes():
                    data.extend(chunk)
                    if len(data) > MAX_BYTES:
                        raise _too_large(index)
    except httpx.HTTPError as exc:
        raise ReferenceAudioError(_gateway.say("reference_audio_download_failed", index=index, reason=exc)) from exc
    return bytes(data)


def upload_reference_audio(data: bytes, filename: str, index: int) -> str:
    """Gateway leg: one clip up to the platform; its ``audio_ref``."""
    try:
        body = _gateway.request_json(
            "POST",
            UPLOAD_PATH,
            files={"file": (_safe_name(filename), data, "application/octet-stream")},
            timeout=_UPLOAD_TIMEOUT,
        )
    except _gateway.GatewayError as exc:
        raise ReferenceAudioError(_gateway.say("reference_audio_upload_failed", index=index, reason=exc)) from exc
    return _uploaded_ref(_gateway.unwrap(body), index)


def legacy_upload_reference_audio(api_base: str, data: bytes, filename: str, index: int) -> str:
    """Legacy leg (``TOOLS_GATEWAY_DISABLED=1``): the same upload on the master's internal route."""
    key = _agent_api_key()
    if not key:
        raise _gateway.missing_credential_error()
    boundary = f"apexnodes-{uuid.uuid4().hex}"
    head = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{_safe_name(filename)}\"\r\n"
        "Content-Type: application/octet-stream\r\n\r\n"
    ).encode()
    request = urllib.request.Request(
        f"{api_base.rstrip('/')}{LEGACY_UPLOAD_PATH}",
        data=head + data + f"\r\n--{boundary}--\r\n".encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=_UPLOAD_TIMEOUT) as response:
            answer = json.loads(response.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read().decode("utf-8", errors="replace")).get("detail")
        except (ValueError, AttributeError):
            detail = None
        message = detail.get("message") if isinstance(detail, dict) else detail if isinstance(detail, str) else ""
        reason = message or f"HTTP {exc.code}"
        raise ReferenceAudioError(_gateway.say("reference_audio_upload_failed", index=index, reason=reason)) from exc
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise ReferenceAudioError(_gateway.say("reference_audio_upload_failed", index=index, reason=exc)) from exc
    return _uploaded_ref(answer, index)


def _source(source: str, index: int, *, upload: Callable[[bytes, str, int], str], server_paths: bool) -> dict[str, str]:
    source = _gateway.attachment_path(source)
    if source.startswith(_MEDIA_TAG):
        source = source[len(_MEDIA_TAG):].strip()
    if source.startswith("media:"):
        return {"ref": source}
    if source.lower().startswith(("http://", "https://")):
        path = source.split("?", 1)[0].split("#", 1)[0]
        return {"ref": upload(_download(source, index), path.rsplit("/", 1)[-1] or "audio", index)}
    local = Path(source).expanduser()
    if local.is_file():
        try:
            if local.stat().st_size > MAX_BYTES:
                raise _too_large(index)
            data = local.read_bytes()
        except OSError as exc:
            raise ReferenceAudioError(_gateway.say("reference_audio_upload_failed", index=index, reason=exc)) from exc
        return {"ref": upload(data, local.name, index)}
    if server_paths:
        # Not a file here: a master path from an earlier result; the platform checks it is ours.
        return {"path": source}
    shown = source if len(source) <= 120 else "…" + source[-119:]
    raise ReferenceAudioError(_gateway.say("reference_audio_missing", index=index, source=shown))


def reference_audio(
    raw: Any,
    *,
    section: dict[str, Any] | None,
    upload: Callable[[bytes, str, int], str],
    server_paths: bool,
) -> list[dict[str, str]]:
    """The request's ``reference_audio`` from the tool's, or :class:`ReferenceAudioError`;
    ``[]`` without any. ``section`` is the video check the handler already read (None when
    unreadable: support it cannot confirm counts as no support); ``upload`` is the leg's
    upload; ``server_paths`` only on the legacy leg."""
    if raw in (None, "", []):
        return []
    if not isinstance(raw, list):
        raise ReferenceAudioError(_gateway.say("reference_audio_not_list"))
    if not takes_reference_audio(section):
        raise ReferenceAudioError(_gateway.say("reference_audio_unsupported_server"))
    clips: list[dict[str, str]] = []
    for index, entry in enumerate(raw, start=1):
        if isinstance(entry, str):
            entry = {"source": entry}
        if not isinstance(entry, dict):
            raise ReferenceAudioError(_gateway.say("reference_audio_not_list"))
        source = str(entry.get("source") or entry.get("audio_ref") or "").strip()
        if not source:
            raise ReferenceAudioError(_gateway.say("reference_audio_source_missing", index=index))
        clips.append(_source(source, index, upload=upload, server_paths=server_paths))
    return clips


__all__ = [
    "LEGACY_UPLOAD_PATH",
    "MAX_BYTES",
    "UPLOAD_PATH",
    "ReferenceAudioError",
    "legacy_upload_reference_audio",
    "reference_audio",
    "takes_reference_audio",
    "upload_reference_audio",
]
