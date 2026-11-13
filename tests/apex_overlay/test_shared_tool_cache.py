"""hc-1230: what APEX downloads from COS is kept once per computer, for APEX and every assistant.

Desktop's assistants are Hermes profiles under the root (``<root>/profiles/apex-bot-N``). The engine that hosts them
scopes HERMES_HOME to the assistant of each call and hands it to every process it starts, so a cache under HERMES_HOME
was a new, empty one per assistant: its first browser task, video or caption downloaded the browser, the OpenFilm and
motion toolkits and the font again (about 430 MB, seen on 0.17.76 on 2026-11-12). They are read-only once installed
and named by their SHA-256, so ``media_tools.tool_cache`` keeps them under the root, with each kind's install lock and
ready.json, and one install serves APEX, every assistant and Desktop.
"""
from __future__ import annotations

import ast
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import threading
import time
from types import SimpleNamespace

import filelock
import pytest

from apex_overlay import film_project, media_tools

ROOT = Path(__file__).resolve().parents[2]
#: One lock key on every host: these also run on CI's Linux lane, where native_target() has no answer.
TARGET = 'fixture'
#: Windows' ensure_browser reads the executable's PE header; elsewhere its `--version` run is answered here.
EXECUTABLE = 'chrome/chrome.exe' if os.name == 'nt' else 'chrome/chrome'
ASSISTANTS = ('apex-bot-2', 'apex-bot-3')


def _tar(files: dict[str, bytes], *, gz: bool = False) -> bytes:
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode='w') as tar:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size, info.mode = len(data), 0o755
            tar.addfile(info, io.BytesIO(data))
    return gzip.compress(raw.getvalue()) if gz else raw.getvalue()


def _assistant_caches(root: Path) -> list[str]:
    return sorted(p.relative_to(root).as_posix() for p in (root / 'profiles').glob('*/tool-cache'))


@pytest.fixture
def apex(tmp_path, monkeypatch):
    """APEX's root with two assistants; a lock pinning a stand-in browser, font and OpenFilm toolkit on APEX COS;
    downloads served from memory and counted."""
    root = tmp_path / 'apexnodes'
    homes = {'APEX': root, **{name: root / 'profiles' / name for name in ASSISTANTS}}
    for home in homes.values():
        home.mkdir(parents=True, exist_ok=True)
    served = {}

    def entry(name, payload, **extra):
        url = f'https://{media_tools.COS_HOST}/media-tools/{name}'
        served[url] = payload
        return {'url': url, 'bytes': len(payload), 'sha256': hashlib.sha256(payload).hexdigest(), **extra}

    browser = entry('chrome/browser.zip', _tar({EXECUTABLE: Path(sys.executable).read_bytes() if os.name == 'nt'
                                               else b'#!/bin/sh\n'}), executable=EXECUTABLE)
    toolkit = _tar({
        'apex-toolkit.json': json.dumps({'openfilm': '0.3.0', 'patches': [{'file': '0001-keep-track-fields.patch'}]}).encode(),
        'node_modules/openfilm/studio/server/server.mjs': b'export {}',
        'node_modules/openfilm/bin/openfilm.mjs': b'',
    }, gz=True)
    lock = tmp_path / 'desktop-lock.json'
    lock.write_text(json.dumps({
        'browser': {TARGET: browser, f'render-{TARGET}': browser},
        'fonts': {'subtitle': entry('fonts/Fixture.otf', b'OTTO' + bytes(range(256)) * 16, file='Fixture.otf')},
        'openfilm': entry('openfilm/openfilm-toolkit.tgz', toolkit, version='0.3.0', patches=['0001-keep-track-fields']),
    }))
    monkeypatch.setattr(media_tools, 'LOCK', lock)
    monkeypatch.setattr(media_tools, 'native_target', lambda: TARGET)
    downloads = []

    def urlopen(url, **_kwargs):
        downloads.append(url.rsplit('/', 1)[-1])
        return io.BytesIO(served[url])

    monkeypatch.setattr(media_tools.urllib.request, 'urlopen', urlopen)
    run = media_tools.subprocess.run

    def answer_version(command, **kwargs):
        if command[-1] == '--version':
            return subprocess.CompletedProcess(command, 0)
        return run(command, **kwargs)

    monkeypatch.setattr(media_tools.subprocess, 'run', answer_version)

    def serve_as(name):
        """As a process for that home runs: an engine of its own, or a process the engine started for it."""
        monkeypatch.setenv('HERMES_HOME', str(homes[name]))

    return SimpleNamespace(root=root, homes=homes, cache=root / 'tool-cache', lock=lock, downloads=downloads,
                           serve_as=serve_as)


# ── where the cache is ──────────────────────────────────────────────────────

