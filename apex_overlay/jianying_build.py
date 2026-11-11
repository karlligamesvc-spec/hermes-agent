"""hc-1219 Build a 剪映 draft from the short-video pipeline's cut list.

The input is the timeline ``assemble`` renders the finished video from (short-video-studio
``footage_assemble.py``: ``width``, ``height``, ``fps``, ``source_dir``, ``subtitles``, ``narration`` and ``shots``
of ``file``, ``in``, ``dur``/``out``, ``zoom``), so the draft has the same cuts as the video the user already has,
on unburned footage, with the subtitles as text the user can edit in 剪映.

What goes in: local media only, plus 叠化 (free) at the cuts the agent names. No filters, effects, animations,
online fonts or VIP material (Kael 2026-11-11, decision 3). Subtitles are white with a black stroke, so they stay
readable on a bright frame (report 2026-11-05 §3).

剪映 takes in any new folder under its draft folder within about two seconds while it runs (a hidden one too) and
keeps the duration it read then, so the draft is put together in a hidden folder beside the draft folder, on the same
disk, and renamed into place whole, its draft_meta_info.json already filled in. The library is the pinned copy in
``apex_overlay/vendor/pyJianYingDraft`` (see its README): it names the timeline ``draft_info.json`` and copies the
media into the draft's ``materials/``.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Optional

from apex_overlay import jianying_install
from apex_overlay.vendor import pyJianYingDraft as draft
from apex_overlay.vendor.pyJianYingDraft import assets
from apex_overlay.vendor.pyJianYingDraft.draft_folder import DRAFT_FILE_NAME
from apex_overlay.vendor.pyJianYingDraft.script_file import MATERIALS_DIR_NAME

SEC = 1_000_000
META_FILE = "draft_meta_info.json"
TRANSITION = "叠化"
NAME_LIMIT = 40
SUBTITLE_TRACK = "字幕"
#: Text size and height: the bottom of a line stays above y 1240 of 1920, inside Douyin's core zone
#: (short-video-studio 「字幕、花字和关键文字只放在安全区」).
SUBTITLE_SIZE = 7.0
SUBTITLE_Y = {"bottom": -0.25, "middle": 0.0}
CLIP_VOLUME = {"plain": 1.0, "under_narration": 0.3}
DEFAULT_CANVAS = (1080, 1920)
_UNSAFE_NAME = re.compile(r'[\\/:*?"<>|\x00-\x1f]+')
_SRT_TIME = re.compile(r"(\d+):(\d{2}):(\d{2})[,.](\d{1,3})")
_ASS_TAGS = re.compile(r"\{[^}]*\}")
STILL_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}


class PlanError(ValueError):
    """The timeline or a file it names cannot become a draft; the message says which and why."""


@dataclass
class Shot:
    path: str
    start: float
    dur: float
    zoom: float = 1.0


@dataclass
class Plan:
    width: int
    height: int
    fps: int
    shots: list[Shot]
    subtitles: Optional[str] = None
    narration: Optional[str] = None
    notes: list[str] = field(default_factory=list)


def _first(entry: dict, keys: Iterable[str]):
    for key in keys:
        if entry.get(key) is not None:
            return entry[key]
    return None


def _shot(entry, base: str, number: int) -> Shot:
    if not isinstance(entry, dict):
        raise PlanError(f"第 {number} 个镜头不是对象")
    name = _first(entry, ("file", "path", "source", "src"))
    start = _first(entry, ("in", "src_in", "start"))
    if name is None or start is None:
        raise PlanError(f"第 {number} 个镜头缺 file 或 in")
    dur = _first(entry, ("dur", "duration"))
    if dur is None:
        end = _first(entry, ("out", "src_out", "end"))
        if end is None:
            raise PlanError(f"第 {number} 个镜头缺 out 或 dur")
        dur = float(end) - float(start)
    if float(dur) <= 0:
        raise PlanError(f"第 {number} 个镜头时长不是正数")
    path = name if os.path.isabs(name) else os.path.join(base, name)
    if not os.path.isfile(path):
        raise PlanError(f"找不到第 {number} 个镜头的素材：{os.path.basename(path)}")
    return Shot(path=path, start=max(0.0, float(start)), dur=float(dur), zoom=float(entry.get("zoom") or 1.0))


def _beside(base: str, value) -> Optional[str]:
    if not value:
        return None
    path = value if os.path.isabs(value) else os.path.join(base, value)
    if not os.path.isfile(path):
        raise PlanError(f"找不到文件：{os.path.basename(path)}")
    return path


def load_plan(timeline: str, subtitles: Optional[str] = None, narration: Optional[str] = None) -> Plan:
    """Read the timeline as ``assemble`` does: relative paths are under ``source_dir`` or the timeline's folder."""
    try:
        with open(timeline, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError) as exc:
        raise PlanError(f"读不了时间轴：{exc}") from exc
    settings = data if isinstance(data, dict) else {}
    entries = data.get("shots") if isinstance(data, dict) else data
    if not isinstance(entries, list) or not entries:
        raise PlanError("时间轴里没有镜头(shots)")
    folder = os.path.dirname(os.path.abspath(timeline))
    base = settings.get("source_dir") or folder
    shots = [_shot(entry, base, number) for number, entry in enumerate(entries, 1)]
    width = int(settings.get("width") or DEFAULT_CANVAS[0])
    height = int(settings.get("height") or DEFAULT_CANVAS[1])
    return Plan(width=width - width % 2, height=height - height % 2, fps=int(settings.get("fps") or 30), shots=shots,
                subtitles=_beside(folder, subtitles or settings.get("subtitles")),
                narration=_beside(folder, narration or settings.get("narration")))


