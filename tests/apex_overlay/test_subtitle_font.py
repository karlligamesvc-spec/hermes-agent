"""hc-1025: the one subtitle font Agents burn captions with, from APEX COS and nowhere else.

Subtitles and styled text use only a font cleared for commercial use. System fonts (Hiragino Sans
GB, STHeiti, Microsoft YaHei, PingFang) are not; the platform skill names this font instead. The
lock pins 得意黑 Smiley Sans 2.0.1 (OFL-1.1) by size and SHA-256 at an immutable COS key; the font
file is not in git. ``ensure_font`` downloads it once into HERMES_HOME's tool cache, refuses a
corrupt download or a non-COS URL, reuses a verified copy and replaces a tampered one.
``publish_fonts.py`` uploads nothing unless the official release member matches the lock.
"""
import hashlib
import importlib.util
import io
import json
import re
import subprocess
import zipfile
from pathlib import Path

import pytest

from apex_overlay import media_tools

ROOT = Path(__file__).resolve().parents[2]
LOCK = json.loads((ROOT / 'scripts/media-tools/desktop-lock.json').read_text(encoding='utf-8'))
SPEC = importlib.util.spec_from_file_location('font_publisher', ROOT / 'scripts/media-tools/publish_fonts.py')
publisher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publisher)


def test_the_subtitle_font_is_licensed_pinned_and_served_from_cos():
    font = LOCK['fonts']['subtitle']

    assert font['license'] == 'OFL-1.1'
    assert font['family'] == 'Smiley Sans Oblique' and font['file'] == 'SmileySans-Oblique.otf'
    assert re.fullmatch(r'[0-9a-f]{64}', font['sha256']) and font['bytes'] > 1_000_000
    assert font['url'] == (
        f'https://{media_tools.COS_HOST}/media-tools/fonts/smiley-sans/{font["version"]}/{font["sha256"]}/{font["file"]}'
    )
    assert font['upstream'].startswith('https://github.com/atelier-anchor/smiley-sans/releases/download/v')
    tracked = subprocess.run(['git', 'ls-files', '*.otf', '*.ttf', '*.ttc'], cwd=ROOT, capture_output=True, text=True, check=True)
    assert 'SmileySans' not in tracked.stdout, 'the font file is fetched from COS, never committed'


def _fixture_lock(tmp_path, monkeypatch, payload, url=None):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path / 'home'))
    lock = tmp_path / 'desktop-lock.json'
    lock.write_text(json.dumps({'fonts': {'subtitle': {
        'family': 'Fixture Sans', 'file': 'Fixture.otf', 'bytes': len(payload),
        'sha256': hashlib.sha256(payload).hexdigest(),
        'url': url or f'https://{media_tools.COS_HOST}/media-tools/fonts/fixture/Fixture.otf',
    }}}))
    monkeypatch.setattr(media_tools, 'LOCK', lock)


def _serve(monkeypatch, body):
    calls = []

    def urlopen(url, **_kwargs):
        calls.append(url)
        return io.BytesIO(body)

    monkeypatch.setattr(media_tools.urllib.request, 'urlopen', urlopen)
    return calls


def test_font_cache_round_trip(tmp_path, monkeypatch):
    from hermes_constants import get_hermes_home
    payload = b'OTTO' + bytes(range(256)) * 64
    _fixture_lock(tmp_path, monkeypatch, payload)

    _serve(monkeypatch, b'broken')
    with pytest.raises(ValueError, match='checksum mismatch'):
        media_tools.ensure_font()
    assert not list((Path(get_hermes_home()) / 'tool-cache' / 'fonts').glob('*/Fixture.otf'))

    calls = _serve(monkeypatch, payload)
    font = media_tools.ensure_font()
    assert font.read_bytes() == payload and font.name == 'Fixture.otf'
    assert font.parent.name == hashlib.sha256(payload).hexdigest()
    assert font.is_relative_to(Path(get_hermes_home()) / 'tool-cache' / 'fonts')
    assert media_tools.ensure_font() == font and len(calls) == 1  # verified copy reused

    font.write_bytes(b'tampered')
    assert media_tools.ensure_font() == font and font.read_bytes() == payload and len(calls) == 2


def test_font_download_must_come_from_cos(tmp_path, monkeypatch):
    _fixture_lock(tmp_path, monkeypatch, b'font', url='https://github.com/example/Fixture.otf')
    calls = _serve(monkeypatch, b'font')

    with pytest.raises(ValueError, match='APEX COS'):
        media_tools.ensure_font()
    assert calls == []


class _Client:
    def __init__(self):
        self.uploads = []

    def upload_file(self, **kwargs):
        self.uploads.append((kwargs['Key'], Path(kwargs['LocalFilePath']).read_bytes()))


def _publish_root(tmp_path, member_bytes):
    font = dict(LOCK['fonts']['subtitle'])
    root = tmp_path / 'publish'
    root.mkdir()
    (root / 'desktop-lock.json').write_text(json.dumps({'fonts': {'subtitle': font}}))
    with zipfile.ZipFile(root / font['upstream'].rsplit('/', 1)[-1], 'w') as bundle:
        bundle.writestr(f'smiley-sans-v{font["version"]}/{font["upstreamMember"]}', member_bytes)
    return root, font


def test_publisher_uploads_nothing_when_the_release_member_differs(tmp_path):
    root, _font = _publish_root(tmp_path, b'not the pinned font')
    client = _Client()

    with pytest.raises(ValueError, match='differs from lock'):
        publisher.publish(root, client)
    assert client.uploads == []


def test_publisher_uploads_the_pinned_key_and_reads_it_back(tmp_path, monkeypatch):
    payload = b'pinned font bytes'
    root, font = _publish_root(tmp_path, payload)
    lock = json.loads((root / 'desktop-lock.json').read_text())
    lock['fonts']['subtitle'].update(bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest())
    (root / 'desktop-lock.json').write_text(json.dumps(lock))
    client = _Client()

    monkeypatch.setattr(publisher.urllib.request, 'urlopen', lambda *a, **k: io.BytesIO(b'stale object'))
    with pytest.raises(ValueError, match='readback failed'):
        publisher.publish(root, client)

    monkeypatch.setattr(publisher.urllib.request, 'urlopen', lambda *a, **k: io.BytesIO(payload))
    client = _Client()
    publisher.publish(root, client)
    assert client.uploads == [(font['url'].split('.myqcloud.com/', 1)[1], payload)]
