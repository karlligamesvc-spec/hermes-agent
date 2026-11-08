"""hc-1176: the OpenFilm toolkit publisher uploads only the locked archive, to the locked key, and reads it back."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('publish_toolkit', ROOT / 'scripts/media-tools/openfilm/publish_toolkit.py')
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)
KEY = 'media-tools/openfilm/0.3.0/abc/openfilm-toolkit.tgz'


class FakeCos:
    def __init__(self):
        self.uploads = []

    def upload_file(self, **kwargs):
        self.uploads.append(kwargs)


@pytest.fixture
def setup(tmp_path, monkeypatch):
    payload = b'toolkit bytes'
    archive = tmp_path / 'openfilm-toolkit.tgz'
    archive.write_bytes(payload)
    lock = tmp_path / 'desktop-lock.json'
    lock.write_text(json.dumps({'openfilm': {'version': '0.3.0', 'patches': ['0001'], 'bytes': len(payload),
                                             'sha256': hashlib.sha256(payload).hexdigest(), 'url': f'https://{publisher.HOST}/{KEY}'}}))
    served = {'body': payload}
    monkeypatch.setattr(publisher.urllib.request, 'urlopen', lambda *a, **k: io.BytesIO(served['body']))
    return archive, lock, served


def test_uploads_the_locked_archive_to_its_key_and_reads_it_back(setup):
    archive, lock, _ = setup
    client = FakeCos()
    assert publisher.publish(archive, client, lock) == KEY
    assert [(u['Bucket'], u['Key'], u['LocalFilePath']) for u in client.uploads] == [(publisher.BUCKET, KEY, str(archive))]


def test_refuses_an_archive_that_is_not_the_locked_one(setup):
    archive, lock, _ = setup
    archive.write_bytes(b'another build')
    client = FakeCos()
    with pytest.raises(ValueError, match='differs from desktop-lock.json'):
        publisher.publish(archive, client, lock)
    assert client.uploads == []


def test_a_read_back_that_differs_fails(setup):
    archive, lock, served = setup
    served['body'] = b'truncated'
    with pytest.raises(ValueError, match='read back'):
        publisher.publish(archive, FakeCos(), lock)
