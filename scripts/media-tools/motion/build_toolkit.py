"""Build APEX's motion toolkit (hc-1221) as one reproducible archive.

The toolkit is the published huashu-motion package (MIT, alchaincyf/huashu-motion) at the version and npm
integrity pinned below, trimmed to what renders, checks and previews a composition: the ``om`` CLI, the page
engine and player, the preview studio, and the Noto Sans SC weights APEX's templates draw with (SIL OFL 1.1).
APEX's own templates are not in here; they ship with the platform skill that uses them.

Left out on purpose:

- **GSAP** (every upstream template's ``vendor/``): its Standard "no charge" License lists as a Prohibited Use any
  tool that lets users build visual animations without code. APEX's templates use their own seekable timeline,
  which the engine drives the same way (``window.__timelines`` entries with ``seek``/``pause``/``duration``).
- **The 「豆子花叔」 character** (``runtime/clip/lib/toon.js`` and the storytime template): the upstream README
  says it is not licensed for other uses. The whole ``runtime/clip`` grammar engine goes with it, unused here.
- **Commands that download from GitHub or Hugging Face** (``voice`` with Kokoro/whisper.cpp models, ``samples
  build``) or write outside the project (``learn``), and ``share``/``grab``: APEX voices with ``text_to_speech``,
  transcribes with ``media_transcribe`` and has its own music library.
- The upstream templates, skill, examples, tests, three.js and the other 20-odd fonts.

The same inputs always give the same bytes (entries sorted, no times or owners, gzip without a timestamp), so the
archive's SHA-256 in desktop-lock.json names them.

    python build_toolkit.py <empty work folder>          builds it and prints its desktop-lock.json entry
    python build_toolkit.py --check <empty work folder>  also fails unless it equals desktop-lock.json's entry
"""
from __future__ import annotations

import argparse
import base64
import fnmatch
import gzip
import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile
import urllib.request

HERE = Path(__file__).resolve().parent
LOCK = HERE.parent / 'desktop-lock.json'
COS = 'https://apexnodes-runtime-202606250443-1300912302.cos.ap-guangzhou.myqcloud.com'
ARCHIVE = 'motion-toolkit.tgz'
PACKAGE = {
    'name': 'huashu-motion',
    'version': '0.4.0',
    'integrity': 'sha512-E1r5+mbmIsObyow1MtglFiMTyYQwDeLYMUH1pIxNFWDd3uveHj+m8vt/HS1C5GxLg3nKGRDceHpwPcHksv0vtg==',
    'tarball': 'https://registry.npmjs.org/huashu-motion/-/huashu-motion-0.4.0.tgz',
}
KEEP = [
    'LICENSE', 'package.json',
    'cli/om.js', 'cli/lib/*.js',
    'runtime/om-engine.js', 'runtime/om-player.js', 'runtime/om.js',
    'studio/index.html', 'studio/studio.css', 'studio/studio.js',
    'fonts/NotoSansSC-500.woff', 'fonts/NotoSansSC-700.woff', 'fonts/NotoSansSC-900.woff', 'fonts/OFL.txt',
]
DROP = {
    'cli/lib/voice.js': 'downloads Kokoro and whisper.cpp models from GitHub / Hugging Face',
    'cli/lib/samples-build.js': 'downloads instrument samples from GitHub',
    'cli/lib/learn.js': 'keeps preferences outside the project',
    'cli/lib/share.js': 'share GIF and post copy for the upstream project',
    'cli/lib/grab.js': 'APEX has its own browser and capture tools',
}
LICENSE_NOTE = 'MIT (huashu-motion 0.4.0, trimmed: no GSAP, no 豆子花叔 character, no model downloads); OFL-1.1 (Noto Sans SC)'
FONTS_LICENSES = """# 字体许可 · Font licenses

本目录的字体不属于 huashu-motion 的 MIT 授权，沿用 SIL Open Font License 1.1(全文见同目录 `OFL.txt`):
可以随软件再分发、可商用，不能单独售卖字体文件。它们是 huashu-motion 按字重实例化后的 GB2312 子集，转成了 woff。

| 文件 | 字体 | 版权 | 来源 |
|---|---|---|---|
| `NotoSansSC-500/700/900.woff` | 思源黑体 Noto Sans SC(GB2312 子集) | © 2014-2021 Adobe，Reserved Font Name "Source" | Google Fonts,经 huashu-motion 0.4.0 |
"""
THIRD_PARTY = """# Third-party components in APEX's motion toolkit

This toolkit is huashu-motion 0.4.0 (MIT, Copyright (c) 2026 alchaincyf, see `LICENSE`) with parts removed by APEX;
nothing in the files that remain was changed. See `apex-toolkit.json` for exactly what was left out and why.

| Component | Where | License |
|---|---|---|
| Noto Sans SC (GB2312 subsets, 500/700/900) | `fonts/` | SIL Open Font License 1.1, see `fonts/OFL.txt` and `fonts/LICENSES.md` |

Not included: GSAP (GSAP Standard License), three.js, the clip grammar engine and the 「豆子花叔」 character, the
upstream templates and examples.
"""


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=300) as response:
        return response.read()


