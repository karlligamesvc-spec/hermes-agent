"""APEX-hosted Hypit generation (`desktop_features.hypihub_apex` on): what a Profile gets.

With APEX_HYPIHUB_ACTIVE=1 a new Hypit 0.3 project also selects `hypihub.apex`, and an
existing APEX Profile gets it only through `hypit apex-enable-hosted`. The Profile names the
env Store slot APEX_HYPIHUB_TOKEN and never holds a key. The off path is pinned byte for byte
by test_hypit_profile_identity.py. The Store is named "env" because @hypit/credential-store-env
resolves only references whose store is literally "env" (found by the real-CLI run: any other
name leaves the Endpoint with RUNTIME_CREDENTIAL_MISSING).
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from apex_overlay import media_tools
from apex_overlay.hypit_profile import merge_hosted_endpoint, prepare_profile

FAKE_KEY = 'fake-agent-key-not-a-secret'
STORE = {'use': '@hypit/credential-store-env'}


def _endpoint(base='https://api.apex-nodes.com'):
    return {'use': '@hypit/provider-hypihub', 'config': {
        'baseUrl': base + '/hypihub', 'apiKey': {'store': 'env', 'key': 'APEX_HYPIHUB_TOKEN'}}}


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    for name in ('APEX_HYPIHUB_ACTIVE', 'TOOLS_GATEWAY_BASE'):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv('TOOLS_GATEWAY_KEY', FAKE_KEY)
    root = tmp_path / 'runtime'
    binary = root / '.runtime/bin'
    binary.mkdir(parents=True)
    for name in ('ffmpeg', 'ffprobe'):
        (binary / (name + ('.exe' if os.name == 'nt' else ''))).touch()
    monkeypatch.setattr(media_tools, 'ROOT', root)
    monkeypatch.setattr(media_tools, 'ensure_browser', lambda **_: tmp_path / 'chrome')
    return root


def _project(tmp_path, name='project'):
    work = tmp_path / name
    work.mkdir()
    return work


def test_switch_on_adds_the_hosted_endpoint_to_a_new_0_3_project(tmp_path, monkeypatch, runtime):
    monkeypatch.setenv('APEX_HYPIHUB_ACTIVE', '1')
    profile = media_tools.prepare_hypit(_project(tmp_path), '0.3.1')
    text = profile.read_text(encoding='utf-8')
    body = json.loads(text)
    assert list(body) == ['format', 'dataRoot', 'credentials', 'endpoints']
    assert body['credentials'] == {'env': STORE}
    assert list(body['endpoints']) == ['media.local', 'html.local', 'hypihub.apex']
    assert body['endpoints']['hypihub.apex'] == _endpoint()
    assert FAKE_KEY not in text


@pytest.mark.parametrize('base,expected', [
    ('https://api.apex-nodes.com/', 'https://api.apex-nodes.com/hypihub'),
    ('http://127.0.0.1:18765', 'http://127.0.0.1:18765/hypihub'),
    ('https://staging.example.test', 'https://staging.example.test/hypihub'),
])
def test_hosted_base_follows_the_platform_tool_base(tmp_path, monkeypatch, runtime, base, expected):
    monkeypatch.setenv('APEX_HYPIHUB_ACTIVE', '1')
    monkeypatch.setenv('TOOLS_GATEWAY_BASE', base)
    body = json.loads(media_tools.prepare_hypit(_project(tmp_path), '0.3.1').read_text(encoding='utf-8'))
    assert body['endpoints']['hypihub.apex']['config']['baseUrl'] == expected


def test_a_plain_http_platform_base_writes_no_profile(tmp_path, monkeypatch, runtime):
    # provider-hypihub accepts only HTTPS or loopback; a Profile it would refuse is never written.
    monkeypatch.setenv('APEX_HYPIHUB_ACTIVE', '1')
    monkeypatch.setenv('TOOLS_GATEWAY_BASE', 'http://api.apex-nodes.com')
    work = _project(tmp_path)
    with pytest.raises(ValueError, match='HTTPS platform address'):
        media_tools.prepare_hypit(work, '0.3.1')
    assert not (work / '.hypit/apex-runtime.json').exists()


def test_switch_on_never_rewrites_an_existing_profile(tmp_path, monkeypatch, runtime):
    work = _project(tmp_path)
    profile = media_tools.prepare_hypit(work, '0.3.1')
    before = profile.read_bytes()
    monkeypatch.setenv('APEX_HYPIHUB_ACTIVE', '1')
    assert media_tools.prepare_hypit(work, '0.3.1') == profile
    assert profile.read_bytes() == before


def _local_profile(tmp_path, runtime, name='project'):
    work = _project(tmp_path, name)
    return work, prepare_profile(work, runtime, '0.3.1', lambda **_: tmp_path / 'chrome')


def test_merge_adds_only_the_hosted_entries_and_is_idempotent(tmp_path, monkeypatch, runtime):
    work, profile = _local_profile(tmp_path, runtime)
    body = json.loads(profile.read_text(encoding='utf-8'))
    body['bindings'] = {}
    body['worker'] = {'executionMemoryMb': 2048}
    profile.write_text(json.dumps(body, indent=2), encoding='utf-8')
    monkeypatch.setenv('APEX_HYPIHUB_ACTIVE', '1')
    assert media_tools.enable_hosted_hypit(work, '0.3.1') == profile
    merged = json.loads(profile.read_text(encoding='utf-8'))
    assert merged == {**body, 'credentials': {'env': STORE},
                      'endpoints': {**body['endpoints'], 'hypihub.apex': _endpoint()}}
    once = profile.read_bytes()
    assert media_tools.enable_hosted_hypit(work, '0.3.1') == profile
    assert profile.read_bytes() == once
    assert FAKE_KEY.encode() not in once
    assert not list(profile.parent.glob('*.apex-tmp'))


def test_merge_writes_into_the_profile_the_project_selected(tmp_path, monkeypatch, runtime):
    work = _project(tmp_path)
    (work / '.hypit').mkdir()
    custom = work / 'custom.runtime.json'
    custom.write_text(json.dumps({'format': 'hypit.runtime-local@1', 'dataRoot': 'data', 'endpoints': {}}))
    (work / '.hypit/runtime').write_text('custom.runtime.json\n')
    monkeypatch.setenv('APEX_HYPIHUB_ACTIVE', '1')
    assert media_tools.enable_hosted_hypit(work, '0.3.1') == custom
    assert json.loads(custom.read_text())['endpoints'] == {'hypihub.apex': _endpoint()}
    assert not (work / '.hypit/apex-runtime.json').exists()


@pytest.mark.parametrize('name,entry,reason', [
    ('hypihub.default', {'use': '@hypit/provider-hypihub', 'config': {}}, 'hypihub.default'),
    ('whisperx.local', {'use': '@hypit/provider-whisperx-local'}, 'whisperx.local'),
    ('hypihub.apex', {'use': '@hypit/provider-hypihub', 'config': {'baseUrl': 'https://hypit.ai'}}, 'hypihub.apex'),
])
def test_merge_keeps_a_profile_with_its_own_choices_unchanged(tmp_path, monkeypatch, runtime, name, entry, reason):
    work, profile = _local_profile(tmp_path, runtime)
    body = json.loads(profile.read_text(encoding='utf-8'))
    body['endpoints'][name] = entry
    profile.write_text(json.dumps(body, indent=2), encoding='utf-8')
    before = profile.read_bytes()
    monkeypatch.setenv('APEX_HYPIHUB_ACTIVE', '1')
    with pytest.raises(ValueError, match=f'keeps its own choices for: .*{reason}'):
        media_tools.enable_hosted_hypit(work, '0.3.1')
    assert profile.read_bytes() == before


def test_merge_keeps_a_different_credential_store_of_the_same_name(tmp_path, monkeypatch, runtime):
    work, profile = _local_profile(tmp_path, runtime)
    body = json.loads(profile.read_text(encoding='utf-8'))
    body['credentials'] = {'env': {'use': '@hypit/credential-store-local'}}
    profile.write_text(json.dumps(body, indent=2), encoding='utf-8')
    before = profile.read_bytes()
    monkeypatch.setenv('APEX_HYPIHUB_ACTIVE', '1')
    with pytest.raises(ValueError, match='credentials.env'):
        media_tools.enable_hosted_hypit(work, '0.3.1')
    assert profile.read_bytes() == before


def test_merge_shares_an_env_store_the_profile_already_declares(tmp_path, monkeypatch, runtime):
    work, profile = _local_profile(tmp_path, runtime)
    body = json.loads(profile.read_text(encoding='utf-8'))
    body['credentials'] = {'local': {'use': '@hypit/credential-store-local'}, 'env': dict(STORE)}
    profile.write_text(json.dumps(body, indent=2), encoding='utf-8')
    monkeypatch.setenv('APEX_HYPIHUB_ACTIVE', '1')
    media_tools.enable_hosted_hypit(work, '0.3.1')
    merged = json.loads(profile.read_text(encoding='utf-8'))
    assert merged['credentials'] == body['credentials']
    assert merged['endpoints']['hypihub.apex'] == _endpoint()


@pytest.mark.parametrize('switch', [None, '0', 'true'])
def test_merge_refuses_while_the_switch_is_off(tmp_path, monkeypatch, runtime, switch):
    work, profile = _local_profile(tmp_path, runtime)
    before = profile.read_bytes()
    if switch is not None:
        monkeypatch.setenv('APEX_HYPIHUB_ACTIVE', switch)
    with pytest.raises(ValueError, match='not enabled'):
        media_tools.enable_hosted_hypit(work, '0.3.1')
    assert profile.read_bytes() == before


def test_merge_refuses_hypit_0_2_and_projects_without_a_profile(tmp_path, monkeypatch, runtime):
    monkeypatch.setenv('APEX_HYPIHUB_ACTIVE', '1')
    with pytest.raises(ValueError, match='needs a Hypit 0.3 project'):
        merge_hosted_endpoint(_project(tmp_path, 'old'), '0.2.17')
    with pytest.raises(FileNotFoundError, match='apex-prepare first'):
        merge_hosted_endpoint(_project(tmp_path, 'new'), '0.3.1')
    assert not (tmp_path / 'new/.hypit').exists()
