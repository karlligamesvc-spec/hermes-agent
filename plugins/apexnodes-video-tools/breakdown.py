"""video_breakdown: the remake card (复刻卡) of one local video, shot by shot (hc-1136).

Byte-identical in apex-nodes ``app/runtime_plugins/apexnodes-video-tools/`` and the hermes-agent
fork ``plugins/apexnodes-video-tools/`` (apex-nodes CI compares the bytes). Each plugin's
``__init__`` passes in ``label_fn``, the one piece that differs: how keyframes reach the platform.

Only the standard library and ffmpeg / ffprobe run here: shots cut by ffmpeg's scene score
(``merge_cuts``; first 300 s only), three keyframes per shot, camera and subject motion by
short-video-studio's ``footage_motion.py`` as installed (never a copy), each shot's speech from
``media_transcribe``'s segments, and shot size, subject, action, scene, real face, beat and
on-screen text from the platform (the question and the model live there). The package is
``复刻包-<标题>/``; its fields are in the coordinator note remake-shots-schema. A step that
cannot run leaves its fields 「不确定」 and says why in ``analysis.notes``; nothing is guessed.
"""

from __future__ import annotations

import base64
import contextvars
import importlib.util
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

SCHEMA = "apex.remake.shots/v2"
TOOL_VERSION = "video_breakdown/1"
SCENE_THRESHOLD = 0.2
MERGE_WITHIN = 0.5
MAX_SECONDS = 300.0
KEYFRAME_LONG_SIDE = 720
LABEL_BATCH = 20
CARD_MAX_CHARS = 12_000  # 50–95 shot rows (120–240 characters each): whole for almost any short video
MIN_CAMERA_SHOT = 0.6
UNSURE = "不确定"
LABEL_FIELDS = ("shot_size", "subject", "action", "scene", "has_face", "beat")
SHOT_SIZES = ("特写", "近景", "中景", "全景", "远景")
SUBJECTS = ("手", "人", "商品", "场景", "文字卡")
BEATS = ("钩子", "痛点", "演示", "证明", "价格", "行动", "过渡")
CAMERA = {"static": "固定", "action": "固定", "push_in": "推", "pull_out": "拉", "pan_left": "左摇", "pan_right": "右摇",
          "tilt_up": "上摇", "tilt_down": "下摇", "shake": "手持晃动", "handheld": "手持晃动"}
MOTION_SCRIPT = ("short-video-studio", "scripts", "footage_motion.py")
FONT_CANDIDATES = (
    "/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/Supplemental/Arial.ttf", "/Library/Fonts/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf", "C:\\Windows\\Fonts\\arial.ttf",
)
_FFMPEG_TIMEOUT = 300
_MOVES = {True: "·主体在动", False: "·主体不动"}
_FACE = {True: "有", False: "没有"}

VIDEO_BREAKDOWN_SCHEMA = {
    "name": "video_breakdown",
    "description": (
        "逐镜看懂一条本机视频，做成「复刻卡」：按画面切出每个镜头，给每镜三张关键帧，并标出景别、运镜、主体、动作、"
        "场景、有没有真人正脸、画面上的字（花字/字幕）、这一镜的口播和它在整条视频里的作用（钩子/痛点/演示/价格…）。"
        "拆解爆款、复刻视频、照着别人的视频拍时先用本工具，不要只看转写。"
        "video_path 用 social_download 下好的原片或用户发来的视频；先调 media_transcribe，把它结果里的 segments_path "
        "一起传进来，口播才能分到每个镜头。结果里的 summary 是一句话总结，card 就是复刻卡（每镜一行），"
        "直接照它们回答、写脚本，不用再读文件，也不要写代码去解析 shots.json；card_media_tag 单独一行发给用户看宫格图。"
        "镜头太多时 card 只列前面的镜头，note 会说，后面的用 read_file 读 card_path。"
        "文件都在工作目录的「复刻包-标题」文件夹里，shots.json 是留给后续工具的逐镜字段。"
        "看不准的字段是「不确定」；note 说明哪一步没做，照实告诉用户，不要自己补猜。只分析前 300 秒。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "video_path": {"type": "string", "description": "本机视频文件路径(social_download 的 video_path 或用户上传的视频)。"},
            "segments_path": {
                "type": "string",
                "description": "media_transcribe 结果里的 segments_path(逐字时间轴);不给的话口播不分到镜头。",
            },
            "title": {"type": "string", "description": "原片标题，用在文件夹名和复刻卡里。"},
            "url": {"type": "string", "description": "原片链接(有的话),记进 shots.json。"},
        },
        "required": ["video_path"],
    },
}


class BreakdownError(RuntimeError):
    """The card could not be made at all; the message says why in the user's words."""


# ── tools and places ───────────────────────────────────────────────────────────


def tools() -> tuple[str | None, str | None]:
    return shutil.which("ffmpeg"), shutil.which("ffprobe")


def available() -> bool:
    ffmpeg, ffprobe = tools()
    return bool(ffmpeg and ffprobe)