def _seconds(stamp: tuple[str, str, str, str]) -> float:
    hours, minutes, secs, frac = stamp
    return int(hours) * 3600 + int(minutes) * 60 + int(secs) + int(frac.ljust(3, "0")) / 1000


def parse_srt(text: str) -> list[tuple[float, float, str]]:
    """Cues as (start, end, text). The last cue needs no blank line after it (the library's import_srt drops it)."""
    cues = []
    for block in re.split(r"\n\s*\n", text.replace("\r\n", "\n").replace("\r", "\n").strip("\ufeff\n ")):
        lines = [line for line in block.split("\n") if line.strip()]
        for at, line in enumerate(lines):
            times = _SRT_TIME.findall(line)
            if "-->" in line and len(times) == 2:
                start, end = _seconds(times[0]), _seconds(times[1])
                words = "\n".join(lines[at + 1:]).strip()
                if words and end > start:
                    cues.append((start, end, words))
                break
    return cues


def _ass_time(value: str) -> float:
    hours, minutes, secs = value.strip().split(":")
    return int(hours) * 3600 + int(minutes) * 60 + float(secs)


def parse_ass(text: str) -> list[tuple[float, float, str]]:
    """Dialogue lines of an ASS file as (start, end, text), override tags removed, ``\\N`` as a line break."""
    cues = []
    for line in text.splitlines():
        if not line.startswith("Dialogue:"):
            continue
        parts = line.split(",", 9)
        if len(parts) < 10:
            continue
        words = _ASS_TAGS.sub("", parts[9]).replace("\\N", "\n").replace("\\n", "\n").strip()
        start, end = _ass_time(parts[1]), _ass_time(parts[2])
        if words and end > start:
            cues.append((start, end, words))
    return cues


def read_cues(path: str) -> list[tuple[float, float, str]]:
    """An SRT, or an ASS: the SRT ``subtitles`` writes beside it is preferred (same cues, no styling to strip)."""
    srt = os.path.splitext(path)[0] + ".srt"
    source = srt if path.lower().endswith(".ass") and os.path.isfile(srt) else path
    with open(source, encoding="utf-8-sig", errors="replace") as handle:
        text = handle.read()
    cues = parse_ass(text) if source.lower().endswith(".ass") else parse_srt(text)
    return sorted(cues)


def draft_name(wanted: str, fallback: str) -> str:
    name = _UNSAFE_NAME.sub(" ", wanted or "").strip(" .")
    name = re.sub(r"\s+", " ", name)[:NAME_LIMIT].strip(" .")
    return name or fallback


def free_folder(root: Path, name: str) -> Path:
    """A name that is neither a folder under ``root`` nor still listed by 剪映: a draft is never written into or
    over another, and a stale entry of a removed draft with the same name cannot pass for the new one."""
    taken = jianying_install.listed_names(root)
    candidate = root / name
    number = 2
    while candidate.exists() or candidate.name in taken:
        candidate = root / f"{name} {number}"
        number += 1
    return candidate


