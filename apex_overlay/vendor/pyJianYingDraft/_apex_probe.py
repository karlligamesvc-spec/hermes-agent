"""APEX: stands in for ``pymediainfo``, reading duration and size with APEX's bundled ffprobe.

``local_materials.py`` imports this module under the name ``pymediainfo`` (one changed line) and uses only
``MediaInfo.can_parse()``, ``MediaInfo.parse(path, ...)`` and each track's ``duration`` (milliseconds, as
MediaInfo reports it), ``width`` and ``height``. ffprobe ships with APEX Desktop, so the 7 MB libmediainfo
that pymediainfo bundles is not needed. See apex_overlay/vendor/README.md.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any, List, Optional

#: Set by tests or a caller that knows the binary to use.
FFPROBE_ENV = "APEX_FFPROBE"
#: The packaged engine's own copy, where hypit_profile also takes it (<engine>/.runtime/bin).
_BUNDLED = Path(__file__).resolve().parents[3] / ".runtime" / "bin" / ("ffprobe.exe" if sys.platform == "win32" else "ffprobe")
PROBE_TIMEOUT_SECONDS = 30
#: ffprobe's demuxers for still images: MediaInfo reports these as an Image track, not a Video track.
_IMAGE_FORMATS = ("image2", "png_pipe", "jpeg_pipe", "webp_pipe", "bmp_pipe", "tiff_pipe", "gif")


def _ffprobe() -> Optional[str]:
    """``APEX_FFPROBE``, else the engine's own ffprobe, else the platform resolver's (a source checkout)."""
    explicit = os.environ.get(FFPROBE_ENV)
    if explicit:
        return explicit
    if _BUNDLED.is_file():
        return str(_BUNDLED)
    from hermes_platform.resolver import locate_command

    found = locate_command("ffprobe").command
    return found[0] if found else None


def _milliseconds(*values: Any) -> Optional[float]:
    for value in values:
        try:
            seconds = float(value)
        except (TypeError, ValueError):
            continue
        if seconds > 0:
            return seconds * 1000.0
    return None


class MediaInfo:
    """The parts of ``pymediainfo.MediaInfo`` that local_materials.py reads."""

    def __init__(self, general: List[Any], video: List[Any], audio: List[Any], image: List[Any]):
        self.general_tracks = general
        self.video_tracks = video
        self.audio_tracks = audio
        self.image_tracks = image

    @staticmethod
    def can_parse() -> bool:
        return _ffprobe() is not None

    @classmethod
    def parse(cls, path: str, mediainfo_options: Optional[dict] = None) -> "MediaInfo":  # noqa: ARG003 - MediaInfo's signature
        binary = _ffprobe()
        if binary is None:
            raise ValueError("找不到 ffprobe")
        flags = 0x08000000 if sys.platform == "win32" else 0  # CREATE_NO_WINDOW: no console flash on Windows
        done = subprocess.run(
            [binary, "-v", "error", "-show_format", "-show_streams", "-of", "json", path],
            stdin=subprocess.DEVNULL, capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=PROBE_TIMEOUT_SECONDS, creationflags=flags, check=False,
        )
        if done.returncode != 0:
            raise ValueError(f"ffprobe 读不了 {os.path.basename(path)}: {done.stderr.strip()[:200]}")
        report = json.loads(done.stdout or "{}")
        fmt = report.get("format") or {}
        general = [SimpleNamespace(duration=_milliseconds(fmt.get("duration")))]
        still = str(fmt.get("format_name", "")).split(",")[0] in _IMAGE_FORMATS
        video: List[Any] = []
        audio: List[Any] = []
        image: List[Any] = []
        for stream in report.get("streams") or []:
            kind = stream.get("codec_type")
            if kind == "video" and (stream.get("disposition") or {}).get("attached_pic"):
                continue  # cover art inside an audio file is not a picture track
            if kind == "video":
                track = SimpleNamespace(duration=_milliseconds(stream.get("duration")),
                                        width=stream.get("width"), height=stream.get("height"))
                (image if still else video).append(track)
            elif kind == "audio":
                audio.append(SimpleNamespace(duration=_milliseconds(stream.get("duration"))))
        return cls(general, video, audio, image)
