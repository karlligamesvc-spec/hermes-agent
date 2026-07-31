#!/usr/bin/env python3
"""Mirror the optional Windows CLI tools (ripgrep, ffmpeg) onto our own COS.

WHY (hc-632). 2026-07-31, a real first install on a mainland-China Windows box
stalled 18+ minutes on the "prerequisites" stage. Every *mandatory* download in
the chain already had a China route -- uv/git/runtime from COS, PyPI from TUNA,
CPython/Node/npm/Electron/Playwright from npmmirror -- and finished in ~17s
total. The stall was `winget install --source winget` fetching ripgrep and
ffmpeg: the only downloads left in the whole install with no China mirror.

The fix is not to time-box the stall, it is to remove it: mirror the exact
upstream artifacts and install from our own bucket, so a CN install gets the
same *complete* result as everyone else. This script is the publisher for those
objects; scripts/lib/apexnodes-region-detect.ps1 (Install-OptionalPkgFromCos)
is the consumer.

Integrity is gated here, not at install time: a zip that fails CRC or does not
contain the expected .exe is never uploaded. A truncated archive on COS would
be strictly worse than no archive -- the installer would download it, fail to
expand it, and fall back anyway, having burned the user's bandwidth first.
(That is not hypothetical: the first attempt to fetch ffmpeg for this mirror
came back at 1.1MB of a 105MB file through a proxy, and looked fine until the
zip was actually opened.)

Usage
-----
    # verify the live objects match the pinned versions, upload nothing
    python scripts/mirror-optional-packages.py --check

    # (re)publish -- needs COS creds in the environment
    python scripts/mirror-optional-packages.py

Run it from a host with unrestricted access to github.com. Bumping a pinned
version below and re-running is the whole upgrade procedure.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import os
import sys
import urllib.error
import urllib.request
import zipfile
from dataclasses import dataclass

BUCKET = "apexnodes-runtime-202606250443-1300912302"
REGION = "ap-guangzhou"
PREFIX = "runtime"
PUBLIC_BASE = f"https://{BUCKET}.cos.{REGION}.myqcloud.com/{PREFIX}"

# Pinned upstream versions. Keep these in step with the package ids in
# install.ps1's Install-SystemPackages (BurntSushi.ripgrep.MSVC / Gyan.FFmpeg):
# the fallback package managers must not install something newer than what a
# COS-served install gets, or the two paths silently diverge.
RIPGREP_VERSION = "15.2.0"
FFMPEG_VERSION = "8.1.2"


@dataclass(frozen=True)
class Artifact:
    """One mirrored object.

    object_name is what Install-OptionalPkgFromCos builds its URL from, so it
    must stay `<package>-<triple>.zip` -- the same convention as uv-<triple>.zip.
    must_contain is the file whose presence makes the archive worth serving.
    """

    object_name: str
    source_url: str
    must_contain: str


ARTIFACTS = [
    Artifact(
        "ripgrep-x86_64-pc-windows-msvc.zip",
        f"https://github.com/BurntSushi/ripgrep/releases/download/{RIPGREP_VERSION}"
        f"/ripgrep-{RIPGREP_VERSION}-x86_64-pc-windows-msvc.zip",
        "rg.exe",
    ),
    Artifact(
        "ripgrep-aarch64-pc-windows-msvc.zip",
        f"https://github.com/BurntSushi/ripgrep/releases/download/{RIPGREP_VERSION}"
        f"/ripgrep-{RIPGREP_VERSION}-aarch64-pc-windows-msvc.zip",
        "rg.exe",
    ),
    # gyan.dev publishes x64 only. Windows-on-ARM runs it under x64 emulation,
    # which is also exactly what `winget install Gyan.FFmpeg` lands there, so
    # the COS path and the fallback path agree on that machine too.
    Artifact(
        "ffmpeg-x86_64-pc-windows-msvc.zip",
        f"https://github.com/GyanD/codexffmpeg/releases/download/{FFMPEG_VERSION}"
        f"/ffmpeg-{FFMPEG_VERSION}-essentials_build.zip",
        "ffmpeg.exe",
    ),
]


def verify(blob: bytes, must_contain: str) -> str:
    """Return the path of `must_contain` inside the archive, or raise."""
    archive = zipfile.ZipFile(io.BytesIO(blob))
    bad = archive.testzip()
    if bad is not None:
        raise ValueError(f"CRC check failed on {bad}")
    hits = [n for n in archive.namelist() if n.rsplit("/", 1)[-1] == must_contain]
    if not hits:
        raise ValueError(f"{must_contain} is not in the archive")
    return hits[0]


def check_live() -> int:
    """Verify every published object is complete and holds the right binary."""
    failures = 0
    for art in ARTIFACTS:
        url = f"{PUBLIC_BASE}/{art.object_name}"
        try:
            with urllib.request.urlopen(url, timeout=300) as resp:
                blob = resp.read()
            member = verify(blob, art.must_contain)
        except (urllib.error.URLError, ValueError, zipfile.BadZipFile) as exc:
            print(f"FAIL {art.object_name}: {exc}")
            failures += 1
            continue
        print(f"ok   {art.object_name}  {len(blob) / 1048576:.1f}MB  {member}")
    return 1 if failures else 0


def publish() -> int:
    from qcloud_cos import CosConfig, CosS3Client  # noqa: PLC0415 -- check mode needs no SDK

    secret_id = os.getenv("COS_SECRET_ID") or os.getenv("TENCENTCLOUD_SECRET_ID")
    secret_key = os.getenv("COS_SECRET_KEY") or os.getenv("TENCENTCLOUD_SECRET_KEY")
    if not (secret_id and secret_key):
        print("COS credentials missing (COS_SECRET_ID / COS_SECRET_KEY)", file=sys.stderr)
        return 2
    client = CosS3Client(CosConfig(Region=REGION, SecretId=secret_id, SecretKey=secret_key))

    for art in ARTIFACTS:
        print(f"-> {art.object_name}")
        with urllib.request.urlopen(art.source_url, timeout=600) as resp:
            blob = resp.read()
        digest = hashlib.sha256(blob).hexdigest()
        print(f"   fetched {len(blob) / 1048576:.1f}MB  sha256={digest}")
        try:
            member = verify(blob, art.must_contain)
        except (ValueError, zipfile.BadZipFile) as exc:
            print(f"   REFUSING TO UPLOAD: {exc}", file=sys.stderr)
            return 1
        print(f"   integrity ok, contains {member}")
        client.put_object(Bucket=BUCKET, Key=f"{PREFIX}/{art.object_name}", Body=blob)
        print(f"   uploaded {PREFIX}/{art.object_name}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify the live COS objects and exit; uploads nothing, needs no credentials",
    )
    args = parser.parse_args()
    return check_live() if args.check else publish()


if __name__ == "__main__":
    sys.exit(main())