PARTS = (MATERIALS_DIR_NAME, DRAFT_FILE_NAME, META_FILE)


def _move_in(staging: Path, final: Path) -> None:
    """Make the folder where 剪映 watches, then move the finished parts in, the meta last. Each move is a rename on
    the same disk, so the folder is whole a moment after it appears; 剪映 looks about two seconds after. On a failure
    the parts go back to ``staging``."""
    final.mkdir()
    moved = []
    try:
        for part in PARTS:
            os.rename(staging / part, final / part)
            moved.append(part)
    except OSError:
        for part in reversed(moved):
            os.rename(final / part, staging / part)
        final.rmdir()
        raise


def announce_again(folder: Path) -> None:
    """Make 剪映 see ``folder`` appear again. Now and then it misses a new folder until something else appears in
    its draft folder (11.7.0: 2 of 18 in a row, 2026-11-11), so the draft is moved out beside that folder and in
    again. A draft 剪映 has not listed is not open there, so nothing of the user's is in the way."""
    holder = Path(tempfile.mkdtemp(prefix=".apex-jianying-", dir=folder.parent.parent))
    away = holder / folder.name
    try:
        os.rename(folder, away)
        _move_in(away, folder)
    finally:
        if away.exists() and not folder.exists():
            os.rename(away, folder)
        shutil.rmtree(holder, ignore_errors=True)


def _meta(final: Path, duration_us: int) -> dict:
    """The library's draft_meta_info.json template, filled in. 剪映 takes the duration on its home page from here
    when it first sees the folder and does not read it again (measured on 11.7.0, 2026-11-11)."""
    with open(assets.get_asset_path("DRAFT_META_TEMPLATE"), encoding="utf-8") as handle:
        meta = json.load(handle)
    now = int(time.time() * SEC)
    meta.update(draft_id=str(uuid.uuid4()).upper(), draft_name=final.name, draft_fold_path=str(final),
                draft_root_path=str(final.parent), tm_duration=duration_us, tm_draft_create=now,
                tm_draft_modified=now)
    return meta


def _fill_scale(material, width: int, height: int) -> float:
    """剪映 fits a clip inside the canvas; ``assemble`` crops it to fill. Scale up by the difference."""
    if material.width <= 0 or material.height <= 0:
        return 1.0
    across, down = width / material.width, height / material.height
    return max(across, down) / min(across, down)


def _video_track(script, plan: Plan, dissolve_after: set[int]) -> tuple[int, list[str]]:
    notes: list[str] = []
    materials: dict[str, object] = {}
    clip_volume = CLIP_VOLUME["under_narration" if plan.narration else "plain"]
    at = 0
    for number, shot in enumerate(plan.shots, 1):
        if os.path.splitext(shot.path)[1].lower() == ".gif":
            raise PlanError(f"第 {number} 个镜头是 GIF,剪映草稿只放视频和图片")
        material = materials.get(shot.path) or draft.VideoMaterial(shot.path)
        materials[shot.path] = material
        start = round(shot.start * SEC)
        length = round(shot.dur * SEC)
        if material.material_type == "video":
            if start >= material.duration:
                raise PlanError(f"第 {number} 个镜头的入点超过了素材长度")
            if start + length > material.duration:
                length = material.duration - start
                notes.append(f"第 {number} 个镜头素材不够长，缩短到 {length / SEC:.2f} 秒")
        scale = _fill_scale(material, plan.width, plan.height) * shot.zoom
        segment = draft.VideoSegment(
            material, draft.Timerange(at, length),
            source_timerange=draft.Timerange(start if material.material_type == "video" else 0, length),
            volume=clip_volume, clip_settings=draft.ClipSettings(scale_x=scale, scale_y=scale))
        if number in dissolve_after and number < len(plan.shots):
            segment.add_transition(draft.TransitionType.from_name(TRANSITION))
        script.add_segment(segment, "画面")
        at += length
    return at, notes