def _homes() -> list[Path]:
    homes: list[Path] = []
    try:
        from hermes_constants import get_default_hermes_root, get_hermes_home
    except ImportError:  # outside the runtime, or an older runtime without the root helper
        get_default_hermes_root = get_hermes_home = None
    if get_hermes_home is not None:
        homes += [Path(get_hermes_home()), Path(get_default_hermes_root())]
    if os.getenv("HERMES_HOME"):
        homes.append(Path(os.environ["HERMES_HOME"]))
    # <HERMES_HOME>/plugins/apexnodes-video-tools/breakdown.py → <HERMES_HOME>; in an apex-nodes
    # checkout the same walk lands on app/, whose skills/apexnodes/ holds the source scripts.
    homes.append(Path(__file__).resolve().parent.parent.parent)
    return homes


def motion_script() -> Path | None:
    """footage_motion.py as installed: hosted agents keep platform skills at
    ``skills/<name>/``, APEX Desktop at ``skills/apexnodes/<name>/``."""
    for home in _homes():
        for path in (home.joinpath("skills", *MOTION_SCRIPT), home.joinpath("skills", "apexnodes", *MOTION_SCRIPT)):
            if path.is_file():
                return path
    return None


_motion_lock = threading.Lock()


def load_motion() -> Any | None:
    path = motion_script()
    if path is None:
        return None
    name = "apexnodes_footage_motion"
    with _motion_lock:
        loaded = sys.modules.get(name)
        if loaded is not None and getattr(loaded, "__file__", None) == str(path):
            return loaded
        spec = importlib.util.spec_from_file_location(name, path)
        if spec is None or spec.loader is None:
            return None
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module  # its dataclasses look their module up while it loads
        try:
            spec.loader.exec_module(module)
        except Exception:  # health: allow BLE001 -- a broken skill install only costs the camera column; logged
            logger.warning("video_breakdown: %s did not load", path, exc_info=True)
            sys.modules.pop(name, None)
            return None
        return module


def resolve_video(raw: str) -> Path | None:
    """The video as this process sees it. A hosted agent gets social_download's path as
    the platform host writes it (``…/agents/<id>/media/…``); its own home is mounted at
    HERMES_HOME, so the part after the agent id is looked up there."""
    path = Path(os.path.expanduser(raw or ""))
    if path.is_file():
        return path.resolve()
    parts = path.parts
    if "agents" in parts[:-2]:
        index = len(parts) - 1 - parts[::-1].index("agents")
        rest = parts[index + 2:]
        for home in _homes():
            candidate = home.joinpath(*rest)
            if rest and candidate.is_file():
                return candidate.resolve()
    return None


def work_dir() -> Path:
    try:
        from agent.runtime_cwd import resolve_agent_cwd
    except ImportError:  # outside the runtime or an older one
        raw = os.getenv("TERMINAL_CWD", "").strip()
        return Path(raw) if raw and Path(raw).is_dir() else Path.cwd()
    return Path(resolve_agent_cwd())


# ── reading the video ──────────────────────────────────────────────────────────


def _run_media_tool(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, stdin=subprocess.DEVNULL, timeout=_FFMPEG_TIMEOUT, check=False, **kwargs)


def _rate(value: Any) -> float:
    try:
        num, _, den = str(value or "0/1").partition("/")
        return float(num) / float(den or 1)
    except (ValueError, ZeroDivisionError):
        return 0.0


def probe(ffprobe: str, path: str) -> dict:
    out = _run_media_tool(
        [ffprobe, "-v", "error", "-show_entries",
         "format=duration:stream=codec_type,width,height,r_frame_rate,avg_frame_rate:stream_tags=rotate:stream_side_data=rotation",
         "-of", "json", path],
        text=True,
    )
    if out.returncode != 0:
        raise BreakdownError("这个文件读不出来，不是能打开的视频。")
    data = json.loads(out.stdout or "{}")
    video = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), None)
    if video is None:
        raise BreakdownError("这个文件里没有画面，不是视频。")
    width, height = int(video.get("width") or 0), int(video.get("height") or 0)
    rotation = 0
    for side in video.get("side_data_list") or []:
        if "rotation" in side:
            rotation = int(float(side["rotation"]))
    if not rotation and (video.get("tags") or {}).get("rotate"):
        rotation = int(float(video["tags"]["rotate"]))
    if abs(rotation) % 180 == 90:
        width, height = height, width
    duration = float((data.get("format") or {}).get("duration") or 0.0)
    if duration <= 0:
        raise BreakdownError("读不出这条视频的时长。")
    fps = _rate(video.get("avg_frame_rate")) or _rate(video.get("r_frame_rate")) or 25.0
    return {"duration": duration, "width": width, "height": height, "fps": round(fps, 2)}


def scene_scores(ffmpeg: str, path: str, seconds: float) -> list[tuple[float, float]]:
    """(time, scene score) of every frame in the first ``seconds``."""
    out = _run_media_tool(
        [ffmpeg, "-v", "error", "-nostdin", "-t", f"{seconds:.3f}", "-i", path, "-an", "-vf",
         "select='gte(scene,0)',metadata=print:key=lavfi.scene_score:file=-", "-f", "null", "-"],
        text=True,
    )
    if out.returncode != 0:
        raise BreakdownError("ffmpeg 读这条视频的画面时出错，切不了镜头。")
    scores: list[tuple[float, float]] = []
    time: float | None = None
    for line in out.stdout.splitlines():
        found = re.search(r"pts_time:([-\d.]+)", line)
        if found:
            time = float(found.group(1))
            continue
        found = re.search(r"lavfi\.scene_score=([\d.]+)", line)
        if found and time is not None:
            scores.append((time, float(found.group(1))))
    return scores


