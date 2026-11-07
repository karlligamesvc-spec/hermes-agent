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
    local = tmp_path / 'APEX-0.17.50-mac-arm64.zip'
    local.write_bytes(b'PKx')
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
        result = publisher.upload_and_verify(local, 'desktop/mac-arm64/' + local.name, client)
        assert result['publicHeadVerified'] and result['bytes'] == 3
    else:
        with pytest.raises(RuntimeError, match='exact size'):
            publisher.upload_and_verify(local, 'desktop/mac-arm64/' + local.name, client)
    assert client.upload_file.call_count == 1
    assert requests[0].get_method() == 'HEAD'
    assert requests[0].full_url == publisher.BASE + '/desktop/mac-arm64/' + local.name


@pytest.mark.parametrize('key', ['desktop/other/file.zip', 'desktop/mac-arm64/../file.zip',
                               'runtime/file.zip', 'desktop/mac-arm64/other.zip'])
def test_foreign_or_mismatched_objects_never_upload(tmp_path, key):
    local = tmp_path / 'file.zip'
    local.write_bytes(b'PK\x03\x04')
    client = Mock()
    with pytest.raises(ValueError):
        publisher.upload_and_verify(local, key, client)
    client.upload_file.assert_not_called()


WINDOWS_FILES = ['latest.yml', 'APEX-0.17.73-win-x64.exe', 'APEX-0.17.73-win-x64.exe.blockmap']
MAC_FILES = ['latest-mac.yml', 'APEX-0.17.73-mac-arm64.zip', 'APEX-0.17.73-mac-arm64.dmg']


def _refused(tmp_path, monkeypatch, key, **options):
    local = tmp_path / key.rsplit('/', 1)[1]
    local.write_bytes(b'version: 0.17.73\n')
    client = Mock()
    monkeypatch.setattr(publisher.urllib.request, 'urlopen', Mock(side_effect=AssertionError('no network in tests')))
    with pytest.raises(ValueError, match='invalid Desktop object key'):
        publisher.upload_and_verify(local, key, client, **options)
    client.upload_file.assert_not_called()


@pytest.mark.parametrize('windows_release', [False, True])
@pytest.mark.parametrize('name', ['latest-mac.yml', 'APEX-0.17.64-mac-x64.zip'])
def test_frozen_intel_feed_is_never_written(tmp_path, monkeypatch, name, windows_release):
    # Intel is not built any more; installed Intel shells keep polling desktop/mac-x64/ at 0.17.63.
    _refused(tmp_path, monkeypatch, 'desktop/mac-x64/' + name, windows_release=windows_release)


@pytest.mark.parametrize('name', WINDOWS_FILES)
def test_windows_feed_is_refused_without_the_windows_release_flag(tmp_path, monkeypatch, name):
    # A release without windows=true leaves desktop/win-x64/ at the last fixed version.
    _refused(tmp_path, monkeypatch, 'desktop/win-x64/' + name)


@pytest.mark.parametrize('name', MAC_FILES)
def test_windows_release_leg_cannot_write_the_mac_feed(tmp_path, monkeypatch, name):
    _refused(tmp_path, monkeypatch, 'desktop/mac-arm64/' + name, windows_release=True)


@pytest.mark.parametrize('name', WINDOWS_FILES)
def test_windows_release_flag_writes_the_windows_feed(tmp_path, monkeypatch, name):
    local = tmp_path / name
    local.write_bytes(b'MZx')
    client = Mock()

    class Response(io.BytesIO):
        status = 200
        headers = {'Content-Length': '3'}

    monkeypatch.setattr(publisher.urllib.request, 'urlopen', lambda *a, **k: Response())
    result = publisher.upload_and_verify(local, 'desktop/win-x64/' + name, client, windows_release=True)
    assert result['object'] == 'desktop/win-x64/' + name and result['publicHeadVerified']
    assert client.upload_file.call_args.kwargs['Key'] == 'desktop/win-x64/' + name


def _fake_sdk(monkeypatch, uploads):
    sdk, errors = ModuleType('qcloud_cos'), ModuleType('qcloud_cos.cos_exception')
    errors.CosClientError = type('CosClientError', (Exception,), {})
    sdk.CosConfig = lambda **kwargs: kwargs

    class Client:
        def __init__(self, config): pass
        def upload_file(self, **kwargs): uploads.append(kwargs['Key'])

    sdk.CosS3Client = Client
    monkeypatch.setitem(sys.modules, 'qcloud_cos', sdk)
    monkeypatch.setitem(sys.modules, 'qcloud_cos.cos_exception', errors)


