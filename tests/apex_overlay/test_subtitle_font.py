"""hc-1149: the cloud image's ``font`` command, the subtitle font from APEX COS and nowhere else.

Backport of fork main's hc-1025 ``ensure_font`` to the v2026.8.31 cloud image line. The lock pins
得意黑 Smiley Sans 2.0.1 (OFL-1.1) by size and SHA-256 at an immutable COS key; the font file is
not in git. ``ensure_font`` downloads it once into HERMES_HOME's tool cache, refuses a corrupt
download or a non-COS URL, reuses a verified copy and replaces a tampered one.

The cloud runs the command by file path with whatever ``python3`` the terminal finds, possibly
Debian's without the Hermes venv, from any directory. So the command must need nothing but the
standard library and the repository's own ``hermes_constants``; the tests run it that way, with
``-I -S`` (no site-packages, no editable finder, no PYTHONPATH) from an unrelated directory.
"""
import fcntl
import hashlib
import io
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from apex_overlay import media_tools

ROOT = Path(__file__).resolve().parents[2]
LOCK = json.loads((ROOT / 'scripts/media-tools/desktop-lock.json').read_text(encoding='utf-8'))
SMILEY_SHA256 = '139b5dcbe70d6d52de85a62d148784c6af4bd161e38fdb62ba0c1e7e5065fca6'


def test_the_subtitle_font_is_the_one_desktop_pins_and_is_served_from_cos():
    font = LOCK['fonts']['subtitle']

    # Same entry as fork main's desktop-lock: Desktop and cloud burn the same file.
    assert font['license'] == 'OFL-1.1' and font['version'] == '2.0.1'
    assert font['family'] == 'Smiley Sans Oblique' and font['file'] == 'SmileySans-Oblique.otf'
    assert font['sha256'] == SMILEY_SHA256 and font['bytes'] == 2_003_884
    assert font['url'] == (
        f'https://{media_tools.COS_HOST}/media-tools/fonts/smiley-sans/{font["version"]}/{font["sha256"]}/{font["file"]}'
    )
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


def test_a_second_installer_waits_for_the_first_and_gives_up_without_downloading(tmp_path, monkeypatch):
    payload = b'OTTO font'
    _fixture_lock(tmp_path, monkeypatch, payload)
    calls = _serve(monkeypatch, payload)
    cache = tmp_path / 'home' / 'tool-cache' / 'fonts'
    cache.mkdir(parents=True)
    monkeypatch.setattr(media_tools, 'LOCK_TIMEOUT_SECONDS', 0.5)

    with (cache / 'install.lock').open('ab') as other_installer:
        fcntl.flock(other_installer, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with pytest.raises(TimeoutError, match='another font install'):
            media_tools.ensure_font()
        assert calls == []
        fcntl.flock(other_installer, fcntl.LOCK_UN)

    assert media_tools.ensure_font().read_bytes() == payload and len(calls) == 1


def _copy_of_the_command(tmp_path, payload):
    """The command's files at their image layout, with a fixture lock instead of the real font."""
    root = tmp_path / 'opt-hermes'
    (root / 'apex_overlay').mkdir(parents=True)
    (root / 'scripts/media-tools').mkdir(parents=True)
    shutil.copy2(ROOT / 'apex_overlay/media_tools.py', root / 'apex_overlay/media_tools.py')
    shutil.copy2(ROOT / 'hermes_constants.py', root / 'hermes_constants.py')
    digest = hashlib.sha256(payload).hexdigest()
    (root / 'scripts/media-tools/desktop-lock.json').write_text(json.dumps({'fonts': {'subtitle': {
        'family': 'Fixture Sans', 'file': 'Fixture.otf', 'bytes': len(payload), 'sha256': digest,
        'url': f'https://{media_tools.COS_HOST}/media-tools/fonts/fixture/{digest}/Fixture.otf',
    }}}))
    elsewhere = tmp_path / 'workspace'
    elsewhere.mkdir()
    return root / 'apex_overlay/media_tools.py', elsewhere, digest


def _run_bare(script, cwd, env):
    # -I -S: no site-packages (so no editable finder and no filelock), no PYTHON* variables.
    return subprocess.run([sys.executable, '-I', '-S', str(script), 'font'], cwd=cwd, env=env,
                          capture_output=True, text=True, timeout=60)


def test_the_font_command_runs_by_file_path_with_a_bare_python_from_any_directory(tmp_path):
    payload = b'OTTO cached font'
    script, elsewhere, digest = _copy_of_the_command(tmp_path, payload)
    home = tmp_path / 'hermes-home'
    cached = home / 'tool-cache' / 'fonts' / digest / 'Fixture.otf'
    cached.parent.mkdir(parents=True)
    cached.write_bytes(payload)

    result = _run_bare(script, elsewhere, {'HERMES_HOME': str(home), 'PATH': '/usr/bin:/bin'})

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == str(cached)


def test_the_font_command_reports_one_line_when_cos_is_unreachable(tmp_path):
    script, elsewhere, _digest = _copy_of_the_command(tmp_path, b'OTTO never downloaded')
    home = tmp_path / 'hermes-home'
    # A proxy on a closed port: urllib fails at once and nothing leaves this machine.
    env = {'HERMES_HOME': str(home), 'PATH': '/usr/bin:/bin',
           'https_proxy': 'http://127.0.0.1:9', 'HTTPS_PROXY': 'http://127.0.0.1:9'}

    result = _run_bare(script, elsewhere, env)

    assert result.returncode == 1 and result.stdout == ''
    assert result.stderr.startswith('APEX subtitle font unavailable: URLError:'), result.stderr
    assert result.stderr.count('\n') == 1 and 'Traceback' not in result.stderr
    assert not list((home / 'tool-cache' / 'fonts').glob('*/Fixture.otf'))
