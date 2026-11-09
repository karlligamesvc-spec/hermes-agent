"""The Agent's side of OpenFilm projects on APEX Desktop (hc-1177).

Desktop can open an Agent's ``film.html`` in OpenFilm Studio, where the person retypes a caption, moves a title or
splits a clip, and Studio writes that into the same files. These commands are what the Agent runs around that:

    $APEX_PYTHON -m apex_overlay.film_project status             is the editor open to this account, is its toolkit
                                                                  installed
    $APEX_PYTHON -m apex_overlay.film_project diff <project>      what changed since the Agent's last write
    $APEX_PYTHON -m apex_overlay.film_project write <project> <draft.html>
                                                                  write film.html, let the editor take it in, then
                                                                  check that no track, caption track or clip was lost
    $APEX_PYTHON -m apex_overlay.film_project snapshot <project>  keep the project as it is as the Agent's own copy

``env`` gives ``openfilm`` (apex_overlay/openfilm_cli.mjs) what OpenFilm's CLI runs with. The checks read film.html
with their own parser and never reuse OpenFilm's merge, so they catch what that merge loses.
"""
from __future__ import annotations

import argparse
import difflib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import shutil
import sys
import time

#: The Scheduler's per-account answer (apex-nodes ``openfilm_access.open_to``), asked with the engine's APEX key, which
#: Desktop's main process puts in the engine's environment while an account is signed in (apex-platform-tools.ts).
CHECK_PATH = '/tools/v1/check'
BASE_ENV = 'TOOLS_GATEWAY_BASE'
KEY_ENV = 'TOOLS_GATEWAY_KEY'
CHECK_TIMEOUT_SECONDS = 5.0
FILM = 'film.html'
#: OpenFilm's folders, all under HERMES_HOME/openfilm; Desktop's editor uses the same (electron/openfilm-studio.ts).
FOLDERS = {
    'OPENFILM_HOME': 'home',
    'OPENFILM_LIBRARY': 'projects',
    'OPENFILM_SAVED': 'saved',
    'OPENFILM_SKILLS': 'skills',
    'OPENFILM_EXPORTS': 'exports',
}
#: The Agent's own copy of the project as it last wrote it, inside the project.
COPY = Path('.apex') / 'agent-copy'
#: Text files the person can change in the editor (and the Agent writes): kept in the copy, compared by diff.
TEXT_SUFFIXES = {'.html', '.vtt', '.css'}
CLIP_TAGS = {'iframe', 'video', 'img', 'audio', 'object', 'embed'}


def editor_on(env=os.environ) -> bool:
    """Is the editor open to this account: ``openfilm.enabled`` on the Scheduler's tools check (hc-1178), as Desktop
    reads it. Signed out, unreadable or anything but true is no. Asked on every command, never kept."""
    base = str(env.get(BASE_ENV, '')).strip().rstrip('/')
    key = str(env.get(KEY_ENV, '')).strip()
    if not (base and key):
        return False
    import httpx

    try:
        answer = httpx.get(f'{base}{CHECK_PATH}', headers={'Authorization': f'Bearer {key}'},
                           timeout=CHECK_TIMEOUT_SECONDS)
        block = answer.json().get('openfilm') if answer.status_code == 200 else None
    except (httpx.HTTPError, ValueError, AttributeError):
        return False
    return isinstance(block, dict) and block.get('enabled') is True


def _hermes_home() -> Path:
    from hermes_constants import get_hermes_home
    return Path(get_hermes_home())


def ready_toolkit(home: Path) -> dict | None:
    """The toolkit the engine installed, as its ready.json names it, while its files are there and it is the toolkit
    this engine pins (hc-1199: after an APEX update that moves the pin, ready.json still names the old one until
    ``ensure_openfilm`` installs the new one)."""
    from apex_overlay import media_tools

    try:
        said = json.loads((home / 'tool-cache' / 'openfilm' / 'ready.json').read_text(encoding='utf-8-sig'))
        pinned = media_tools.openfilm_pin()['sha256']
    except (OSError, ValueError, KeyError, TypeError):
        return None
    if not isinstance(said, dict) or not pinned or said.get('sha256') != pinned:
        return None
    toolkit, chromium = Path(str(said.get('toolkit', ''))), Path(str(said.get('chromium', '')))
    cli = toolkit / 'node_modules' / 'openfilm' / 'bin' / 'openfilm.mjs'
    if not (toolkit.is_absolute() and chromium.is_absolute() and cli.is_file() and chromium.is_file()):
        return None
    return {'toolkit': str(toolkit), 'chromium': str(chromium), 'cli': str(cli)}


