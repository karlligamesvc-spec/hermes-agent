"""Qwen uses the actual active profile and the established local WS gates."""
import asyncio
import json
from unittest.mock import AsyncMock

import pytest
import yaml
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from apex_overlay import voice_realtime as voice


@pytest.fixture
def homes(monkeypatch, tmp_path, _isolate_hermes_home):
    from hermes_constants import get_hermes_home
    from hermes_cli import profiles
    root = get_hermes_home(); worker = root / 'profiles' / 'worker'
    worker.mkdir(parents=True)
    for home in (root, worker):
        (home / 'config.yaml').write_text('{}\n')
        (home / '.env').write_text('')
    monkeypatch.setattr(profiles, '_get_default_hermes_home', lambda: root)
    monkeypatch.setattr(profiles, '_get_profiles_root', lambda: root / 'profiles')
    monkeypatch.setenv('TOOLS_GATEWAY_KEY', 'default-process-identity')
    return root, worker


def test_foreign_profile_never_borrows_process_key(homes):
    from hermes_cli.web_server_profiles import _config_profile_scope
    root, worker = homes
    (worker / '.env').write_text('TOOLS_GATEWAY_KEY=worker-key\n')
    with _config_profile_scope('worker'):
        key, base, settings = voice.resolve_connection()
        assert key == 'worker-key'
        assert base == voice.RELAY_BASE and settings['model'] == voice.DEFAULT_MODEL
    (worker / '.env').write_text('')
    with _config_profile_scope('worker'):
        assert voice.resolve_connection()[0] == ''
        assert voice.status()['available'] is False
    assert voice.resolve_connection()[0] == 'default-process-identity'


def test_actual_provider_configuration_and_model_are_profile_local(homes):
    from hermes_cli.web_server_profiles import _config_profile_scope
    root, worker = homes
    (worker / 'config.yaml').write_text(yaml.safe_dump({'custom_providers': [
        {'name': 'apex-nodes.com', 'api_key': 'configured-worker-key', 'base_url': 'https://apex-nodes.com/relay/v1/'}],
        'voice': {'voice_chat_mode': 'qwen-realtime', 'qwen_realtime': {'model': 'qwen-audio-3.0-realtime-plus'}}}))
    with _config_profile_scope('worker'):
        key, base, settings = voice.resolve_connection()
        assert key == 'configured-worker-key' and base == voice.RELAY_BASE
        assert settings['model'] == 'qwen-audio-3.0-realtime-plus'
        from tools.voice_live import voice_chat_mode
        assert voice_chat_mode() == 'qwen-realtime'
    assert voice.resolve_connection()[2]['model'] == voice.DEFAULT_MODEL


@pytest.fixture
def client(homes, monkeypatch):
    from hermes_cli.web_server import app
    monkeypatch.setattr(app.state, 'bound_host', '127.0.0.1', raising=False)
    return TestClient(app, base_url='http://127.0.0.1')


def test_runtime_ws_rejects_unauthenticated_and_wrong_origin_before_connection(client, monkeypatch):
    from hermes_cli.web_server import _SESSION_TOKEN
    called = AsyncMock(side_effect=AssertionError('unauthenticated upstream'))
    monkeypatch.setattr(voice, 'serve', called)
    for url, headers in [('/api/audio/qwen-realtime', {}),
                         ('/api/audio/qwen-realtime?token=' + _SESSION_TOKEN, {'Origin': 'https://evil.example'})]:
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect('ws://127.0.0.1' + url, headers=headers): pass
        assert exc.value.code in (4401, 4403)
    called.assert_not_called()


def test_runtime_ws_captures_profile_connection_before_awaiting(client, homes, monkeypatch):
    from hermes_cli.web_server import _SESSION_TOKEN
    (homes[1] / '.env').write_text('TOOLS_GATEWAY_KEY=worker-key\n')
    async def serve(ws, connection):
        assert connection[0] == 'worker-key'
        await ws.send_json({'type': 'session.updated'})
    monkeypatch.setattr(voice, 'serve', serve)
    with client.websocket_connect('ws://127.0.0.1/api/audio/qwen-realtime?profile=worker&token=' + _SESSION_TOKEN) as ws:
        assert ws.receive_json() == {'type': 'session.updated'}


