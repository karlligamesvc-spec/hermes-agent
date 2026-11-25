"""hc-1219 Build a 剪映 draft from the short-video pipeline's cut list.

The input is the timeline ``assemble`` renders the finished video from (short-video-studio
``footage_assemble.py``: ``width``, ``height``, ``fps``, ``source_dir``, ``subtitles``, ``narration`` and ``shots``
of ``file``, ``in``, ``dur``/``out``, ``zoom``), so the draft has the same cuts as the video the user already has,
on unburned footage, with the subtitles as text the user can edit in 剪映.

What goes in: local media only, plus 叠化 (free) at the cuts the agent names. No filters, effects, animations,
online fonts or VIP material (hc-1219). Subtitles are white with a black stroke, so they stay
readable on a bright frame (report 2026-11-05 §3).

The narration plays as loud as in the finished cut (hc-1232). ``assemble`` measures it and raises it to -16 LUFS,
and writes how many dB it added in the report beside the cut, ``<cut>.assembly.json`` ``narration_level.gain_db``.
The draft takes that number from the report in the timeline's folder that names the same narration and the same
shots, and does not measure anything itself. 剪映 takes a volume of at most 10 times (+20 dB). Without such a report
(no cut yet, or one from an ``assemble`` before hc-1232, which left the narration as recorded) the narration stays
as recorded.

The sound effects of the cut come along (hc-1258). ``assemble --sfx`` lays APEX's own synthesized effects over the
cut and lists them in the same report, ``sfx.cues``: the file, where it starts, how much of its head was cut off and
the dB set on it. The draft puts each on a track named 音效 (a second one where two overlap) at that start and that
level, from the newest report of a cut made from this timeline; a cut without effects, or no cut, means no such
track. With somebody speaking the level is the cut's, because the narration is as loud in the draft as in the cut.
With nobody speaking the cut's loudness step raised everything else to the target and the effects were set against
that; a draft keeps the rest where it was recorded, so the effects come down by ``UNNORMALISED_EFFECT_DB``.

The music is laid as in the cut (hc-1285). ``assemble`` plays it from ``music_start`` at ``music_gain`` dB, joins it
again where it is shorter than the cut (each seam a crossfade), fades it in and out at the ends of the cut and ducks it
under the narration with a sidechain compressor. The draft takes the file's start and level from the newest report of
a cut made from this timeline when that cut's music is the same file, else from the timeline; lays each play as a
segment of its own, on 配乐 and 配乐 2 by turns so that the seams can overlap; and writes the ducking as volume
keyframes, ``MUSIC_DUCK_DB`` down while the narration speaks. Where the narration speaks is measured on the narration
file the way the cut's compressor hears it (see ``speech_windows``), the one thing here measured rather than read
from the report: assemble does not write it down.

The footage's own sound is as in the cut (hc-1290). ``assemble`` brings each shot's sound part of the way toward one
RMS level, so it does not jump from shot to shot (``shots[].gain_db`` in the report), and ducks it under the narration
with a sidechain compressor of its own. Each shot in the draft takes that level from the same report, and where its
file has sound the ducking goes on as volume keyframes over the music's windows, ``LIVE_DUCK_DB`` down.

The cut also crosses the sound over at every cut: the next shot's sound comes in 0.35 s before its picture and the
last one's goes out 0.35 s after (J and L cuts). The draft does not. Each shot's sound stays with its picture on the
one 画面 track, where segments cannot overlap, so the sound changes at the cut, and the user's trims and moves in
剪映 keep it with its picture; laying it on tracks of its own would lose that. Measured against the real ``assemble``
(ffmpeg 9.0.2, 2026-11-25), that is the one difference left in the footage's sound before ducking. It lies only in
the 0.7 s around each cut, where about a fifth of the cut's sound energy is the other shot's. Between two shots of
about the same level the draft's level there is 1.1 dB from the cut's on average (90% of 10 ms blocks within 2.9 dB);
between a quiet shot and one about 20 dB louder it is 3.5 dB, at most 21.6 dB, where the cut lets the loud one in
early.

剪映 takes in any new folder under its draft folder within about two seconds while it runs (a hidden one too) and
keeps the duration it read then, so the draft is put together in a hidden folder beside the draft folder, on the same
disk, and renamed into place whole, its draft_meta_info.json already filled in. The library is the pinned copy in
``apex_overlay/vendor/pyJianYingDraft`` (see its README): it names the timeline ``draft_info.json`` and copies the
media into the draft's ``materials/``.
"""