@pytest.mark.parametrize('flags,prefix,writes', [
    ([], 'desktop/mac-arm64/', True),
    ([], 'desktop/win-x64/', False),
    ([publisher.WINDOWS_RELEASE], 'desktop/win-x64/', True),
    ([publisher.WINDOWS_RELEASE], 'desktop/mac-arm64/', False),
])
def test_cli_windows_release_flag_picks_the_feed_it_may_write(tmp_path, monkeypatch, flags, prefix, writes):
    # The flag desktop-windows.yml's publish job passes must reach upload_and_verify.
    local = tmp_path / 'latest.yml'
    local.write_bytes(b'v: 1')
    monkeypatch.setattr(sys, 'argv', [str(SCRIPT), '--file', str(local), '--key', prefix + local.name, *flags])
    monkeypatch.setenv('COS_SECRET_ID', 'fixture-identity')
    monkeypatch.setenv('COS_SECRET_KEY', 'fixture-secret')
    uploads = []
    _fake_sdk(monkeypatch, uploads)

    class Response(io.BytesIO):
        status = 200
        headers = {'Content-Length': '4'}

    monkeypatch.setattr(publisher.urllib.request, 'urlopen', lambda *a, **k: Response())
    if writes:
        assert publisher.main() == 0
        assert uploads == [prefix + local.name]
    else:
        with pytest.raises(ValueError, match='invalid Desktop object key'):
            publisher.main()
        assert uploads == []


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
    local = tmp_path / 'APEX-0.17.50-mac-arm64.zip'
    local.write_bytes(b'PKx')
    env = {**os.environ, 'PYTHONPATH': str(tmp_path),
           'COS_SECRET_ID': 'fixture-identity', 'COS_SECRET_KEY': 'credential-redline-test-value'}
    result = subprocess.run([sys.executable, str(SCRIPT), '--file', str(local), '--key',
                             'desktop/mac-arm64/' + local.name], env=env, capture_output=True, text=True, check=False)
    assert result.returncode == 1
    assert 'RuntimeError' in result.stderr
    assert 'credential-redline-test-value' not in result.stdout + result.stderr


@pytest.mark.parametrize('failed_route,served_size', [('network', 3), ('network', 2), ('service', 3)])
def test_cli_transport_failover_keeps_service_and_public_size_gates(tmp_path, monkeypatch, capsys,
                                                                 failed_route, served_size):
    local = tmp_path / 'APEX-0.17.52-mac-arm64.zip'
    local.write_bytes(b'PKx')
    monkeypatch.setattr(sys, 'argv', [str(SCRIPT), '--file', str(local), '--key',
                                    'desktop/mac-arm64/' + local.name])
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
        assert all(c.get('Endpoint') == 'cos.accelerate.myqcloud.com' for c in configurations)
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
    args = ['--file', '/owned/release.zip', '--key', 'desktop/mac-arm64/release.zip']
    assert publisher.run_bounded_upload(args) == expected
    assert len(seen) == calls
    assert all(command[-4:] == args and '--transfer-worker' in command and options['timeout'] == 600
               for command, options in seen)


def test_bounded_upload_hands_the_windows_release_flag_to_every_worker(monkeypatch):
    seen = []
    def run(args, **kwargs):
        seen.append(args)
        raise subprocess.TimeoutExpired(args, kwargs['timeout'])
    monkeypatch.setattr(publisher.subprocess, 'run', run)
    args = ['--file', '/owned/latest.yml', '--key', 'desktop/win-x64/latest.yml', publisher.WINDOWS_RELEASE]
    assert publisher.run_bounded_upload(args) == 75
    assert len(seen) == publisher.DEFAULT_WORKERS
    assert all(command[-5:] == args for command in seen)


def _sized(tmp_path, size):
    local = tmp_path / f'APEX-0.17.58-mac-arm64-{size}.dmg'
    with local.open('wb') as stream:
        stream.truncate(size)  # sparse: the budget reads only the size
    return local


@pytest.mark.parametrize('size,workers', [
    (1, 3),                # blockmap / feed: never fewer than the default three
    (200_000_000, 4),      # 1526 s at the 128 KiB/s floor + 600 s overhead
    (630_165_015, 9),      # the 0.17.58 arm64 DMG that outgrew 3 x 600 s on 2026-10-17
    (5_000_000_000, 9),    # capped at 90 minutes so a DMG + zip fit the 240-minute job
])
def test_size_budget_scales_workers_with_the_file(tmp_path, size, workers):
    assert publisher.size_budget_workers(_sized(tmp_path, size)) == workers


def test_size_budget_leaves_a_missing_file_to_the_worker(tmp_path):
    assert publisher.size_budget_workers(tmp_path / 'absent.dmg') == publisher.DEFAULT_WORKERS


@pytest.mark.parametrize('budget_from_size,calls', [(True, 9), (False, 3)])
def test_budget_flag_keeps_resuming_a_large_file_and_never_reaches_the_worker(
        tmp_path, monkeypatch, budget_from_size, calls):
    seen = []
    def run(args, **kwargs):
        seen.append((args, kwargs))
        raise subprocess.TimeoutExpired(args, kwargs['timeout'])
    monkeypatch.setattr(publisher.subprocess, 'run', run)
    local = _sized(tmp_path, 630_165_015)
    args = ['--file', str(local), '--key', 'desktop/mac-arm64/' + local.name]
    assert publisher.run_bounded_upload(args + ([publisher.BUDGET_FROM_SIZE] if budget_from_size else [])) == 75
    assert len(seen) == calls
    assert all(command[-4:] == args and publisher.BUDGET_FROM_SIZE not in command and options['timeout'] == 600
               for command, options in seen)
