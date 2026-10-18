"""Source preparation and native smoke for the independently versioned media mirror."""
from __future__ import annotations

import argparse
import hashlib
import json
import platform
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
from pathlib import Path

# Every source linked into ffmpeg/ffprobe; each ships in the package as corresponding source.
SOURCES = ("ffmpeg", "x264", "zlib", "freetype", "fribidi", "harfbuzz", "libunibreak", "libass")
CHECKS = ["h264-aac-encode", "ffprobe-streams-duration", "png-frame", "drawtext-cjk", "subtitles-cjk"]

# hc-926: captions are rendered with fonts the OS already ships. drawtext takes a font
# file; libass asks CoreText/DirectWrite for a family name, so no fontconfig is linked.
# (macOS maps "PingFang SC" to a reserved file FreeType cannot open; Hiragino is a plain file.)
CJK_FONT_FILES = {
    "Darwin": ("/System/Library/Fonts/Hiragino Sans GB.ttc", "/System/Library/Fonts/STHeiti Medium.ttc"),
    "Windows": (r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\simhei.ttf"),
}
CJK_FONT_FAMILIES = {"Darwin": "Hiragino Sans GB", "Windows": "Microsoft YaHei"}
CAPTION = "APEX 中文字幕"
# No spaces: only libunibreak's line breaking can wrap it inside a 640px frame.
LONG_CAPTION = "今天上门给一位独居的老奶奶做了四菜一汤从备菜到上桌一共花了一个半小时"
# libass reports a glyph no installed font can draw at warning level.
FONT_FALLBACK_FAILURE = "failed to find any fallback"


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def source_archive(name: str, record: dict) -> str:
    return f"{name}.source.tar.{'xz' if record['url'].endswith('.xz') else 'gz'}"


def sources(work: Path) -> None:
    lock = json.loads(Path(__file__).with_name("source-lock.json").read_text(encoding="utf-8-sig"))
    for name in SOURCES:
        record = lock[name]
        archive = work / source_archive(name, record)
        with urllib.request.urlopen(record["url"], timeout=120) as response:
            with archive.open("wb") as stream:
                shutil.copyfileobj(response, stream)
        if sha256(archive) != record["sha256"]:
            raise ValueError(f"Source checksum mismatch: {name}")
        destination = work / name
        destination.mkdir()
        with tarfile.open(archive) as tar:
            members = tar.getmembers()
            roots = {m.name.split("/")[0] for m in members}
            if len(roots) != 1:
                raise ValueError("Source archive needs exactly one root")
            root = roots.pop()
            tar.extractall(work / (name + "-unpacked"), filter="data")
        for child in (work / (name + "-unpacked") / root).iterdir():
            shutil.move(child, destination / child.name)


def run(argv: list[str]) -> str:
    result = subprocess.run(argv, capture_output=True, text=True, timeout=90, check=True, encoding="utf-8", errors="replace")
    return result.stdout


def lit_rows(ffmpeg: str, folder: Path, video_filter: str) -> tuple[list[int], str]:
    """Bright pixels per row after drawing *video_filter* on one black 640x360 frame, plus warnings.

    Runs in *folder* so font, text and subtitle files are plain relative names (no
    filtergraph escaping of Windows drive letters)."""
    width, height = 640, 360
    result = subprocess.run(
        [ffmpeg, "-hide_banner", "-v", "warning", "-f", "lavfi", "-i", f"color=black:size={width}x{height}:duration=1",
         "-vf", video_filter, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        capture_output=True, timeout=90, check=True, cwd=folder)
    if len(result.stdout) != width * height:
        raise ValueError("Caption frame has the wrong size")
    rows = [sum(1 for value in result.stdout[row * width:(row + 1) * width] if value > 128) for row in range(height)]
    return rows, result.stderr.decode("utf-8", "replace")


def text_band_height(rows: list[int]) -> int:
    lit = [index for index, count in enumerate(rows) if count]
    return lit[-1] - lit[0] + 1 if lit else 0


def caption_checks(ffmpeg: str, folder: Path) -> None:
    """drawtext and subtitles must both draw Chinese text with an OS font, and libass must
    wrap a long Chinese line that has no spaces."""
    system = platform.system()
    font = next((Path(p) for p in CJK_FONT_FILES[system] if Path(p).is_file()), None)
    if font is None:
        raise ValueError("No CJK system font available for the drawtext check")
    shutil.copyfile(font, folder / ("font" + font.suffix))
    (folder / "caption.txt").write_text(CAPTION, encoding="utf-8")
    (folder / "caption.srt").write_text(f"1\n00:00:00,000 --> 00:00:05,000\n{CAPTION}\n", encoding="utf-8")
    (folder / "long.srt").write_text(f"1\n00:00:00,000 --> 00:00:05,000\n{LONG_CAPTION}\n", encoding="utf-8")
    rows, _warnings = lit_rows(
        ffmpeg, folder, f"drawtext=fontfile=font{font.suffix}:textfile=caption.txt:fontsize=48:fontcolor=white:x=20:y=150")
    if sum(rows) < 500:
        raise ValueError("drawtext rendered no visible text")
    style = f"FontName={CJK_FONT_FAMILIES[system]},FontSize=24,PrimaryColour=&H00FFFFFF"
    rows, warnings = lit_rows(ffmpeg, folder, f"subtitles=caption.srt:force_style='{style}'")
    if sum(rows) < 500 or FONT_FALLBACK_FAILURE in warnings:
        raise ValueError(f"subtitles did not render the caption with a system font: {warnings.strip()}")
    one_line = text_band_height(rows)
    rows, warnings = lit_rows(ffmpeg, folder, f"subtitles=long.srt:force_style='{style}'")
    if FONT_FALLBACK_FAILURE in warnings or text_band_height(rows) < 2 * one_line:
        raise ValueError("subtitles did not wrap a long Chinese line")


def smoke(package: Path) -> dict:
    target = (package / "TARGET").read_text(encoding="utf-8-sig").strip()
    expected = {"mac-arm64": ("Darwin", "arm64"), "mac-x64": ("Darwin", "x86_64"),
                "win-x64": ("Windows", "AMD64")}
    if (platform.system(), platform.machine()) != expected[target]:
        raise ValueError("Smoke must execute on the package's native host")
    suffix = ".exe" if target == "win-x64" else ""
    ffmpeg, ffprobe = [str(package / (name + suffix)) for name in ("ffmpeg", "ffprobe")]
    lock = json.loads((package / "source-lock.json").read_text(encoding="utf-8-sig"))
    version = lock["ffmpeg"]["version"]
    for binary in (ffmpeg, ffprobe):
        output = run([binary, "-version"])
        if f"version {version}" not in output or "--enable-nonfree" in output:
            raise ValueError("Unexpected or nonredistributable media build")
    with tempfile.TemporaryDirectory() as folder:
        video, frame = str(Path(folder) / "test.mp4"), str(Path(folder) / "frame.png")
        run([ffmpeg, "-v", "error", "-f", "lavfi", "-i", "testsrc=size=96x64:rate=10",
             "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=44100", "-t", "1",
             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-y", video])
        media = json.loads(run([ffprobe, "-v", "error", "-show_streams", "-show_format",
                                "-of", "json", video]))
        streams = media["streams"]
        video_stream = next(s for s in streams if s["codec_type"] == "video")
        audio_stream = next(s for s in streams if s["codec_type"] == "audio")
        if (video_stream["width"], video_stream["height"], video_stream["codec_name"],
                audio_stream["codec_name"]) != (96, 64, "h264", "aac"):
            raise ValueError("Encoded media does not match requested properties")
        if not 0.9 <= float(media["format"]["duration"]) <= 1.2:
            raise ValueError("Encoded duration is invalid")
        run([ffmpeg, "-v", "error", "-i", video, "-frames:v", "1", "-y", frame])
        if not Path(frame).read_bytes().startswith(b"\x89PNG\r\n\x1a\n"):
            raise ValueError("Frame extraction failed")
        caption_checks(ffmpeg, Path(folder))
    proof = {"schema": 1, "target": target, "version": version, "native": True,
             "host": {"system": platform.system(), "machine": platform.machine()},
             "checks": CHECKS,
             "files": {Path(binary).name: sha256(Path(binary)) for binary in (ffmpeg, ffprobe)}}
    (package / "native-proof.json").write_text(json.dumps(proof, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(proof))
    return proof


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["sources", "smoke"])
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    if args.command == "sources":
        sources(args.directory.resolve())
    else:
        smoke(args.directory.resolve())