@pytest.mark.platforms('any')
@pytest.mark.parametrize('layout', ['APEX root', 'Hermes default root'])
@pytest.mark.parametrize('scope', ['engine of its own', 'scoped on one engine'])
def test_the_cache_is_the_roots_for_apex_and_every_assistant(tmp_path, monkeypatch, layout, scope):
    from hermes_constants import _get_platform_default_hermes_home, reset_hermes_home_override, set_hermes_home_override
    # APEX keeps its root beside the Hermes default (~/.apexnodes, %LOCALAPPDATA%\apexnodes); plain Hermes in it.
    root = tmp_path / 'apexnodes' if layout == 'APEX root' else _get_platform_default_hermes_home()
    assistant = root / 'profiles' / 'apex-bot-2'
    assistant.mkdir(parents=True)
    expected = root / 'tool-cache' / 'chrome'
    monkeypatch.setenv('HERMES_HOME', str(root))
    assert media_tools.tool_cache('chrome') == expected
    if scope == 'engine of its own':  # or a process an engine started for the assistant: HERMES_HOME is its home
        monkeypatch.setenv('HERMES_HOME', str(assistant))
        assert media_tools.tool_cache('chrome') == expected
    else:  # hc-1166: the engine started as APEX runs the assistant's call in the assistant's scope
        token = set_hermes_home_override(str(assistant))
        try:
            assert media_tools.tool_cache('chrome') == expected
        finally:
            reset_hermes_home_override(token)


def test_a_call_scoped_to_another_roots_profile_uses_that_roots_cache(tmp_path, monkeypatch):
    """The root of the call's scoped home, as upstream's pm resolves dependency state, not the launch home's: the
    Desktop that reads ready.json is that root's."""
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override
    monkeypatch.setenv('HERMES_HOME', str(tmp_path / 'launch'))
    token = set_hermes_home_override(str(tmp_path / 'other' / 'profiles' / 'apex-bot-2'))
    try:
        assert media_tools.tool_cache('fonts') == tmp_path / 'other' / 'tool-cache' / 'fonts'
    finally:
        reset_hermes_home_override(token)


# ── one install for everyone ────────────────────────────────────────────────

@pytest.mark.platforms('any')
@pytest.mark.parametrize('first', ['APEX', 'apex-bot-2'])
def test_the_browser_is_downloaded_once_for_apex_and_every_assistant(apex, first):
    apex.serve_as(first)
    chromium = media_tools.ensure_browser()
    for name in apex.homes:
        apex.serve_as(name)
        assert {'agent': media_tools.ensure_browser(), 'render': media_tools.ensure_browser(render=True)} == {
            'agent': chromium, 'render': chromium}, name
    assert apex.downloads == ['browser.zip']
    assert chromium.is_file() and chromium.is_relative_to(apex.cache / 'chrome')
    assert _assistant_caches(apex.root) == []


@pytest.mark.parametrize('first', ['APEX', 'apex-bot-2'])
def test_the_subtitle_font_is_downloaded_once_for_apex_and_every_assistant(apex, first):
    apex.serve_as(first)
    font = media_tools.ensure_font()
    for name in apex.homes:
        apex.serve_as(name)
        assert media_tools.ensure_font() == font, name
    assert apex.downloads == ['Fixture.otf']
    assert font.is_relative_to(apex.cache / 'fonts')
    assert _assistant_caches(apex.root) == []


def test_an_assistant_finds_the_editor_toolkit_desktop_installed(apex):
    """Desktop installs the toolkit with the engine at its own home, the root (openfilm-studio.ts INSTALL_ARGS); an
    assistant's check, its `openfilm` and its own install then all take that one."""
    apex.serve_as('APEX')
    ready = media_tools.ensure_openfilm()
    said = json.loads(ready.read_text(encoding='utf-8'))
    for name in ASSISTANTS:
        apex.serve_as(name)
        check = media_tools.openfilm_check()
        assert {'browser': check['browser']['ready'], 'toolkit': check['toolkit']['ready'],
                'needed': check['disk']['needed']} == {'browser': True, 'toolkit': True, 'needed': 0}, name
        assert film_project.ready_toolkit() == {
            'toolkit': said['toolkit'], 'chromium': said['chromium'],
            'cli': str(Path(said['toolkit']) / 'node_modules' / 'openfilm' / 'bin' / 'openfilm.mjs')}, name
        assert media_tools.ensure_openfilm() == ready
    assert apex.downloads == ['browser.zip', 'openfilm-toolkit.tgz']
    assert _assistant_caches(apex.root) == []


