"""Publish verified media packages, read every byte back, then replace one manifest.

Run only on the publishing server with COS credentials in its environment.
Input is the six *-verified artifacts from one successful media-tools workflow.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import logging
import os
import re
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

BUCKET = "apexnodes-runtime-202606250443-1300912302"
REGION = "ap-guangzhou"
BASE = f"https://{BUCKET}.cos.{REGION}.myqcloud.com"
TARGETS = {"mac-arm64": ("Darwin", "arm64"), "mac-x64": ("Darwin", "x86_64"),
           "win-x64": ("Windows", "AMD64")}
CHECKS = ["h264-aac-encode", "ffprobe-streams-duration", "png-frame"]


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def prepare_ffmpeg(directory: Path, target: str, destination: Path) -> dict:
    proof = json.loads((directory / "native-proof.json").read_text())
    lock = json.loads((directory / "source-lock.json").read_text())
    commit = (directory / "BUILD_COMMIT").read_text().strip()
    version = lock["ffmpeg"]["version"]
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version) or not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise ValueError("Invalid version/build identity")
    if (proof["target"] != target or proof["version"] != version or proof["native"] is not True
            or proof["checks"] != CHECKS
            or (proof["host"]["system"], proof["host"]["machine"]) != TARGETS[target]):
        raise ValueError("Native proof does not match target")
    suffix = ".exe" if target == "win-x64" else ""
    required = ["ffmpeg" + suffix, "ffprobe" + suffix, "LICENSE-FFmpeg.txt", "LICENSE-x264.txt",
                "ffmpeg-config.h", "ffmpeg-configure.log", "source-lock.json", "build.sh", "mirror.py",
                "ffmpeg.source.tar.xz", "x264.source.tar.gz", "zlib.source.tar.gz", "LICENSE-zlib.txt",
                "TARGET", "BUILD_COMMIT", "native-proof.json"]
    for name in required:
        path = directory / name
        if path.is_symlink() or not path.is_file() or not path.stat().st_size:
            raise ValueError(f"Required package member missing: {name}")
    for name in required[:2]:
        if digest(directory / name) != proof["files"][name]:
            raise ValueError("Binary changed after native smoke")
    for name, suffix in (("ffmpeg", "xz"), ("x264", "gz"), ("zlib", "gz")):
        if digest(directory / f"{name}.source.tar.{suffix}") != lock[name]["sha256"]:
            raise ValueError("Corresponding source changed")
    config = (directory / "ffmpeg-config.h").read_text()
    if not re.search(r"^#define CONFIG_NONFREE 0$", config, re.MULTILINE):
        raise ValueError("Build must explicitly disable nonfree")
    destination.mkdir(parents=True, exist_ok=True)
    archive = destination / f"ffmpeg-{version}-{target}.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as out:
        for name in required:
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (0o100755 if name in required[:2] else 0o100644) << 16
            out.writestr(info, (directory / name).read_bytes(), compress_type=zipfile.ZIP_DEFLATED)
    return {"target": target, "version": version, "buildCommit": commit, "path": archive,
            "sha256": digest(archive), "bytes": archive.stat().st_size,
            "license": "GPL-2.0-or-later", "correspondingSourceIncluded": True,
            "nativeChecks": CHECKS,
            "profile": "FFmpeg core + libx264; no external libass/libx265/libvpx"}


def prepare_hypit(root: Path, lock: dict) -> dict:
    spec = importlib.util.spec_from_file_location("media_hypit", Path(__file__).with_name("hypit.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    proofs = {}
    archive = None
    for target, host in TARGETS.items():
        directory = root / f"hypit-{target}-verified"
        path = directory / f"hypit-{lock['version']}.tgz"
        module.verify_archive(path, lock)
        proof = json.loads((directory / "hypit-proof.json").read_text())
        if ((proof["system"], proof["machine"]) != host or proof["version"] != lock["version"]
                or proof["sha256"] != digest(path)
                or proof["checks"] != ["npm-integrity", "license-preserved", "npm-install", "cli-version"]):
            raise ValueError("Hypit native installation proof mismatch")
        proofs[target] = proof
        archive = path
    return {"version": lock["version"], "path": archive, "sha256": digest(archive),
            "bytes": archive.stat().st_size, "npmIntegrity": lock["integrity"],
            "license": "Hypit modified Apache-2.0; written commercial grant confirmed by owner",
            "node": ">=22.15.0", "nativeChecks": proofs,
            "dependenciesMirrored": False, "renderVerified": False}


def read_public(key: str) -> tuple[int, str]:
    with urllib.request.urlopen(BASE + "/" + key, timeout=120) as response:
        result = hashlib.sha256()
        size = 0
        while chunk := response.read(1024 * 1024):
            result.update(chunk)
            size += len(chunk)
    return size, result.hexdigest()


def publish(root: Path, client, readback=read_public) -> dict:
    output = root / "packages"
    # Complete all local validation before the first remote write.
    media = [prepare_ffmpeg(root / f"media-{target}-verified", target, output) for target in TARGETS]
    if len({(m["buildCommit"], m["version"]) for m in media}) != 1:
        raise ValueError("Media packages must come from one build commit and version")
    lock = json.loads((root / "media-mac-arm64-verified/source-lock.json").read_text())
    hypit = prepare_hypit(root, lock["hypit"])
    for package in [*media, hypit]:
        kind = "ffmpeg" if "target" in package else "hypit"
        key = f"media-tools/{kind}/{package['version']}/{package['sha256']}/{package['path'].name}"
        try:
            existing = readback(key)
        except urllib.error.HTTPError as exc:
            if exc.code != 404:
                raise
            existing = None
        expected = (package["bytes"], package["sha256"])
        if existing is not None and existing != expected:
            raise ValueError("Immutable object already exists with different bytes")
        if existing is None:
            client.upload_file(Bucket=BUCKET, Key=key, LocalFilePath=str(package["path"]),
                               PartSize=1, MAXThread=4, EnableMD5=True)
        if readback(key) != expected:
            raise ValueError("COS full readback mismatch; stable manifest unchanged")
        package["url"] = BASE + "/" + key
        package.pop("path")
        print(f"Verified COS object: {key}", flush=True)
    manifest = {"schema": 1, "ffmpeg": {m["target"]: m for m in media}, "hypit": hypit}
    body = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode()
    key = "media-tools/stable.json"
    client.put_object(Bucket=BUCKET, Key=key, Body=body, ContentType="application/json",
                      CacheControl="no-cache, max-age=0")
    if readback(key) != (len(body), hashlib.sha256(body).hexdigest()):
        raise ValueError("Stable manifest readback failed")
    (root / "published-manifest.json").write_bytes(body)
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifacts", type=Path)
    args = parser.parse_args()
    logging.getLogger("qcloud_cos").setLevel(logging.CRITICAL)
    from qcloud_cos import CosConfig, CosS3Client
    client = CosS3Client(CosConfig(Region=REGION, SecretId=os.environ["COS_SECRET_ID"],
                                  SecretKey=os.environ["COS_SECRET_KEY"], Scheme="https", Timeout=120))
    try:
        # One server-side publisher at a time; no public feed races between scheduled runs.
        import fcntl
        with (args.artifacts.parent / ".media-publish.lock").open("w") as lock_file:
            fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
            publish(args.artifacts.resolve(), client)
    except Exception as exc:
        # SDK exception details can contain signed headers.
        raise SystemExit(f"Media mirror publish failed: {type(exc).__name__}") from None