def merge_cuts(scores: list[tuple[float, float]], duration: float,
               threshold: float = SCENE_THRESHOLD, within: float = MERGE_WITHIN) -> list[float]:
    """Cut times: scores ≥ threshold; of cuts less than ``within`` apart only the highest
    stays; none closer than ``within`` to the start or the end."""
    clusters: list[list[tuple[float, float]]] = []
    for time, score in sorted(s for s in scores if s[1] >= threshold):
        if clusters and time - clusters[-1][-1][0] < within:
            clusters[-1].append((time, score))
        else:
            clusters.append([(time, score)])
    cuts = [max(cluster, key=lambda item: item[1])[0] for cluster in clusters]
    return [round(t, 2) for t in cuts if within <= t <= duration - within]


def shot_spans(cuts: list[float], duration: float) -> list[tuple[float, float]]:
    edges = [0.0, *cuts, round(duration, 2)]
    return [(edges[i], edges[i + 1]) for i in range(len(edges) - 1)]


def keyframe_times(start: float, end: float, fps: float) -> list[float]:
    edge = min(max(2.0 / max(fps, 1.0), 0.1), (end - start) / 4)
    return [round(start + edge, 3), round((start + end) / 2, 3), round(end - edge, 3)]


def _scale(width: int, height: int) -> str:
    if height >= width:
        return f"scale=-2:'min({KEYFRAME_LONG_SIDE},ih)'"
    return f"scale='min({KEYFRAME_LONG_SIDE},iw)':-2"


def extract_frame(ffmpeg: str, path: str, time: float, out: Path, scale: str) -> None:
    for at in (time, max(0.0, time - 0.15)):
        _run_media_tool([ffmpeg, "-v", "error", "-nostdin", "-y", "-ss", f"{at:.3f}", "-i", path, "-frames:v", "1",
              "-vf", scale, "-q:v", "5", "-update", "1", str(out)])
        if out.is_file() and out.stat().st_size > 0:
            return
    raise BreakdownError(f"取不出 {time:.2f} 秒的画面。")


# ── camera (footage_motion) ────────────────────────────────────────────────────


def camera_for_shots(motion: Any, ffmpeg: str, ffprobe: str, path: str, spans: list[tuple[float, float]],
                     seconds: float) -> list[tuple[str, bool | str]]:
    """(camera, subject_moves) per shot. footage_motion judges each shot on its own frames,
    so a cut never reads as a camera move."""
    clip = motion.probe(ffprobe, path)
    width, height = motion.analysis_size(clip.width, clip.height)
    stats = motion.analyze_frames(motion._frames(ffmpeg, path, width, height, seconds), width, height)
    fps = motion.FPS
    out: list[tuple[str, bool | str]] = []
    for start, end in spans:
        duration = end - start
        # stats[j] compares frames j and j+1; drop the one that straddles the cut.
        part = [s for j, s in enumerate(stats) if start + 1.0 / fps < (j + 1) / fps <= end]
        # Too short, or too little texture (a plain wall, a solid text card): footage_motion's
        # own rule for "可能不准" is fewer than half the frames matched with confidence.
        if duration < MIN_CAMERA_SHOT or len(part) < 3 or sum(1 for s in part if s.confident) < len(part) / 2:
            out.append((UNSURE, UNSURE))
            continue
        _bins, segments = motion.segment_clip(part, width, height, duration)
        share: dict[str, float] = {}
        for seg in segments:
            share[seg.kind] = share.get(seg.kind, 0.0) + max(0.0, seg.end - seg.start)
        kind, length = max(share.items(), key=lambda item: item[1]) if share else ("", 0.0)
        fixed = share.get("static", 0.0) + share.get("action", 0.0)
        if fixed >= duration / 2:
            out.append(("固定", share.get("action", 0.0) >= 0.3 * duration))
        elif kind in CAMERA and length >= duration / 2:
            out.append((CAMERA[kind], UNSURE))
        else:
            out.append((UNSURE, UNSURE))
    return out


# ── speech (media_transcribe segments) ─────────────────────────────────────────


def load_speech(path: str) -> list[dict]:
    """Sentences as ``{"text", "words": [(text, start_s, end_s)]}``. Accepts media_transcribe's
    segments file, a result JSON with ``segments``, or a plain word list; a sentence without
    words counts as one word spanning the sentence."""
    with open(path, encoding="utf-8-sig") as fh:
        data = json.load(fh)
    if isinstance(data, dict):
        data = data.get("segments") or data.get("utterances") or []
    if not isinstance(data, list):
        raise BreakdownError("segments_path 不是 media_transcribe 的时间轴文件。")
    sentences = []
    for seg in (item for item in data if isinstance(item, dict)):
        words = []
        for word in seg.get("words") or [seg]:
            text = str(word.get("text") or "").strip()
            if text and word.get("start_time") is not None and word.get("end_time") is not None:
                words.append((text, float(word["start_time"]) / 1000, float(word["end_time"]) / 1000))
        if words:
            sentences.append({"text": str(seg.get("text") or "").strip(), "words": words})
    return sentences


