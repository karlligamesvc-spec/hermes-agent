"""Public, content-addressed copies of reviewed binary inputs."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re

from pm.downloader import Source
from pm.index_config import npm_registry_url

_LAYOUT = json.loads(Path(__file__).with_name("artifact-mirror.json").read_text(encoding="utf-8-sig"))
KEY_PREFIX = _LAYOUT["prefix"]
PUBLIC_PREFIX = _LAYOUT["origin"] + "/" + KEY_PREFIX


def object_key(sha256: str) -> str:
    if not isinstance(sha256, str) or not re.fullmatch(r"[a-f0-9]{64}", sha256):
        raise ValueError("A pinned input requires a full lowercase SHA256")
    return KEY_PREFIX + sha256


def mirror_url(sha256: str) -> str:
    object_key(sha256)
    return PUBLIC_PREFIX + sha256


def apexnodes_cn_mirror_url(sha256: str) -> str | None:
    """ApexNodes overlay seam: the mainland COS copy of one content-addressed object.

    Only in CN mode (``HERMES_CN_MIRRORS=1``, set by scripts/lib/apexnodes-region-detect)
    with an HTTPS ``HERMES_RUNTIME_COS_BASE``. The COS bucket mirrors the same
    ``<prefix><sha256>`` layout as the public mirror, so the pinned digest still verifies
    whatever host served the bytes; ``None`` keeps upstream behaviour unchanged.
    """
    if os.environ.get("HERMES_CN_MIRRORS") != "1":
        return None
    base = os.environ.get("HERMES_RUNTIME_COS_BASE", "").strip().rstrip("/")
    if not base.startswith("https://"):
        return None
    return f"{base}/{object_key(sha256)}"


def pinned_source(url: str, dest: Path, sha256: str) -> Source:
    archive = mirror_url(sha256)
    # The lock records registry.npmjs.org; a user's npm mirror serves the same pinned bytes (#123132).
    url = npm_registry_url(url, os.environ)
    cn = apexnodes_cn_mirror_url(sha256)
    if cn is not None:
        # Mainland first (github.com / overseas CDNs are blocked or slow there), then the
        # original URL and the public mirror -- every candidate checks the same sha256.
        return Source(cn, dest, sha256, fallbacks=tuple(dict.fromkeys(u for u in (url, archive) if u != cn)))
    return Source(url, dest, sha256, fallbacks=() if url == archive else (archive,))