def test_a_toolkit_an_assistant_installs_is_named_where_desktop_reads(apex):
    apex.serve_as('apex-bot-2')
    ready = media_tools.ensure_openfilm()
    # planOpenfilmStudio(env, <Desktop's HERMES_HOME, the root>).ready; see the Desktop test below
    assert ready == apex.root / 'tool-cache' / 'openfilm' / 'ready.json'
    said = json.loads(ready.read_text(encoding='utf-8'))
    assert Path(said['toolkit']).parent == apex.cache / 'openfilm'
    assert Path(said['chromium']).is_relative_to(apex.cache / 'chrome')
    apex.serve_as('APEX')
    assert film_project.ready_toolkit() is not None
    assert apex.downloads == ['browser.zip', 'openfilm-toolkit.tgz']
    assert _assistant_caches(apex.root) == []


def test_desktop_reads_ready_json_where_every_assistant_writes_it():
    """The twin reader (hard rule 12): Desktop's Studio takes ``<HERMES_HOME>/tool-cache/openfilm/ready.json`` with
    main's HERMES_HOME, which ``resolveHermesHome`` normalises to the root (backend-env.ts normalizeHermesHomeRoot maps
    a profile's home to its root). That is where ensure_openfilm now writes it from any home under the root."""
    studio = (ROOT / 'apps/desktop/electron/openfilm-studio.ts').read_text(encoding='utf-8')
    joined = re.search(r'ready: join\(hermesHome, ([^)]*)\)', studio).group(1)
    assert Path(*re.findall(r"'([^']+)'", joined)) == Path('tool-cache', 'openfilm', 'ready.json')
    main = (ROOT / 'apps/desktop/electron/main.ts').read_text(encoding='utf-8')
    # the call's own property (two-space lines), not the one its basePath passes to buildDesktopBackendPath
    assert re.search(r'= createOpenfilmStudio\(\{\n(?:  \S[^\n]*\n)*?  hermesHome: HERMES_HOME,\n', main)
    assert 'const HERMES_HOME = resolveHermesHome()' in main
    resolve = main[main.index('function resolveHermesHome()'):][:300]
    assert 'return normalizeHermesHomeRoot(process.env.HERMES_HOME)' in resolve


# ── installs at the same time ───────────────────────────────────────────────

@pytest.fixture
def impatient_locks(monkeypatch):
    """Install locks that give up after 0.3 s instead of half an hour, so a second install proves it waited on the
    first one's lock by timing out while that one holds it."""
    real = filelock.FileLock

    def lock(path, timeout=-1, **kwargs):
        return real(path, timeout=0.3, **kwargs)

    monkeypatch.setattr(filelock, 'FileLock', lock)


def _first_download_held(apex, monkeypatch):
    """The first download blocks until released; later ones are answered at once (so a second install that does not
    wait on the lock downloads right away instead of hanging)."""
    serve = media_tools.urllib.request.urlopen
    downloading, release = threading.Event(), threading.Event()

    def urlopen(url, **kwargs):
        response = serve(url, **kwargs)
        if not downloading.is_set():
            downloading.set()
            assert release.wait(30)
        return response

    monkeypatch.setattr(media_tools.urllib.request, 'urlopen', urlopen)
    return downloading, release


@pytest.mark.platforms('any')
def test_two_assistants_on_one_engine_installing_at_once_download_once(apex, monkeypatch, impatient_locks):
    """hc-1166's engine runs each assistant's call in that assistant's scope, on threads of one process. The second
    install waits on the first one's lock (each call opens its own handle on the lock file) and then takes its font."""
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override
    apex.serve_as('APEX')  # the engine's own home
    downloading, release = _first_download_held(apex, monkeypatch)
    found = {}

    def scoped(name):
        token = set_hermes_home_override(str(apex.homes[name]))
        try:
            found[name] = media_tools.ensure_font()
        except Exception as exc:  # asserted below
            found[name] = exc
        finally:
            reset_hermes_home_override(token)

    first = threading.Thread(target=scoped, args=('apex-bot-2',))
    first.start()
    try:
        assert downloading.wait(30), 'the first install started its download'
        scoped('apex-bot-3')
        assert isinstance(found['apex-bot-3'], filelock.Timeout), found['apex-bot-3']
    finally:
        release.set()
        first.join(30)
    scoped('apex-bot-3')
    assert found['apex-bot-3'] == found['apex-bot-2']
    assert apex.downloads == ['Fixture.otf']


_CHILD = '''
import io, sys, time, urllib.request
from pathlib import Path
from apex_overlay import media_tools
media_tools.LOCK, payload, marks = Path(sys.argv[1]), Path(sys.argv[2]).read_bytes(), Path(sys.argv[3])
def urlopen(url, **kwargs):
    (marks / 'downloading').write_text(url)
    while not (marks / 'release').exists():
        time.sleep(0.02)
    return io.BytesIO(payload)
urllib.request.urlopen = urlopen
print(media_tools.ensure_font())
'''