def openfilm_env(home: Path, ready: dict) -> dict:
    """What OpenFilm's CLI runs with: Desktop's editor folders, no browser window, the Agent browser's Chromium, and
    hosted: it uses the Studio Desktop runs and never starts one of its own, which nothing would stop when APEX quits
    (OPENFILM_HOSTED, APEX's patch 0003)."""
    root = home / 'openfilm'
    return {
        **{name: str(root / folder) for name, folder in FOLDERS.items()},
        'OPENFILM_NO_BROWSER': '1',
        'OPENFILM_NO_UPDATE_CHECK': '1',
        'OPENFILM_HOSTED': '1',
        'OPENFILM_CHROMIUM': ready['chromium'],
    }


# ── film.html, read on its own terms ────────────────────────────────────────

class _FilmReader(HTMLParser):
    """film.html's tracks: each <section> with its attributes, its clips (by id) and its caption <track>s."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tracks: list[dict] = []
        self._depth = 0

    def handle_starttag(self, tag, attrs):
        attributes = {k: (v if v is not None else '') for k, v in attrs}
        if tag == 'section':
            self.tracks.append({'attrs': attributes, 'clips': [], 'captions': []})
            self._depth = 1
            return
        if not self.tracks or self._depth == 0:
            return
        if tag == 'track' and attributes.get('kind', 'captions') in {'captions', 'subtitles'}:
            self.tracks[-1]['captions'].append(attributes)
        elif tag in CLIP_TAGS:
            self.tracks[-1]['clips'].append({'id': attributes.get('id') or f'{tag}:{attributes.get("src", "")}', 'tag': tag, 'attrs': attributes})

    handle_startendtag = handle_starttag

    def handle_endtag(self, tag):
        if tag == 'section':
            self._depth = 0


def read_film(text: str | None) -> dict | None:
    if text is None:
        return None
    reader = _FilmReader()
    reader.feed(text)
    reader.close()
    tracks = reader.tracks
    clips = {c['id']: (i, c) for i, t in enumerate(tracks) for c in t['clips']}
    captions = {c.get('src', ''): (i, c) for i, t in enumerate(tracks) for c in t['captions']}
    return {'tracks': tracks, 'clips': clips, 'captions': captions}


def _short(value: str, width: int = 80) -> str:
    value = ' '.join(str(value).split())
    return value if len(value) <= width else value[: width - 1] + '…'


def _track_name(track: dict) -> str:
    if track['captions']:
        return f'字幕轨 {track["captions"][0].get("src", "")}'
    return f'片段 {track["clips"][0]["id"]} 所在的轨道' if track['clips'] else '一条空轨道'


def film_changes(before: dict, after: dict) -> list[str]:
    """What changed in film.html from `before` to `after`, one line each."""
    out: list[str] = []
    for src in before['captions'].keys() - after['captions'].keys():
        out.append(f'删掉了字幕轨 {src}')
    for src in after['captions'].keys() - before['captions'].keys():
        out.append(f'加了字幕轨 {src}')
    for src in before['captions'].keys() & after['captions'].keys():
        a, b = before['captions'][src][1], after['captions'][src][1]
        for key in sorted(a.keys() | b.keys()):
            if a.get(key) != b.get(key):
                out.append(f'字幕轨 {src} 的 {key}：{_short(a.get(key, "（无）"))} → {_short(b.get(key, "（无）"))}')
    for clip_id in sorted(before['clips'].keys() - after['clips'].keys()):
        out.append(f'删掉了片段 {clip_id}')
    for clip_id in sorted(after['clips'].keys() - before['clips'].keys()):
        out.append(f'加了片段 {clip_id}（{after["clips"][clip_id][1]["attrs"].get("src", "")}）')
    for clip_id in sorted(before['clips'].keys() & after['clips'].keys()):
        a, b = before['clips'][clip_id][1]['attrs'], after['clips'][clip_id][1]['attrs']
        for key in sorted(a.keys() | b.keys()):
            if a.get(key) != b.get(key):
                out.append(f'片段 {clip_id} 的 {key}：{_short(a.get(key, "（无）"))} → {_short(b.get(key, "（无）"))}')
    def named(film: dict) -> dict:
        return {_track_name(t): t for t in film['tracks']}

    was, now = named(before), named(after)
    for name in sorted(was.keys() & now.keys()):
        a, b = was[name]['attrs'], now[name]['attrs']
        for key in sorted(a.keys() | b.keys()):
            if a.get(key) != b.get(key):
                out.append(f'{name}的 {key}：{_short(a.get(key, "（无）"))} → {_short(b.get(key, "（无）"))}')
    return out


def _cues(text: str) -> list[tuple[str, str]]:
    cues = []
    for block in text.replace('\r\n', '\n').split('\n\n'):
        lines = [line for line in block.strip().split('\n') if line.strip()]
        timing = next((i for i, line in enumerate(lines) if '-->' in line), None)
        if timing is not None:
            cues.append((lines[timing].split(' ', 3)[0] + ' → ' + lines[timing].split('-->', 1)[1].strip().split(' ')[0],
                         ' '.join(lines[timing + 1:])))
    return cues


def caption_changes(rel: str, before: str, after: str) -> list[str]:
    """What the person changed in a WebVTT file, cue by cue (the editor rewrites only the cues it touches)."""
    a, b = _cues(before), _cues(after)
    out = []
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(a=a, b=b, autojunk=False).get_opcodes():
        if op == 'equal':
            continue
        if op == 'replace' and i2 - i1 == j2 - j1:
            for (ta, xa), (tb, xb) in zip(a[i1:i2], b[j1:j2]):
                if xa != xb:
                    out.append(f'{rel} {tb} 的字：「{_short(xa, 40)}」→「{_short(xb, 40)}」')
                if ta != tb:
                    out.append(f'{rel} 一句字幕的时间：{ta} → {tb}')
            continue
        for timing, text in a[i1:i2]:
            out.append(f'{rel} 删掉了 {timing}「{_short(text, 40)}」')
        for timing, text in b[j1:j2]:
            out.append(f'{rel} 加了 {timing}「{_short(text, 40)}」')
    return out


# ── the Agent's copy ────────────────────────────────────────────────────────

def _text_files(project: Path) -> dict[str, Path]:
    found = {}
    for path in project.rglob('*'):
        rel = path.relative_to(project)
        if any(part.startswith('.') or part == 'node_modules' for part in rel.parts) or not path.is_file():
            continue
        if path.suffix.lower() in TEXT_SUFFIXES and path.stat().st_size <= 4 * 1024 * 1024:
            found[rel.as_posix()] = path
    return found


def snapshot(project: Path) -> int:
    """Keep the project's text files as they are now as the Agent's copy; how many."""
    copy = project / COPY
    if copy.exists():
        shutil.rmtree(copy)
    files = _text_files(project)
    for rel, path in files.items():
        (copy / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, copy / rel)
    (copy / 'manifest.json').write_text(json.dumps({'files': sorted(files), 'at': time.time()}, ensure_ascii=False), encoding='utf-8')
    return len(files)


def project_changes(project: Path) -> list[str] | None:
    """What changed in the project since the Agent's copy; None when there is no copy yet."""
    copy = project / COPY
    try:
        kept = json.loads((copy / 'manifest.json').read_text(encoding='utf-8'))['files']
    except (OSError, ValueError, KeyError):
        return None
    now = _text_files(project)
    out: list[str] = []
    for rel in sorted(set(kept) | set(now)):
        was = (copy / rel).read_text(encoding='utf-8', errors='replace') if rel in kept else None
        is_ = now[rel].read_text(encoding='utf-8', errors='replace') if rel in now else None
        if was == is_:
            continue
        if was is None or is_ is None:
            out.append(f'{"加了" if was is None else "删掉了"}文件 {rel}')
        elif rel == FILM:
            out.extend(film_changes(read_film(was), read_film(is_)))
        elif rel.endswith('.vtt'):
            out.extend(caption_changes(rel, was, is_) or [f'{rel} 改了'])
        else:
            changed = sum(1 for line in difflib.ndiff(was.splitlines(), is_.splitlines()) if line[:1] in '+-')
            out.append(f'{rel} 改了（{changed} 行不同）')
    return out


