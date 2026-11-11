"""hc-1224: the title font, 思源黑体 Black (Noto Sans SC Black 2.004, OFL-1.1), beside the subtitle font.

The lock pins the official release member (notofonts/noto-cjk Sans2.004 ``18_NotoSansSC.zip``) by size and SHA-256
at an immutable APEX COS key, and its license file (the archive's ``LICENSE``, published as ``OFL.txt``) in the same
COS folder. ``ensure_font('title')`` installs the license first, then the font, into one folder of HERMES_HOME's tool
cache, from APEX COS only. ``font title`` prints the font; plain ``font`` still prints 得意黑; a font it cannot give
is one line naming it. ``publish_fonts.py --only title`` uploads both from that one archive and reads each back.
"""
import hashlib
import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

from apex_overlay import media_tools

ROOT = Path(__file__).resolve().parents[2]
LOCK = json.loads((ROOT / 'scripts/media-tools/desktop-lock.json').read_text(encoding='utf-8'))
SPEC = importlib.util.spec_from_file_location('title_font_publisher', ROOT / 'scripts/media-tools/publish_fonts.py')
publisher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publisher)
FONT = b'OTTO' + bytes(range(256)) * 32
LICENSE = b'This Font Software is licensed under the SIL Open Font License, Version 1.1.\n'


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def test_the_title_font_is_noto_sans_sc_black_pinned_with_its_license_on_cos():
    font = LOCK['fonts']['title']

    assert font['license'] == 'OFL-1.1' and font['version'] == '2.004'
    # What an ASS `Fontname` must say: libass takes the font's nameID 1 (or its CFF PostScript name); the
    # typographic family "Noto Sans SC" falls back to a system font (measured with ffmpeg 9.0.1 / libass 0.17.5).
    assert font['family'] == 'Noto Sans SC Black' and font['file'] == 'NotoSansSC-Black.otf'
    assert re.fullmatch(r'[0-9a-f]{64}', font['sha256']) and font['bytes'] > 1_000_000
    folder = f'https://{media_tools.COS_HOST}/media-tools/fonts/noto-sans-sc/{font["version"]}/{font["sha256"]}/'
    assert font['url'] == folder + font['file']
    assert font['upstream'] == 'https://github.com/notofonts/noto-cjk/releases/download/Sans2.004/18_NotoSansSC.zip'
    assert font['upstreamMember'] == font['file']
    license_file = font['licenseFile']
    assert license_file['file'] == 'OFL.txt' and license_file['upstreamMember'] == 'LICENSE'
    assert license_file['url'] == folder + 'OFL.txt'
    assert re.fullmatch(r'[0-9a-f]{64}', license_file['sha256']) and 1_000 < license_file['bytes'] < 10_000
    tracked = subprocess.run(['git', 'ls-files', '*.otf', '*.ttf', '*.ttc'], cwd=ROOT, capture_output=True, text=True, check=True)
    assert 'NotoSansSC' not in tracked.stdout, 'the font file is fetched from COS, never committed'


def _title_lock(tmp_path, monkeypatch, license_url=None):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path / 'home'))
    folder = f'https://{media_tools.COS_HOST}/media-tools/fonts/fixture/1/{_sha(FONT)}/'
    entry = {
        'family': 'Fixture Black', 'file': 'Fixture-Black.otf', 'bytes': len(FONT), 'sha256': _sha(FONT),
        'url': folder + 'Fixture-Black.otf',
        'licenseFile': {'file': 'OFL.txt', 'bytes': len(LICENSE), 'sha256': _sha(LICENSE),
                        'url': license_url or folder + 'OFL.txt'},
    }
    lock = tmp_path / 'desktop-lock.json'
    lock.write_text(json.dumps({'fonts': {'title': entry}}))
    monkeypatch.setattr(media_tools, 'LOCK', lock)
    return entry


def _serve(monkeypatch, bodies):
    """A COS stand-in answering by file name; returns the file names in the order they were asked for."""
    calls = []

    def urlopen(url, **_kwargs):
        name = url.rsplit('/', 1)[-1]
        calls.append(name)
        return io.BytesIO(bodies[name])

    monkeypatch.setattr(media_tools.urllib.request, 'urlopen', urlopen)
    return calls