def verified_package(data: bytes) -> dict[str, bytes]:
    algorithm, expected = PACKAGE['integrity'].split('-', 1)
    if algorithm != 'sha512' or base64.b64encode(hashlib.sha512(data).digest()).decode() != expected:
        raise SystemExit('huashu-motion tarball differs from the pinned npm integrity')
    files: dict[str, bytes] = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as tar:
        for member in tar.getmembers():
            if member.isfile() and member.name.startswith('package/'):
                files[member.name[len('package/'):]] = tar.extractfile(member).read()
    if json.loads(files['package.json'])['version'] != PACKAGE['version']:
        raise SystemExit('huashu-motion tarball is not the pinned version')
    return files


def select(files: dict[str, bytes]) -> dict[str, bytes]:
    kept = {name: data for name, data in files.items()
            if any(fnmatch.fnmatchcase(name, pattern) for pattern in KEEP) and name not in DROP}
    missing = [p for p in KEEP if not any(fnmatch.fnmatchcase(n, p) for n in kept)]
    if missing:
        raise SystemExit(f'huashu-motion {PACKAGE["version"]} has no {missing}')
    lost = [n for n in DROP if n not in files]
    if lost:
        raise SystemExit(f'the dropped files moved upstream, review DROP: {lost}')
    for name, data in kept.items():
        if name.endswith('.js') and b'gsap.min.js' in data and name.startswith('runtime/'):
            raise SystemExit(f'{name} loads GSAP')
    kept['fonts/LICENSES.md'] = FONTS_LICENSES.encode()
    kept['THIRD_PARTY.md'] = THIRD_PARTY.encode()
    return kept


def manifest() -> dict:
    return {
        'schema': 1,
        'package': PACKAGE['name'],
        'version': PACKAGE['version'],
        'integrity': PACKAGE['integrity'],
        'kept': KEEP,
        'dropped': {**DROP,
                    'templates/, examples/': 'upstream templates carry GSAP; storytime draws the 豆子花叔 character',
                    'runtime/clip/, runtime/three/, runtime/camera-rig.js': 'unused by APEX templates; clip holds the character',
                    'skills/, fonts/* other than Noto Sans SC 500/700/900': 'APEX ships its own skill and templates'},
    }


def archive(files: dict[str, bytes], meta: dict) -> bytes:
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode='w', format=tarfile.GNU_FORMAT) as tar:
        def add(name: str, data: bytes, executable: bool = False) -> None:
            info = tarfile.TarInfo(name)
            info.mtime, info.uid, info.gid, info.uname, info.gname = 0, 0, 0, '', ''
            info.size, info.mode = len(data), 0o755 if executable else 0o644
            tar.addfile(info, io.BytesIO(data))
        add('apex-toolkit.json', (json.dumps(meta, indent=2, sort_keys=True, ensure_ascii=False) + '\n').encode())
        for name in sorted(files):
            add(name, files[name], name == 'cli/om.js')
    out = io.BytesIO()
    with gzip.GzipFile(filename='', fileobj=out, mode='wb', compresslevel=9, mtime=0) as packed:
        packed.write(raw.getvalue())
    return out.getvalue()


def build(tarball: bytes | None = None) -> tuple[bytes, dict]:
    files = select(verified_package(tarball if tarball is not None else fetch(PACKAGE['tarball'])))
    data = archive(files, manifest())
    digest = hashlib.sha256(data).hexdigest()
    entry = {
        'version': PACKAGE['version'],
        'integrity': PACKAGE['integrity'],
        'license': LICENSE_NOTE,
        'bytes': len(data),
        'sha256': digest,
        'url': f'{COS}/media-tools/motion/{PACKAGE["version"]}/{digest}/{ARCHIVE}',
    }
    return data, entry


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('work', type=Path, help='an empty folder to build in; the archive is left in it')
    parser.add_argument('--check', action='store_true', help="fail unless the build equals desktop-lock.json's motion entry")
    parser.add_argument('--tarball', type=Path, help='a local copy of the pinned npm tarball (checked against its integrity)')
    args = parser.parse_args()
    work = args.work.resolve()
    work.mkdir(parents=True, exist_ok=True)
    if any(work.iterdir()):
        raise SystemExit(f'{work} is not empty')
    data, entry = build(args.tarball.read_bytes() if args.tarball else None)
    (work / ARCHIVE).write_bytes(data)
    print(json.dumps({'motion': entry}, indent=2, ensure_ascii=False))
    if args.check:
        locked = json.loads(LOCK.read_text(encoding='utf-8-sig')).get('motion')
        if locked != entry:
            raise SystemExit('desktop-lock.json motion differs from this build: update it (and publish the archive) with the pin')
        print(f'{ARCHIVE} equals desktop-lock.json ({entry["bytes"]} bytes, sha256 {entry["sha256"]})')


if __name__ == '__main__':
    sys.exit(main())
