"""Publish APEX's OpenFilm toolkit (hc-1176) to APEX COS without changing any live feed.

``archive`` is the openfilm-toolkit.tgz that ``build_toolkit.py`` left. Nothing is uploaded unless its size and
SHA-256 equal desktop-lock.json's ``openfilm`` entry; the immutable object is then read back over public HTTPS and
hashed again. Load COS credentials through the existing server environment (COS_SECRET_ID / COS_SECRET_KEY).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
from pathlib import Path
import urllib.request

BUCKET = 'apexnodes-runtime-202606250443-1300912302'
HOST = f'{BUCKET}.cos.ap-guangzhou.myqcloud.com'
LOCK = Path(__file__).resolve().parent.parent / 'desktop-lock.json'


def publish(archive: Path, client, lock_path: Path = LOCK) -> str:
    item = json.loads(lock_path.read_text(encoding='utf-8-sig'))['openfilm']
    prefix = f'https://{HOST}/'
    if not item['url'].startswith(prefix):
        raise ValueError('The toolkit URL must be on APEX COS')
    data = archive.read_bytes()
    if len(data) != item['bytes'] or hashlib.sha256(data).hexdigest() != item['sha256']:
        raise ValueError('The archive differs from desktop-lock.json; build it again or update the lock')
    key = item['url'][len(prefix):]
    client.upload_file(Bucket=BUCKET, Key=key, LocalFilePath=str(archive), PartSize=8, MAXThread=4, EnableMD5=True)
    digest, size = hashlib.sha256(), 0
    with urllib.request.urlopen(item['url'], timeout=300) as response:
        while chunk := response.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
    if size != item['bytes'] or digest.hexdigest() != item['sha256']:
        raise ValueError('The toolkit read back from COS differs from desktop-lock.json')
    print(f'Verified OpenFilm toolkit {item["version"]} ({", ".join(item["patches"])}): {size} bytes', flush=True)
    return key


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path, help='openfilm-toolkit.tgz from build_toolkit.py')
    args = parser.parse_args()
    logging.getLogger('qcloud_cos').setLevel(logging.CRITICAL)
    from qcloud_cos import CosConfig, CosS3Client
    client = CosS3Client(CosConfig(Region='ap-guangzhou', SecretId=os.environ['COS_SECRET_ID'],
                                  SecretKey=os.environ['COS_SECRET_KEY'], Scheme='https', Timeout=300))
    try:
        publish(args.archive, client)
    except Exception as exc:  # health: allow BLE001 -- publisher boundary prints the type only, never a COS message that could carry credentials
        raise SystemExit(f'OpenFilm toolkit publication failed: {type(exc).__name__}') from None