from __future__ import annotations

import array
import itertools
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Optional

from apex_overlay import jianying_install
from apex_overlay.vendor import pyJianYingDraft as draft
from apex_overlay.vendor.pyJianYingDraft import _apex_probe, assets
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
#: The loudest a clip can be in a draft, as a multiple of its own level (1 = as recorded). 剪映 11.7.0's own draft
#: tool takes volume 0 to 10 (its creator-cli schema), and its timeline docs give the slider as 0 to 1000 %.
VOLUME_MAX = 10.0
VOLUME_MAX_DB = 20 * math.log10(VOLUME_MAX)
#: What ``assemble`` writes beside the cut: ``成片.mp4`` -> ``成片.assembly.json``.
ASSEMBLY_REPORT_SUFFIX = ".assembly.json"
#: The effects ``assemble`` synthesized for a cut sit beside it: ``成片.mp4`` -> ``成片.sfx/ding.wav``.
EFFECT_FOLDER_SUFFIX = ".sfx"
EFFECT_TRACK = "音效"
#: With nobody speaking, the cut's loudness step lifts the footage's sound and the -10 dB music back up to the
#: target, by about 7 to 10 dB (measured +7 on a cut of live sound and music, 2026-11-16), and the effects were set
#: against that. A draft keeps them where they were, so the effects come down by as much: a little quiet rather than
#: blaring, and the user can raise the track in 剪映.
UNNORMALISED_EFFECT_DB = -10.0
#: Shorter than this, what is left of an effect at the end of the cut is not worth a segment.
EFFECT_MIN = SEC // 50
MUSIC_TRACK = "配乐"
#: How ``assemble`` lays the music (short-video-studio footage_assemble.py, hc-1220 and hc-1232): -10 dB unless the
#: timeline sets ``music_gain`` (-30 to 0); faded in over 0.5 s and out over 1.5 s, each at most a quarter of the cut;
#: a 2 s crossfade at each seam where it is joined again, a quarter of the piece when that is shorter; at most 100
#: plays.
MUSIC_GAIN_DEFAULT_DB = -10.0
MUSIC_GAIN_LIMITS = (-30.0, 0.0)
MUSIC_FADE_IN = SEC // 2
MUSIC_FADE_OUT = 3 * SEC // 2
MUSIC_LOOP_CROSSFADE = 2 * SEC
MUSIC_MAX_PLAYS = 100
#: The cut ducks the music with ``sidechaincompress=threshold=0.02:ratio=8:attack=20:release=500`` keyed on the
#: narration after its gain. Measured on ffmpeg 9.0.2 with three TTS voices and a noisy take at -16 LUFS
#: (2026-11-25): while the narration speaks the music sits 19.2 to 19.4 dB lower on average; it is down a few
#: hundredths of a second into the first word and back about half a second after the last. The draft writes that as
#: keyframes: ``MUSIC_DUCK_DB`` down over each stretch where the narration speaks, going down over ``DUCK_DOWN``
#: before it and back up over ``DUCK_UP`` after it. On those takes it is within 2.1 dB of the cut on average.
DUCK_THRESHOLD = 0.02
MUSIC_DUCK_DB = 19.0
DUCK_DOWN = SEC // 20
DUCK_UP = 11 * SEC // 20
#: The cut ducks the footage's own sound under the narration too, with
#: ``sidechaincompress=threshold=0.02:ratio=6:attack=20:release=400`` keyed on the same narration (hc-1290). Measured
#: the same way (ffmpeg 9.0.2, the same three voices and the noisy take, 2026-11-25): 18.0 dB lower while the narration
#: speaks, within 1 dB of its level again 0.40 to 0.46 s after the last word. The music's windows and ramps fit that
#: best, within 1.9 dB of the cut on average, so the footage's sound goes down over the same windows by this much.
LIVE_DUCK_DB = 18.0
#: The narration is read as 16-bit mono at this rate in blocks of this many µs.
SPEECH_RATE = 8000
SPEECH_BLOCK = SEC // 100
PCM_TIMEOUT_SECONDS = 60
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
    #: dB ``assemble`` set on this shot's own sound in the finished cut (hc-1290); 0 when no report of the cut says.
    gain_db: float = 0.0


