"""Publish a fixed registry slice to COS with full byte readback for every object."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import logging
import os
from pathlib import Path
import urllib.error
import urllib.request

BUCKET = 'apexnodes-runtime-202606250443-1300912302'
BASE = f'https://{BUCKET}.cos.ap-guangzhou.myqcloud.com'


def publish(root, client):
    manifest = json.loads((root / 'mirror.json').read_text())
    prefix = manifest['prefix']
    if not prefix.startswith('media-tools/npm/') or len(prefix.rsplit('/', 1)[-1]) != 64:
        raise ValueError('Invalid immutable registry prefix')
    paths = [p for p in root.rglob('*') if p.is_file() and '.cache' not in p.parts]

    def upload(path):
        key = prefix + '/' + path.relative_to(root).as_posix()
        expected = hashlib.sha256(path.read_bytes()).digest()
        def readback():
            with urllib.request.urlopen(BASE + '/' + key, timeout=180) as response:
                digest = hashlib.sha256()
                while chunk := response.read(1024 * 1024):
                    digest.update(chunk)
                return digest.digest()
        try:
            actual = readback()
        except urllib.error.HTTPError as exc:
            if exc.code != 404:
                raise
            actual = None
        if actual is not None and actual != expected:
            raise ValueError('Immutable registry object conflict')
        if actual is None:
            client.upload_file(Bucket=BUCKET, Key=key, LocalFilePath=str(path),
                               PartSize=8, MAXThread=2, EnableMD5=True)
            if readback() != expected:
                raise ValueError('COS readback differs from prepared bytes')
        return key

    # Tarballs first. Registry metadata is made visible only after all payloads
    # are verified. No live stable.json or Desktop updater feed is changed.
    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(upload, [p for p in paths if 'tarballs' in p.parts]))
        list(pool.map(upload, [p for p in paths if 'tarballs' not in p.parts]))
    print(json.dumps({'verifiedObjects': len(paths), **manifest}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    args = parser.parse_args()
    logging.getLogger('qcloud_cos').setLevel(logging.CRITICAL)
    from qcloud_cos import CosConfig, CosS3Client
    client = CosS3Client(CosConfig(Region='ap-guangzhou', SecretId=os.environ['COS_SECRET_ID'],
                                  SecretKey=os.environ['COS_SECRET_KEY'], Scheme='https', Timeout=180))
    try:
        publish(args.root, client)
    except Exception as exc:
        raise SystemExit(f'Registry publication failed: {type(exc).__name__}') from None
