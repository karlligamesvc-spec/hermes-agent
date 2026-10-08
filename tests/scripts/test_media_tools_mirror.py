"""hc-906: corrupt/unverified media must never advance the COS manifest."""
from __future__ import annotations

import base64
import hashlib
import importlib.util
import io
import json
import tarfile
import urllib.error
import zipfile
from pathlib import Path

import pytest

SPEC = importlib.util.spec_from_file_location(
    "media_publisher", Path(__file__).resolve().parents[2] / "scripts/media-tools/publish.py")
publisher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publisher)


class Cos:
    def __init__(self):
        self.objects = {}
        self.writes = []

    def upload_file(self, *, Key, LocalFilePath, **kwargs):
        self.objects[Key] = Path(LocalFilePath).read_bytes()
        self.writes.append(Key)

    def put_object(self, *, Key, Body, **kwargs):
        self.objects[Key] = Body
        self.writes.append(Key)

    def read(self, key):
        if key not in self.objects:
            raise urllib.error.HTTPError(key, 404, "missing", {}, None)
        body = self.objects[key]
        return len(body), hashlib.sha256(body).hexdigest()


@pytest.fixture
def artifacts(tmp_path):
    tar_bytes = io.BytesIO()
    with tarfile.open(fileobj=tar_bytes, mode="w:gz") as tar:
        for name, content in {
            "package/package.json": '{"name":"@hypit/hypit","version":"0.2.17"}',
            "package/LICENSE": "Hypit Commercial redistribution license",
        }.items():
            body = content.encode()
            member = tarfile.TarInfo(name)
            member.size = len(body)
            tar.addfile(member, io.BytesIO(body))
    hypit = tar_bytes.getvalue()
    hypit_record = {"version": "0.2.17", "integrity": "sha512-" + base64.b64encode(
        hashlib.sha512(hypit).digest()).decode()}
    source = b"fixture corresponding source bytes"
    lock = {"ffmpeg": {"version": "9.0.2", "sha256": hashlib.sha256(source).hexdigest()},
            "x264": {"sha256": hashlib.sha256(source).hexdigest()},
            "zlib": {"sha256": hashlib.sha256(source).hexdigest()}, "hypit": hypit_record}
    for target, host in publisher.TARGETS.items():
        directory = tmp_path / f"media-{target}-verified"
        directory.mkdir()
        suffix = ".exe" if target == "win-x64" else ""
        binary_names = ["ffmpeg" + suffix, "ffprobe" + suffix]
        for name in binary_names:
            (directory / name).write_bytes(name.encode())
        for name in ("LICENSE-FFmpeg.txt", "LICENSE-x264.txt", "LICENSE-zlib.txt", "ffmpeg-configure.log", "build.sh", "mirror.py"):
            (directory / name).write_text("fixture", encoding="utf-8")
        (directory / "ffmpeg-config.h").write_text("#define CONFIG_NONFREE 0\n", encoding="utf-8")
        (directory / "source-lock.json").write_text(json.dumps(lock), encoding="utf-8")
        (directory / "ffmpeg.source.tar.xz").write_bytes(source)
        (directory / "x264.source.tar.gz").write_bytes(source)
        (directory / "zlib.source.tar.gz").write_bytes(source)
        (directory / "TARGET").write_text(target, encoding="utf-8")
        (directory / "BUILD_COMMIT").write_text("a" * 40, encoding="utf-8")
        (directory / "native-proof.json").write_text(json.dumps({
            "target": target, "version": "9.0.2", "native": True, "checks": publisher.CHECKS,
            "host": {"system": host[0], "machine": host[1]},
            "files": {name: publisher.digest(directory / name) for name in binary_names}}), encoding="utf-8")
        directory = tmp_path / f"hypit-{target}-verified"
        directory.mkdir()
        (directory / "hypit-0.2.17.tgz").write_bytes(hypit)
        (directory / "hypit-proof.json").write_text(json.dumps({
            "system": host[0], "machine": host[1], "version": "0.2.17",
            "sha256": hashlib.sha256(hypit).hexdigest(),
            "checks": ["npm-integrity", "license-preserved", "npm-install", "cli-version"]}), encoding="utf-8")
    return tmp_path


def test_manifest_last_after_all_readbacks_and_source_license_preserved(artifacts):
    cos = Cos()
    manifest = publisher.publish(artifacts, cos, cos.read)
    assert cos.writes[-1] == "media-tools/stable.json"
    assert len(cos.writes) == 5
    assert json.loads(cos.objects[cos.writes[-1]]) == manifest
    assert manifest["hypit"]["dependenciesMirrored"] is False
    with zipfile.ZipFile(io.BytesIO(cos.objects[cos.writes[0]])) as package:
        assert package.read("ffmpeg.source.tar.xz") == b"fixture corresponding source bytes"
        assert package.read("LICENSE-x264.txt") == b"fixture"
        assert package.getinfo("ffmpeg").external_attr >> 16 == 0o100755


@pytest.mark.parametrize("target", list(publisher.TARGETS))
def test_missing_probe_in_any_target_prevents_all_writes(artifacts, target):
    suffix = ".exe" if target == "win-x64" else ""
    (artifacts / f"media-{target}-verified" / ("ffprobe" + suffix)).unlink()
    cos = Cos()
    with pytest.raises(ValueError, match="missing"):
        publisher.publish(artifacts, cos, cos.read)
    assert cos.writes == []


@pytest.mark.parametrize("member,body,message", [
    ("ffmpeg", b"modified after smoke", "Binary changed"),
    ("ffmpeg.source.tar.xz", b"wrong corresponding source", "source changed"),
    ("ffmpeg-config.h", b"#define CONFIG_NONFREE 1\n", "nonfree"),
    ("BUILD_COMMIT", b"b" * 40, "one build commit"),
])
def test_corruption_or_mixed_build_prevents_publication(artifacts, member, body, message):
    (artifacts / "media-mac-arm64-verified" / member).write_bytes(body)
    cos = Cos()
    with pytest.raises(ValueError, match=message):
        publisher.publish(artifacts, cos, cos.read)
    assert cos.writes == []


def test_bad_hypit_integrity_does_not_publish_other_packages(artifacts):
    (artifacts / "hypit-win-x64-verified/hypit-0.2.17.tgz").write_bytes(b"truncated")
    cos = Cos()
    with pytest.raises(ValueError, match="npm integrity"):
        publisher.publish(artifacts, cos, cos.read)
    assert cos.writes == []


def test_failed_full_readback_does_not_advance_manifest(artifacts):
    cos = Cos()
    def corrupt_readback(key):
        size, checksum = cos.read(key)
        return size, "0" * len(checksum)
    with pytest.raises(ValueError, match="readback mismatch"):
        publisher.publish(artifacts, cos, corrupt_readback)
    assert len(cos.writes) == 1
    assert "media-tools/stable.json" not in cos.objects
