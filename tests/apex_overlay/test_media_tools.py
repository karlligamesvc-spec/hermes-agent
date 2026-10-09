"""Verify fail-closed archives and cache reuse against real native extraction."""
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import zipfile

import pytest

from apex_overlay import media_tools


def _browser_cache_round_trip(tmp_path, monkeypatch):
    from hermes_constants import get_hermes_home
    monkeypatch.setenv('HERMES_HOME', str(tmp_path / 'home'))
    archive = tmp_path / 'browser.zip'
    name = 'browser.exe' if os.name == 'nt' else 'browser'
    with zipfile.ZipFile(archive, 'w') as output:
        output.write(Path(sys.executable).resolve(), name)
    payload = archive.read_bytes()
    original_run = media_tools.subprocess.run
    def run(command, **kwargs):
        if command[-1] == '--version':
            assert Path(command[0]).is_file()
            return media_tools.subprocess.CompletedProcess(command, 0)
        return original_run(command, **kwargs)
    monkeypatch.setattr(media_tools.subprocess, 'run', run)
    lock = tmp_path / 'desktop-lock.json'
    lock.write_text(json.dumps({'browser': {media_tools.native_target(): {
        'url': f'https://{media_tools.COS_HOST}/fixture.zip', 'bytes': len(payload),
        'sha256': hashlib.sha256(payload).hexdigest(), 'executable': name,
    }}}))
    monkeypatch.setattr(media_tools, 'LOCK', lock)
    monkeypatch.setattr(media_tools.urllib.request, 'urlopen', lambda *a, **k: io.BytesIO(b'broken'))
    with pytest.raises(ValueError, match='checksum mismatch'):
        media_tools.ensure_browser()
    monkeypatch.setattr(media_tools.urllib.request, 'urlopen', lambda *a, **k: io.BytesIO(payload))
    executable = media_tools.ensure_browser()
    assert executable.is_file()
    assert executable.is_relative_to(Path(get_hermes_home()))
    def no_download(*args, **kwargs):
        raise AssertionError('A second call must reuse the verified installation')
    monkeypatch.setattr(media_tools.urllib.request, 'urlopen', no_download)
    assert media_tools.ensure_browser() == executable


@pytest.mark.macos_only
def test_mac_browser_cache(tmp_path, monkeypatch):
    _browser_cache_round_trip(tmp_path, monkeypatch)


@pytest.mark.windows_only
def test_windows_browser_cache(tmp_path, monkeypatch):
    _browser_cache_round_trip(tmp_path, monkeypatch)