@dataclass
class Effect:
    """One sound effect of the finished cut, as ``assemble`` placed it."""
    path: str
    start: float  # where it starts in the cut, seconds
    skip: float  # how much of its head was cut off, seconds
    gain_db: float  # dB set on the file in the cut


@dataclass
class Music:
    """The draft's music and how ``assemble`` lays it (hc-1285)."""
    path: str
    start: float = 0.0  # where in the file it starts, seconds
    gain_db: float = MUSIC_GAIN_DEFAULT_DB


@dataclass
class Plan:
    width: int
    height: int
    fps: int
    shots: list[Shot]
    subtitles: Optional[str] = None
    narration: Optional[str] = None
    #: dB ``assemble`` added to this narration in the finished cut; None when no report of the cut says so.
    narration_gain_db: Optional[float] = None
    #: The sound effects of the finished cut (hc-1258), and whether somebody speaks in it (the effects' level).
    effects: list[Effect] = field(default_factory=list)
    effects_under_voice: bool = True
    music: Optional[Music] = None
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


def load_plan(timeline: str, subtitles: Optional[str] = None, narration: Optional[str] = None,
              music: Optional[str] = None) -> Plan:
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
    voice = _beside(folder, narration or settings.get("narration"))
    for shot, gain in zip(shots, assembled_shot_gains(folder, voice, shots)):
        shot.gain_db = gain
    effects, under_voice, notes = assembled_effects(folder, voice, shots)
    return Plan(width=width - width % 2, height=height - height % 2, fps=int(settings.get("fps") or 30), shots=shots,
                subtitles=_beside(folder, subtitles or settings.get("subtitles")), narration=voice,
                narration_gain_db=assembled_narration_gain(folder, voice, shots) if voice else None,
                effects=effects, effects_under_voice=under_voice,
                music=cut_music(folder, settings, music, voice, shots), notes=notes)


def _same_file(listed, path: str) -> bool:
    if not isinstance(listed, str) or not listed:
        return False
    try:
        return os.path.samefile(listed, path)
    except OSError:
        return False


def _same_shots(listed, shots: list[Shot]) -> bool:
    """The report's shots are this timeline's: same files, in points and lengths, in the same order."""
    if not isinstance(listed, list) or len(listed) != len(shots):
        return False
    for entry, shot in zip(listed, shots):
        try:
            same = (entry["file"] == os.path.basename(shot.path)
                    and abs(max(0.0, float(entry["in"])) - shot.start) < 1e-3
                    and abs(float(entry["dur"]) - shot.dur) < 1e-3)
        except (KeyError, TypeError, ValueError):
            return False
        if not same:
            return False
    return True


