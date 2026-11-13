"""Publish the pinned fonts (hc-1025 subtitle, hc-1224 title) to APEX COS without changing any live feed.

The publisher downloads each font's official release archive (``upstream`` in desktop-lock.json)
into ``root`` first. Every font member, and the license file pinned beside it (``licenseFile``,
from the same archive), must match the lock's size and SHA-256 before anything is uploaded; each
immutable object is then read back over public HTTPS and hashed again. ``--only NAME`` publishes
just that font, so ``root`` needs only its archive.
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
HOST = f'{BUCKET}.cos.ap-guangzhou.myqcloud.com'


def _extract(root, upstream, member):
    archive = root / upstream.rsplit('/', 1)[-1]
    with zipfile.ZipFile(archive) as bundle:
        members = [name for name in bundle.namelist() if name.rsplit('/', 1)[-1] == member]
        if len(members) != 1:
            raise ValueError(f'{archive.name} must hold exactly one {member}')
        return bundle.read(members[0])


def publish(root, client, only=None):
    fonts = json.loads((root / 'desktop-lock.json').read_text(encoding='utf-8-sig'))['fonts']
    unknown = sorted(set(only or ()) - set(fonts))
    if unknown:
        raise ValueError(f'Not a pinned font: {", ".join(unknown)}')
    objects = []
    for name in dict.fromkeys(only or fonts):
        item = fonts[name]
        # The license goes up first: a font is never on COS without its OFL text.
        for record in [item['licenseFile'], item] if 'licenseFile' in item else [item]:
            if not record['url'].startswith(f'https://{HOST}/'):
                raise ValueError(f'Font URL must be on APEX COS: {name} {record["file"]}')
            payload = _extract(root, item['upstream'], record['upstreamMember'])
            if len(payload) != record['bytes'] or hashlib.sha256(payload).hexdigest() != record['sha256']:
                raise ValueError(f'Upstream font differs from lock: {name} {record["file"]}')
            objects.append((name, record, payload))
    for name, record, payload in objects:
        key = record['url'].split('.myqcloud.com/', 1)[1]
        with tempfile.TemporaryDirectory() as temporary:
            local = Path(temporary) / record['file']
            local.write_bytes(payload)
            client.upload_file(Bucket=BUCKET, Key=key, LocalFilePath=str(local), PartSize=8, MAXThread=4, EnableMD5=True)
        with urllib.request.urlopen(record['url'], timeout=180) as response:
            body = response.read()
        if len(body) != record['bytes'] or hashlib.sha256(body).hexdigest() != record['sha256']:
            raise ValueError(f'Font COS readback failed: {name} {record["file"]}')
        font = fonts[name]
        print(f'Verified {name} font {font["family"]} {font["version"]} {record["file"]}: {len(body)} bytes', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path, help='folder holding desktop-lock.json and the official release archives')
    parser.add_argument('--only', action='append', metavar='NAME',
                        help='publish only this pinned font (subtitle, title); repeat for more')
    args = parser.parse_args()
    logging.getLogger('qcloud_cos').setLevel(logging.CRITICAL)
    from qcloud_cos import CosConfig, CosS3Client
    client = CosS3Client(CosConfig(Region='ap-guangzhou', SecretId=os.environ['COS_SECRET_ID'],
                                  SecretKey=os.environ['COS_SECRET_KEY'], Scheme='https', Timeout=180))
    try:
        publish(args.root, client, args.only)
    except Exception as exc:  # health: allow BLE001 -- publisher boundary prints the type only, never a COS message that could carry credentials
        raise SystemExit(f'Font mirror publication failed: {type(exc).__name__}') from None
