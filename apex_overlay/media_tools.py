"""APEX's verified COS cache for the subtitle font (v2026.8.31 cloud hotfix, hc-1149).

hc-1025 on fork main: Agents burn captions only with 得意黑 Smiley Sans (OFL-1.1). System
fonts are not cleared for commercial use, so subtitles never rely on them. This hotfix brings
only main's ``font`` command to the cloud image line; main's browser and Hypit parts of this
module are Desktop-only and stay out. ``font`` prints the verified font file, and ffmpeg loads
it through ``subtitles=…:fontsdir=<its folder>``.

In the cloud, run it by file path: ``python3 /opt/hermes/apex_overlay/media_tools.py font``.
That works from any directory and with any Python 3.11+. ``python3 -m apex_overlay.media_tools``
does not work there outside /opt/hermes: the image installs the project editable with a finder
that maps only the packages pyproject lists, and ``apex_overlay`` is not one of them. The
terminal's ``python3`` may also be Debian's own rather than the Hermes venv's, so the font path
uses the standard library only (``fcntl`` instead of main's ``filelock``).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile
import time
import urllib.request
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / 'scripts/media-tools/desktop-lock.json'
COS_HOST = 'apexnodes-runtime-202606250443-1300912302.cos.ap-guangzhou.myqcloud.com'
LOCK_TIMEOUT_SECONDS = 600


@contextmanager
def _install_lock(path: Path, timeout: float):
    """One installer per cache at a time, across processes (main uses ``filelock`` here)."""
    import fcntl
    with path.open('ab') as handle:
        deadline = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError(f'another font install still holds {path}') from None
                time.sleep(0.2)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def ensure_font(name: str = 'subtitle') -> Path:
    """The licensed font ``name`` from desktop-lock, downloaded once from APEX COS and hash verified."""
    from hermes_constants import get_hermes_home
    from urllib.parse import urlsplit
    spec = json.loads(LOCK.read_text(encoding='utf-8-sig'))['fonts'][name]
    url = urlsplit(spec['url'])
    if url.scheme != 'https' or url.hostname != COS_HOST:
        raise ValueError('Font download must use APEX COS')
    cache = Path(get_hermes_home()) / 'tool-cache' / 'fonts'
    cache.mkdir(parents=True, exist_ok=True)
    destination = cache / spec['sha256'] / spec['file']
    with _install_lock(cache / 'install.lock', LOCK_TIMEOUT_SECONDS):
        if destination.is_file():
            with destination.open('rb') as cached:
                if hashlib.file_digest(cached, 'sha256').hexdigest() == spec['sha256']:
                    return destination
        with tempfile.TemporaryDirectory(prefix='install-', dir=cache) as temporary:
            download = Path(temporary) / spec['file']
            digest, size = hashlib.sha256(), 0
            with urllib.request.urlopen(spec['url'], timeout=120) as response, download.open('wb') as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
                    digest.update(chunk)
                    size += len(chunk)
            if size != spec['bytes'] or digest.hexdigest() != spec['sha256']:
                raise ValueError('COS font checksum mismatch')
            destination.parent.mkdir(exist_ok=True)
            os.replace(download, destination)
    return destination


if __name__ == '__main__':
    if str(ROOT) not in sys.path:
        # Run by file path: hermes_constants sits at the repository root, next to this package.
        sys.path.insert(0, str(ROOT))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['font'])
    parser.parse_args()
    try:
        print(ensure_font())
    except (OSError, ValueError, KeyError) as exc:  # the Agent relays this line instead of a traceback
        raise SystemExit(f'APEX subtitle font unavailable: {type(exc).__name__}: {exc}') from None
