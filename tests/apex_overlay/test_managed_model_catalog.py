import urllib.error

import pytest

from apex_overlay import managed_model_catalog as seam
from hermes_cli import models


@pytest.fixture
def patched(monkeypatch):
    original = models.probe_api_models
    # Register restoration before apply replaces the attribute.
    monkeypatch.setattr(models, 'probe_api_models', original)
    assert seam.apply()
    assert seam.apply()


def test_cold_relay_catalog_outlives_picker_budget_then_uses_credential_cache(patched, monkeypatch):
    calls = []
    def get_json(url, timeout, headers, **kwargs):
        calls.append((url, timeout, headers['Authorization']))
        if timeout < 2:
            raise TimeoutError('slow initial TLS handshake')
        return {'data': [{'id': 'model-a'}, {'id': 'model-b'}]}
    monkeypatch.setattr(models, '_get_json', get_json)
    from hermes_cli.model_switch_providers import _fetch_picker_live_models
    base = 'https://apex-nodes.com/relay/v1'
    def fetch(key):
        return _fetch_picker_live_models(key, base, 'custom', True, timeout=1.5)
    assert fetch('account-a') == ['model-a', 'model-b']
    assert fetch('account-a') == ['model-a', 'model-b']
    assert len(calls) == 1
    assert fetch('account-b') == ['model-a', 'model-b']
    assert [c[2] for c in calls] == ['Bearer account-a', 'Bearer account-b']


@pytest.mark.parametrize('base', [
    'https://other.example/v1', 'http://apex-nodes.com/relay/v1',
    'https://apex-nodes.com.attacker.example/relay/v1',
    'https://apex-nodes.com/other', 'https://apex-nodes.com:444/relay/v1',
])
def test_other_endpoint_budget_unchanged(base, patched, monkeypatch):
    budgets = []
    def get_json(url, timeout, headers, **kwargs):
        budgets.append(timeout)
        return {'data': [{'id': 'private-model'}]}
    monkeypatch.setattr(models, '_get_json', get_json)
    assert models.fetch_api_models('key', base, timeout=1.5) == ['private-model']
    assert budgets == [1.5]


def test_relay_auth_failure_does_not_invent_models(patched, monkeypatch):
    def unauthorized(url, **kwargs):
        raise urllib.error.HTTPError(url, 401, 'unauthorized', {}, None)
    monkeypatch.setattr(models, '_get_json', unauthorized)
    assert models.fetch_api_models('revoked', 'https://apex-nodes.com/relay/v1', timeout=1.5) is None


def test_plugin_registers_catalog_seam():
    from tests.apex_overlay.conftest import run_plugin_register_with_stubbed_seams
    assert 'managed_model_catalog' in run_plugin_register_with_stubbed_seams('managed_catalog_boot')