# ── writing film.html and checking what the editor made of it ──────────────

def settle(path: Path, quiet: float = 1.5, least: float = 3.0, most: float = 20.0) -> str | None:
    """film.html once nothing has written it for `quiet` seconds (the editor merges a write within about one), read
    no earlier than `least` seconds and no later than `most`."""
    start = time.monotonic()
    last, since = None, start
    while True:
        try:
            text = path.read_text(encoding='utf-8')
        except OSError:
            text = None
        moment = time.monotonic()
        if text != last:
            last, since = text, moment
        if (moment - start >= least and moment - since >= quiet) or moment - start >= most:
            return last
        time.sleep(0.2)


def lost(base: dict | None, pre: dict | None, intended: dict, result: dict) -> list[str]:
    """What the Agent wrote (`intended`) or the person had added since the Agent's copy (`base` → `pre`, the file
    before this write) that the film on disk (`result`) no longer has, leaving out what the person removed."""
    before = base or pre or {'clips': {}, 'captions': {}}
    pre = pre or before
    removed_clips = before['clips'].keys() - pre['clips'].keys()
    removed_captions = before['captions'].keys() - pre['captions'].keys()
    out = []
    for src in sorted(intended['captions'].keys() - result['captions'].keys() - removed_captions):
        out.append(f'写进去的字幕轨 {src} 没了')
    for src in sorted(pre['captions'].keys() - before['captions'].keys() - result['captions'].keys()):
        out.append(f'用户加的字幕轨 {src} 没了')
    for clip_id in sorted(intended['clips'].keys() - result['clips'].keys() - removed_clips):
        out.append(f'写进去的片段 {clip_id} 没了')
    for clip_id in sorted(pre['clips'].keys() - before['clips'].keys() - result['clips'].keys()):
        out.append(f'用户加的片段 {clip_id} 没了')
    if intended['tracks'] and not result['tracks']:
        out.append('film.html 里一条轨道都没了')
    return out


