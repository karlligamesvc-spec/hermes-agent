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


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def sources(work: Path) -> None:
    lock = json.loads(Path(__file__).with_name("source-lock.json").read_text(encoding="utf-8"))
    for name in ("ffmpeg", "x264", "zlib"):
        record = lock[name]
        suffix = ".xz" if name == "ffmpeg" else ".gz"
        archive = work / (name + ".source.tar" + suffix)
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


def smoke(package: Path) -> dict:
    target = (package / "TARGET").read_text(encoding="utf-8").strip()
    expected = {"mac-arm64": ("Darwin", "arm64"), "mac-x64": ("Darwin", "x86_64"),
                "win-x64": ("Windows", "AMD64")}
    if (platform.system(), platform.machine()) != expected[target]:
        raise ValueError("Smoke must execute on the package's native host")
    suffix = ".exe" if target == "win-x64" else ""
    ffmpeg, ffprobe = [str(package / (name + suffix)) for name in ("ffmpeg", "ffprobe")]
    lock = json.loads((package / "source-lock.json").read_text(encoding="utf-8"))
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
    proof = {"schema": 1, "target": target, "version": version, "native": True,
             "host": {"system": platform.system(), "machine": platform.machine()},
             "checks": ["h264-aac-encode", "ffprobe-streams-duration", "png-frame"],
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
