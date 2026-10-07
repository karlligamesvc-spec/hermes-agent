"""Manual CI transport diagnostic; never writes installer names or updater feeds."""
import argparse
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import urllib.request

BUCKET = 'apexnodes-runtime-202606250443-1300912302'
REGION = 'ap-guangzhou'
BASE = f'https://{BUCKET}.cos.{REGION}.myqcloud.com'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--platform', choices=['mac-arm64', 'mac-x64', 'win-x64'], required=True)
    parser.add_argument('--run-id', required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'[0-9]+', args.run_id):
        raise ValueError('diagnostic run ID must be numeric')
    from qcloud_cos import CosConfig, CosS3Client
    logging.getLogger('qcloud_cos').setLevel(logging.CRITICAL)
    client = CosS3Client(CosConfig(Region=REGION, SecretId=os.environ['COS_SECRET_ID'],
                                 SecretKey=os.environ['COS_SECRET_KEY'], Scheme='https',
                                 Timeout=30, AutoSwitchDomainOnRetry=True))
    name = f'hc906-network-probe-{args.run_id}.bin'
    key = f'desktop/{args.platform}/{name}'
    with tempfile.TemporaryDirectory(prefix='apex-cos-diagnostic-') as directory:
        local = Path(directory) / name
        local.write_bytes(bytes(range(256)) * (64 * 1024))
        expected = hashlib.sha256(local.read_bytes()).hexdigest()
        try:
            subprocess.run([sys.executable, str(Path(__file__).with_name('upload-desktop-cos.py')),
                            '--file', str(local), '--key', key], check=True)
            digest = hashlib.sha256()
            size = 0
            with urllib.request.urlopen(BASE + '/' + key, timeout=60) as response:
                for chunk in iter(lambda: response.read(1024 * 1024), b''):
                    digest.update(chunk)
                    size += len(chunk)
            if size != local.stat().st_size or digest.hexdigest() != expected:
                raise RuntimeError('anonymous diagnostic body does not match generated fixture')
        finally:
            # Own numeric nonce + exact platform key only. Never clean other
            # release objects, manifests, or incomplete installer uploads.
            client.delete_object(Bucket=BUCKET, Key=key)
            for upload in client.list_multipart_uploads(Bucket=BUCKET, Prefix=key).get('Upload', []):
                if upload['Key'] == key:
                    client.abort_multipart_upload(Bucket=BUCKET, Key=key, UploadId=upload['UploadId'])
    print(json.dumps({'platform': args.platform, 'bytes': size, 'sha256': expected,
                      'sourceCommit': os.environ.get('GITHUB_SHA'), 'probeObjectsRemoved': True,
                      'scope': 'GitHub runner generated16MiB transport diagnostic; no installers, feeds or runtime defaults'}))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'Desktop COS diagnostic failed: {type(exc).__name__}', file=sys.stderr)
        sys.exit(1)