def test_the_title_font_installs_with_its_license_beside_it(tmp_path, monkeypatch):
    from hermes_constants import get_hermes_home
    entry = _title_lock(tmp_path, monkeypatch)
    calls = _serve(monkeypatch, {'Fixture-Black.otf': FONT, 'OFL.txt': LICENSE})

    font = media_tools.ensure_font('title')
    assert font == Path(get_hermes_home()) / 'tool-cache' / 'fonts' / entry['sha256'] / 'Fixture-Black.otf'
    assert font.read_bytes() == FONT and (font.parent / 'OFL.txt').read_bytes() == LICENSE
    assert calls == ['OFL.txt', 'Fixture-Black.otf'], 'the license is installed first'
    assert media_tools.ensure_font('title') == font and len(calls) == 2, 'verified copies are reused'

    (font.parent / 'OFL.txt').write_bytes(b'edited')
    assert media_tools.ensure_font('title') == font
    assert calls[2:] == ['OFL.txt'] and (font.parent / 'OFL.txt').read_bytes() == LICENSE


def test_a_bad_license_leaves_no_font(tmp_path, monkeypatch):
    _title_lock(tmp_path, monkeypatch)
    calls = _serve(monkeypatch, {'Fixture-Black.otf': FONT, 'OFL.txt': b'not the license'})

    with pytest.raises(ValueError, match='checksum mismatch'):
        media_tools.ensure_font('title')
    assert calls == ['OFL.txt']
    assert not list((tmp_path / 'home' / 'tool-cache' / 'fonts').glob('*/*'))


def test_the_license_too_comes_only_from_cos(tmp_path, monkeypatch):
    _title_lock(tmp_path, monkeypatch, license_url='https://github.com/notofonts/noto-cjk/raw/Sans2.004/Sans/LICENSE')
    calls = _serve(monkeypatch, {'Fixture-Black.otf': FONT, 'LICENSE': LICENSE})

    with pytest.raises(ValueError, match='APEX COS'):
        media_tools.ensure_font('title')
    assert calls == [], 'nothing is downloaded, not even the font'


# --------------------------------------------------------------------------- #
# The `font` command, run the way an Agent runs it (the cloud runs the file by path)
# --------------------------------------------------------------------------- #


@pytest.fixture
def engine(tmp_path):
    """A copy of media_tools beside a fixture lock, and a tool cache already holding verified copies (no network)."""
    root, home = tmp_path / 'engine', tmp_path / 'home'
    (root / 'apex_overlay').mkdir(parents=True)
    shutil.copy(Path(media_tools.__file__), root / 'apex_overlay' / 'media_tools.py')
    cos = f'https://{media_tools.COS_HOST}/media-tools/fonts/fixture'
    subtitle = b'OTTO subtitle'
    fonts = {
        'subtitle': {'family': 'Fixture Sans', 'file': 'Fixture.otf', 'bytes': len(subtitle), 'sha256': _sha(subtitle),
                     'url': f'{cos}/Fixture.otf'},
        'title': {'family': 'Fixture Black', 'file': 'Fixture-Black.otf', 'bytes': len(FONT), 'sha256': _sha(FONT),
                  'url': f'{cos}/Fixture-Black.otf',
                  'licenseFile': {'file': 'OFL.txt', 'bytes': len(LICENSE), 'sha256': _sha(LICENSE), 'url': f'{cos}/OFL.txt'}},
    }
    for entry, files in ((fonts['subtitle'], {'Fixture.otf': subtitle}),
                         (fonts['title'], {'Fixture-Black.otf': FONT, 'OFL.txt': LICENSE})):
        folder = home / 'tool-cache' / 'fonts' / entry['sha256']
        folder.mkdir(parents=True)
        for name, body in files.items():
            (folder / name).write_bytes(body)
    lock = root / 'scripts' / 'media-tools' / 'desktop-lock.json'
    lock.parent.mkdir(parents=True)
    lock.write_text(json.dumps({'fonts': fonts}))

    def run(*argv):
        return subprocess.run([sys.executable, str(root / 'apex_overlay' / 'media_tools.py'), *argv],
                              capture_output=True, text=True, timeout=120, check=False,
                              env={'HERMES_HOME': str(home), 'PYTHONPATH': str(ROOT), 'PATH': os.environ.get('PATH', '')})

    def relock():
        lock.write_text(json.dumps({'fonts': fonts}))

    return {'run': run, 'fonts': fonts, 'cache': home / 'tool-cache' / 'fonts', 'relock': relock}


def test_font_title_prints_the_title_font_and_plain_font_still_the_subtitle_font(engine):
    fonts, cache = engine['fonts'], engine['cache']

    title = engine['run']('font', 'title')
    assert title.returncode == 0, title.stderr
    assert title.stdout.strip() == str(cache / fonts['title']['sha256'] / 'Fixture-Black.otf')
    plain = engine['run']('font')
    assert plain.returncode == 0, plain.stderr
    assert plain.stdout.strip() == str(cache / fonts['subtitle']['sha256'] / 'Fixture.otf')
    assert engine['run']('font', 'subtitle').stdout == plain.stdout


