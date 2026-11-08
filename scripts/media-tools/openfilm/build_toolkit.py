"""Build APEX's OpenFilm toolkit (hc-1176) as one reproducible archive.

The toolkit is the pinned openfilm package with this folder's patches applied, beside its pinned dependencies
(pin.json), and APEX's editor (``apex-editor/``, hc-1188: Studio's editor built from the pinned source with
``editor/*.patch``), plus ``apex-toolkit.json`` naming what went in. ``verify.mjs`` runs first (pins, patches, guards,
reverse checks, upstream tests, the editor's build and guards), and the archive holds exactly the files it verified. The same inputs always give the same
bytes (entries sorted, no times or owners, gzip without a timestamp), so the archive's SHA-256 in desktop-lock.json
names them; a change to a pin or a patch changes it.

    python build_toolkit.py <empty work folder>          builds it and prints its desktop-lock.json entry
    python build_toolkit.py --check <empty work folder>  also fails unless it equals desktop-lock.json's entry
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile

HERE = Path(__file__).resolve().parent
LOCK = HERE.parent / 'desktop-lock.json'
COS = 'https://apexnodes-runtime-202606250443-1300912302.cos.ap-guangzhou.myqcloud.com'
ARCHIVE = 'openfilm-toolkit.tgz'
# APEX's editor in the toolkit (hc-1188): Desktop has Studio serve it when it is there (electron/openfilm-studio.ts)
EDITOR = 'apex-editor'


def _patches(paths: list[str]) -> list[dict]:
    return [{'file': Path(p).name, 'sha256': hashlib.sha256((HERE / p).read_bytes()).hexdigest()} for p in paths]


def _manifest(pin: dict) -> dict:
    return {
        'schema': 1,
        'openfilm': pin['package']['version'],
        'patches': _patches(pin['patches']),
        'dependencies': {name: dep['version'] for name, dep in sorted(pin['dependencies'].items())},
        'editor': {'dir': EDITOR, 'patches': _patches(pin['editor']['patches'])},
    }


def _entries(work: Path, pin: dict) -> list[tuple[str, Path]]:
    """Each archive path and the verified file or folder it comes from, sorted."""
    trees = {'node_modules/openfilm': (work / 'npm' / 'package', 'package.json')}
    trees.update({f'node_modules/{name}': (work / 'npm' / 'node_modules' / name, 'package.json') for name in pin['dependencies']})
    trees[EDITOR] = (work / 'editor' / EDITOR, 'index.html')
    out = [('node_modules', None)]
    for prefix, (root, marker) in trees.items():
        if not (root / marker).is_file():
            raise SystemExit(f'verify.mjs left no {marker} at {root}')
        out.append((prefix, root))
        for path in root.rglob('*'):
            if path.is_symlink():
                raise SystemExit(f'the toolkit holds no links: {path}')
            out.append((f'{prefix}/{path.relative_to(root).as_posix()}', path))
    return sorted(out)


def _archive(entries: list[tuple[str, Path | None]], manifest: dict) -> bytes:
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode='w', format=tarfile.GNU_FORMAT) as tar:
        def add(name: str, data: bytes | None, executable: bool = False) -> None:
            info = tarfile.TarInfo(name)
            info.mtime, info.uid, info.gid, info.uname, info.gname = 0, 0, 0, '', ''
            if data is None:
                info.type, info.mode = tarfile.DIRTYPE, 0o755
                tar.addfile(info)
            else:
                info.size, info.mode = len(data), 0o755 if executable else 0o644
                tar.addfile(info, io.BytesIO(data))
        add('apex-toolkit.json', (json.dumps(manifest, indent=2, sort_keys=True) + '\n').encode())
        for name, path in entries:
            if path is None or path.is_dir():
                add(name, None)
            else:
                add(name, path.read_bytes(), bool(path.stat().st_mode & 0o111))
    out = io.BytesIO()
    with gzip.GzipFile(filename='', fileobj=out, mode='wb', compresslevel=9, mtime=0) as packed:
        packed.write(raw.getvalue())
    return out.getvalue()


def build(work: Path) -> tuple[bytes, dict]:
    pin = json.loads((HERE / 'pin.json').read_text(encoding='utf-8-sig'))
    subprocess.run(['node', str(HERE / 'verify.mjs'), str(work / 'verify')], check=True, stdin=subprocess.DEVNULL, timeout=1800)
    manifest = _manifest(pin)
    data = _archive(_entries(work / 'verify', pin), manifest)
    digest = hashlib.sha256(data).hexdigest()
    entry = {
        'version': manifest['openfilm'],
        'patches': [p['file'].removesuffix('.patch') for p in manifest['patches']],
        'editor': [p['file'].removesuffix('.patch') for p in manifest['editor']['patches']],
        'dependencies': manifest['dependencies'],
        'license': "MIT (openfilm, patched: not the OpenFilm product; its editor rebuilt as APEX's); Apache-2.0 (playwright-core)",
        'bytes': len(data),
        'sha256': digest,
        'url': f'{COS}/media-tools/openfilm/{manifest["openfilm"]}/{digest}/{ARCHIVE}',
    }
    return data, entry


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('work', type=Path, help='an empty folder to build in; the archive is left in it')
    parser.add_argument('--check', action='store_true', help="fail unless the build equals desktop-lock.json's openfilm entry")
    args = parser.parse_args()
    work = args.work.resolve()
    work.mkdir(parents=True, exist_ok=True)
    if any(work.iterdir()):
        raise SystemExit(f'{work} is not empty')
    data, entry = build(work)
    (work / ARCHIVE).write_bytes(data)
    print(json.dumps({'openfilm': entry}, indent=2))
    if args.check:
        locked = json.loads(LOCK.read_text(encoding='utf-8-sig')).get('openfilm')
        if locked != entry:
            raise SystemExit('desktop-lock.json openfilm differs from this build: update it (and publish the archive) with the pins or patches')
        print(f'{ARCHIVE} equals desktop-lock.json ({entry["bytes"]} bytes, sha256 {entry["sha256"]})')


if __name__ == '__main__':
    sys.exit(main())
