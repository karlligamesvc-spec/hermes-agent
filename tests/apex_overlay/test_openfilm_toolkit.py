"""hc-1176: the OpenFilm toolkit comes from APEX COS only, checked, unpacked whole, and named in ready.json last."""
import gzip
import hashlib
import io
import json
from pathlib import Path
import tarfile

import pytest

from apex_overlay import media_tools

PATCHES = ['0001-keep-track-fields', '0002-host-chromium']


def _toolkit(manifest_patches=PATCHES, server=True) -> bytes:
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode='w') as tar:
        def add(name, data):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
        add('apex-toolkit.json', json.dumps({'schema': 1, 'openfilm': '0.3.0', 'patches': [{'file': f'{p}.patch'} for p in manifest_patches]}).encode())
        add('node_modules/openfilm/package.json', b'{"name": "openfilm", "version": "0.3.0"}')
        if server:
            add('node_modules/openfilm/studio/server/server.mjs', b'export {}')
    return gzip.compress(raw.getvalue())


@pytest.fixture
def toolkit(tmp_path, monkeypatch):
    """A lock naming `payload` (set later), a stand-in Agent browser, and a counted download."""
    monkeypatch.setenv('HERMES_HOME', str(tmp_path / 'home'))
    state = {'payload': _toolkit(), 'downloads': 0, 'browser_calls': []}
    chromium = tmp_path / 'chrome' / 'chrome'

    def lock(payload, url=None):
        path = tmp_path / 'desktop-lock.json'
        path.write_text(json.dumps({'openfilm': {
            'version': '0.3.0', 'patches': PATCHES, 'bytes': len(payload), 'sha256': hashlib.sha256(payload).hexdigest(),
            'url': url or f'https://{media_tools.COS_HOST}/media-tools/openfilm/0.3.0/x/openfilm-toolkit.tgz',
        }}))
        monkeypatch.setattr(media_tools, 'LOCK', path)

    def download(*args, **kwargs):
        state['downloads'] += 1
        return io.BytesIO(state['served'])

    def browser(**kwargs):
        state['browser_calls'].append(kwargs)
        return chromium

    monkeypatch.setattr(media_tools.urllib.request, 'urlopen', download)
    monkeypatch.setattr(media_tools, 'ensure_browser', browser)
    state['lock'] = lock
    state['cache'] = tmp_path / 'home' / 'tool-cache' / 'openfilm'
    state['chromium'] = chromium
    return state


def test_installs_once_and_names_the_toolkit_and_the_agent_browser(toolkit):
    toolkit['lock'](toolkit['payload'])
    toolkit['served'] = toolkit['payload']
    ready = media_tools.ensure_openfilm()
    said = json.loads(ready.read_text(encoding='utf-8'))
    folder = Path(said['toolkit'])
    assert folder == toolkit['cache'] / hashlib.sha256(toolkit['payload']).hexdigest()
    assert (folder / 'node_modules/openfilm/studio/server/server.mjs').is_file()
    assert said['chromium'] == str(toolkit['chromium'])
    assert said['patches'] == PATCHES
    assert toolkit['browser_calls'] == [{'render': True}]
    assert media_tools.ensure_openfilm() == ready
    assert toolkit['downloads'] == 1, 'a second call reuses the verified install'


@pytest.mark.parametrize('case', ['checksum', 'not the locked toolkit'])
def test_a_bad_download_installs_nothing_and_names_nothing(toolkit, case):
    if case == 'checksum':
        toolkit['lock'](toolkit['payload'])
        toolkit['served'] = toolkit['payload'][:-10]
        match = 'checksum mismatch'
    else:
        wrong = _toolkit(server=False)
        toolkit['lock'](wrong)
        toolkit['served'] = wrong
        match = 'not the locked toolkit'
    with pytest.raises(ValueError, match=match):
        media_tools.ensure_openfilm()
    assert not (toolkit['cache'] / 'ready.json').exists()
    assert [p.name for p in toolkit['cache'].iterdir() if p.name != 'install.lock'] == []


def test_a_damaged_install_is_downloaded_again(toolkit):
    toolkit['lock'](toolkit['payload'])
    toolkit['served'] = toolkit['payload']
    folder = Path(json.loads(media_tools.ensure_openfilm().read_text(encoding='utf-8'))['toolkit'])
    (folder / 'node_modules/openfilm/studio/server/server.mjs').unlink()
    media_tools.ensure_openfilm()
    assert toolkit['downloads'] == 2
    assert (folder / 'node_modules/openfilm/studio/server/server.mjs').is_file()


def test_a_moved_pin_installs_the_pinned_toolkit_and_ready_json_names_it(toolkit):
    # hc-1199: an APEX update moves the pin; the old toolkit stays on disk, but ready.json now names the new one.
    toolkit['lock'](toolkit['payload'])
    toolkit['served'] = toolkit['payload']
    old = json.loads(media_tools.ensure_openfilm().read_text(encoding='utf-8'))
    moved = gzip.compress(gzip.decompress(toolkit['payload']) + b'\0' * 512)  # the same files, another archive
    toolkit['lock'](moved)
    toolkit['served'] = moved
    assert media_tools.openfilm_pin()['sha256'] == hashlib.sha256(moved).hexdigest()
    said = json.loads(media_tools.ensure_openfilm().read_text(encoding='utf-8'))
    assert toolkit['downloads'] == 2
    assert said['sha256'] == hashlib.sha256(moved).hexdigest() != old['sha256']
    assert said['toolkit'] == str(toolkit['cache'] / said['sha256']) != old['toolkit']
    assert Path(old['toolkit']).is_dir(), 'a Studio may still run from it until Desktop restarts it'


def test_only_apex_cos_is_downloaded_from(toolkit):
    toolkit['lock'](toolkit['payload'], url='https://registry.npmjs.org/openfilm/-/openfilm-0.3.0.tgz')
    toolkit['served'] = toolkit['payload']
    with pytest.raises(ValueError, match='must use APEX COS'):
        media_tools.ensure_openfilm()
    assert toolkit['downloads'] == 0


def test_another_patch_set_is_not_taken_for_the_locked_one(toolkit):
    other = _toolkit(manifest_patches=['0001-keep-track-fields'])
    toolkit['lock'](other)
    toolkit['served'] = other
    with pytest.raises(ValueError, match='not the locked toolkit'):
        media_tools.ensure_openfilm()