def test_a_font_it_cannot_give_is_one_line_naming_that_font(engine):
    fonts = engine['fonts']
    for name in ('subtitle', 'title'):  # off COS and not cached: refused before any download
        fonts[name]['url'] = 'https://github.com/example/font.otf'
        shutil.rmtree(engine['cache'] / fonts[name]['sha256'])
    engine['relock']()

    for name in ('subtitle', 'title'):
        failed = engine['run']('font', name)
        assert failed.returncode == 1 and failed.stdout == ''
        assert failed.stderr.strip() == f'APEX {name} font unavailable: ValueError: Font download must use APEX COS'
    assert engine['run']('font').stderr == engine['run']('font', 'subtitle').stderr
    unknown = engine['run']('font', 'cover')
    assert unknown.returncode == 1 and unknown.stderr.strip() == "APEX font 'cover' unavailable: KeyError: 'cover'"


def test_only_the_font_command_takes_a_name(engine):
    refused = engine['run']('openfilm-check', 'title')
    assert refused.returncode == 2 and 'unrecognized arguments: title' in refused.stderr


# --------------------------------------------------------------------------- #
# publish_fonts.py --only title
# --------------------------------------------------------------------------- #


class _Client:
    def __init__(self):
        self.uploads = []

    def upload_file(self, **kwargs):
        self.uploads.append((kwargs['Key'], Path(kwargs['LocalFilePath']).read_bytes()))


def _key(url: str) -> str:
    return url.split('.myqcloud.com/', 1)[1]


def _noto_root(tmp_path, font=FONT, license=LICENSE):
    """A publish folder with the real lock's title entry, re-pinned to fixture bytes, and a stand-in release archive.

    Smiley Sans's archive is not there: ``--only title`` must not need it.
    """
    entry = json.loads(json.dumps(LOCK['fonts']['title']))
    entry.update(bytes=len(FONT), sha256=_sha(FONT))
    entry['licenseFile'].update(bytes=len(LICENSE), sha256=_sha(LICENSE))
    root = tmp_path / 'publish'
    root.mkdir()
    (root / 'desktop-lock.json').write_text(json.dumps({'fonts': {'subtitle': LOCK['fonts']['subtitle'], 'title': entry}}))
    with zipfile.ZipFile(root / entry['upstream'].rsplit('/', 1)[-1], 'w') as bundle:
        bundle.writestr('NotoSansSC-Black.otf', font)
        bundle.writestr('NotoSansSC-Regular.otf', b'another weight')
        bundle.writestr('LICENSE', license)
    return root, entry


def _read_back(monkeypatch, served):
    reads = []

    def urlopen(url, **_kwargs):
        reads.append(url)
        return io.BytesIO(served[url])

    monkeypatch.setattr(publisher.urllib.request, 'urlopen', urlopen)
    return reads


def test_publishing_the_title_font_uploads_its_license_then_the_font_and_reads_both_back(tmp_path, monkeypatch):
    root, entry = _noto_root(tmp_path)
    reads = _read_back(monkeypatch, {entry['licenseFile']['url']: LICENSE, entry['url']: FONT})
    client = _Client()

    publisher.publish(root, client, ['title'])
    assert client.uploads == [(_key(entry['licenseFile']['url']), LICENSE), (_key(entry['url']), FONT)]
    assert reads == [entry['licenseFile']['url'], entry['url']]


@pytest.mark.parametrize('case', ['license differs', 'font differs', 'off cos', 'license read back differs', 'unknown name'])
def test_the_title_font_publisher_stops_at_the_first_mismatch(tmp_path, monkeypatch, case):
    root, entry = _noto_root(tmp_path, license=b'another license' if case == 'license differs' else LICENSE,
                             font=b'another font' if case == 'font differs' else FONT)
    if case == 'off cos':
        lock = json.loads((root / 'desktop-lock.json').read_text())
        lock['fonts']['title']['url'] = 'https://example.com/NotoSansSC-Black.otf'
        (root / 'desktop-lock.json').write_text(json.dumps(lock))
    _read_back(monkeypatch, {entry['licenseFile']['url']: b'stale' if case == 'license read back differs' else LICENSE,
                             entry['url']: FONT})
    client = _Client()
    match = {'license differs': 'differs from lock', 'font differs': 'differs from lock', 'off cos': 'must be on APEX COS',
             'license read back differs': 'readback failed', 'unknown name': 'Not a pinned font'}[case]

    with pytest.raises(ValueError, match=match):
        publisher.publish(root, client, ['cover'] if case == 'unknown name' else ['title'])
    expected = [(_key(entry['licenseFile']['url']), LICENSE)] if case == 'license read back differs' else []
    assert client.uploads == expected, 'nothing goes up unless both files match, and nothing after a bad read-back'