def _join(words: list[str]) -> str:
    out = ""
    for word in words:
        if out and re.match(r"[A-Za-z0-9]", word) and re.search(r"[A-Za-z0-9]$", out):
            out += " "
        out += word
    return out


def speech_for_shots(sentences: list[dict], spans: list[tuple[float, float]]) -> list[tuple[str, list[float] | None]]:
    """Each word goes to the shot its midpoint falls in. A sentence that stays inside one
    shot keeps its punctuation; a split one is joined from its words."""
    last = len(spans) - 1
    per_shot: list[list[tuple[int, int]]] = [[] for _ in spans]
    for s_index, sentence in enumerate(sentences):
        for w_index, (_text, start, end) in enumerate(sentence["words"]):
            mid = (start + end) / 2
            for k, (lo, hi) in enumerate(spans):
                if lo <= mid < hi or (k == last and lo <= mid <= hi):
                    per_shot[k].append((s_index, w_index))
                    break
    out: list[tuple[str, list[float] | None]] = []
    for owned in per_shot:
        if not owned:
            out.append(("", None))
            continue
        parts: list[str] = []
        for s_index in dict.fromkeys(s for s, _w in owned):
            sentence = sentences[s_index]
            mine = [w for s, w in owned if s == s_index]
            if len(mine) == len(sentence["words"]) and sentence["text"]:
                parts.append(sentence["text"])
            else:
                parts.append(_join([sentence["words"][w][0] for w in mine]))
        times = [t for s, w in owned for t in sentences[s]["words"][w][1:]]
        out.append(("".join(parts), [round(min(times), 2), round(max(times), 2)]))
    return out


# ── labels from the platform ──────────────────────────────────────────────────


