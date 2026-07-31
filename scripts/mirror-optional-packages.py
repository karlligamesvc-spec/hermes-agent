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
    must_contain lists the files whose presence makes the archive worth serving;
    when `repack` is set, the published zip is trimmed to exactly those files.
    """

    object_name: str
    source_url: str
    must_contain: tuple[str, ...]
    repack: bool = False


ARTIFACTS = [
    # ripgrep ships 1.7MB total -- nothing to trim, so it is mirrored verbatim.
    Artifact(
        "ripgrep-x86_64-pc-windows-msvc.zip",
        f"https://github.com/BurntSushi/ripgrep/releases/download/{RIPGREP_VERSION}"
        f"/ripgrep-{RIPGREP_VERSION}-x86_64-pc-windows-msvc.zip",
        ("rg.exe",),
    ),
    Artifact(
        "ripgrep-aarch64-pc-windows-msvc.zip",
        f"https://github.com/BurntSushi/ripgrep/releases/download/{RIPGREP_VERSION}"
        f"/ripgrep-{RIPGREP_VERSION}-aarch64-pc-windows-msvc.zip",
        ("rg.exe",),
    ),
    # gyan.dev publishes x64 only. Windows-on-ARM runs it under x64 emulation,
    # which is also exactly what `winget install Gyan.FFmpeg` lands there, so
    # the COS path and the fallback path agree on that machine too.
    #
    # REPACKED, and this one earns it. The upstream "essentials" build is 104.6MB
    # compressed / 303.8MB expanded, and a third of that is ffplay.exe (34.6MB /
    # 98.6MB) -- a media PLAYER we never invoke -- plus ~10MB of HTML docs. Both
    # halves of that matter here: the download, and Expand-Archive, which on
    # Windows PowerShell 5.1 is slow enough that 300MB is felt. This whole ticket
    # exists because the prerequisites stage stalled, so shipping 110MB we never
    # read would be answering the complaint with a smaller version of itself.
    # Trimmed to the two binaries we actually shell out to.
    Artifact(
        "ffmpeg-x86_64-pc-windows-msvc.zip",
        f"https://github.com/GyanD/codexffmpeg/releases/download/{FFMPEG_VERSION}"
        f"/ffmpeg-{FFMPEG_VERSION}-essentials_build.zip",
        ("ffmpeg.exe", "ffprobe.exe"),
        repack=True,
    ),
]


def verify(blob: bytes, must_contain: tuple[str, ...] | str) -> list[str]:
    """Return the paths of every `must_contain` entry in the archive, or raise.

    Every required name must be present: a half-populated archive is exactly
    the failure this gate exists to stop.
    """
    wanted = (must_contain,) if isinstance(must_contain, str) else must_contain
    archive = zipfile.ZipFile(io.BytesIO(blob))
    bad = archive.testzip()
    if bad is not None:
        raise ValueError(f"CRC check failed on {bad}")

    found = []
    for name in wanted:
        hits = [n for n in archive.namelist() if n.rsplit("/", 1)[-1] == name]
        if not hits:
            raise ValueError(f"{name} is not in the archive")
        found.append(hits[0])
    return found


def repack(blob: bytes, keep: tuple[str, ...]) -> bytes:
    """Rebuild the archive with only `keep`, flattened to the zip root.

    Flattened because the consumer finds binaries with a recursive filter, so
    the directory prefix carries no information -- and a flat archive makes what
    we publish self-evident.
    """
    source = zipfile.ZipFile(io.BytesIO(blob))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as dest:
        for name in keep:
            member = next(n for n in source.namelist() if n.rsplit("/", 1)[-1] == name)
            dest.writestr(name, source.read(member))
    return out.getvalue()


def check_live() -> int:
    """Verify every published object is complete and holds the right binary."""
    failures = 0
    for art in ARTIFACTS:
        url = f"{PUBLIC_BASE}/{art.object_name}"
        try:
            with urllib.request.urlopen(url, timeout=300) as resp:
                blob = resp.read()
            members = verify(blob, art.must_contain)
        except (urllib.error.URLError, ValueError, zipfile.BadZipFile) as exc:
            print(f"FAIL {art.object_name}: {exc}")
            failures += 1
            continue
        expanded = sum(i.file_size for i in zipfile.ZipFile(io.BytesIO(blob)).infolist())
        print(
            f"ok   {art.object_name}  {len(blob) / 1048576:.1f}MB download / "
            f"{expanded / 1048576:.1f}MB expanded  {', '.join(members)}"
        )
    return 1 if failures else 0


def prepare(blob: bytes, art: Artifact, *, log=print) -> bytes:
    """Turn a freshly downloaded archive into the bytes we are willing to publish.

    Separate from publish() so it is reachable from a test. Inside publish() this
    logic sat behind a network call and COS credentials, which meant the
    re-verify below -- a line that only matters when something has gone wrong --
    could not be exercised at all. That is the shape AGENTS.md #14 warns about:
    a check the verifier is structurally unable to reach is not a check.

    Raises on anything that must not be uploaded.
    """
    # Verify BEFORE repacking. repack() reads members out of this same archive,
    # so a corrupt download has to be caught here, not inferred from whatever
    # the repack happened to produce.
    members = verify(blob, art.must_contain)
    log(f"   integrity ok, contains {', '.join(members)}")
    if not art.repack:
        return blob

    original = len(blob)
    trimmed = repack(blob, art.must_contain)
    # Re-verify what we are ACTUALLY publishing: the archive we checked above is
    # no longer the archive we ship.
    verify(trimmed, art.must_contain)
    log(f"   repacked {original / 1048576:.1f}MB -> {len(trimmed) / 1048576:.1f}MB")
    return trimmed


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
        # Record the UPSTREAM digest even when we repack: it is the provenance
        # anchor for whatever ends up on COS.
        digest = hashlib.sha256(blob).hexdigest()
        print(f"   fetched {len(blob) / 1048576:.1f}MB  upstream sha256={digest}")
        try:
            blob = prepare(blob, art)
        except (ValueError, zipfile.BadZipFile, StopIteration) as exc:
            print(f"   REFUSING TO UPLOAD: {exc}", file=sys.stderr)
            return 1
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