def write(project: Path, draft: Path, **settling) -> tuple[list[str], list[str]]:
    """Write `draft` as the project's film.html, wait for the editor, check. What was lost, and what the editor kept
    of the person's over the write. Nothing lost: the result is the Agent's new copy."""
    film = project / FILM
    copy = project / COPY / FILM
    base = read_film(copy.read_text(encoding='utf-8')) if copy.is_file() else None
    pre = read_film(film.read_text(encoding='utf-8')) if film.is_file() else None
    text = draft.read_text(encoding='utf-8')
    intended = read_film(text)
    if not intended['tracks']:
        raise ValueError(f'{draft} has no <section> track: not a film.html')
    staged = film.with_name(f'.{FILM}.apex-write')
    staged.write_text(text, encoding='utf-8')
    os.replace(staged, film)
    result = read_film(settle(film, **settling))
    if result is None:
        return ['写入后 film.html 不见了'], []
    missing = lost(base, pre, intended, result)
    if not missing:
        snapshot(project)
    return missing, film_changes(intended, result)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog='python -m apex_overlay.film_project', description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('status')
    sub.add_parser('env')
    for name in ('diff', 'snapshot'):
        sub.add_parser(name).add_argument('project', type=Path)
    writer = sub.add_parser('write')
    writer.add_argument('project', type=Path)
    writer.add_argument('draft', type=Path)
    args = parser.parse_args(argv)

    if args.command in {'status', 'env'}:
        home = _hermes_home()
        ready = ready_toolkit(home)
        on = editor_on()
        if args.command == 'status':
            print(json.dumps({'on': on, 'ready': ready is not None}))
            return 0
        if not on:
            print('APEX 的剪辑编辑器没开：这个账号还不能用，不做 OpenFilm 工程', file=sys.stderr)
            return 2
        if ready is None:
            from apex_overlay.media_tools import ensure_openfilm
            try:
                ensure_openfilm()
            except (OSError, ValueError, KeyError) as exc:  # one line for the Agent, no traceback
                print(f'APEX OpenFilm toolkit unavailable: {type(exc).__name__}: {exc}', file=sys.stderr)
                return 1
            ready = ready_toolkit(home)
            if ready is None:
                print('APEX OpenFilm toolkit unavailable: its install names no usable toolkit', file=sys.stderr)
                return 1
        print(json.dumps({'cli': ready['cli'], 'env': openfilm_env(home, ready)}))
        return 0

    project = args.project.resolve()
    if args.command == 'snapshot':
        print(f'已把 {project} 现在的 {snapshot(project)} 个文本文件记为智能体的副本')
        return 0
    if args.command == 'diff':
        changes = project_changes(project)
        if changes is None:
            print('还没有智能体的副本：用 write 写 film.html，或先跑 snapshot')
            return 1
        print('\n'.join(['从你上次写入以来，这些地方变了（多半是用户在编辑器里改的，保留它们）：', *changes]) if changes else '从你上次写入以来没有变化')
        return 0
    missing, kept = write(project, args.draft.resolve())
    if missing:
        print('\n'.join(['写入后，这些东西没了（没有更新智能体的副本）。把它们补回去再写一次，并告诉用户：', *missing]))
        return 1
    print('\n'.join(['写好了：轨道、字幕轨和片段都在。', *(['编辑器保住了用户的这些修改，它们和你写的不同：', *kept] if kept else [])]))
    return 0


if __name__ == '__main__':
    sys.exit(main())