def _audio(script, path: str, track: str, total: int, volume: float, fade: bool) -> None:
    material = draft.AudioMaterial(path)
    length = min(material.duration, total)
    segment = draft.AudioSegment(material, draft.Timerange(0, length), volume=volume)
    if fade and length > 4 * SEC:
        segment.add_fade("1s", "1s")
    script.append_track(draft.TrackSpec(draft.TrackType.audio, track))
    script.add_segment(segment, track)


def _subtitles(script, cues, total: int, position: str) -> int:
    style = draft.TextStyle(size=SUBTITLE_SIZE, bold=True, color=(1.0, 1.0, 1.0), align=1,
                            auto_wrapping=True, max_line_width=0.73)
    border = draft.TextBorder(color=(0.0, 0.0, 0.0), width=40.0)
    clip = draft.ClipSettings(transform_y=SUBTITLE_Y.get(position, SUBTITLE_Y["bottom"]))
    script.append_track(draft.TrackSpec(draft.TrackType.text, SUBTITLE_TRACK))
    placed = 0
    for at, (start, end, words) in enumerate(cues):
        begin = round(start * SEC)
        if begin >= total:
            break
        stop = min(round(end * SEC), total)
        if at + 1 < len(cues):
            stop = min(stop, round(cues[at + 1][0] * SEC))  # cues may not overlap on one track
        if stop - begin < SEC // 10:
            continue
        script.add_segment(draft.TextSegment(words, draft.Timerange(begin, stop - begin), style=style, border=border,
                                             clip_settings=clip), SUBTITLE_TRACK)
        placed += 1
    return placed


@dataclass
class Written:
    folder: Path
    duration_us: int
    shots: int
    subtitles: int
    notes: list[str]


def write(plan: Plan, root: Path, name: str, *, music: Optional[str] = None, music_volume: float = 0.3,
          dissolve_after: Iterable[int] = (), subtitle_position: str = "bottom") -> Written:
    """Write the draft into ``root`` under a free name and return where it went."""
    final = free_folder(root, name)
    # 剪映 takes in any new folder under its draft folder within seconds, a hidden one too, and keeps what it saw
    # first. So the draft is put together beside that folder (same disk, never looked at) and renamed in whole.
    holder = Path(tempfile.mkdtemp(prefix=".apex-jianying-", dir=root.parent))
    staging = holder / final.name
    staging.mkdir()
    try:
        script = draft.ScriptFile(plan.width, plan.height, plan.fps, True)
        script.append_track(draft.TrackSpec(draft.TrackType.video, "画面"))
        total, notes = _video_track(script, plan, set(dissolve_after))
        if plan.narration:
            _audio(script, plan.narration, "旁白", total, 1.0, fade=False)
        if music:
            _audio(script, music, "配乐", total, max(0.05, min(1.0, music_volume)), fade=True)
        placed = _subtitles(script, read_cues(plan.subtitles), total, subtitle_position) if plan.subtitles else 0
        script.save_path = str(staging / DRAFT_FILE_NAME)
        script.save(inline_materials=True)  # copies the media into materials/ (PR #198)
        for material in [*script.materials.videos, *script.materials.audios]:  # where they are after the rename
            material.path = str(final / MATERIALS_DIR_NAME / os.path.basename(material.path))
        script.dump(script.save_path)
        with open(staging / META_FILE, "w", encoding="utf-8") as handle:
            json.dump(_meta(final, total), handle, ensure_ascii=False, indent=1)
        _move_in(staging, final)
    finally:
        shutil.rmtree(holder, ignore_errors=True)
    return Written(folder=final, duration_us=total, shots=len(plan.shots), subtitles=placed, notes=plan.notes + notes)


def check_written(folder: Path) -> Optional[str]:
    """Our own check of what we wrote, before 剪映 sees it: the timeline parses, lasts, and its media are there."""
    try:
        timeline = json.loads((folder / DRAFT_FILE_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return "草稿的时间线文件没有写好"
    if not isinstance(timeline.get("duration"), int) or timeline["duration"] <= 0:
        return "草稿的时长是 0"
    for kind in ("videos", "audios"):
        for item in (timeline.get("materials") or {}).get(kind) or []:
            path = item.get("path") or ""
            if path and not os.path.isfile(path):
                return f"草稿里的素材没拷全：{os.path.basename(path)}"
    if not (folder / META_FILE).is_file():
        return "草稿缺 draft_meta_info.json"
    return None
