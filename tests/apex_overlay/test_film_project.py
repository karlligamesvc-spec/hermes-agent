"""hc-1177: the Agent's side of OpenFilm projects — whether the editor is open to this account (hc-1178: the
Scheduler's answer), OpenFilm's folders (Desktop's), what the person changed since the Agent's copy, and the
independent check after a write that the editor merged."""
import json
from pathlib import Path
import re
import threading
import time

import pytest

from apex_overlay import film_project

ROOT = Path(__file__).resolve().parents[2]
CAPTIONS = '<section>\n  <track kind="captions" src="captions.vtt" srclang="zh" label="字幕">\n</section>\n'


def film(*sections: str) -> str:
    return '<!doctype html>\n<html>\n<head><meta name="viewport" content="width=1080, height=1920"></head>\n<body>\n' + ''.join(sections) + '</body>\n</html>\n'


def clips(*tags: str, attrs: str = '') -> str:
    return f'<section{attrs}>\n' + ''.join(f'  {t}\n' for t in tags) + '</section>\n'


BASE = film(
    clips('<iframe id="hook" src="scenes/hook.html" at="0"></iframe>'),
    clips('<video id="shot01" src="assets/a.mp4#t=0,4" at="0"></video>', '<video id="shot03" src="assets/c.mp4#t=0,6" at="4"></video>'),
    CAPTIONS,
)
VTT = 'WEBVTT\n\n00:00.000 --> 00:02.000\n菜是我买的\n\n00:02.000 --> 00:04.000\n这间厨房不是我的\n'


@pytest.fixture
def project(tmp_path):
    folder = tmp_path / 'cook'
    folder.mkdir()
    (folder / 'film.html').write_text(BASE, encoding='utf-8')
    (folder / 'captions.vtt').write_text(VTT, encoding='utf-8')
    (folder / 'scenes').mkdir()
    (folder / 'scenes' / 'hook.html').write_text('<p>hook</p>\n', encoding='utf-8')
    return folder


# ── the account's answer and OpenFilm's folders ─────────────────────────────

@pytest.fixture
def scheduler(monkeypatch):
    """The Scheduler's tools check on a local port, as the engine reaches it (the APEX key and base Desktop puts in
    its environment): it says what the test sets, and notes each request's path and Authorization."""
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    state = {'status': 200, 'body': {'ok': True, 'openfilm': {'enabled': True}}, 'asked': []}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            state['asked'].append((self.path, self.headers.get('Authorization')))
            data = json.dumps(state['body']).encode()
            self.send_response(state['status'])
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
    monkeypatch.setenv(film_project.BASE_ENV, f'http://127.0.0.1:{server.server_port}/')
    monkeypatch.setenv(film_project.KEY_ENV, 'apex-key-for-test')
    yield state
    server.shutdown()


@pytest.mark.parametrize('status, body, on', [
    (200, {'ok': True, 'openfilm': {'enabled': True}}, True),
    (200, {'ok': True, 'openfilm': {'enabled': False}}, False),
    (200, {'ok': True, 'chatcut': {'enabled': True}}, False),
    (200, {'ok': True, 'openfilm': {'enabled': 'true'}}, False),
    (401, {'error': 'unauthorized'}, False),
    (503, {}, False),
])
def test_the_editor_is_on_only_when_the_scheduler_says_so_for_this_account(scheduler, status, body, on):
    scheduler.update(status=status, body=body)
    assert film_project.editor_on() is on
    assert scheduler['asked'] == [('/tools/v1/check', 'Bearer apex-key-for-test')]


@pytest.mark.parametrize('missing', [film_project.KEY_ENV, film_project.BASE_ENV])
def test_signed_out_is_off_and_asks_nobody(scheduler, monkeypatch, missing):
    import httpx

    calls = []
    real = httpx.get
    monkeypatch.setattr(httpx, 'get', lambda *args, **kwargs: calls.append(args) or real(*args, **kwargs))
    monkeypatch.delenv(missing)
    assert film_project.editor_on() is False
    assert calls == [] and scheduler['asked'] == []


