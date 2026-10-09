"""APEX's verified COS browser cache, shared by browser automation and Hypit."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import struct
import subprocess
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / 'scripts/media-tools/desktop-lock.json'
COS_HOST = 'apexnodes-runtime-202606250443-1300912302.cos.ap-guangzhou.myqcloud.com'


def native_target() -> str:
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
            if size != spec['bytes'] or digest.hexdigest() != spec['sha256']:
                raise ValueError('COS browser archive checksum mismatch')
            unpacked = temporary / 'unpacked'
            unpacked.mkdir()
            tar = str(Path(os.environ.get('SystemRoot', 'C:/Windows')) / 'System32/tar.exe') if os.name == 'nt' else '/usr/bin/tar'
            subprocess.run([tar, '-xf', str(archive), '-C', str(unpacked)], check=True, timeout=180)
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
                subprocess.run([str(candidate), '--version'], check=True, capture_output=True, timeout=30)
            # A previous interrupted installation cannot leave a half-valid tree.
            if destination.exists():
                shutil.rmtree(destination)
            unpacked.rename(destination)
    return executable


def prepare_hypit(workspace: Path) -> Path:
    browser = ensure_browser(render=True)
    profile = workspace.resolve() / '.hypit' / 'apex-runtime.json'
    if profile.exists():
        return profile  # Never overwrite a project's explicit configuration.
    suffix = '.exe' if os.name == 'nt' else ''
    binary = ROOT / '.runtime/bin'
    for name in ('ffmpeg', 'ffprobe'):
        if not (binary / (name + suffix)).is_file():
            raise FileNotFoundError(f'Bundled {name} missing; repair APEX installation')
    tools = {'ffmpegPath': str(binary / ('ffmpeg' + suffix)), 'ffprobePath': str(binary / ('ffprobe' + suffix))}
    profile.parent.mkdir(parents=True, exist_ok=True)
    body = {'format': 'hypit.runtime-local@1', 'dataRoot': 'apex-runtime-data', 'endpoints': {
        'media.local': {'use': '@hypit/provider-media-local', 'config': tools},
        'hyperframes.local': {'use': '@hypit/provider-hyperframes-local', 'config': {**tools, 'chromePath': str(browser)}},
    }}
    with profile.open('x', encoding='utf-8') as output:
        json.dump(body, output, ensure_ascii=False, indent=2)
    return profile


def apply() -> bool:
    # Cloud/Linux and unpackaged developer environments retain their own installer.
    if platform.system() not in {'Darwin', 'Windows'} or not LOCK.is_file() or not (ROOT / '.runtime/node').is_dir():
        return False
    from tools import browser_tool_install as installer
    original = installer._maybe_autoinstall_chromium
    if getattr(original, '_apex_cos_browser', False):
        return True

    def install():
        from tools.lazy_deps import _allow_lazy_installs
        if not _allow_lazy_installs():
            return False
        if os.environ.get('AGENT_BROWSER_EXECUTABLE_PATH'):
            return Path(os.environ['AGENT_BROWSER_EXECUTABLE_PATH']).is_file()
        try:
            os.environ['AGENT_BROWSER_EXECUTABLE_PATH'] = str(ensure_browser())
            from tools.browser_tool_origin import origin_module
            origin_module()._cached_chromium_installed = None
            return True
        except Exception:
            import logging
            logging.getLogger(__name__).exception('APEX COS browser preparation failed')
            return False  # Do not fall through to a foreign download endpoint.
    install._apex_cos_browser = True
    installer._maybe_autoinstall_chromium = install
    return True


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['browser', 'prepare-hypit'])
    parser.add_argument('--workspace', type=Path, default=Path.cwd())
    args = parser.parse_args()
    print(ensure_browser() if args.command == 'browser' else prepare_hypit(args.workspace))
