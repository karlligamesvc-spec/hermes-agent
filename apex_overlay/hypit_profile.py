"""Prepare only a new project; preserve explicit profiles and project locks.

APEX-hosted generation (`desktop_features.hypihub_apex`, default off): Desktop main writes
APEX_HYPIHUB_ACTIVE=1 before the engine spawns. Only then does a new Hypit 0.3 Profile also
select `hypihub.apex`, Hypit's own HypiHub Provider pointed at the APEX Scheduler, and
`merge_hosted_endpoint` adds it to an existing APEX Profile on explicit request. The Profile
names only the environment variable; the `hypit` wrapper fills it with the engine's
platform-tool credential (hc-604's TOOLS_GATEWAY_KEY), so no key is written to the project.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.parse import urlsplit

HOSTED_SWITCH = 'APEX_HYPIHUB_ACTIVE'
HOSTED_ENDPOINT = 'hypihub.apex'
# @hypit/credential-store-env resolves only references whose store is literally "env".
HOSTED_STORE = 'env'
HOSTED_TOKEN = 'APEX_HYPIHUB_TOKEN'
PUBLIC_BASE = 'https://api.apex-nodes.com'
# The Endpoints APEX writes itself; anything else in a Profile is the user's own choice.
APEX_LOCAL_PROVIDERS = {'@hypit/media-local', '@hypit/provider-html-local'}


def hosted_active(environ=os.environ) -> bool:
    return environ.get(HOSTED_SWITCH) == '1'


def hosted_entries(environ=os.environ) -> tuple[dict, dict]:
    """The credential Store and Endpoint the hosted Profile adds, on the same base as every platform tool."""
    base = (environ.get('TOOLS_GATEWAY_BASE') or PUBLIC_BASE).strip().rstrip('/')
    url = urlsplit(base)
    # provider-hypihub refuses anything else at activation; fail here, before a Profile is written.
    if url.scheme != 'https' and url.hostname not in {'localhost', '127.0.0.1'}:
        raise ValueError(f'APEX hosted generation needs an HTTPS platform address, not {base}')
    store = {'use': '@hypit/credential-store-env'}
    endpoint = {'use': '@hypit/provider-hypihub', 'config': {
        'baseUrl': base + '/hypihub', 'apiKey': {'store': HOSTED_STORE, 'key': HOSTED_TOKEN}}}
    return store, endpoint


def _selected_profile(workspace: Path) -> Path | None:
    # runtime use writes this selector. Never replace an existing selection.
    selection = workspace / '.hypit/runtime'
    if selection.is_file():
        selected = Path(selection.read_text(encoding='utf-8').strip())
        selected = selected if selected.is_absolute() else workspace / selected
        if not selected.is_file():
            raise FileNotFoundError(f'Selected Hypit profile missing: {selected}')
        return selected
    profile = workspace / '.hypit/apex-runtime.json'
    return profile if profile.exists() else None


def prepare_profile(workspace: Path, root: Path, version: str, resolve_browser, *, hosted: bool = False) -> Path:
    modern = version.startswith('0.3.')
    if not modern and not version.startswith('0.2.'):
        raise ValueError(f'Unsupported Hypit version: {version}')
    workspace = workspace.resolve()
    existing = _selected_profile(workspace)
    if existing is not None:
        return existing
    profile = workspace / '.hypit/apex-runtime.json'
    # provider-hypihub 0.2.0 peers on @hypit/hypit ^0.3.1: a 0.2 project keeps its local Profile.
    hosted = hosted and modern
    store, endpoint = hosted_entries() if hosted else (None, None)
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
    if hosted:
        body = {'format': body['format'], 'dataRoot': body['dataRoot'], 'credentials': {HOSTED_STORE: store},
                'endpoints': {**body['endpoints'], HOSTED_ENDPOINT: endpoint}}
    with profile.open('x', encoding='utf-8') as output:
        json.dump(body, output, ensure_ascii=False, indent=2)
    return profile


def merge_hosted_endpoint(workspace: Path, version: str) -> Path:
    """Add `hypihub.apex` to the project's selected Profile; only ever on an explicit command."""
    if not version.startswith('0.3.'):
        raise ValueError(f'APEX hosted generation needs a Hypit 0.3 project; this one uses {version}')
    workspace = workspace.resolve()
    profile = _selected_profile(workspace)
    if profile is None:
        raise FileNotFoundError('This project has no Hypit Profile yet; run hypit apex-prepare first')
    body = json.loads(profile.read_text(encoding='utf-8'))
    endpoints = body.get('endpoints') if isinstance(body, dict) else None
    credentials = body.get('credentials', {}) if isinstance(body, dict) else None
    if not isinstance(endpoints, dict) or not isinstance(credentials, dict):
        raise ValueError(f'{profile} is not a Hypit Runtime Profile')
    store, endpoint = hosted_entries()
    if endpoints.get(HOSTED_ENDPOINT) == endpoint and credentials.get(HOSTED_STORE) == store:
        return profile
    # The same env Store may already be declared; anything else under these names is the user's.
    taken = [name for name, value, wanted in (
        (HOSTED_ENDPOINT, endpoints.get(HOSTED_ENDPOINT), endpoint),
        (f'credentials.{HOSTED_STORE}', credentials.get(HOSTED_STORE), store)) if value not in (None, wanted)]
    # A second Provider for the same capabilities would need bindings this command cannot choose.
    chosen = sorted(name for name, value in endpoints.items() if name != HOSTED_ENDPOINT and (
        not isinstance(value, dict) or value.get('use') not in APEX_LOCAL_PROVIDERS))
    if taken or chosen:
        raise ValueError('Not merged; this Profile keeps its own choices for: ' + ', '.join(taken + chosen))
    body['credentials'] = {**credentials, HOSTED_STORE: store}
    body['endpoints'] = {**endpoints, HOSTED_ENDPOINT: endpoint}
    temporary = profile.with_name(profile.name + '.apex-tmp')
    with temporary.open('x', encoding='utf-8') as output:
        json.dump(body, output, ensure_ascii=False, indent=2)
    temporary.replace(profile)
    return profile