def test_a_scheduler_that_cannot_be_reached_is_off(monkeypatch):
    import socket

    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    for name in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'):
        monkeypatch.delenv(name, raising=False)
    assert film_project.editor_on({film_project.BASE_ENV: f'http://127.0.0.1:{port}', film_project.KEY_ENV: 'k'}) is False


def test_it_asks_where_desktop_asks():
    """The same check, path and field Desktop's main process reads (electron/openfilm-studio.ts)."""
    source = (ROOT / 'apps/desktop/electron/openfilm-studio.ts').read_text(encoding='utf-8')
    assert f"OPENFILM_CHECK_PATH = '{film_project.CHECK_PATH}'" in source
    assert 'said?.openfilm?.enabled === true' in source
    tools = (ROOT / 'apps/desktop/electron/apex-platform-tools.ts').read_text(encoding='utf-8')
    assert f'{film_project.KEY_ENV}: credential' in tools and f'{film_project.BASE_ENV}: host' in tools


def test_openfilm_folders_are_the_ones_desktop_editor_uses():
    source = (ROOT / 'apps/desktop/electron/openfilm-studio.ts').read_text(encoding='utf-8')
    block = re.search(r'export function openfilmStudioFolders\(dataRoot: string\)[^{]*\{\s*return \{(.*?)\}', source, re.DOTALL).group(1)
    desktop = dict(re.findall(r"(OPENFILM_[A-Z]+): join\(dataRoot, '([a-z]+)'\)", block))
    assert desktop and desktop == film_project.FOLDERS
    assert "join(hermesHome, 'openfilm')" in source, 'Desktop keeps them under HERMES_HOME/openfilm, as here'


def _ready(home: Path) -> dict:
    toolkit, chromium = home / 'tool-cache/openfilm/abc', home / 'tool-cache/chrome/x/chrome'
    (toolkit / 'node_modules/openfilm/bin').mkdir(parents=True)
    (toolkit / 'node_modules/openfilm/bin/openfilm.mjs').write_text('')
    chromium.parent.mkdir(parents=True)
    chromium.write_text('')
    (home / 'tool-cache/openfilm/ready.json').write_text(json.dumps({'toolkit': str(toolkit), 'chromium': str(chromium)}))
    return {'toolkit': toolkit, 'chromium': chromium}


def test_env_is_off_while_the_editor_is_not_open_to_the_account_and_installs_nothing(tmp_path, monkeypatch, capsys,
                                                                                      scheduler):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    scheduler['body'] = {'ok': True, 'openfilm': {'enabled': False}}
    _ready(tmp_path)
    from apex_overlay import media_tools
    monkeypatch.setattr(media_tools, 'ensure_openfilm', lambda: pytest.fail('nothing is installed while the editor is off'))
    assert film_project.main(['env']) == 2
    assert '没开' in capsys.readouterr().err


def test_env_runs_openfilm_with_the_editor_folders_no_browser_and_the_agent_browser(tmp_path, monkeypatch, capsys,
                                                                                   scheduler):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    ready = _ready(tmp_path)
    assert film_project.main(['env']) == 0
    said = json.loads(capsys.readouterr().out)
    assert said['cli'] == str(ready['toolkit'] / 'node_modules/openfilm/bin/openfilm.mjs')
    assert said['env'] == {
        **{name: str(tmp_path / 'openfilm' / folder) for name, folder in film_project.FOLDERS.items()},
        'OPENFILM_NO_BROWSER': '1', 'OPENFILM_NO_UPDATE_CHECK': '1', 'OPENFILM_HOSTED': '1',
        'OPENFILM_CHROMIUM': str(ready['chromium']),
    }


def test_hosted_is_the_switch_the_toolkit_patch_reads():
    # OPENFILM_HOSTED=1 is what keeps the agent's openfilm from starting a Studio nothing stops (patch 0003): the
    # name and the value the patch tests must be the ones env gives.
    patch = (ROOT / 'scripts/media-tools/openfilm/patches/0003-hosted-studio.patch').read_text(encoding='utf-8')
    pin = json.loads((ROOT / 'scripts/media-tools/openfilm/pin.json').read_text(encoding='utf-8'))
    assert "+  if (process.env.OPENFILM_HOSTED === '1') {" in patch
    assert 'patches/0003-hosted-studio.patch' in pin['patches']
    assert film_project.openfilm_env(Path('/h'), {'chromium': '/c'})['OPENFILM_HOSTED'] == '1'


