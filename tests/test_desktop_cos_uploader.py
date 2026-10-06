"""Actual release uploader rejects unserved/truncated files and hides SDK secrets."""
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import sys
from unittest.mock import Mock

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/release/upload-desktop-cos.py'
spec = importlib.util.spec_from_file_location('desktop_cos_uploader', SCRIPT)
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


@pytest.mark.parametrize('served_size', [0, 2, 3])
def test_actual_published_size_gates_success(tmp_path, monkeypatch, served_size):
    local = tmp_path / 'APEX-0.17.50-win-x64.exe'
    local.write_bytes(b'MZx')
    client = Mock()

    class Response(io.BytesIO):
        status = 200
        headers = {'Content-Length': str(served_size)}

    requests = []
    def urlopen(request, **kwargs):
        requests.append(request)
        return Response()

    monkeypatch.setattr(publisher.urllib.request, 'urlopen', urlopen)
    if served_size == 3:
        result = publisher.upload_and_verify(local, 'desktop/win-x64/' + local.name, client)
        assert result['publicHeadVerified'] and result['bytes'] == 3
    else:
        with pytest.raises(RuntimeError, match='exact size'):
            publisher.upload_and_verify(local, 'desktop/win-x64/' + local.name, client)
    assert client.upload_file.call_count == 1
    assert requests[0].get_method() == 'HEAD'
    assert requests[0].full_url == publisher.BASE + '/desktop/win-x64/' + local.name


@pytest.mark.parametrize('key', ['desktop/other/file.zip', 'desktop/mac-arm64/../file.zip',
                               'runtime/file.zip', 'desktop/mac-arm64/other.zip'])
def test_foreign_or_mismatched_objects_never_upload(tmp_path, key):
    local = tmp_path / 'file.zip'
    local.write_bytes(b'PK\x03\x04')
    client = Mock()
    with pytest.raises(ValueError):
        publisher.upload_and_verify(local, key, client)
    client.upload_file.assert_not_called()


def test_cli_never_prints_signed_sdk_exception_headers(tmp_path):
    (tmp_path / 'qcloud_cos.py').write_text('''
class CosConfig:
    def __init__(self, **kwargs): pass
class CosS3Client:
    def __init__(self, config): pass
    def upload_file(self, **kwargs): raise RuntimeError('credential-redline-test-value')
''')
    local = tmp_path / 'APEX-0.17.50-win-x64.exe'
    local.write_bytes(b'MZx')
    env = {**os.environ, 'PYTHONPATH': str(tmp_path),
           'COS_SECRET_ID': 'fixture-identity', 'COS_SECRET_KEY': 'credential-redline-test-value'}
    result = subprocess.run([sys.executable, str(SCRIPT), '--file', str(local), '--key',
                             'desktop/win-x64/' + local.name], env=env, capture_output=True, text=True)
    assert result.returncode == 1
    assert 'RuntimeError' in result.stderr
    assert 'credential-redline-test-value' not in result.stdout + result.stderr