def test_runtime_protocol_pins_vendor_config_and_passes_tool_results(monkeypatch):
    captured = []
    class Vendor:
        def __init__(self): self.queue = asyncio.Queue()
        async def __aenter__(self): return self
        async def __aexit__(self, *args): return False
        async def recv(self): return json.dumps({'type': 'session.created'})
        async def send(self, text): captured.append(json.loads(text))
        def __aiter__(self): return self
        async def __anext__(self): return await self.queue.get()
    vendor = Vendor()
    def connect(url, **kwargs):
        assert url == 'wss://apex-nodes.com/relay/v1/audio/realtime?model=' + voice.DEFAULT_MODEL
        assert kwargs['additional_headers'] == {'Authorization': 'Bearer profile-key'}
        return vendor
    monkeypatch.setattr(voice, 'connect', connect)
    class Browser:
        async def receive_json(self): return {'type': 'apex.start', 'history': [
            {'role': 'user', 'content': [{'text': '刚才的任务'}]}]}
        async def send_json(self, event): assert event['type'] == 'session.created'
        async def send_text(self, text): pass
        async def receive_text(self):
            if not getattr(self, 'sent', False):
                self.sent = True
                return json.dumps({'type': 'conversation.item.create', 'item': {
                    'type': 'function_call_output', 'call_id': 'call-a', 'output': '真实结果'}})
            raise WebSocketDisconnect()
    asyncio.run(voice.serve(Browser(), ('profile-key', voice.RELAY_BASE, {'model': voice.DEFAULT_MODEL, 'voice': voice.DEFAULT_VOICE})))
    assert captured[0] == voice.session_config({'voice': voice.DEFAULT_VOICE})
    assert captured[0]['session']['tools'][0]['function']['name'] == 'apex_assistant'
    assert captured[1]['item']['content'] == [{'type': 'input_text', 'text': '刚才的任务'}]
    assert captured[2]['item']['output'] == '真实结果'
    assert 'profile-key' not in json.dumps(captured)


def test_renderer_cannot_replace_session_authority(monkeypatch):
    class Vendor:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): return False
        async def recv(self): return '{"type":"session.created"}'
        async def send(self, text): pass
        def __aiter__(self): return self
        async def __anext__(self): await asyncio.Future()
    monkeypatch.setattr(voice, 'connect', lambda *a, **k: Vendor())
    class Browser:
        async def receive_json(self): return {'type': 'apex.start'}
        async def send_json(self, event): pass
        async def receive_text(self): return '{"type":"session.update","session":{"tools":[]}}'
    with pytest.raises(ValueError, match='不支持'):
        asyncio.run(voice.serve(Browser(), ('key', voice.RELAY_BASE, {'model': voice.DEFAULT_MODEL, 'voice': voice.DEFAULT_VOICE})))


def test_voice_settings_model_change_reaches_actual_profile_config(client, homes):
    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN
    client.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    response = client.put('/api/config?profile=worker', json={'config': {'voice': {
        'voice_chat_mode': 'qwen-realtime', 'qwen_realtime': {'model': 'qwen-audio-3.0-realtime-plus'}}}})
    assert response.status_code == 200, response.text
    from hermes_cli.web_server_profiles import _config_profile_scope
    with _config_profile_scope('worker'):
        assert voice.resolve_connection()[2]['model'] == 'qwen-audio-3.0-realtime-plus'
    assert voice.resolve_connection()[2]['model'] == voice.DEFAULT_MODEL


def test_status_passes_selected_model_and_only_apex_auth(monkeypatch):
    import io
    monkeypatch.setattr(voice, 'resolve_connection', lambda: ('apex-identity', voice.RELAY_BASE,
        {'model': 'qwen-audio-3.0-realtime-plus', 'voice': voice.DEFAULT_VOICE}))
    def urlopen(request, **kwargs):
        assert request.full_url.endswith('/audio/realtime/status?model=qwen-audio-3.0-realtime-plus')
        assert request.get_header('Authorization') == 'Bearer apex-identity'
        return io.BytesIO(b'{"available":true,"reason":null}')
    monkeypatch.setattr(voice.urllib.request, 'urlopen', urlopen)
    assert voice.status()['available'] is True
    assert voice.status()['model'] == 'qwen-audio-3.0-realtime-plus'
