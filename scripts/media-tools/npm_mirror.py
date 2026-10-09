"""Prepare an immutable, integrity-checked npm registry slice for Hypit."""
from __future__ import annotations

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import subprocess
import urllib.parse

COS = 'https://apexnodes-runtime-202606250443-1300912302.cos.ap-guangzhou.myqcloud.com'
LOCK = Path(__file__).with_name('hypit-runtime') / 'package-lock.json'


def fetch(url: str, target: Path) -> bytes:
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(target.suffix + '.part')
        subprocess.run(['curl', '--fail', '--silent', '--show-error', '--location',
                        '--retry', '3', '--connect-timeout', '20', '--max-time', '180',
                        '--output', str(temporary), url], check=True)
        temporary.replace(target)
    return target.read_bytes()


def prepare(output: Path) -> None:
    lock_bytes = LOCK.read_bytes()
    lock = json.loads(lock_bytes)
    prefix = 'media-tools/npm/' + hashlib.sha256(lock_bytes).hexdigest()
    packages = {}
    for location, item in lock['packages'].items():
        if location:
            packages[(location.rsplit('node_modules/', 1)[1], item['version'])] = item

    def package(entry):
        (name, version), item = entry
        url, integrity = item['resolved'], item['integrity']
        if urllib.parse.urlparse(url).hostname != 'registry.npmjs.org':
            raise ValueError(f'Unapproved package source for {name}')
        cache_key = hashlib.sha256(url.encode()).hexdigest()
        payload = fetch(url, output / '.cache' / (cache_key + '.tgz'))
        algorithm, encoded = integrity.split('-', 1)
        if base64.b64encode(hashlib.new(algorithm, payload).digest()).decode() != encoded:
            raise ValueError(f'Integrity mismatch for {name}')
        relative = f'tarballs/{hashlib.sha256(payload).hexdigest()}.tgz'
        target = output / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)
        metadata = json.loads(fetch(
            f'https://registry.npmjs.org/{urllib.parse.quote(name, safe="")}/{version}',
            output / '.cache' / (cache_key + '.json')))
        if metadata['name'] != name or metadata['version'] != version or metadata['dist']['integrity'] != integrity:
            raise ValueError(f'Metadata identity mismatch for {name}')
        metadata['dist']['tarball'] = f'{COS}/{prefix}/{relative}'
        return name, version, metadata

    records = {}
    with ThreadPoolExecutor(max_workers=6) as pool:
        for name, version, metadata in pool.map(package, packages.items()):
            records.setdefault(name, {})[version] = metadata
    for name, versions in records.items():
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        # Top-level consumers always install exact locked versions. No misleading
        # latest tag: this is a closed dependency slice, not the public registry.
        target.write_text(json.dumps({'name': name, 'versions': versions}) + '\n')
    (output / 'mirror.json').write_text(json.dumps({
        'prefix': prefix, 'registry': f'{COS}/{prefix}',
        'lockSha256': hashlib.sha256(lock_bytes).hexdigest(),
        'versions': len(packages), 'packages': len(records),
    }, indent=2) + '\n')
    print(f'Prepared {len(packages)} npm versions across {len(records)} packages', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    prepare(parser.parse_args().output)