def _modified(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def _number(value) -> Optional[float]:
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return float(value)
    return None


def _newest_report(folder: str, narration: Optional[str], shots: list[Shot]) -> tuple[Optional[Path], dict]:
    """The report of the cut the user has last from this timeline: in the timeline's folder, of the same shots and
    the same narration (none on both sides counts as the same); of several, the newest. (None, {}) when there is
    none."""
    for report in sorted(Path(folder).glob("*" + ASSEMBLY_REPORT_SUFFIX), key=_modified, reverse=True):
        try:
            data = json.loads(report.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(data, dict) or not _same_shots(data.get("shots"), shots):
            continue
        listed = data.get("narration")
        if _same_file(listed, narration) if narration else not listed:
            return report, data
    return None, {}


def assembled_narration_gain(folder: str, narration: str, shots: list[Shot]) -> Optional[float]:
    """How many dB ``assemble`` added to this narration in the finished cut (hc-1232), from its report in the
    timeline's folder that names the same narration file and the same shots; of several, the newest, which is the
    cut the user has last. None when there is none, or when that report has no number: an ``assemble`` before
    hc-1232 left the narration as recorded."""
    level = _newest_report(folder, narration, shots)[1].get("narration_level")
    return _number(level.get("gain_db")) if isinstance(level, dict) else None


def assembled_shot_gains(folder: str, narration: Optional[str], shots: list[Shot]) -> list[float]:
    """The dB ``assemble`` set on each shot's own sound in the finished cut (hc-1290), from the same report as the
    narration's level. It brings each shot's sound part of the way toward one RMS level, at most 9 dB either way, and
    leaves it as recorded when the timeline says ``match_levels`` false. 0 for every shot without such a report, and
    for a shot the report gives no number."""
    listed = _newest_report(folder, narration, shots)[1].get("shots") or [{}] * len(shots)
    return [_number(entry.get("gain_db")) or 0.0 for entry in listed]


def assembled_effects(folder: str, narration: Optional[str], shots: list[Shot]) -> tuple[list[Effect], bool, list[str]]:
    """The sound effects ``assemble`` laid into the finished cut (hc-1258), from the same report as the narration's
    level: (effects, whether somebody speaks in the cut, notes for the result). A file the report names is taken
    where it is, or from the cut's ``.sfx`` folder beside the report when the work folder was moved; one that is
    in neither place is left out and counted in a note."""
    report, data = _newest_report(folder, narration, shots)
    listed = data.get("sfx")
    cues = listed.get("cues") if isinstance(listed, dict) else None
    if report is None or not isinstance(cues, list):
        return [], True, []
    beside = report.with_name(report.name[: -len(ASSEMBLY_REPORT_SUFFIX)] + EFFECT_FOLDER_SUFFIX)
    effects, missing = [], 0
    for cue in cues:
        if not isinstance(cue, dict) or not isinstance(cue.get("file"), str):
            continue
        start, gain, skip = _number(cue.get("start")), _number(cue.get("gain_db")), _number(cue.get("skip") or 0.0)
        if start is None or gain is None or skip is None or start < 0 or skip < 0:
            continue
        path = next((p for p in (cue["file"], str(beside / os.path.basename(cue["file"]))) if os.path.isfile(p)), None)
        if path is None:
            missing += 1
            continue
        effects.append(Effect(path=path, start=start, skip=skip, gain_db=gain))
    notes = [f"成片里有 {missing} 个音效的文件找不到了，草稿里没放这几个"] if missing else []
    return effects, listed.get("voice") is not False, notes


def _timeline_number(settings: dict, key: str, default: float) -> float:
    """A number the timeline sets, read as ``assemble`` reads it: ``float(value or default)``."""
    try:
        value = float(settings.get(key) or default)
    except (TypeError, ValueError):
        value = math.nan
    if not math.isfinite(value):
        raise PlanError(f"时间轴里的 {key} 不是数")
    return value


def cut_music(folder: str, settings: dict, chosen: Optional[str], narration: Optional[str],
              shots: list[Shot]) -> Optional[Music]:
    """The draft's music, the file the tool names or else the timeline's ``music``, with the start and level of the
    cut (hc-1285). They come from the same report as the narration's level when that cut's music is the same file;
    else from the timeline's ``music_start`` and ``music_gain`` when the timeline names the same file or none
    (``assemble --music`` takes them for the file it is given), checked as ``assemble`` checks them. A file that
    neither describes starts at 0 at assemble's default level."""
    path = _beside(folder, chosen or settings.get("music"))
    if path is None:
        return None
    listed = _newest_report(folder, narration, shots)[1].get("music")
    if isinstance(listed, dict) and _same_file(listed.get("file"), path):
        start, gain = _number(listed.get("start")), _number(listed.get("gain_db"))
        return Music(path, start=start or 0.0, gain_db=MUSIC_GAIN_DEFAULT_DB if gain is None else gain)
    named = settings.get("music")
    if isinstance(named, str) and named and not _same_file(os.path.join(folder, named), path):
        return Music(path)
    gain = _timeline_number(settings, "music_gain", MUSIC_GAIN_DEFAULT_DB)
    if not MUSIC_GAIN_LIMITS[0] <= gain <= MUSIC_GAIN_LIMITS[1]:
        raise PlanError(f"配乐音量要在 {MUSIC_GAIN_LIMITS[0]:g} 到 {MUSIC_GAIN_LIMITS[1]:g} dB 之间,收到 {gain:g}")
    return Music(path, start=_timeline_number(settings, "music_start", 0.0), gain_db=gain)


def clip_volume(gain_db: float) -> float:
    """A shot's own sound in the draft, before any ducking: as loud as in the cut, at most 剪映's VOLUME_MAX."""
    return min(VOLUME_MAX, round(10 ** (gain_db / 20), 4))


def effect_volume(gain_db: float, under_voice: bool) -> float:
    """An effect's volume in the draft: the cut's own level under a voice, ``UNNORMALISED_EFFECT_DB`` below it when
    nobody speaks (see the constant), at most 剪映's VOLUME_MAX."""
    shift = 0.0 if under_voice else UNNORMALISED_EFFECT_DB
    return min(VOLUME_MAX, round(10 ** ((gain_db + shift) / 20), 4))


def narration_volume(gain_db: Optional[float]) -> tuple[float, Optional[str]]:
    """The narration's volume in the draft for ``gain_db`` added in the cut, at most 剪映's VOLUME_MAX, and a note
    for the result when the draft's narration ends up quieter than the cut's."""
    if gain_db is None:
        return 1.0, None
    short = gain_db - VOLUME_MAX_DB
    if round(short, 1) <= 0:
        return min(VOLUME_MAX, round(10 ** (gain_db / 20), 4)), None
    return VOLUME_MAX, (f"成片里旁白拉响了 {gain_db:.1f} dB,剪映最多拉响 {VOLUME_MAX_DB:.0f} dB,"
                        f"草稿里的旁白比成片轻 {short:.1f} dB")


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


def _video_track(script, plan: Plan, dissolve_after: set[int]) -> tuple[int, list[str], list[tuple]]:
    """The shots on 画面, each at its sound's level in the cut. Returns how long they last, notes, and the segments
    whose files have sound as (segment, start in the cut, start in the file, length, level), for the ducking."""
    notes: list[str] = []
    materials: dict[str, object] = {}
    sound: dict[str, bool] = {}
    footage: list[tuple] = []
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
        level = clip_volume(shot.gain_db)
        segment = draft.VideoSegment(
            material, draft.Timerange(at, length),
            source_timerange=draft.Timerange(start if material.material_type == "video" else 0, length),
            volume=level, clip_settings=draft.ClipSettings(scale_x=scale, scale_y=scale))
        if number in dissolve_after and number < len(plan.shots):
            segment.add_transition(draft.TransitionType.from_name(TRANSITION))
        script.add_segment(segment, "画面")
        if material.material_type == "video":
            if shot.path not in sound:  # as assemble decides: the file has an audio stream
                sound[shot.path] = bool(_apex_probe.MediaInfo.parse(shot.path).audio_tracks)
            if sound[shot.path]:
                footage.append((segment, at, start, length, level))
        at += length
    return at, notes, footage


def _narration(script, path: str, total: int, volume: float) -> int:
    """The narration from 0, as in the cut; returns how long it plays in the draft."""
    material = draft.AudioMaterial(path)
    length = min(material.duration, total)
    script.append_track(draft.TrackSpec(draft.TrackType.audio, "旁白"))
    script.add_segment(draft.AudioSegment(material, draft.Timerange(0, length), volume=volume), "旁白")
    return length


def music_track(lane: int) -> str:
    return MUSIC_TRACK if lane == 0 else f"{MUSIC_TRACK} {lane + 1}"


def music_loop(usable: int, total: int) -> tuple[int, int]:
    """``assemble``'s music_loop in µs: how many plays of the music from its start fill the cut, and how long the
    crossfade at each seam is."""
    if usable >= total:
        return 1, 0
    crossfade = min(MUSIC_LOOP_CROSSFADE, usable // 4)
    return max(2, math.ceil((total - crossfade) / (usable - crossfade))), crossfade


def music_plays(usable: int, total: int) -> list[tuple[int, int, int, int]]:
    """Each play of the music as ``assemble`` joins them (µs): where it starts in the cut, how long it lasts, its fade
    in and its fade out. Each next play starts a crossfade before the last ends and fades in over it while the last
    fades out; the first fades in and the last fades out as the cut's ends do. Where a short last play cannot hold
    both, the seam keeps its crossfade and the end's fade is shortened."""
    count, crossfade = music_loop(usable, total)
    first_in, last_out = min(MUSIC_FADE_IN, total // 4), min(MUSIC_FADE_OUT, total // 4)
    plays = []
    for number in range(count):
        at = number * (usable - crossfade)
        length = min(usable, total - at)
        fade_in = first_in if number == 0 else crossfade
        fade_out = last_out if number == count - 1 else crossfade
        if number == 0 and count > 1:
            fade_in = min(fade_in, length - fade_out)
        elif number == count - 1:
            fade_out = min(fade_out, length - fade_in)
        plays.append((at, length, fade_in, fade_out))
    return plays


def speech_windows(samples, gain: float, rate: int = SPEECH_RATE) -> list[tuple[int, int]]:
    """Where the narration speaks (µs), the way the cut's compressors hear it: blocks of ``SPEECH_BLOCK`` whose RMS
    times ``gain`` (the narration's gain in the cut) is above ``DUCK_THRESHOLD``, of 16-bit ``samples`` at ``rate``.
    A pause shorter than the two ramps is bridged: the music and the footage's sound would not get back up in it."""
    block = rate * SPEECH_BLOCK // SEC
    limit = (DUCK_THRESHOLD * 32768 / gain) ** 2 * block  # a block's sum of squares at the threshold
    windows: list[list[int]] = []
    for first in range(0, len(samples) - block + 1, block):
        chunk = samples[first:first + block]
        if math.sumprod(chunk, chunk) <= limit:
            continue
        begin, end = first * SEC // rate, (first + block) * SEC // rate
        if windows and begin - windows[-1][1] < DUCK_DOWN + DUCK_UP:
            windows[-1][1] = end
        else:
            windows.append([begin, end])
    return [(begin, end) for begin, end in windows]


def _ffmpeg() -> Optional[str]:
    """The ffmpeg beside the ffprobe the library reads media with (the named one, the engine's own, the platform's),
    else the platform resolver's."""
    probe = _apex_probe._ffprobe()
    if probe:
        beside = Path(probe).with_name("ffmpeg.exe" if sys.platform == "win32" else "ffmpeg")
        if beside.is_file():
            return str(beside)
    from hermes_platform.resolver import locate_command

    found = locate_command("ffmpeg").command
    return found[0] if found else None


def narration_samples(path: str, total: int):
    """The first ``total`` µs of the narration as 16-bit mono at ``SPEECH_RATE``; None when ffmpeg cannot read it."""
    binary = _ffmpeg()
    if binary is None:
        return None
    flags = 0x08000000 if sys.platform == "win32" else 0  # CREATE_NO_WINDOW, as the library's ffprobe
    try:
        done = subprocess.run(
            [binary, "-v", "error", "-nostdin", "-t", f"{total / SEC:.3f}", "-i", path, "-vn", "-ac", "1",
             "-ar", str(SPEECH_RATE), "-f", "s16le", "-"],
            stdin=subprocess.DEVNULL, capture_output=True, timeout=PCM_TIMEOUT_SECONDS, creationflags=flags,
            check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    if done.returncode != 0 or not done.stdout:
        return None
    samples = array.array("h")
    samples.frombytes(done.stdout[: len(done.stdout) // 2 * 2])
    if sys.byteorder == "big":
        samples.byteswap()
    return samples


def narration_windows(plan: Plan, total: int, narration_length: int) -> tuple[list[tuple[int, int]], bool]:
    """Where the music and the footage's sound go down for the narration (µs; see ``speech_windows``), and whether
    the narration could not be read. Then it is all of the narration: never louder than the cut where somebody
    speaks."""
    if not plan.narration or narration_length <= 0:
        return [], False
    samples = narration_samples(plan.narration, total)
    if samples is None:
        return [(0, narration_length)], True
    return speech_windows(samples, 10 ** ((plan.narration_gain_db or 0.0) / 20)), False


def duck_points(windows: list[tuple[int, int]], level: float,
                depth_db: float = MUSIC_DUCK_DB) -> list[tuple[int, float]]:
    """A volume over the cut (µs, volume): ``level``, and ``depth_db`` lower over each window, going down over
    ``DUCK_DOWN`` before it and back up over ``DUCK_UP`` after. A ramp may start before 0 or end after the cut; a
    segment's keyframes take the value where it begins and ends."""
    low = round(level * 10 ** (-depth_db / 20), 4)
    points: list[tuple[int, float]] = []
    for begin, end in windows:
        for at, volume in ((begin - DUCK_DOWN, level), (begin, low), (end, low), (end + DUCK_UP, level)):
            if points and points[-1][0] == at:
                points[-1] = (at, volume)
            else:
                points.append((at, volume))
    return points


def _volume_at(points: list[tuple[int, float]], at: int) -> float:
    for (start, before), (end, after) in itertools.pairwise(points):
        if start <= at <= end:
            return before if end == start else round(before + (after - before) * (at - start) / (end - start), 4)
    return points[0][1] if at < points[0][0] else points[-1][1]


def segment_keyframes(points: list[tuple[int, float]], level: float, at: int, length: int,
                      source_start: int) -> list[tuple[int, float]]:
    """The volume keyframes (time, volume) of a segment at ``level`` that plays ``length`` µs from ``at`` in the cut
    and from ``source_start`` in its file, following the volume ``points`` over the cut: the value where it begins,
    each point inside it and the value where it ends. None where the curve stays at ``level`` all through it.
    剪映 keeps a keyframe's time in the file's own time: its runtime (11.8.0, Resources/canvas_agent/runtime/
    app-server.mjs) reads (time_offset - source_timerange.start) / speed as the time into the segment."""
    if not points:
        return []
    inner = [point for point in points if at < point[0] < at + length]
    edges = [(at, _volume_at(points, at)), (at + length, _volume_at(points, at + length))]
    if not inner and all(value == level for _, value in edges):
        return []
    return [(source_start + when - at, value) for when, value in [edges[0], *inner, edges[1]]]


def _music(script, plan: Plan, total: int, windows: list[tuple[int, int]], volume: Optional[float]) -> dict:
    """The music as the cut lays it (hc-1285): from its start, joined again where it is shorter than the cut, faded,
    at the cut's level unless the tool asks for another, ducked over the narration's ``windows``. Returns what the
    result says about it."""
    music = plan.music
    material = draft.AudioMaterial(music.path)
    start = round(music.start * SEC)
    if not 0 <= start < material.duration:
        raise PlanError(f"配乐起点 {music.start:g} 秒不在曲子里")
    usable = material.duration - start
    count = music_loop(usable, total)[0]
    if count > MUSIC_MAX_PLAYS:
        raise PlanError(f"配乐从第 {music.start:g} 秒起只有 {usable / SEC:.1f} 秒，要接 {count} 遍才够，换一首长一点的")
    level = round(max(0.05, min(1.0, volume)) if volume is not None else 10 ** (music.gain_db / 20), 4)
    points = duck_points(windows, level)
    plays = music_plays(usable, total)
    for lane in range(min(2, len(plays))):
        script.append_track(draft.TrackSpec(draft.TrackType.audio, music_track(lane)))
    for number, (at, length, fade_in, fade_out) in enumerate(plays):
        segment = draft.AudioSegment(material, draft.Timerange(at, length),
                                     source_timerange=draft.Timerange(start, length), volume=level)
        if fade_in or fade_out:
            segment.add_fade(fade_in, fade_out)
        for offset, value in segment_keyframes(points, level, at, length, start):
            segment.add_keyframe(offset, value)
        script.add_segment(segment, music_track(number % 2))
    return {"plays": len(plays), "start": round(start / SEC, 2), "ducked": bool(windows)}


def effect_track(lane: int) -> str:
    return EFFECT_TRACK if lane == 0 else f"{EFFECT_TRACK} {lane + 1}"


def _effects(script, plan: Plan, total: int) -> int:
    """Each effect at its place in the cut. Segments may not overlap on one track, so one that starts before the
    last on every track has ended opens another."""
    materials: dict[str, object] = {}
    ends: list[int] = []  # where the last segment of each effect track ends
    placed = 0
    for effect in sorted(plan.effects, key=lambda item: item.start):
        begin, skip = round(effect.start * SEC), round(effect.skip * SEC)
        if begin >= total:
            continue
        material = materials.get(effect.path) or draft.AudioMaterial(effect.path)
        materials[effect.path] = material
        length = min(material.duration - skip, total - begin)
        if length < EFFECT_MIN:
            continue
        lane = next((at for at, end in enumerate(ends) if end <= begin), len(ends))
        if lane == len(ends):
            ends.append(0)
            script.append_track(draft.TrackSpec(draft.TrackType.audio, effect_track(lane)))
        script.add_segment(draft.AudioSegment(material, draft.Timerange(begin, length),
                                              source_timerange=draft.Timerange(skip, length),
                                              volume=effect_volume(effect.gain_db, plan.effects_under_voice)),
                           effect_track(lane))
        ends[lane] = begin + length
        placed += 1
    return placed


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
    effects: int = 0  # sound effects of the cut placed in the draft (hc-1258)
    music: Optional[dict] = None  # how the music went in (hc-1285): plays, start, ducked


def write(plan: Plan, root: Path, name: str, *, music_volume: Optional[float] = None,
          dissolve_after: Iterable[int] = (), subtitle_position: str = "bottom") -> Written:
    """Write the draft into ``root`` under a free name and return where it went. The music is ``plan.music``; its
    level is the cut's unless ``music_volume`` (0.05 to 1) asks for another."""
    final = free_folder(root, name)
    # 剪映 takes in any new folder under its draft folder within seconds, a hidden one too, and keeps what it saw
    # first. So the draft is put together beside that folder (same disk, never looked at) and renamed in whole.
    holder = Path(tempfile.mkdtemp(prefix=".apex-jianying-", dir=root.parent))
    staging = holder / final.name
    staging.mkdir()
    try:
        script = draft.ScriptFile(plan.width, plan.height, plan.fps, True)
        script.append_track(draft.TrackSpec(draft.TrackType.video, "画面"))
        total, notes, footage = _video_track(script, plan, set(dissolve_after))
        narration_length = 0
        if plan.narration:
            volume, quieter = narration_volume(plan.narration_gain_db)
            narration_length = _narration(script, plan.narration, total, volume)
            notes += [quieter] if quieter else []
        windows, unread = narration_windows(plan, total, narration_length) if footage or plan.music else ([], False)
        for segment, at, start, length, level in footage:  # the footage's sound ducks under the narration (hc-1290)
            for offset, value in segment_keyframes(duck_points(windows, level, LIVE_DUCK_DB), level, at, length, start):
                segment.add_keyframe(draft.KeyframeProperty.volume, offset, value)
        music = _music(script, plan, total, windows, music_volume) if plan.music else None
        if unread:
            ducked = "现场声和配乐" if footage and plan.music else "配乐" if plan.music else "现场声"
            notes.append(f"量不出旁白在哪几段说话，草稿里{ducked}在整段旁白下都压低了")
        effects = _effects(script, plan, total)
        if effects and not plan.effects_under_voice:
            notes.append("这条片没有人说话：草稿不做整条的响度归一，音效按和现场声、配乐的比例放轻了，觉得轻就在剪映里把音效轨拉高")
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
    return Written(folder=final, duration_us=total, shots=len(plan.shots), subtitles=placed, notes=plan.notes + notes,
                   effects=effects, music=music)


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
