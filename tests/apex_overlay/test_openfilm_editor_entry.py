"""hc-1201: the engine's side of the titlebar's 剪辑 and of the editor opened to whole plans.

- The engine's tools check says which Desktop asks (``film_project.CLIENT_HEADERS``), from the environment Desktop's
  main process writes (apps/desktop/electron/apex-desktop-client.ts): apex-nodes opens the editor plan-wide only to a
  Desktop that says it is new enough, so a check without them is an older Desktop's.
- The install says how far its downloads are when Desktop asks for it (``media_tools.PROGRESS_ENV``), and never
  otherwise.
- ``media_tools openfilm-check`` is the first-run check: what is installed, and whether the disk has room.
"""
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import threading

import pytest

from apex_overlay import film_project, media_tools

ROOT = Path(__file__).resolve().parents[2]
DESKTOP = ROOT / 'apps/desktop/electron'


# ── which Desktop asks ──────────────────────────────────────────────────────

@pytest.fixture
def scheduler(monkeypatch):
    """The Scheduler's tools check on a local port; notes every header of each request."""
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    asked = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            asked.append({name.lower(): value for name, value in self.headers.items()})
            data = json.dumps({'ok': True, 'openfilm': {'enabled': True}}).encode()
            self.send_response(200)
            self.send_header('content-type', 'application/json')
            self.send_header('content-length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    for name in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'):
        monkeypatch.delenv(name, raising=False)
    yield {film_project.BASE_ENV: f'http://127.0.0.1:{server.server_port}', film_project.KEY_ENV: 'k'}, asked
    server.shutdown()


@pytest.mark.parametrize('env, sent', [
    ({'APEX_DESKTOP_VERSION': '0.17.77', 'APEX_DESKTOP_PLATFORM': 'mac-arm64'},
     {'x-apex-desktop-version': '0.17.77', 'x-apex-desktop-platform': 'mac-arm64'}),
    ({'APEX_DESKTOP_VERSION': '0.17.77'}, {'x-apex-desktop-version': '0.17.77'}),
    ({'APEX_DESKTOP_VERSION': ' ', 'APEX_DESKTOP_PLATFORM': ''}, {}),
    ({}, {}),
])
def test_the_check_says_which_desktop_asks_from_the_environment_desktop_writes(scheduler, env, sent):
    base, asked = scheduler
    assert film_project.editor_on({**base, **env}) is True
    headers = asked[0]
    assert headers['authorization'] == 'Bearer k'
    assert {name: value for name, value in headers.items() if name.startswith('x-apex-desktop-')} == sent


def test_the_names_are_the_ones_desktop_writes_and_sends():
    """The engine reads the variables main writes and sends the headers main sends (apex-desktop-client.ts)."""
    source = (DESKTOP / 'apex-desktop-client.ts').read_text(encoding='utf-8')
    for env_name, header in film_project.CLIENT_HEADERS:
        assert f"= '{env_name}'" in source
        assert f"= '{header}'" in source


# ── progress while installing ───────────────────────────────────────────────

def _toolkit() -> bytes:
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode='w') as tar:
        def add(name, data):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
        add('apex-toolkit.json', json.dumps({'schema': 1, 'openfilm': '0.3.0', 'patches': [{'file': 'p1.patch'}]}).encode())
        add('node_modules/openfilm/studio/server/server.mjs', b'export {}' + b' ' * (3 * 1024 * 1024))
    return gzip.compress(raw.getvalue(), compresslevel=0)


@pytest.fixture
def toolkit(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path / 'home'))
    payload = _toolkit()
    lock = tmp_path / 'desktop-lock.json'
    lock.write_text(json.dumps({'openfilm': {
        'version': '0.3.0', 'patches': ['p1'], 'bytes': len(payload), 'sha256': hashlib.sha256(payload).hexdigest(),
        'url': f'https://{media_tools.COS_HOST}/media-tools/openfilm/0.3.0/x/openfilm-toolkit.tgz',
    }}))
    monkeypatch.setattr(media_tools, 'LOCK', lock)
    monkeypatch.setattr(media_tools.urllib.request, 'urlopen', lambda *args, **kwargs: io.BytesIO(payload))
    monkeypatch.setattr(media_tools, 'ensure_browser', lambda **kwargs: tmp_path / 'chrome' / 'chrome')
    return payload


def _progress_lines(text: str) -> list[dict]:
    return [json.loads(line[len(media_tools.PROGRESS_MARK):]) for line in text.splitlines()
            if line.startswith(media_tools.PROGRESS_MARK)]


def test_the_install_says_how_far_its_download_is_when_desktop_asks(toolkit, monkeypatch, capsys):
    monkeypatch.setenv(media_tools.PROGRESS_ENV, '1')
    media_tools.ensure_openfilm()
    lines = _progress_lines(capsys.readouterr().out)
    assert len(lines) >= 2, 'one line per megabyte read'
    assert {line['step'] for line in lines} == {'toolkit'}
    assert all(line['total'] == len(toolkit) for line in lines)
    assert [line['done'] for line in lines] == sorted(line['done'] for line in lines)
    assert lines[-1]['done'] == len(toolkit)


