"""hc-1221: the motion toolkit (trimmed huashu-motion) comes from APEX COS only, checked, unpacked whole, named in
ready.json last, and `motion` runs its `om` in the Agent browser's Chromium; commands it does not carry say what to
use instead."""
import gzip
import hashlib
import io
import json
from pathlib import Path
import tarfile

import pytest

from apex_overlay import media_tools

INTEGRITY = 'sha512-test'


def _toolkit(package='huashu-motion', cli=True) -> bytes:
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode='w') as tar:
        def add(name, data):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
        add('apex-toolkit.json', json.dumps({'schema': 1, 'package': package, 'version': '0.4.0', 'integrity': INTEGRITY}).encode())
        add('package.json', b'{"name": "huashu-motion", "version": "0.4.0"}')
        if cli:
            add('cli/om.js', b'// om')
    return gzip.compress(raw.getvalue())


@pytest.fixture
def toolkit(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path / 'home'))
    state = {'payload': _toolkit(), 'downloads': 0, 'browser_calls': []}
    chromium = tmp_path / 'chrome' / 'chrome'

    def lock(payload, url=None):
        path = tmp_path / 'desktop-lock.json'
        path.write_text(json.dumps({'motion': {
            'version': '0.4.0', 'integrity': INTEGRITY, 'bytes': len(payload), 'sha256': hashlib.sha256(payload).hexdigest(),
            'url': url or f'https://{media_tools.COS_HOST}/media-tools/motion/0.4.0/x/motion-toolkit.tgz',
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
    state.update(lock=lock, cache=tmp_path / 'home' / 'tool-cache' / 'motion', chromium=chromium)
    return state


def test_installs_once_and_names_the_toolkit_and_the_agent_browser(toolkit):
    toolkit['lock'](toolkit['payload'])
    toolkit['served'] = toolkit['payload']
    ready = media_tools.ensure_motion()
    said = json.loads(ready.read_text(encoding='utf-8'))
    assert Path(said['toolkit']) == toolkit['cache'] / hashlib.sha256(toolkit['payload']).hexdigest()
    assert (Path(said['toolkit']) / 'cli/om.js').is_file()
    assert said['chromium'] == str(toolkit['chromium'])
    assert toolkit['browser_calls'] == [{'render': True}]
    assert media_tools.ensure_motion() == ready
    assert toolkit['downloads'] == 1, 'a second call reuses the verified install'


@pytest.mark.parametrize('case', ['checksum', 'no cli', 'another package'])
def test_a_bad_download_installs_nothing_and_names_nothing(toolkit, case):
    if case == 'checksum':
        toolkit['lock'](toolkit['payload'])
        toolkit['served'] = toolkit['payload'][:-10]
        match = 'checksum mismatch'
    else:
        wrong = _toolkit(cli=False) if case == 'no cli' else _toolkit(package='openfilm')
        toolkit['lock'](wrong)
        toolkit['served'] = wrong
        match = 'not the locked toolkit'
    with pytest.raises(ValueError, match=match):
        media_tools.ensure_motion()
    assert not (toolkit['cache'] / 'ready.json').exists()
    assert [p.name for p in toolkit['cache'].iterdir() if p.name != 'install.lock'] == []


def test_a_damaged_install_is_downloaded_again(toolkit):
    toolkit['lock'](toolkit['payload'])
    toolkit['served'] = toolkit['payload']
    folder = Path(json.loads(media_tools.ensure_motion().read_text(encoding='utf-8'))['toolkit'])
    (folder / 'cli/om.js').unlink()
    media_tools.ensure_motion()
    assert toolkit['downloads'] == 2 and (folder / 'cli/om.js').is_file()


def test_only_apex_cos_is_downloaded_from(toolkit):
    toolkit['lock'](toolkit['payload'], url='https://registry.npmjs.org/huashu-motion/-/huashu-motion-0.4.0.tgz')
    toolkit['served'] = toolkit['payload']
    with pytest.raises(ValueError, match='must use APEX COS'):
        media_tools.ensure_motion()
    assert toolkit['downloads'] == 0


def test_motion_runs_om_with_the_agent_browser_and_bundled_tools(toolkit, monkeypatch):
    toolkit['lock'](toolkit['payload'])
    toolkit['served'] = toolkit['payload']
    media_tools.ensure_motion()  # installed first: the stand-in below replaces subprocess.run, which unpacks it
    calls = []
    monkeypatch.setattr(media_tools, 'motion_node', lambda: '/runtime/node')
    monkeypatch.setattr(media_tools.subprocess, 'run', lambda argv, **kw: calls.append((argv, kw)) or media_tools.subprocess.CompletedProcess(argv, 0))
    assert media_tools.run_motion(['render', 'film', '--fps', '30']) == 0
    (argv, kw), = calls
    folder = toolkit['cache'] / hashlib.sha256(toolkit['payload']).hexdigest()
    assert argv == ['/runtime/node', str(folder / 'cli/om.js'), 'render', 'film', '--fps', '30']
    assert kw['env']['OM_CHROME'] == str(toolkit['chromium']) and kw['timeout'] == media_tools.MOTION_TIMEOUT


@pytest.mark.parametrize('command', sorted(media_tools.MOTION_NOT_CARRIED))
def test_commands_the_toolkit_does_not_carry_say_what_to_use(toolkit, monkeypatch, capsys, command):
    monkeypatch.setattr(media_tools, 'ensure_motion', lambda: pytest.fail('nothing is installed for a refused command'))
    assert media_tools.run_motion([command]) == 2
    said = capsys.readouterr().out
    assert f'`{command}` is not part of APEX' in said and media_tools.MOTION_NOT_CARRIED[command] in said


def test_the_lock_pins_a_trimmed_huashu_motion_on_apex_cos():
    entry = json.loads(media_tools.LOCK.read_text(encoding='utf-8-sig'))['motion']
    assert entry['url'].startswith(f'https://{media_tools.COS_HOST}/media-tools/motion/{entry["version"]}/{entry["sha256"]}/')
    assert entry['integrity'].startswith('sha512-') and 'no GSAP' in entry['license']
