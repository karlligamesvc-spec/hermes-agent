"""Upload one owned Desktop release file with bounded parallel COS parts.

Mac and Windows workflows keep their binary-before-feed ordering and use this
same uploader. Only the Mac arm64 feed is published now: Windows x64 is paused
after 0.17.66 (see upload_and_verify). Supplier credentials stay in the workflow
environment.
"""
from __future__ import annotations

import argparse
import hashlib
import logging
import math
import os
from pathlib import Path
import re
import sys
import subprocess
import urllib.error
import urllib.request

BUCKET = 'apexnodes-runtime-202606250443-1300912302'
REGION = 'ap-guangzhou'
BASE = f'https://{BUCKET}.cos.{REGION}.myqcloud.com'
BACKUP_DOMAIN = f'{BUCKET}.cos.{REGION}.tencentcos.cn'

WORKER_SECONDS = 600
DEFAULT_WORKERS = 3
# Opt-in for callers with no outer bound of their own (the Mac publish step). The hosted
# macOS runners publish from the US: on 2026-10-17 a 630 MB DMG moved at about 0.22 MB/s
# and three 600 s workers reached only 335 MB. Budget a 128 KiB/s floor, as the Windows
# wrapper already does, capped at 90 minutes per file so a DMG plus zip still fits the
# 240-minute Mac job. Windows keeps the default: its outer Stop-Process ends only this
# parent, so a longer inner budget there would leave a worker uploading behind the retry.
BUDGET_FROM_SIZE = '--budget-from-size'
BUDGET_RATE_FLOOR = 128 * 1024
BUDGET_OVERHEAD_SECONDS = 600
BUDGET_CAP_SECONDS = 90 * 60


def size_budget_workers(local: Path) -> int:
    try:
        size = local.stat().st_size
    except OSError:
        return DEFAULT_WORKERS  # the worker reports the missing file itself
    budget = min(BUDGET_CAP_SECONDS, size / BUDGET_RATE_FLOOR + BUDGET_OVERHEAD_SECONDS)
    return max(DEFAULT_WORKERS, math.ceil(budget / WORKER_SECONDS))


def upload_and_verify(local: Path, key: str, client) -> dict:
    # desktop/mac-x64/ and desktop/win-x64/ are left out on purpose: Intel is no longer
    # built and Windows is paused. Installed shells keep polling those feeds, which must
    # stay at 0.17.63 (Intel) and 0.17.66 (Windows).
    if not re.fullmatch(r'desktop/mac-arm64/[A-Za-z0-9_.-]+', key):
        raise ValueError('invalid Desktop object key')
    if not local.is_file() or local.is_symlink() or local.stat().st_size == 0:
        raise ValueError('missing or empty release file')
    if local.name != key.rsplit('/', 1)[1]:
        raise ValueError('release filename does not match object key')
    size = local.stat().st_size
    digest = hashlib.sha256()
    with local.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    sha256 = digest.hexdigest()
    reported = 0
    def report_progress(finished, total):
        nonlocal reported
        if finished == total or finished - reported >= 64 * 1024 * 1024:
            reported = finished
            print(f'Desktop COS progress: {key} {finished}/{total} bytes', flush=True)
    client.upload_file(
        Bucket=BUCKET, Key=key, LocalFilePath=str(local),
        PartSize=1, MAXThread=8, EnableMD5=True,
        Metadata={'sha256': sha256},
        progress_callback=report_progress,
    )
    with urllib.request.urlopen(urllib.request.Request(BASE + '/' + key, method='HEAD'), timeout=60) as response:
        if response.status != 200 or int(response.headers.get('Content-Length', '-1')) != size:
            raise RuntimeError('uploaded release file is not publicly served at its exact size')
    return {'object': key, 'bytes': size, 'sha256': sha256, 'publicHeadVerified': True}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--file', type=Path, required=True)
    parser.add_argument('--key', required=True)
    args = parser.parse_args()
    identity = os.environ.get('COS_SECRET_ID', '')
    secret = os.environ.get('COS_SECRET_KEY', '')
    if not identity or not secret:
        raise ValueError('COS workflow credentials are missing')
    from qcloud_cos import CosConfig, CosS3Client
    from qcloud_cos.cos_exception import CosClientError

    # SDK exception logging may include signed headers. Keep diagnostics below
    # limited to classes and the owned object key.
    logging.getLogger('qcloud_cos').setLevel(logging.CRITICAL)
    # Bucket acceleration was enabled on 2026-10-26. Hosted runners enter COS
    # near their region; public verification still uses the consumer's BASE URL.
    # Each worker keeps the existing bounded multipart retries.
    for attempt in range(1, 3):
        client = CosS3Client(CosConfig(
            Region=REGION, SecretId=identity, SecretKey=secret,
            Endpoint='cos.accelerate.myqcloud.com',
            Scheme='https', Timeout=60,
            AutoSwitchDomainOnRetry=True,
        ))
        try:
            result = upload_and_verify(args.file, args.key, client)
        except CosClientError:
            if attempt == 2:
                raise
            # The SDK verifies matching local part hashes before resuming an
            # incomplete multipart upload. Service/auth errors do not retry.
            print(f'Desktop COS transport failed; resuming verified multipart state: {args.key}', flush=True)
            continue
        print(result, flush=True)
        return 0
    return 1


def run_bounded_upload(argv: list[str]) -> int:
    # A dead multipart batch otherwise processes every queued part before the
    # SDK returns. Kill only this owned child; completed server parts survive
    # and the next worker verifies their hashes before resuming the same file.
    # A real 543 MB installer made steady progress but reached only 402 MB in
    # the old 3 x 180s budget. By default keep three bounded workers, allowing up
    # to 30 minutes per file; --budget-from-size scales the worker count with the
    # file. Public size verification still gates feed publication.
    worker_argv = [arg for arg in argv if arg != BUDGET_FROM_SIZE]
    workers = DEFAULT_WORKERS
    if BUDGET_FROM_SIZE in argv and '--file' in worker_argv[:-1]:
        workers = size_budget_workers(Path(worker_argv[worker_argv.index('--file') + 1]))
    for attempt in range(1, workers + 1):
        try:
            result = subprocess.run(
                [sys.executable, str(Path(__file__).resolve()), '--transfer-worker', *worker_argv],
                timeout=WORKER_SECONDS, check=False,
            )
        except subprocess.TimeoutExpired:
            print(f'Desktop COS worker timed out; preserving resumable parts ({attempt}/{workers})', flush=True)
            continue
        if result.returncode != 75:
            return result.returncode
    return 75


if __name__ == '__main__':
    if '--transfer-worker' not in sys.argv:
        sys.exit(run_bounded_upload(sys.argv[1:]))
    sys.argv.remove('--transfer-worker')
    try:
        sys.exit(main())
    except Exception as exc:
        # SDK exception details can contain signed request headers. CI needs
        # the failure class, never credential-bearing diagnostic data.
        print(f'Desktop COS publish failed: {type(exc).__name__}', file=sys.stderr)
        try:
            from qcloud_cos.cos_exception import CosClientError
            transient = isinstance(exc, CosClientError)
        except ImportError:
            transient = False
        transient |= isinstance(exc, urllib.error.URLError) and not isinstance(exc, urllib.error.HTTPError)
        sys.exit(75 if transient else 1)