@pytest.mark.parametrize('value', [None, '0', ''])
def test_nobody_else_gets_progress_lines(toolkit, monkeypatch, capsys, value):
    if value is None:
        monkeypatch.delenv(media_tools.PROGRESS_ENV, raising=False)
    else:
        monkeypatch.setenv(media_tools.PROGRESS_ENV, value)
    media_tools.ensure_openfilm()
    assert _progress_lines(capsys.readouterr().out) == []


def test_desktop_reads_the_same_marks():
    source = (DESKTOP / 'openfilm-studio.ts').read_text(encoding='utf-8')
    assert f"INSTALL_PROGRESS_MARK = '{media_tools.PROGRESS_MARK}'" in source
    assert f"INSTALL_PROGRESS_ENV = '{media_tools.PROGRESS_ENV}'" in source
    assert "CHECK_ARGS = ['-m', 'apex_overlay.media_tools', 'openfilm-check']" in source


# ── the first-run check ─────────────────────────────────────────────────────

@pytest.fixture
def check_lock(tmp_path, monkeypatch):
    home = tmp_path / 'home'
    monkeypatch.setenv('HERMES_HOME', str(home))
    # What the check answers depends only on the lock entry it reads, not on the host: so one fixed entry, and these
    # run on CI's Linux lane too, where native_target() has no answer (the lock names Mac and Windows only).
    target = 'mac-arm64'
    monkeypatch.setattr(media_tools, 'native_target', lambda: target)
    browser = {'url': 'https://x/b.zip', 'bytes': 190_000_000, 'sha256': 'b' * 64, 'executable': 'Chrome/chrome'}
    toolkit = {'url': 'https://x/t.tgz', 'bytes': 40_000_000, 'sha256': 't' * 64, 'version': '0.3.0', 'patches': []}
    lock = tmp_path / 'desktop-lock.json'
    lock.write_text(json.dumps({'browser': {target: browser, f'render-{target}': browser}, 'openfilm': toolkit}))
    monkeypatch.setattr(media_tools, 'LOCK', lock)
    return {'home': home, 'browser': browser, 'toolkit': toolkit}


def _install_browser(state):
    executable = state['home'] / 'tool-cache' / 'chrome' / state['browser']['sha256'] / state['browser']['executable']
    executable.parent.mkdir(parents=True)
    executable.write_text('')
    return executable


def _name_toolkit(state, sha256, chromium):
    folder = state['home'] / 'tool-cache' / 'openfilm' / sha256
    (folder / 'node_modules/openfilm/studio/server').mkdir(parents=True)
    (folder / 'node_modules/openfilm/studio/server/server.mjs').write_text('')
    (state['home'] / 'tool-cache' / 'openfilm' / 'ready.json').write_text(json.dumps(
        {'sha256': sha256, 'toolkit': str(folder), 'chromium': str(chromium)}))


def test_nothing_installed_needs_both_with_room(check_lock):
    said = media_tools.openfilm_check()
    assert said['browser'] == {'ready': False, 'bytes': 190_000_000}
    assert said['toolkit'] == {'ready': False, 'bytes': 40_000_000}
    assert said['disk']['needed'] == (190_000_000 + 40_000_000) * 3 + 256 * 1024 * 1024
    assert said['disk']['free'] > 0, 'measured on the nearest folder that exists'


def test_everything_installed_needs_nothing(check_lock):
    chromium = _install_browser(check_lock)
    _name_toolkit(check_lock, check_lock['toolkit']['sha256'], chromium)
    said = media_tools.openfilm_check()
    assert said['browser']['ready'] is True and said['toolkit']['ready'] is True
    assert said['disk']['needed'] == 0


def test_a_toolkit_ready_json_names_that_is_not_this_engines_pin_is_not_installed(check_lock):
    """After an APEX update moved the pin, ready.json still names the old toolkit (hc-1199)."""
    chromium = _install_browser(check_lock)
    _name_toolkit(check_lock, 'o' * 64, chromium)
    said = media_tools.openfilm_check()
    assert said['browser']['ready'] is True
    assert said['toolkit']['ready'] is False
    assert said['disk']['needed'] == 40_000_000 * 3 + 256 * 1024 * 1024


@pytest.mark.platforms("macos", "windows")
def test_the_check_from_the_command_line_is_one_line_of_json(tmp_path):
    """As Desktop runs it (``CHECK_ARGS``): the real lock, a fresh home, nothing installed, nothing downloaded.

    Only where Desktop runs: the real lock names no Linux browser, so on Linux the check rightly says it is unavailable.
    """
    env = {**os.environ, 'HERMES_HOME': str(tmp_path / 'home')}
    done = subprocess.run([sys.executable, '-m', 'apex_overlay.media_tools', 'openfilm-check'], cwd=ROOT, env=env,
                          capture_output=True, text=True, timeout=60, check=False)
    assert done.returncode == 0, done.stderr
    lines = done.stdout.strip().splitlines()
    assert len(lines) == 1
    said = json.loads(lines[0])
    assert said['browser']['ready'] is False and said['toolkit']['ready'] is False
    assert said['toolkit']['bytes'] == json.loads(media_tools.LOCK.read_text(encoding='utf-8-sig'))['openfilm']['bytes']
    assert not (tmp_path / 'home' / 'tool-cache').exists(), 'the check installs nothing'