def _b64(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode("ascii")


# step -> (the answer's error key, the run's list of shots it left out)
_STEPS = {"labels_from": ("labels_error", "labels_missing"), "ocr_from": ("ocr_error", "ocr_missing")}


def _batch_answer(future: Any) -> dict:
    """One batch's answer; a batch that raised (gateway down, timeout) failed both steps for its
    own shots only."""
    try:
        return future.result()
    except Exception as exc:  # health: allow BLE001 -- one batch's failure stays with its shots; logged
        logger.warning("video_breakdown: one labels batch failed", exc_info=True)
        reason = {"message": f"看图和读字这一步没做：{exc}"}
        return {"labels_from": "none", "ocr_from": "none", "labels_error": reason, "ocr_error": reason}


def _shot_ranges(numbers: list[int]) -> str:
    """[21, 22, …, 40, 44] -> 「21–40、44」."""
    spans: list[list[int]] = []
    for n in sorted(numbers):
        if spans and n == spans[-1][1] + 1:
            spans[-1][1] = n
        else:
            spans.append([n, n])
    return "、".join(f"{a}–{b}" if b > a else str(a) for a, b in spans)


def _scoped(reason: str, numbers: list[int], total: int) -> str:
    """A step's reason as a note: whole-run as the platform wrote it, or naming the shots it
    covers when other batches did get through (the platform's 「这次」 is about one request)."""
    if len(numbers) == total:
        return reason
    reason = reason.replace("这次没看画面", "这几镜没看画面").replace("这次没读画面上的字", "这几镜没读画面上的字")
    return f"第 {_shot_ranges(numbers)} 镜：{reason}"


def _coverage(missing: list[int], total: int) -> str:
    return "server" if not missing else ("none" if len(missing) >= total else "partial")


def request_labels(label_fn: Callable[[dict], dict], video: dict, shots: list[dict], root: Path) -> tuple[dict[int, dict], dict]:
    """Labels per shot number, plus what the platform said about the whole run: ``labels_from``
    and ``ocr_from`` (server, partial or none), the shots each step left out (``labels_missing``,
    ``ocr_missing``), ``model``, ``summary`` and the reasons. Each batch counts for its own shots:
    one that failed or raised leaves only those 「不确定」."""
    batches = [shots[i:i + LABEL_BATCH] for i in range(0, len(shots), LABEL_BATCH)]

    def ask(batch: list[dict]) -> dict:
        payload = {
            "video": video,
            "shots": [
                {"n": s["n"], "start": s["start"], "end": s["end"], "speech": s["speech"][:1000],
                 "frames": [_b64(root / frame) for frame in s["keyframes"]]}
                for s in batch
            ],
        }
        return label_fn(payload)

    with ThreadPoolExecutor(max_workers=3) as pool:
        answers = [_batch_answer(future) for future in [_in_context(pool, ask, batch) for batch in batches]]
    labels: dict[int, dict] = {}
    run: dict[str, Any] = {"notes": [], "labels_missing": [], "ocr_missing": []}
    reasons: dict[str, list[int]] = {}
    for batch, answer in zip(batches, answers):
        numbers = [s["n"] for s in batch]
        for item in answer.get("shots") or []:
            if isinstance(item, dict) and isinstance(item.get("n"), int):
                labels[item["n"]] = item
        for step, (key, missing) in _STEPS.items():
            if answer.get(step) != "server":
                run[missing] += numbers
                reason = (answer.get(key) or {}).get("message") or "平台没有做这一步。"
                covered = reasons.setdefault(reason, [])
                covered += [n for n in numbers if n not in covered]
        if answer.get("model"):
            run["model"] = answer["model"]
        if answer.get("summary") and len(batches) == 1:
            run["summary"] = answer["summary"]
    run["notes"] = [_scoped(reason, numbers, len(shots)) for reason, numbers in reasons.items()]
    for step, (_key, missing) in _STEPS.items():
        run[step] = _coverage(run[missing], len(shots))
    return labels, run


def apply_labels(shot: dict, entry: dict | None, *, labels_ran: bool, ocr_ran: bool) -> None:
    """Put the platform's answer for one shot into it; a step that did not run leaves
    its fields 「不确定」 and out of ``evidence``."""
    entry = entry or {}
    if labels_ran:
        for name in LABEL_FIELDS:
            value = entry.get(name, UNSURE)
            shot[name] = value
            if value == UNSURE:
                shot["uncertain"].append(name)
            shot["evidence"][name] = "看图和口播" if name == "beat" and shot["speech"] else "看图"
        shot["seen"] = str(entry.get("seen") or "")
    else:
        for name in LABEL_FIELDS:
            shot[name] = UNSURE
            shot["uncertain"].append(name)
        shot["seen"] = ""
    if ocr_ran:
        shot["text_overlays"] = list(entry.get("text_overlays") or [])
        shot["evidence"]["text_overlays"] = "读字"
    else:
        shot["text_overlays"] = []
        shot["uncertain"].append("text_overlays")


# ── writing the package ────────────────────────────────────────────────────────


def _folder_name(title: str) -> str:
    clean = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", " ", title or "").strip()
    clean = re.sub(r"\s+", " ", clean)[:40].strip(" .")
    return f"复刻包-{clean}" if clean else "复刻包"


def _unique(base: Path) -> Path:
    if not base.exists():
        return base
    for k in range(2, 1000):
        candidate = base.with_name(f"{base.name}-{k}")
        if not candidate.exists():
            return candidate
    raise BreakdownError("工作目录里同名的复刻包太多了，先清理一下再做。")


def _keep_source(path: str, dest: Path) -> None:
    try:
        os.link(path, dest)
    except OSError:
        shutil.copy2(path, dest)
    try:
        os.chmod(dest, 0o444)
    except OSError:
        pass


def _font() -> str | None:
    # The client's Smiley Sans, cached where the Desktop font command puts it (hc-1025).
    cached = Path(tempfile.gettempdir()) / "apexnodes-fonts" / "SmileySans-Oblique.otf"
    for path in (str(cached), *FONT_CANDIDATES):
        if Path(path).is_file():
            return path
    return None


def _filter_path(value: str) -> str:
    return value.replace("\\", "/").replace("'", "\\'").replace(":", "\\:")


def contact_sheet(ffmpeg: str, root: Path, shots: list[dict], out: Path, portrait: bool) -> bool:
    """One cell per shot (its middle keyframe). True when the cells carry their number and
    time; False when no usable font was found and the sheet has no writing."""
    count = len(shots)
    cols = min(count, 5 if portrait else 4)
    cell_w = (240 if portrait else 320) if count <= 40 else 160
    cell_h = round(cell_w * (16 / 9 if portrait else 9 / 16) / 2) * 2
    font = _font()
    for labelled in ((True, False) if font else (False,)):
        cmd = [ffmpeg, "-v", "error", "-nostdin", "-y"]
        parts = []
        for k, shot in enumerate(shots):
            cmd += ["-i", str(root / shot["keyframes"][1])]
            chain = (f"[{k}:v]scale={cell_w}:{cell_h}:force_original_aspect_ratio=decrease,"
                     f"pad={cell_w}:{cell_h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1")
            if labelled:
                text = f"{shot['n']}  {shot['start']:.1f}-{shot['end']:.1f}s"
                chain += (f",drawtext=fontfile='{_filter_path(font)}':text='{text}':x=6:y=6:fontsize={max(12, cell_w // 12)}:"
                          "fontcolor=yellow:box=1:boxcolor=black@0.6:boxborderw=4")
            parts.append(chain + f"[c{k}]")
        if count == 1:
            parts.append("[c0]null[out]")
        else:
            layout = "|".join(f"{(k % cols) * cell_w}_{(k // cols) * cell_h}" for k in range(count))
            parts.append("".join(f"[c{k}]" for k in range(count)) + f"xstack=inputs={count}:layout={layout}:fill=black[out]")
        cmd += ["-filter_complex", ";".join(parts), "-map", "[out]", "-frames:v", "1", "-update", "1", "-q:v", "4", str(out)]
        if _run_media_tool(cmd).returncode == 0 and out.is_file():
            return labelled
    raise BreakdownError("宫格图没能拼出来。")


def _cell(value: Any) -> str:
    return str(value).replace("|", "/").replace("\n", " ").strip() or "—"


def _card_parts(card: dict) -> tuple[list[str], list[str], list[str]]:
    """The card's head (title, length, summary, table header), one row per shot, and foot."""
    source, analysis = card["source"], card["analysis"]
    length = f"原片 {source['duration']:.1f} 秒，{len(card['shots'])} 个镜头"
    if analysis["analyzed_seconds"] < source["duration"]:
        length += f"(只看了前 {analysis['analyzed_seconds']:.0f} 秒)"
    head = [
        f"# 复刻卡：{source.get('title') or Path(source['path']).name}", "", length + "。", "", card["summary"], "",
        "| 镜 | 时间 | 景别 | 运镜 | 主体 · 动作 | 场景 | 真人脸 | 画面上的字 | 口播 | 节拍 | 依据(看到的) |",
        "|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    rows = []
    for s in card["shots"]:
        overlays = "；".join(f"{o['text']}({o['kind']}·{o['position']}·{o['size']})" for o in s["text_overlays"])
        if "text_overlays" in s["uncertain"]:
            overlays = UNSURE
        # A fixed camera tells whether the subject moves; a bool face reads as 有 / 没有.
        moves = _MOVES.get(s["subject_moves"], "") if s["camera"] == "固定" else ""
        face = _FACE.get(s["has_face"]) if isinstance(s["has_face"], bool) else _cell(s["has_face"])
        rows.append(
            f"| {s['n']} | {s['start']:.2f}–{s['end']:.2f} | {_cell(s['shot_size'])} | {_cell(s['camera'])}{moves} | "
            f"{_cell(s['subject'])} · {_cell(s['action'])} | {_cell(s['scene'])} | {face} | "
            f"{_cell(overlays)} | {_cell(s['speech'])} | {_cell(s['beat'])} | {_cell(s['seen'])} |"
        )
    foot = ["", "看不准的写「不确定」，不是猜的。"] + [f"- {note}" for note in analysis["notes"]]
    return head, rows, foot


def render_card(card: dict) -> str:
    head, rows, foot = _card_parts(card)
    return "\n".join(head + rows + foot) + "\n"


def card_for_result(card: dict) -> tuple[str, int]:
    """The card as the tool result carries it, so the model reads no file: whole when it fits
    in CARD_MAX_CHARS, else whole rows from the top and a line saying how many are left out.
    Returns the text and how many shots it lists."""
    head, rows, foot = _card_parts(card)
    kept = list(rows)
    text = "\n".join(head + kept + foot) + "\n"
    while len(text) > CARD_MAX_CHARS and kept:
        kept.pop()
        left_out = f"(后面还有 {len(rows) - len(kept)} 镜没列在这里，完整的在 复刻卡.md 和 shots.json)"
        text = "\n".join([*head, *kept, "", left_out, *foot]) + "\n"
    return text, len(kept)


def _summary(card: dict) -> str:
    shots = card["shots"]
    duration = card["analysis"]["analyzed_seconds"]
    text = f"这条 {duration:.0f} 秒、{len(shots)} 个镜头，平均每镜 {duration / max(1, len(shots)):.1f} 秒"
    sizes = [s["shot_size"] for s in shots if s["shot_size"] in SHOT_SIZES]
    if sizes:
        top = max(set(sizes), key=sizes.count)
        text += f"；景别以{top}为主({sizes.count(top)}/{len(shots)})"
    beats = [s["beat"] for s in shots if s["beat"] in BEATS]
    if beats:
        order = list(dict.fromkeys(beats))
        text += "；节奏：" + "→".join(order)
    return text + "。"


# ── the whole run ──────────────────────────────────────────────────────────────


def _in_context(pool: ThreadPoolExecutor, fn: Callable, *args: Any):
    """Submit with the caller's context: the runtime keeps the profile (and so the platform
    key) in ContextVars, which a bare worker thread would not see."""
    return pool.submit(contextvars.copy_context().run, fn, *args)


def _video_or_fail(video_path: str) -> tuple[str, str, str]:
    ffmpeg, ffprobe = tools()
    if not (ffmpeg and ffprobe):
        raise BreakdownError("这台机器上找不到 ffmpeg / ffprobe，做不了复刻卡。")
    found = resolve_video(video_path)
    if found is None:
        raise BreakdownError(f"找不到视频文件：{video_path}")
    return ffmpeg, ffprobe, str(found)


def _shot_skeletons(ffmpeg: str, path: str, info: dict, spans: list[tuple[float, float]], root: Path) -> list[dict]:
    """One entry per shot with its time and three keyframes on disk."""
    scale = _scale(info["width"], info["height"])
    shots: list[dict] = []
    jobs = []
    for n, (start, end) in enumerate(spans, 1):
        frames = [f"frames/{n:03d}-{tag}.jpg" for tag in "abc"]
        shots.append({"n": n, "start": round(start, 2), "end": round(end, 2), "dur": round(end - start, 2),
                      "keyframes": frames, "uncertain": [], "evidence": {"time": "切镜头"}})
        jobs += [(t, root / f) for t, f in zip(keyframe_times(start, end, info["fps"]), frames)]
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda job: extract_frame(ffmpeg, path, job[0], job[1], scale), jobs))
    return shots