@pytest.mark.platforms('any')
def test_a_process_one_assistant_started_and_another_assistant_download_once(apex, tmp_path, monkeypatch,
                                                                             impatient_locks):
    """What the agent runs (``$APEX_PYTHON -m apex_overlay.media_tools font``) is a process with the assistant's
    HERMES_HOME. While one assistant's process downloads, another assistant's install waits on the same lock, then
    takes that font."""
    marks = tmp_path / 'marks'
    marks.mkdir()
    payload = tmp_path / 'font.bin'
    payload.write_bytes(b'OTTO' + bytes(range(256)) * 16)
    child = subprocess.Popen(
        [sys.executable, '-c', _CHILD, str(apex.lock), str(payload), str(marks)], cwd=ROOT,
        env={**os.environ, 'HERMES_HOME': str(apex.homes['apex-bot-2']),
             'PYTHONPATH': os.pathsep.join(filter(None, [str(ROOT), os.environ.get('PYTHONPATH')]))},
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        deadline = time.monotonic() + 60
        while not (marks / 'downloading').exists():
            assert child.poll() is None, child.communicate()
            assert time.monotonic() < deadline, 'the first install started its download'
            time.sleep(0.02)
        apex.serve_as('apex-bot-3')
        with pytest.raises(filelock.Timeout):
            media_tools.ensure_font()
    finally:
        (marks / 'release').write_text('')
        out, err = child.communicate(timeout=60)
    assert child.returncode == 0, err
    font = media_tools.ensure_font()
    assert Path(out.strip()) == font and font.is_relative_to(apex.cache / 'fonts')
    assert apex.downloads == [], 'this process took the font the other one downloaded'
    assert _assistant_caches(apex.root) == []


# ── every installer, and every path ─────────────────────────────────────────

def _installers() -> list[str]:
    """Every installer media_tools has: its ``ensure_*``, including ones added after this ticket (motion's)."""
    return sorted(name for name, value in vars(media_tools).items() if name.startswith('ensure_') and callable(value))


@pytest.mark.parametrize('name', _installers())
def test_no_installer_keeps_a_download_in_an_assistants_own_home(name, tmp_path, monkeypatch):
    """With the real lock, the Agent browser already in the shared cache and COS unreachable, an installer called from
    an assistant's home either finds its tool in the shared cache or gets as far as its download, and nothing lands in
    that home."""
    root = tmp_path / 'apexnodes'
    home = root / 'profiles' / 'apex-bot-2'
    home.mkdir(parents=True)
    monkeypatch.setenv('HERMES_HOME', str(home))
    monkeypatch.setattr(media_tools, 'native_target', lambda: 'win-x64' if os.name == 'nt' else 'mac-arm64')
    for spec in json.loads(media_tools.LOCK.read_text(encoding='utf-8-sig'))['browser'].values():
        executable = root / 'tool-cache' / 'chrome' / spec['sha256'] / spec['executable']
        executable.parent.mkdir(parents=True, exist_ok=True)
        executable.write_bytes(b'')

    class Offline(OSError):
        pass

    asked = []

    def offline(url, **_kwargs):
        asked.append(url)
        raise Offline(url)

    monkeypatch.setattr(media_tools.urllib.request, 'urlopen', offline)
    try:
        found = getattr(media_tools, name)()
    except Offline:
        found = None
    assert asked or found is not None, 'it got as far as its download, or found its tool'
    assert found is None or Path(found).is_relative_to(root / 'tool-cache')
    assert not (home / 'tool-cache').exists()


def _named_in_code(path: Path) -> list[int]:
    """Lines where code (not a docstring or a comment) names the tool-cache folder, outside ``tool_cache`` itself."""
    tree = ast.parse(path.read_text(encoding='utf-8'))
    skipped = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = node.body
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
                skipped.add(id(body[0].value))
            if isinstance(node, ast.FunctionDef) and node.name == 'tool_cache' and path.name == 'media_tools.py':
                skipped.update(id(inner) for inner in ast.walk(node))
    return sorted(node.lineno for node in ast.walk(tree)
                  if isinstance(node, ast.Constant) and isinstance(node.value, str) and 'tool-cache' in node.value
                  and id(node) not in skipped)


def test_every_tool_cache_path_in_apex_code_comes_from_tool_cache():
    """A tripwire for a new exit (hard rule 12): APEX's overlay and plugins name the folder only through
    ``media_tools.tool_cache``, so a new kind of download cannot quietly start a cache per assistant again."""
    files = sorted([*(ROOT / 'apex_overlay').rglob('*.py'), *(ROOT / 'plugins').glob('apex*/**/*.py'),
                    *(ROOT / 'plugins').glob('apex*.py')])
    assert ROOT / 'apex_overlay' / 'media_tools.py' in files and ROOT / 'apex_overlay' / 'film_project.py' in files
    found = {path.relative_to(ROOT).as_posix(): lines for path in files if (lines := _named_in_code(path))}
    assert found == {}