def test_env_installs_the_toolkit_first_when_it_is_not_there(tmp_path, monkeypatch, capsys, scheduler):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    from apex_overlay import media_tools
    installs = []
    monkeypatch.setattr(media_tools, 'ensure_openfilm', lambda: installs.append(_ready(tmp_path)))
    assert film_project.main(['env']) == 0
    assert len(installs) == 1 and json.loads(capsys.readouterr().out)['cli'].endswith('openfilm.mjs')


# ── what the person changed since the Agent's copy ─────────────────────────

def test_diff_names_caption_text_splits_overrides_and_caption_track_changes(project):
    film_project.snapshot(project)
    person = BASE.replace('<iframe id="hook" src="scenes/hook.html" at="0">', '<iframe id="hook" src="scenes/hook.html" overrides=\'[{"at":"#hookA1","text":"这间厨房不归我"}]\'>')
    person = person.replace('<video id="shot03" src="assets/c.mp4#t=0,6" at="4"></video>',
                            '<video id="shot03" src="assets/c.mp4#t=0,2" at="4"></video>\n  <video id="shot03-b" src="assets/c.mp4#t=2,6" at="6"></video>')
    person = person.replace(CAPTIONS, '<section hidden>\n  <track kind="captions" src="captions.vtt" srclang="zh" label="字幕">\n</section>\n')
    (project / 'film.html').write_text(person, encoding='utf-8')
    (project / 'captions.vtt').write_text(VTT.replace('菜是我买的', '菜是我们提前买好的'), encoding='utf-8')
    changes = film_project.project_changes(project)
    assert 'captions.vtt 00:00.000 → 00:02.000 的字：「菜是我买的」→「菜是我们提前买好的」' in changes
    assert '加了片段 shot03-b（assets/c.mp4#t=2,6）' in changes
    assert '片段 shot03 的 src：assets/c.mp4#t=0,6 → assets/c.mp4#t=0,2' in changes
    assert any(line.startswith('片段 hook 的 overrides：') and '这间厨房不归我' in line for line in changes)
    assert '片段 hook 的 at：0 → （无）' in changes
    assert '字幕轨 captions.vtt的 hidden：（无） → ' in changes
    assert len(changes) == 6, changes


def test_diff_names_a_removed_caption_track_and_a_changed_page(project):
    film_project.snapshot(project)
    (project / 'film.html').write_text(BASE.replace(CAPTIONS, ''), encoding='utf-8')
    (project / 'scenes' / 'hook.html').write_text('<p>hook, retyped</p>\n', encoding='utf-8')
    assert film_project.project_changes(project) == ['删掉了字幕轨 captions.vtt', 'scenes/hook.html 改了（2 行不同）']


def test_diff_without_a_copy_says_so(project, capsys):
    assert film_project.project_changes(project) is None
    assert film_project.main(['diff', str(project)]) == 1
    assert '还没有智能体的副本' in capsys.readouterr().out


# ── writing film.html, and what the editor made of it ──────────────────────

FAST = {'quiet': 0.4, 'least': 0.6, 'most': 5.0}


def _editor(project: Path, rewrite):
    """A stand-in for the editor: soon after the Agent's write it writes film.html again, as its merge does."""
    film = project / 'film.html'
    written = film.stat().st_mtime_ns

    def run():
        for _ in range(100):
            time.sleep(0.02)
            if film.stat().st_mtime_ns != written:
                time.sleep(0.1)
                film.write_text(rewrite(film.read_text(encoding='utf-8')), encoding='utf-8')
                return
    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return thread


def _draft(project: Path, text: str) -> Path:
    draft = project.parent / 'draft.html'
    draft.write_text(text, encoding='utf-8')
    return draft


def test_a_write_the_editor_leaves_alone_is_checked_and_becomes_the_copy(project):
    film_project.snapshot(project)
    new = BASE.replace('assets/c.mp4#t=0,6', 'assets/c.mp4#t=1,6')
    missing, kept = film_project.write(project, _draft(project, new), **FAST)
    assert (missing, kept) == ([], [])
    assert (project / 'film.html').read_text(encoding='utf-8') == new
    assert (project / film_project.COPY / 'film.html').read_text(encoding='utf-8') == new


