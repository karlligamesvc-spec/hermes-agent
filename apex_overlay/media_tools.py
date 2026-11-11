"""APEX's verified COS browser cache, shared by browser automation and Hypit.

hc-1025: the same cache holds the one subtitle font Agents burn captions with
(得意黑 Smiley Sans, OFL-1.1). System fonts such as Hiragino Sans GB or Microsoft
YaHei are not cleared for commercial use, so subtitles never rely on them:
``python -m apex_overlay.media_tools font`` prints the verified font file, and
ffmpeg loads it through ``subtitles=…:fontsdir=<its folder>`` or ``fontfile=``.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import struct
import sysconfig
import subprocess
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / 'scripts/media-tools/desktop-lock.json'
COS_HOST = 'apexnodes-runtime-202606250443-1300912302.cos.ap-guangzhou.myqcloud.com'
#: hc-1201: Desktop's install of the editor's parts sets this, and the downloads then say how far they are, one line
#: each on stdout (``PROGRESS_MARK`` + JSON), which the editor's first-run check shows (electron/openfilm-studio.ts).
PROGRESS_ENV = 'APEX_MEDIA_TOOLS_PROGRESS'
PROGRESS_MARK = '@@apex-progress '


def _progress(step: str, done: int, total: int) -> None:
    """One progress line for Desktop, only when it asked for them (``PROGRESS_ENV``); every other caller gets none."""
    if os.environ.get(PROGRESS_ENV) == '1':
        print(f'{PROGRESS_MARK}{json.dumps({"step": step, "done": done, "total": total})}', flush=True)


def native_target() -> str:
    if os.name == 'nt':
        # Python 3.11's platform.machine() depends on inherited PROCESSOR_*
        # variables; isolated Desktop/test environments intentionally omit them.
        if sysconfig.get_platform() != 'win-amd64' or struct.calcsize('P') != 8:
            raise ValueError('APEX browser requires a native Windows x64 interpreter')
        return 'win-x64'
    system = {'Darwin': 'mac', 'Windows': 'win'}[platform.system()]
    arch = {'arm64': 'arm64', 'aarch64': 'arm64', 'x86_64': 'x64', 'AMD64': 'x64'}[platform.machine()]
    return f'{system}-{arch}'


def ensure_browser(*, render=False) -> Path:
    from filelock import FileLock
    from hermes_constants import get_hermes_home
    target = native_target()
    spec = json.loads(LOCK.read_text())['browser'][f'render-{target}' if render and os.name == 'nt' else target]
    from urllib.parse import urlsplit
    url = urlsplit(spec['url'])
    if url.scheme != 'https' or url.hostname != COS_HOST:
        raise ValueError('Browser download must use APEX COS')
    cache = Path(get_hermes_home()) / 'tool-cache' / 'chrome'
    cache.mkdir(parents=True, exist_ok=True)
    destination = cache / spec['sha256']
    executable = destination / spec['executable']
    with FileLock(str(cache / 'install.lock'), timeout=1800):
        if executable.is_file():
            return executable
        with tempfile.TemporaryDirectory(prefix='install-', dir=cache) as temporary:
            temporary = Path(temporary)
            archive = temporary / 'browser.zip'
            digest, size = hashlib.sha256(), 0
            with urllib.request.urlopen(spec['url'], timeout=120) as response, archive.open('wb') as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
                    digest.update(chunk)
                    size += len(chunk)
                    _progress('browser', size, spec['bytes'])
            if size != spec['bytes'] or digest.hexdigest() != spec['sha256']:
                raise ValueError('COS browser archive checksum mismatch')
            unpacked = temporary / 'unpacked'
            unpacked.mkdir()
            tar = str(Path(os.environ.get('SystemRoot', 'C:/Windows')) / 'System32/tar.exe') if os.name == 'nt' else '/usr/bin/tar'
            subprocess.run([tar, '-xf', str(archive), '-C', str(unpacked)], stdin=subprocess.DEVNULL, check=True, timeout=180)
            candidate = unpacked / spec['executable']
            if not candidate.is_file():
                raise ValueError('COS browser archive has no native executable')
            if os.name == 'nt':
                # Windows Chrome ignores --version and opens a persistent GUI.
                # The trusted archive hash plus native PE header validates this
                # install without launching it; capture tests exercise startup.
                with candidate.open('rb') as binary:
                    if binary.read(2) != b'MZ':
                        raise ValueError('Browser is not a Windows executable')
                    binary.seek(0x3c)
                    offset = struct.unpack('<I', binary.read(4))[0]
                    binary.seek(offset)
                    if binary.read(6) != b'PE\0\0\x64\x86':
                        raise ValueError('Browser is not a native Windows x64 executable')
            else:
                subprocess.run([str(candidate), '--version'], stdin=subprocess.DEVNULL, check=True, capture_output=True, timeout=30)
            # A previous interrupted installation cannot leave a half-valid tree.
            if destination.exists():
                shutil.rmtree(destination)
            unpacked.rename(destination)
    return executable


def ensure_font(name: str = 'subtitle') -> Path:
    """The licensed font ``name`` from desktop-lock, downloaded once from APEX COS and hash verified."""
    from filelock import FileLock
    from hermes_constants import get_hermes_home
    from urllib.parse import urlsplit
    spec = json.loads(LOCK.read_text(encoding='utf-8-sig'))['fonts'][name]
    url = urlsplit(spec['url'])
    if url.scheme != 'https' or url.hostname != COS_HOST:
        raise ValueError('Font download must use APEX COS')
    cache = Path(get_hermes_home()) / 'tool-cache' / 'fonts'
    cache.mkdir(parents=True, exist_ok=True)
    destination = cache / spec['sha256'] / spec['file']
    with FileLock(str(cache / 'install.lock'), timeout=600):
        if destination.is_file():
            with destination.open('rb') as cached:
                if hashlib.file_digest(cached, 'sha256').hexdigest() == spec['sha256']:
                    return destination
        with tempfile.TemporaryDirectory(prefix='install-', dir=cache) as temporary:
            download = Path(temporary) / spec['file']
            digest, size = hashlib.sha256(), 0
            with urllib.request.urlopen(spec['url'], timeout=120) as response, download.open('wb') as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
                    digest.update(chunk)
                    size += len(chunk)
            if size != spec['bytes'] or digest.hexdigest() != spec['sha256']:
                raise ValueError('COS font checksum mismatch')
            destination.parent.mkdir(exist_ok=True)
            os.replace(download, destination)
    return destination


def openfilm_pin() -> dict:
    """desktop-lock's ``openfilm``: the toolkit this engine pins, and so the only one its editor runs (hc-1199).

    ``ensure_openfilm`` installs it. An APEX update that moves the pin leaves the old toolkit and its ready.json in
    place, so every reader of ready.json (``film_project.ready_toolkit``, Desktop's ``findOpenfilmToolkit``, which
    reads this same file under the engine's root) takes the toolkit it names only while its ``sha256`` is this one's.
    """
    return json.loads(LOCK.read_text(encoding='utf-8-sig'))['openfilm']


def ensure_openfilm() -> Path:
    """APEX's OpenFilm toolkit (hc-1176), for the editor Desktop opens an Agent's film.html in.

    The toolkit (desktop-lock ``openfilm``: the pinned openfilm package with APEX's patches, and its dependencies) is
    downloaded once from APEX COS, size and SHA-256 checked, and unpacked into HERMES_HOME/tool-cache/openfilm/<sha256>/.
    It draws in the Agent browser's Chromium (``ensure_browser(render=True)``), never in one it downloads itself.
    ``tool-cache/openfilm/ready.json`` is written last and names both: Desktop reads only that file, so it never sees
    a half-done install. Returns its path.
    """
    from filelock import FileLock
    from hermes_constants import get_hermes_home
    from urllib.parse import urlsplit
    spec = openfilm_pin()
    url = urlsplit(spec['url'])
    if url.scheme != 'https' or url.hostname != COS_HOST:
        raise ValueError('OpenFilm toolkit download must use APEX COS')
    chromium = ensure_browser(render=True)
    cache = Path(get_hermes_home()) / 'tool-cache' / 'openfilm'
    cache.mkdir(parents=True, exist_ok=True)
    destination = cache / spec['sha256']

    def installed(folder: Path) -> bool:
        try:
            manifest = json.loads((folder / 'apex-toolkit.json').read_text(encoding='utf-8'))
        except (OSError, ValueError):
            return False
        patches = [str(p.get('file', '')).removesuffix('.patch') for p in manifest.get('patches', [])]
        return (manifest.get('openfilm') == spec['version'] and patches == spec['patches']
                and (folder / 'node_modules/openfilm/studio/server/server.mjs').is_file())

    with FileLock(str(cache / 'install.lock'), timeout=1800):
        if not installed(destination):
            with tempfile.TemporaryDirectory(prefix='install-', dir=cache) as temporary:
                temporary = Path(temporary)
                archive = temporary / 'openfilm-toolkit.tgz'
                digest, size = hashlib.sha256(), 0
                with urllib.request.urlopen(spec['url'], timeout=120) as response, archive.open('wb') as output:
                    while chunk := response.read(1024 * 1024):
                        output.write(chunk)
                        digest.update(chunk)
                        size += len(chunk)
                        _progress('toolkit', size, spec['bytes'])
                if size != spec['bytes'] or digest.hexdigest() != spec['sha256']:
                    raise ValueError('COS OpenFilm toolkit checksum mismatch')
                unpacked = temporary / 'unpacked'
                unpacked.mkdir()
                tar = str(Path(os.environ.get('SystemRoot', 'C:/Windows')) / 'System32/tar.exe') if os.name == 'nt' else '/usr/bin/tar'
                subprocess.run([tar, '-xzf', str(archive), '-C', str(unpacked)], stdin=subprocess.DEVNULL, check=True, timeout=300)
                if not installed(unpacked):
                    raise ValueError('COS OpenFilm toolkit archive is not the locked toolkit')
                # A previous interrupted installation cannot leave a half-valid tree.
                if destination.exists():
                    shutil.rmtree(destination)
                unpacked.rename(destination)
        ready = cache / 'ready.json'
        staged = cache / 'ready.json.tmp'
        staged.write_text(json.dumps({
            'schema': 1, 'version': spec['version'], 'patches': spec['patches'], 'sha256': spec['sha256'],
            'toolkit': str(destination), 'chromium': str(chromium),
        }, indent=2), encoding='utf-8')
        os.replace(staged, ready)
    return ready


#: What installing a missing part takes on disk, as a multiple of its download: the archive, then its unpacked tree
#: beside it until the move (measured 2026-11-09 on mac-arm64: the browser 191 MB → 359 MB, the toolkit 42 MB →
#: 67 MB), with room to spare; and what is kept free on top.
INSTALL_ROOM_FACTOR = 3
INSTALL_ROOM_MARGIN = 256 * 1024 * 1024


def openfilm_check() -> dict:
    """What the editor still needs on this computer, for Desktop's first-run check of the titlebar's 剪辑 (hc-1201).

    The browser Studio draws in and the toolkit this engine pins: whether each is installed, and its download's size;
    and the free space where APEX keeps its data against what installing the missing ones takes. Reads only: it
    installs nothing (``ensure_openfilm`` does). The toolkit counts as installed only while ready.json names the
    pinned one and its files are there, as every reader of ready.json takes it.
    """
    from hermes_constants import get_hermes_home
    lock = json.loads(LOCK.read_text(encoding='utf-8-sig'))
    target = native_target()
    browser = lock['browser'][f'render-{target}' if os.name == 'nt' else target]
    toolkit = openfilm_pin()
    home = Path(get_hermes_home())
    browser_ready = (home / 'tool-cache' / 'chrome' / browser['sha256'] / browser['executable']).is_file()
    try:
        said = json.loads((home / 'tool-cache' / 'openfilm' / 'ready.json').read_text(encoding='utf-8-sig'))
    except (OSError, ValueError):
        said = None
    toolkit_ready = (isinstance(said, dict) and said.get('sha256') == toolkit['sha256']
                     and (Path(str(said.get('toolkit', ''))) / 'node_modules/openfilm/studio/server/server.mjs').is_file()
                     and Path(str(said.get('chromium', ''))).is_file())
    missing = [part['bytes'] for part, ready in ((browser, browser_ready), (toolkit, toolkit_ready)) if not ready]
    existing = home
    while not existing.exists() and existing != existing.parent:
        existing = existing.parent
    return {
        'browser': {'ready': browser_ready, 'bytes': browser['bytes']},
        'toolkit': {'ready': toolkit_ready, 'bytes': toolkit['bytes']},
        'disk': {
            'free': shutil.disk_usage(existing).free,
            'needed': sum(missing) * INSTALL_ROOM_FACTOR + (INSTALL_ROOM_MARGIN if missing else 0),
        },
    }


def motion_pin() -> dict:
    """desktop-lock's ``motion``: the huashu-motion toolkit this engine pins (hc-1221)."""
    return json.loads(LOCK.read_text(encoding='utf-8-sig'))['motion']


def ensure_motion() -> Path:
    """APEX's motion toolkit (hc-1221): huashu-motion's renderer, trimmed (no GSAP, no model downloads), for the
    explainer templates the ``explainer-video`` skill ships.

    Downloaded once from APEX COS, size and SHA-256 checked, and unpacked whole into
    HERMES_HOME/tool-cache/motion/<sha256>/. It renders in the Agent browser's Chromium (``ensure_browser(render=True)``),
    never in a browser of the user's. ``tool-cache/motion/ready.json`` is written last and names the toolkit, the
    Chromium and the pin. Returns its path.
    """
    from filelock import FileLock
    from hermes_constants import get_hermes_home
    from urllib.parse import urlsplit
    spec = motion_pin()
    url = urlsplit(spec['url'])
    if url.scheme != 'https' or url.hostname != COS_HOST:
        raise ValueError('Motion toolkit download must use APEX COS')
    chromium = ensure_browser(render=True)
    cache = Path(get_hermes_home()) / 'tool-cache' / 'motion'
    cache.mkdir(parents=True, exist_ok=True)
    destination = cache / spec['sha256']

    def installed(folder: Path) -> bool:
        try:
            manifest = json.loads((folder / 'apex-toolkit.json').read_text(encoding='utf-8'))
        except (OSError, ValueError):
            return False
        return (manifest.get('package') == 'huashu-motion' and manifest.get('version') == spec['version']
                and manifest.get('integrity') == spec['integrity'] and (folder / 'cli/om.js').is_file())

    with FileLock(str(cache / 'install.lock'), timeout=1800):
        if not installed(destination):
            with tempfile.TemporaryDirectory(prefix='install-', dir=cache) as temporary:
                temporary = Path(temporary)
                archive = temporary / 'motion-toolkit.tgz'
                digest, size = hashlib.sha256(), 0
                with urllib.request.urlopen(spec['url'], timeout=120) as response, archive.open('wb') as output:
                    while chunk := response.read(1024 * 1024):
                        output.write(chunk)
                        digest.update(chunk)
                        size += len(chunk)
                        _progress('motion', size, spec['bytes'])
                if size != spec['bytes'] or digest.hexdigest() != spec['sha256']:
                    raise ValueError('COS motion toolkit checksum mismatch')
                unpacked = temporary / 'unpacked'
                unpacked.mkdir()
                tar = str(Path(os.environ.get('SystemRoot', 'C:/Windows')) / 'System32/tar.exe') if os.name == 'nt' else '/usr/bin/tar'
                subprocess.run([tar, '-xzf', str(archive), '-C', str(unpacked)], stdin=subprocess.DEVNULL, check=True, timeout=300)
                if not installed(unpacked):
                    raise ValueError('COS motion toolkit archive is not the locked toolkit')
                # A previous interrupted installation cannot leave a half-valid tree.
                if destination.exists():
                    shutil.rmtree(destination)
                unpacked.rename(destination)
        ready = cache / 'ready.json'
        staged = cache / 'ready.json.tmp'
        staged.write_text(json.dumps({
            'schema': 1, 'version': spec['version'], 'sha256': spec['sha256'],
            'toolkit': str(destination), 'chromium': str(chromium),
        }, indent=2), encoding='utf-8')
        os.replace(staged, ready)
    return ready


#: ``om`` commands the motion toolkit does not carry (hc-1221), and what an Agent uses instead.
MOTION_NOT_CARRIED = {
    'voice': 'APEX voices with text_to_speech and times captions with media_transcribe',
    'samples': 'APEX has its own music library',
    'learn': 'keep notes in the project folder',
    'share': 'deliver the rendered film and the publish package',
    'grab': 'use the browser tools to capture pages',
    'new': "start from the explainer-video skill's template",
    'templates': "start from the explainer-video skill's template",
    'demo': "start from the explainer-video skill's template",
    'studio': 'look at frames with `still` and the film with `qa --sheet`; the user watches the rendered film',
    'inbox': 'look at frames with `still` and the film with `qa --sheet`; the user watches the rendered film',
}

#: One `om` run, render included (a 30-second 1080x1920 film renders in about 20 s on a laptop).
MOTION_TIMEOUT = 1800


def motion_node() -> str:
    """The engine's bundled Node (huashu-motion needs 22+), else the one on PATH."""
    for folder in (ROOT / '.runtime/node/bin', ROOT / '.runtime/node'):
        found = shutil.which('node', path=str(folder))
        if found:
            return found
    found = shutil.which('node')
    if not found:
        raise ValueError('no Node runtime found for the motion toolkit')
    return found


def run_motion(args: list[str]) -> int:
    """``motion <om command> …``: run the pinned toolkit's ``om`` in the Agent browser's Chromium."""
    if args and args[0] in MOTION_NOT_CARRIED:
        print(f'APEX motion: `{args[0]}` is not part of APEX\'s motion toolkit; {MOTION_NOT_CARRIED[args[0]]}.', flush=True)
        return 2
    ready = json.loads(ensure_motion().read_text(encoding='utf-8'))
    env = dict(os.environ, OM_CHROME=ready['chromium'])
    bundled = ROOT / '.runtime/bin'
    if bundled.is_dir():  # the bundled ffmpeg/ffprobe render and mix
        env['PATH'] = os.pathsep.join([str(bundled), env.get('PATH', '')])
    try:
        return subprocess.run([motion_node(), str(Path(ready['toolkit']) / 'cli/om.js'), *args], env=env,
                              stdin=subprocess.DEVNULL, timeout=MOTION_TIMEOUT, check=False).returncode
    except subprocess.TimeoutExpired:
        print(f'APEX motion: `{" ".join(args[:1])}` did not finish within {MOTION_TIMEOUT // 60} minutes.', flush=True)
        return 124


def _bundled_hypit_version() -> str:
    package = ROOT / '.runtime/hypit/node_modules/@hypit/hypit/package.json'
    return json.loads(package.read_text(encoding='utf-8'))['version']


def prepare_hypit(workspace: Path, version: str | None = None) -> Path:
    from apex_overlay.hypit_profile import hosted_active, prepare_profile
    return prepare_profile(workspace, ROOT, version or _bundled_hypit_version(), ensure_browser, hosted=hosted_active())


def enable_hosted_hypit(workspace: Path, version: str | None = None) -> Path:
    from apex_overlay.hypit_profile import hosted_active, merge_hosted_endpoint
    if not hosted_active():
        raise ValueError('APEX hosted generation is not enabled for this Desktop')
    return merge_hosted_endpoint(workspace, version or _bundled_hypit_version())


#: Where this process keeps the COS browser once installed. The engine no longer reads it (v0.23.0 resolves its
#: browser through ``hermes_cli.browser_runtime.chromium_executable``), but children inherit it, so a script the
#: agent runs finds the same browser.
BROWSER_ENV = 'AGENT_BROWSER_EXECUTABLE_PATH'
_BROWSER_MARK = '_apex_cos_browser'


def cos_browser() -> str | None:
    """The COS browser this process installed (``BROWSER_ENV``), while it is a file."""
    path = os.environ.get(BROWSER_ENV, '')
    return path if path and Path(path).is_file() else None


def _install_cos_browser(user_pinned) -> bool:
    """APEX's replacement for upstream's one-shot ``pm.ensure("chromium")``: the verified COS build, never a
    foreign host, nothing over a browser the user pinned in ``browser.executable_path`` (the launcher reports a
    missing pin itself), and only where lazy installs are allowed (security.allow_lazy_installs)."""
    from pm import lazy_installs_allowed
    if user_pinned() or not lazy_installs_allowed():
        return False
    if cos_browser():
        return True
    try:
        os.environ[BROWSER_ENV] = str(ensure_browser())
        return True
    except Exception:
        import logging
        logging.getLogger(__name__).exception('APEX COS browser preparation failed')
        return False  # Do not fall through to a foreign download endpoint.


def install_browser_seam() -> bool:
    """hc-1203 (v0.23.0): browser_exec's Chromium comes from APEX COS.

    v0.23.0 dropped agent-browser and its installer module; ``tools.browser_launcher.chromium_ready`` resolves
    the browser through ``hermes_cli.browser_runtime.chromium_executable`` (``browser.executable_path``, then pm's
    Chromium) and otherwise calls ``tools.browser_launcher._maybe_autoinstall_chromium`` (pm's download). Both are
    wrapped, once: the installer becomes the COS one, and the resolver answers the COS browser after everything
    upstream would pick (a user's pin or a pm build still wins)."""
    import functools

    from hermes_cli import browser_runtime
    from tools import browser_launcher

    resolve = browser_runtime.chromium_executable
    if not getattr(resolve, _BROWSER_MARK, False):
        @functools.wraps(resolve)
        def chromium_executable(*, allow_override: bool = True) -> str | None:
            found = resolve(allow_override=allow_override)
            return found if found or not allow_override else cos_browser()
        setattr(chromium_executable, _BROWSER_MARK, True)
        browser_runtime.chromium_executable = chromium_executable
        resolve_upstream = resolve
    else:
        resolve_upstream = resolve.__wrapped__

    autoinstall = browser_launcher._maybe_autoinstall_chromium
    if not getattr(autoinstall, _BROWSER_MARK, False):
        def user_pinned() -> bool:
            # upstream's own test (_explicit_executable_configured), on the resolver without this seam
            return resolve_upstream(allow_override=True) != resolve_upstream(allow_override=False)

        @functools.wraps(autoinstall)
        def install() -> bool:
            return _install_cos_browser(user_pinned)
        setattr(install, _BROWSER_MARK, True)
        browser_launcher._maybe_autoinstall_chromium = install
    return True


def apply() -> bool:
    # Cloud/Linux and unpackaged developer environments retain their own installer.
    if platform.system() not in {'Darwin', 'Windows'} or not LOCK.is_file() or not (ROOT / '.runtime/node').is_dir():
        return False
    return install_browser_seam()


if __name__ == '__main__':
    import sys
    if sys.argv[1:2] == ['motion']:  # hc-1221: everything after `motion` belongs to `om`
        try:
            raise SystemExit(run_motion(sys.argv[2:]))
        except (OSError, ValueError, KeyError, subprocess.SubprocessError) as exc:  # the Agent relays this line
            raise SystemExit(f'APEX motion toolkit unavailable: {type(exc).__name__}: {exc}') from None
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['browser', 'prepare-hypit', 'enable-hosted-hypit', 'font', 'openfilm',
                                            'openfilm-check', 'motion'])
    parser.add_argument('--workspace', '--project', type=Path, default=Path.cwd())
    parser.add_argument('--hypit-version')
    args = parser.parse_args()
    if args.command == 'openfilm-check':  # hc-1201: Desktop's first-run check of the editor; reads only
        try:
            print(json.dumps(openfilm_check()))
        except (OSError, ValueError, KeyError) as exc:  # Desktop then starts the install without the check
            raise SystemExit(f'APEX OpenFilm check unavailable: {type(exc).__name__}: {exc}') from None
        raise SystemExit(0)
    if args.command == 'openfilm':
        try:
            print(ensure_openfilm())
        except (OSError, ValueError, KeyError, subprocess.SubprocessError) as exc:  # Desktop retries later; one line, no traceback
            raise SystemExit(f'APEX OpenFilm toolkit unavailable: {type(exc).__name__}: {exc}') from None
    elif args.command == 'font':
        try:
            print(ensure_font())
        except (OSError, ValueError, KeyError) as exc:  # the Agent relays this line instead of a traceback
            raise SystemExit(f'APEX subtitle font unavailable: {type(exc).__name__}: {exc}') from None
    elif args.command == 'enable-hosted-hypit':
        try:
            print(enable_hosted_hypit(args.workspace, args.hypit_version))
        except (OSError, ValueError) as exc:  # the Agent relays this line instead of a traceback
            raise SystemExit(f'APEX hosted generation not added: {exc}') from None
    else:
        print(ensure_browser() if args.command == 'browser' else prepare_hypit(args.workspace, args.hypit_version))
