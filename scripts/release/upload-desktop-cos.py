"""Upload one owned Desktop release file with bounded parallel COS parts.

Mac and Windows workflows keep their binary-before-feed ordering and use this
same uploader. Supplier credentials stay in the workflow environment.
"""
from __future__ import annotations

import argparse
import hashlib
import logging
import os
from pathlib import Path
import re
import sys
import urllib.request

BUCKET = 'apexnodes-runtime-202606250443-1300912302'
REGION = 'ap-guangzhou'
BASE = f'https://{BUCKET}.cos.{REGION}.myqcloud.com'


def upload_and_verify(local: Path, key: str, client) -> dict:
    if not re.fullmatch(r'desktop/(?:mac-arm64|mac-x64|win-x64)/[A-Za-z0-9_.-]+', key):
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
    client.upload_file(
        Bucket=BUCKET, Key=key, LocalFilePath=str(local),
        PartSize=8, MAXThread=16, EnableMD5=True,
        Metadata={'sha256': sha256},
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

    logging.getLogger('qcloud_cos').setLevel(logging.WARNING)
    client = CosS3Client(CosConfig(Region=REGION, SecretId=identity, SecretKey=secret, Scheme='https', Timeout=60))
    print(upload_and_verify(args.file, args.key, client), flush=True)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as exc:
        # SDK exception details can contain signed request headers. CI needs
        # the failure class, never credential-bearing diagnostic data.
        print(f'Desktop COS publish failed: {type(exc).__name__}', file=sys.stderr)
        sys.exit(1)
