"""The APEX Hypit Profile with APEX-hosted generation off: byte-identical to fork main.

`desktop_features.hypihub_apex` (default off) lets `hypit apex-prepare` add the hosted
`hypihub.apex` Endpoint. While it is off (anything but APEX_HYPIHUB_ACTIVE=1, or a
Hypit 0.2 project), the Profile and package.json a new project gets must stay the bytes
fork main wrote. The goldens under ``__identity__/hypit-profile/`` were recorded on fork
main 024c8151 before the switch existed; only the three machine paths are placeholders.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from apex_overlay import media_tools

GOLDEN = Path(__file__).parent / '__identity__' / 'hypit-profile'

OFF_ENVIRONMENTS = {
    'unset': {},
    'zero': {'APEX_HYPIHUB_ACTIVE': '0'},
    'empty': {'APEX_HYPIHUB_ACTIVE': ''},
    'word-true': {'APEX_HYPIHUB_ACTIVE': 'true'},
    'key-only': {'TOOLS_GATEWAY_KEY': 'fake-agent-key-not-a-secret'},
}


def _runtime(tmp_path: Path) -> Path:
    root = tmp_path / 'runtime'
    binary = root / '.runtime/bin'
    binary.mkdir(parents=True)
    for name in ('ffmpeg', 'ffprobe'):
        (binary / (name + ('.exe' if os.name == 'nt' else ''))).touch()
    return root


def _normalized(text: str, root: Path, browser: Path) -> str:
    suffix = '.exe' if os.name == 'nt' else ''
    for path, token in ((root / '.runtime/bin' / ('ffmpeg' + suffix), '<FFMPEG>'),
                        (root / '.runtime/bin' / ('ffprobe' + suffix), '<FFPROBE>'),
                        (browser, '<BROWSER>')):
        encoded = json.dumps(str(path), ensure_ascii=False)[1:-1]
        assert text.count(encoded) >= 1, f'{token} path missing from the written Profile'
        text = text.replace(encoded, token)
    return text


def _prepare(tmp_path, monkeypatch, version, environment):
    for name in ('APEX_HYPIHUB_ACTIVE', 'TOOLS_GATEWAY_KEY', 'TOOLS_GATEWAY_BASE'):
        monkeypatch.delenv(name, raising=False)
    for name, value in environment.items():
        monkeypatch.setenv(name, value)
    root = _runtime(tmp_path)
    browser = tmp_path / 'chrome' / 'Google Chrome for Testing'
    monkeypatch.setattr(media_tools, 'ROOT', root)
    monkeypatch.setattr(media_tools, 'ensure_browser', lambda **_: browser)
    work = tmp_path / 'project'
    work.mkdir()
    (work / 'package.json').write_text(json.dumps({'name': 'retained', 'scripts': {'test': 'original'}}))
    profile = media_tools.prepare_hypit(work, version)
    return root, browser, work, profile


@pytest.mark.parametrize('environment', OFF_ENVIRONMENTS.values(), ids=OFF_ENVIRONMENTS.keys())
@pytest.mark.parametrize('version', ['0.3.1', '0.2.17'])
def test_new_project_profile_is_main_bytes_while_hosted_generation_is_off(tmp_path, monkeypatch, version, environment):
    root, browser, work, profile = _prepare(tmp_path, monkeypatch, version, environment)
    written = profile.read_text(encoding='utf-8')
    assert _normalized(written, root, browser) == (GOLDEN / f'profile-{version}.json').read_text(encoding='utf-8')
    assert (work / 'package.json').read_text(encoding='utf-8') == (
        GOLDEN / f'package-{version}.json').read_text(encoding='utf-8')
    assert 'fake-agent-key-not-a-secret' not in written


def test_hypit_0_2_projects_never_get_the_hosted_endpoint(tmp_path, monkeypatch):
    # provider-hypihub 0.2.0 peers on @hypit/hypit ^0.3.1, so the switch cannot reach a 0.2 project.
    root, browser, _, profile = _prepare(tmp_path, monkeypatch, '0.2.17', {'APEX_HYPIHUB_ACTIVE': '1'})
    assert _normalized(profile.read_text(encoding='utf-8'), root, browser) == (
        GOLDEN / 'profile-0.2.17.json').read_text(encoding='utf-8')
