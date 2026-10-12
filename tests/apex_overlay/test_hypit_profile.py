"""Version-aware preparation preserves user configuration and existing locks."""
import json
import os
from pathlib import Path

import pytest

from apex_overlay.hypit_profile import prepare_profile


@pytest.mark.parametrize('version,media,render', [
    ('0.2.17', '@hypit/provider-media-local', '@hypit/provider-hyperframes-local'),
    ('0.3.1', '@hypit/media-local', '@hypit/provider-html-local'),
])
def test_new_profiles_select_matching_providers_and_preserve_package_fields(tmp_path, version, media, render):
    binary = tmp_path / 'runtime/.runtime/bin'
    binary.mkdir(parents=True)
    for name in ('ffmpeg', 'ffprobe'):
        (binary / (name + ('.exe' if os.name == 'nt' else ''))).touch()
    work = tmp_path / 'project'
    work.mkdir()
    package = work / 'package.json'
    package.write_text(json.dumps({'name':'retained','scripts':{'test':'original'}}))
    lock = work / 'package-lock.json'
    lock.write_text('untouched-lock')
    profile = prepare_profile(work, tmp_path/'runtime', version, lambda **kwargs: Path('/test/browser'))
    body = json.loads(profile.read_text())
    assert {e['use'] for e in body['endpoints'].values()} == {media, render}
    assert json.loads(package.read_text())['scripts'] == {'test':'original'}
    assert lock.read_text() == 'untouched-lock'
    assert json.loads(package.read_text()).get('hypit',{}).get('project',False) == version.startswith('0.3.')
    before = profile.read_bytes()
    assert prepare_profile(work,tmp_path/'absent',version,lambda **_: pytest.fail('unexpected download')) == profile
    assert profile.read_bytes() == before


def test_selected_custom_profile_never_downloads_or_overwrites(tmp_path):
    (tmp_path/'.hypit').mkdir()
    (tmp_path/'.hypit/runtime').write_text('custom.json\n')
    selected = tmp_path/'custom.json'
    selected.write_text('{"endpoints":{}}')
    assert prepare_profile(tmp_path,tmp_path/'absent','0.3.1',lambda **_: pytest.fail('download')) == selected
    assert not (tmp_path/'package.json').exists()
    selected.unlink()
    with pytest.raises(FileNotFoundError,match='Selected Hypit profile missing'):
        prepare_profile(tmp_path,tmp_path,'0.3.1',lambda **_: pytest.fail('download'))
