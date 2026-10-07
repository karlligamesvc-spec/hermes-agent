"""Actual release uploader rejects unserved/truncated files and hides SDK secrets."""
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import sys
from types import ModuleType
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
    package = tmp_path / 'qcloud_cos'
    package.mkdir()
    (package / 'cos_exception.py').write_text('class CosClientError(Exception): pass\n')
    (package / '__init__.py').write_text('''
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


@pytest.mark.parametrize('failed_route,served_size', [('network', 3), ('network', 2), ('service', 3)])
def test_cli_transport_failover_keeps_service_and_public_size_gates(tmp_path, monkeypatch, capsys,
                                                                 failed_route, served_size):
    local = tmp_path / 'APEX-0.17.52-win-x64.exe'
    local.write_bytes(b'MZx')
    monkeypatch.setattr(sys, 'argv', [str(SCRIPT), '--file', str(local), '--key',
                                    'desktop/win-x64/' + local.name])
    monkeypatch.setenv('COS_SECRET_ID', 'fixture-identity')
    monkeypatch.setenv('COS_SECRET_KEY', 'credential-redline-test-value')
    sdk, errors = ModuleType('qcloud_cos'), ModuleType('qcloud_cos.cos_exception')
    class CosClientError(Exception): pass
    errors.CosClientError = CosClientError
    configurations, uploads = [], []
    sdk.CosConfig = lambda **kwargs: kwargs
    class Client:
        def __init__(self, config):
            configurations.append(config)
            self.config = config
        def upload_file(self, **kwargs):
            uploads.append(kwargs)
            if failed_route == 'service' or len(uploads) == 1 or not self.config['AutoSwitchDomainOnRetry']:
                error = PermissionError if failed_route == 'service' else CosClientError
                raise error('credential-redline-test-value')
            kwargs['progress_callback'](3, 3)
    sdk.CosS3Client = Client
    monkeypatch.setitem(sys.modules, 'qcloud_cos', sdk)
    monkeypatch.setitem(sys.modules, 'qcloud_cos.cos_exception', errors)
    class Response(io.BytesIO):
        status = 200
        headers = {'Content-Length': str(served_size)}
    monkeypatch.setattr(publisher.urllib.request, 'urlopen', lambda *a, **k: Response())
    if failed_route == 'service':
        with pytest.raises(PermissionError): publisher.main()
        assert len(uploads) == 1
    elif served_size != 3:
        with pytest.raises(RuntimeError, match='exact size'): publisher.main()
        assert len(uploads) == 2
    else:
        assert publisher.main() == 0
        assert len(uploads) == 2
        stable = [{k:v for k,v in upload.items() if k != 'progress_callback'} for upload in uploads]
        assert stable[0] == stable[1] and uploads[0]['EnableMD5']
        assert all(c.get('Domain') is None for c in configurations)
        assert all(c['Scheme'] == 'https' and c['AutoSwitchDomainOnRetry'] for c in configurations)
    assert 'credential-redline-test-value' not in ''.join(capsys.readouterr())


@pytest.mark.parametrize('outcomes,expected,calls', [
    (['timeout', 75, 0], 0, 3), ([75, 75, 75], 75, 3), ([1], 1, 1),
])
def test_stalled_owned_worker_is_bounded_and_only_transient_exits_resume(monkeypatch, outcomes, expected, calls):
    seen = []
    def run(args, **kwargs):
        seen.append((args, kwargs))
        outcome = outcomes[len(seen)-1]
        if outcome == 'timeout': raise subprocess.TimeoutExpired(args, kwargs['timeout'])
        return subprocess.CompletedProcess(args, outcome)
    monkeypatch.setattr(publisher.subprocess, 'run', run)
    args = ['--file', '/owned/release.exe', '--key', 'desktop/win-x64/release.exe']
    assert publisher.run_bounded_upload(args) == expected
    assert len(seen) == calls
    assert all(command[-4:] == args and '--transfer-worker' in command and options['timeout'] == 180
               for command, options in seen)
