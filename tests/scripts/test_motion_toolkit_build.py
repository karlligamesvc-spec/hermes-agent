"""hc-1221: the motion toolkit is huashu-motion trimmed to what renders — no GSAP, no 豆子花叔 character, no
commands that download models — built from the pinned npm package and nothing else, byte for byte reproducibly."""
import base64
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile

import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('motion_build', ROOT / 'scripts/media-tools/motion/build_toolkit.py')
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)

UPSTREAM = {
    'LICENSE': b'MIT', 'package.json': json.dumps({'name': 'huashu-motion', 'version': '0.4.0'}).encode(),
    'cli/om.js': b'// om', 'cli/lib/render.js': b'', 'cli/lib/voice.js': b'kokoro', 'cli/lib/samples-build.js': b'',
    'cli/lib/learn.js': b'', 'cli/lib/share.js': b'', 'cli/lib/grab.js': b'', 'cli/lib/kokoro.py': b'',
    'runtime/om-engine.js': b'', 'runtime/om-player.js': b'', 'runtime/om.js': b'', 'runtime/clip/lib/toon.js': b'bean',
    'runtime/three/three.min.js': b'', 'studio/index.html': b'', 'studio/studio.css': b'', 'studio/studio.js': b'',
    'templates/blank/vendor/gsap.min.js': b'gsap', 'templates/storytime/index.html': b'bean',
    'fonts/NotoSansSC-500.woff': b'5', 'fonts/NotoSansSC-700.woff': b'7', 'fonts/NotoSansSC-900.woff': b'9',
    'fonts/OFL.txt': b'OFL', 'fonts/Anton-400.woff': b'', 'examples/showcase/vendor/gsap.min.js': b'gsap',
}


def _npm_tarball(files: dict[str, bytes]) -> bytes:
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode='w') as tar:
        for name, data in files.items():
            info = tarfile.TarInfo(f'package/{name}')
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return gzip.compress(raw.getvalue())


@pytest.fixture
def pinned(monkeypatch):
    tarball = _npm_tarball(UPSTREAM)
    integrity = 'sha512-' + base64.b64encode(hashlib.sha512(tarball).digest()).decode()
    monkeypatch.setitem(build.PACKAGE, 'integrity', integrity)
    return tarball


def test_the_archive_keeps_the_renderer_and_drops_gsap_the_character_and_downloads(pinned):
    data, entry = build.build(pinned)
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as tar:
        names = set(tar.getnames())
    assert {'cli/om.js', 'cli/lib/render.js', 'runtime/om-engine.js', 'studio/studio.js', 'fonts/NotoSansSC-900.woff',
            'LICENSE', 'THIRD_PARTY.md', 'fonts/LICENSES.md', 'apex-toolkit.json'} <= names
    for gone in ('gsap', 'toon.js', 'storytime', 'voice.js', 'samples-build.js', 'kokoro.py', 'three', 'Anton', 'examples/'):
        assert not [n for n in names if gone in n], gone
    assert entry['sha256'] == hashlib.sha256(data).hexdigest() and entry['bytes'] == len(data)
    assert entry['url'].endswith(f'/media-tools/motion/0.4.0/{entry["sha256"]}/motion-toolkit.tgz')


def test_the_same_package_gives_the_same_bytes(pinned):
    assert build.build(pinned)[0] == build.build(pinned)[0]


def test_another_tarball_is_refused(pinned):
    with pytest.raises(SystemExit, match='integrity'):
        build.build(_npm_tarball({**UPSTREAM, 'cli/om.js': b'// changed'}))


def test_a_moved_upstream_file_stops_the_build(monkeypatch):
    files = {k: v for k, v in UPSTREAM.items() if k != 'cli/lib/voice.js'}
    tarball = _npm_tarball(files)
    monkeypatch.setitem(build.PACKAGE, 'integrity', 'sha512-' + base64.b64encode(hashlib.sha512(tarball).digest()).decode())
    with pytest.raises(SystemExit, match='review DROP'):
        build.build(tarball)