def _add_speech(shots: list[dict], spans: list[tuple[float, float]], segments_path: str | None,
                notes: list[str]) -> tuple[str, bool | str]:
    """Speech per shot; returns (speech_from, has_speech)."""
    speech: list[tuple[str, list[float] | None]] = [("", None)] * len(shots)
    speech_from, has_speech = "none", UNSURE
    if not segments_path:
        notes.append("没给 media_transcribe 的 segments_path,口播没分到镜头。")
    else:
        try:
            sentences = load_speech(os.path.expanduser(segments_path))
            speech = speech_for_shots(sentences, spans)
            speech_from, has_speech = "segments", bool(sentences)
        except (OSError, ValueError, BreakdownError) as exc:
            notes.append(f"读不了 segments_path({exc}),口播没分到镜头。")
    for shot, (text, span) in zip(shots, speech):
        shot.update({"speech": text, "speech_span": span})
        if speech_from == "segments":
            shot["evidence"]["speech"] = "转写"
        else:
            shot["uncertain"].append("speech")
    return speech_from, has_speech


def _cameras(motion: Any, args: tuple) -> list[tuple[str, bool | str]] | Exception:
    try:
        return camera_for_shots(motion, *args)
    except Exception as exc:  # health: allow BLE001 -- the camera column is not worth the whole card; logged
        logger.warning("video_breakdown: camera analysis failed", exc_info=True)
        return exc


