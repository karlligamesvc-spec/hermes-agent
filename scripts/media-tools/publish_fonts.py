"""Publish the pinned subtitle fonts (hc-1025) to APEX COS without changing any live feed.

The publisher downloads each font's official release archive (``upstream`` in desktop-lock.json)
into ``root`` first. Every font member must match the lock's size and SHA-256 before anything is
uploaded; each immutable object is then read back over public HTTPS and hashed again.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import logging
import os
from pathlib import Path
import tempfile
import urllib.request
import zipfile

BUCKET = 'apexnodes-runtime-202606250443-1300912302'


def _extract(root, item):
    archive = root / item['upstream'].rsplit('/', 1)[-1]
    with zipfile.ZipFile(archive) as bundle:
        members = [name for name in bundle.namelist() if name.rsplit('/', 1)[-1] == item['upstreamMember']]
        if len(members) != 1:
            raise ValueError(f'{archive.name} must hold exactly one {item["upstreamMember"]}')
        return bundle.read(members[0])


def publish(root, client):
    fonts = json.loads((root / 'desktop-lock.json').read_text(encoding='utf-8-sig'))['fonts']
    payloads = {}
    for name, item in fonts.items():
        payload = _extract(root, item)
        if len(payload) != item['bytes'] or hashlib.sha256(payload).hexdigest() != item['sha256']:
            raise ValueError(f'Upstream font differs from lock: {name}')
        payloads[name] = payload
    for name, item in fonts.items():
        key = item['url'].split('.myqcloud.com/', 1)[1]
        with tempfile.TemporaryDirectory() as temporary:
            local = Path(temporary) / item['file']
            local.write_bytes(payloads[name])
            client.upload_file(Bucket=BUCKET, Key=key, LocalFilePath=str(local), PartSize=8, MAXThread=4, EnableMD5=True)
        with urllib.request.urlopen(item['url'], timeout=180) as response:
            body = response.read()
        if len(body) != item['bytes'] or hashlib.sha256(body).hexdigest() != item['sha256']:
            raise ValueError(f'Font COS readback failed: {name}')
        print(f'Verified {name} font {item["family"]} {item["version"]}: {len(body)} bytes', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path, help='folder holding desktop-lock.json and the official release archives')
    args = parser.parse_args()
    logging.getLogger('qcloud_cos').setLevel(logging.CRITICAL)
    from qcloud_cos import CosConfig, CosS3Client
    client = CosS3Client(CosConfig(Region='ap-guangzhou', SecretId=os.environ['COS_SECRET_ID'],
                                  SecretKey=os.environ['COS_SECRET_KEY'], Scheme='https', Timeout=180))
    try:
        publish(args.root, client)
    except Exception as exc:  # health: allow BLE001 -- publisher boundary prints the type only, never a COS message that could carry credentials
        raise SystemExit(f'Font mirror publication failed: {type(exc).__name__}') from None
