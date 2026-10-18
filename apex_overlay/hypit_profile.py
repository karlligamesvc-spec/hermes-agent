"""Prepare only a new project; preserve explicit profiles and project locks."""
from __future__ import annotations

import json
import os
from pathlib import Path


def prepare_profile(workspace: Path, root: Path, version: str, resolve_browser) -> Path:
    modern = version.startswith('0.3.')
    if not modern and not version.startswith('0.2.'):
        raise ValueError(f'Unsupported Hypit version: {version}')
    workspace = workspace.resolve()
    # runtime use writes this selector. Never replace an existing selection.
    selection = workspace / '.hypit/runtime'
    profile = workspace / '.hypit/apex-runtime.json'
    if selection.is_file():
        selected = Path(selection.read_text(encoding='utf-8').strip())
        selected = selected if selected.is_absolute() else workspace / selected
        if not selected.is_file():
            raise FileNotFoundError(f'Selected Hypit profile missing: {selected}')
        return selected
    if profile.exists():
        return profile
    suffix = '.exe' if os.name == 'nt' else ''
    binary = root / '.runtime/bin'
    for name in ('ffmpeg', 'ffprobe'):
        if not (binary / (name + suffix)).is_file():
            raise FileNotFoundError(f'Bundled {name} missing; repair APEX installation')
    browser = resolve_browser(render=True)
    tools = {'ffmpegPath': str(binary / ('ffmpeg' + suffix)), 'ffprobePath': str(binary / ('ffprobe' + suffix))}
    profile.parent.mkdir(parents=True, exist_ok=True)
    if modern:
        package = workspace / 'package.json'
        body = json.loads(package.read_text(encoding='utf-8')) if package.exists() else {'private': True}
        if not isinstance(body.get('hypit', {}), dict):
            raise ValueError('package.json hypit field must be an object')
        if body.get('hypit', {}).get('project') is not True:
            body.setdefault('hypit', {})['project'] = True
            temporary = package.with_name('package.json.apex-tmp')
            with temporary.open('x', encoding='utf-8') as output:
                json.dump(body, output, ensure_ascii=False, indent=2)
            temporary.replace(package)
    body = {'format': 'hypit.runtime-local@1', 'dataRoot': 'apex-runtime-data', 'endpoints': {
        'media.local': {'use': '@hypit/media-local' if modern else '@hypit/provider-media-local', 'config': tools},
        'html.local' if modern else 'hyperframes.local': {
            'use': '@hypit/provider-html-local' if modern else '@hypit/provider-hyperframes-local',
            'config': {**tools, 'chromePath': str(browser)}},
    }}
    with profile.open('x', encoding='utf-8') as output:
        json.dump(body, output, ensure_ascii=False, indent=2)
    return profile