def _labels(label_fn: Callable[[dict], dict], video: dict, shots: list[dict], root: Path) -> tuple[dict[int, dict], dict]:
    try:
        return request_labels(label_fn, video, shots, root)
    except Exception as exc:  # health: allow BLE001 -- any failure of the labels leg keeps the card and says why; logged
        logger.warning("video_breakdown: labels request failed", exc_info=True)
        every = [s["n"] for s in shots]
        return {}, {"labels_from": "none", "ocr_from": "none", "labels_missing": every, "ocr_missing": list(every),
                    "notes": [f"看图和读字这一步没做：{exc}"]}


def _missing_notice(run: dict, total: int) -> str:
    """The summary's first sentence when the platform left shots out, so a card with holes in it
    never reads as a whole one (the reasons are in the notes)."""
    labels, ocr, fields = sorted(run["labels_missing"]), sorted(run["ocr_missing"]), "景别、主体、动作、场景、真人脸、节拍"
    parts = [(labels, "没看成画面、也没读字", fields + "和画面上的字")] if labels and labels == ocr else [
        (labels, "没看成画面", fields), (ocr, "没读成画面上的字", "画面上的字")]
    said = []
    for numbers, what, unsure in parts:
        if numbers:
            whole = len(numbers) >= total
            scope = f"{total} 镜都" if whole else f"第 {_shot_ranges(numbers)} 镜({total} 镜中 {len(numbers)} 镜)"
            said.append(f"{scope}{what}，{'' if whole else '这些镜头的'}{unsure}是「不确定」")
    return f"注意：画面这一层没做全——{'；'.join(said)}。" if said else ""


def _merge(shots: list[dict], labels: dict[int, dict], run: dict, cameras: list[tuple[str, bool | str]] | None) -> None:
    for k, shot in enumerate(shots):
        apply_labels(shot, labels.get(shot["n"]), labels_ran=shot["n"] not in run["labels_missing"],
                     ocr_ran=shot["n"] not in run["ocr_missing"])
        shot["camera"], shot["subject_moves"] = cameras[k] if cameras else (UNSURE, UNSURE)
        if cameras:
            shot["evidence"]["camera"] = shot["evidence"]["subject_moves"] = "运动分析"
        shot["uncertain"] += [name for name in ("camera", "subject_moves") if shot[name] == UNSURE]


def _source(source_name: str, info: dict, title: str | None, url: str | None, has_speech: bool | str) -> dict:
    source: dict[str, Any] = {"path": f"source/{source_name}"}
    if url:
        source["url"] = url
        platform = _platform(url)
        if platform:
            source["platform"] = platform
    if title:
        source["title"] = title
    source.update({"duration": round(info["duration"], 2), "width": info["width"], "height": info["height"],
                   "fps": info["fps"], "has_speech": has_speech})
    return source


