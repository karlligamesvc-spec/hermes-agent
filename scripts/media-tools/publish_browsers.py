"""Publish the pinned upstream Chrome archives without changing any live feed."""
from __future__ import annotations
import argparse
import hashlib
import json
import logging
import os
from pathlib import Path
import urllib.request

BUCKET = 'apexnodes-runtime-202606250443-1300912302'


def publish(root, client):
    packages = json.loads((root / 'desktop-lock.json').read_text())['browser']
    for target, item in packages.items():
        archive = root / item['url'].rsplit('/', 1)[-1]
        with archive.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        if digest != item['sha256'] or archive.stat().st_size != item['bytes']:
            raise ValueError(f'Upstream archive differs from lock: {target}')
    for target, item in packages.items():
        archive = root / item['url'].rsplit('/', 1)[-1]
        key = item['url'].split('.myqcloud.com/', 1)[1]
        client.upload_file(Bucket=BUCKET, Key=key, LocalFilePath=str(archive),
                           PartSize=8, MAXThread=4, EnableMD5=True)
        with urllib.request.urlopen(item['url'], timeout=180) as response:
            digest, size = hashlib.sha256(), 0
            while chunk := response.read(1024 * 1024):
                digest.update(chunk)
                size += len(chunk)
        if size != item['bytes'] or digest.hexdigest() != item['sha256']:
            raise ValueError(f'Browser COS readback failed: {target}')
        print(f'Verified {target} browser {item["version"]}: {size} bytes', flush=True)


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
        raise SystemExit(f'Browser mirror publication failed: {type(exc).__name__}') from None