def test_a_caption_track_the_editor_drops_is_reported_and_the_copy_is_not_moved(project):
    film_project.snapshot(project)
    (project / 'film.html').write_text(BASE.replace('at="0"></iframe>', 'overrides=\'[{"at":"#a","text":"x"}]\'></iframe>'), encoding='utf-8')
    editor = _editor(project, lambda text: text.replace(CAPTIONS, ''))
    missing, _ = film_project.write(project, _draft(project, BASE.replace('#t=0,6', '#t=1,6')), **FAST)
    editor.join()
    assert missing == ['写进去的字幕轨 captions.vtt 没了']
    assert (project / film_project.COPY / 'film.html').read_text(encoding='utf-8') == BASE


def test_what_the_person_removed_is_not_reported_as_lost(project):
    film_project.snapshot(project)
    (project / 'film.html').write_text(BASE.replace(CAPTIONS, '').replace('<video id="shot01" src="assets/a.mp4#t=0,4" at="0"></video>', ''), encoding='utf-8')
    # The Agent's draft, from its older copy, still has both; the editor keeps the person's removals.
    editor = _editor(project, lambda text: text.replace(CAPTIONS, '').replace('<video id="shot01" src="assets/a.mp4#t=0,4" at="0"></video>', ''))
    missing, kept = film_project.write(project, _draft(project, BASE.replace('#t=0,6', '#t=1,6')), **FAST)
    editor.join()
    assert missing == []
    assert '删掉了字幕轨 captions.vtt' in kept and '删掉了片段 shot01' in kept


@pytest.mark.parametrize('editor_keeps, missing', [(True, []), (False, ['用户加的片段 title 没了'])])
def test_a_clip_the_person_added_must_survive_the_agent_write(project, editor_keeps, missing):
    film_project.snapshot(project)
    title = '<iframe id="title" src="scenes/title.html" at="1"></iframe>'
    with_title = BASE.replace('<iframe id="hook" src="scenes/hook.html" at="0"></iframe>', f'<iframe id="hook" src="scenes/hook.html" at="0"></iframe>\n  {title}')
    (project / 'film.html').write_text(with_title, encoding='utf-8')
    editor = _editor(project, (lambda text: text.replace('<iframe id="hook" src="scenes/hook.html" at="0"></iframe>', f'<iframe id="hook" src="scenes/hook.html" at="0"></iframe>\n  {title}')) if editor_keeps else (lambda text: text))
    found, _ = film_project.write(project, _draft(project, BASE.replace('#t=0,6', '#t=1,6')), **FAST)
    editor.join()
    assert found == missing


def test_a_clip_the_agent_wrote_that_is_gone_is_reported(project):
    film_project.snapshot(project)
    editor = _editor(project, lambda text: text.replace('<video id="shot03" src="assets/c.mp4#t=1,6" at="4"></video>', ''))
    missing, _ = film_project.write(project, _draft(project, BASE.replace('#t=0,6', '#t=1,6')), **FAST)
    editor.join()
    assert missing == ['写进去的片段 shot03 没了']


def test_a_draft_that_is_not_a_film_is_refused_before_anything_is_written(project):
    with pytest.raises(ValueError, match='not a film.html'):
        film_project.write(project, _draft(project, '<p>notes</p>'), **FAST)
    assert (project / 'film.html').read_text(encoding='utf-8') == BASE


def test_write_and_diff_from_the_command_line(project, capsys):
    film_project.snapshot(project)
    assert film_project.main(['diff', str(project)]) == 0
    assert '没有变化' in capsys.readouterr().out


@pytest.mark.parametrize('enabled', [True, False])
def test_status_says_whether_the_editor_is_open_to_this_account(tmp_path, monkeypatch, capsys, scheduler, enabled):
    """The skill's first step: ``"on": false`` makes it stand aside (apex-nodes film-edit SKILL.md)."""
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    scheduler['body'] = {'ok': True, 'openfilm': {'enabled': enabled}}
    assert film_project.main(['status']) == 0
    assert json.loads(capsys.readouterr().out) == {'on': enabled, 'ready': False}