def _fill(root: Path, job: dict) -> dict:
    """Everything inside the package directory; returns the card."""
    ffmpeg, ffprobe, path, info, spans, notes = (job[k] for k in ("ffmpeg", "ffprobe", "path", "info", "spans", "notes"))
    source_name = "原片" + (Path(path).suffix.lower() or ".mp4")
    _keep_source(path, root / "source" / source_name)
    shots = _shot_skeletons(ffmpeg, path, info, spans, root)
    speech_from, has_speech = _add_speech(shots, spans, job["segments_path"], notes)
    video = {"duration": round(job["seconds"], 2), "width": info["width"], "height": info["height"], "shot_count": len(shots)}
    if job["title"]:
        video["title"] = job["title"][:200]
    motion = load_motion()
    if motion is None:
        notes.append("没找到 short-video-studio 技能里的 footage_motion.py(这个助手没装这个技能，或技能还没同步下来),运镜没分析。")
    with ThreadPoolExecutor(max_workers=1) as pool:
        mover = _in_context(pool, _cameras, motion, (ffmpeg, ffprobe, path, spans, job["seconds"])) if motion else None
        labels, run = _labels(job["label_fn"], video, shots, root)
        cameras = mover.result() if mover else None
    notes += run["notes"]
    if isinstance(cameras, Exception):
        notes.append(f"运镜分析出错({cameras}),运镜没分析。")
        cameras = None
    _merge(shots, labels, run, cameras)
    card = {
        "schema": SCHEMA,
        "source": _source(source_name, info, job["title"], job["url"], has_speech),
        "analysis": {
            "tool": TOOL_VERSION, "scene_threshold": SCENE_THRESHOLD, "merge_within": MERGE_WITHIN,
            "analyzed_seconds": round(job["seconds"], 2), "labels_from": run["labels_from"],
            **({"model": run["model"]} if run.get("model") else {}),
            "ocr_from": run["ocr_from"], "motion_from": "footage_motion" if cameras else "none",
            "speech_from": speech_from, "notes": notes,
            "created_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        },
        "summary": "",
        "shots": [_ordered(shot) for shot in shots],
    }
    card["summary"] = _missing_notice(run, len(shots)) + (run.get("summary") or _summary(card))
    if not contact_sheet(ffmpeg, root, card["shots"], root / "复刻卡.jpg", info["height"] >= info["width"]):
        notes.append("找不到能写字的字体，宫格图上没写镜号和时间，按从左到右、从上到下的顺序对应镜号。")
    (root / "shots.json").write_text(json.dumps(card, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    (root / "复刻卡.md").write_text(render_card(card), encoding="utf-8")
    return card


def build(video_path: str, *, label_fn: Callable[[dict], dict], segments_path: str | None = None,
          title: str | None = None, url: str | None = None, out_root: Path | None = None) -> dict:
    """Make the package and return what the tool reports. Raises BreakdownError when no
    card can be made at all."""
    ffmpeg, ffprobe, path = _video_or_fail(video_path)
    info = probe(ffprobe, path)
    seconds = min(info["duration"], MAX_SECONDS)
    notes: list[str] = []
    if info["duration"] > MAX_SECONDS:
        notes.append(f"视频有 {info['duration']:.0f} 秒，只拆了前 {MAX_SECONDS:.0f} 秒。")
    spans = shot_spans(merge_cuts(scene_scores(ffmpeg, path, seconds), seconds), seconds)
    final = _unique((out_root or work_dir()) / _folder_name(title or ""))
    root = final.with_name(f".{final.name}.partial")
    shutil.rmtree(root, ignore_errors=True)
    (root / "frames").mkdir(parents=True)
    (root / "source").mkdir()
    job = {"ffmpeg": ffmpeg, "ffprobe": ffprobe, "path": path, "info": info, "spans": spans, "notes": notes,
           "seconds": seconds, "segments_path": segments_path, "title": title, "url": url, "label_fn": label_fn}
    try:
        card = _fill(root, job)
        root.rename(final)
    except BaseException:
        shutil.rmtree(root, ignore_errors=True)
        raise
    card_text, listed = card_for_result(card)
    if listed < len(card["shots"]):
        notes = [*notes, f"复刻卡有 {len(card['shots'])} 镜，结果里的 card 只列了前 {listed} 镜；后面的镜头用 read_file 读 "
                         "card_path(复刻卡.md，每镜一行)，不用写代码解析 shots.json。"]
    result: dict[str, Any] = {"summary": card["summary"], "card": card_text}
    if notes:
        result["note"] = " ".join(notes)
    result.update({
        "card_media_tag": f"MEDIA:{final / '复刻卡.jpg'}", "shot_count": len(card["shots"]),
        "duration": card["source"]["duration"], "labels_from": card["analysis"]["labels_from"],
        "package_dir": str(final), "card_path": str(final / "复刻卡.md"), "card_image": str(final / "复刻卡.jpg"),
        "shots_path": str(final / "shots.json"),
    })
    return result


_FIELD_ORDER = ("n", "start", "end", "dur", "keyframes", "shot_size", "camera", "subject_moves", "subject", "action",
                "scene", "has_face", "seen", "text_overlays", "speech", "speech_span", "beat", "evidence", "uncertain")


def _ordered(shot: dict) -> dict:
    return {name: shot[name] for name in _FIELD_ORDER}


def _platform(url: str) -> str | None:
    host = url.lower()
    for marker, name in (("douyin", "douyin"), ("iesdouyin", "douyin"), ("xiaohongshu", "xiaohongshu"),
                         ("xhslink", "xiaohongshu"), ("kuaishou", "kuaishou"), ("bilibili", "bilibili"),
                         ("b23.tv", "bilibili"), ("tiktok", "tiktok")):
        if marker in host:
            return name
    return None
