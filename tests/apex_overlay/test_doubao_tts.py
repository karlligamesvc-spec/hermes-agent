import json
from email.message import Message
from pathlib import Path
from types import SimpleNamespace

import pytest

from apex_overlay import doubao_tts as adapter

AUDIO = b'ID3\x04\x00\x00test-audio'


@pytest.fixture
def tts_entry(monkeypatch):
    """apply() wraps the real text_to_speech entry; put it back after each test."""
    from tools import tts_tool  # registers text_to_speech
    from tools.registry import registry
    entry = registry.get_entry('text_to_speech')
    monkeypatch.setattr(entry, 'dynamic_schema_overrides', entry.dynamic_schema_overrides)
    return entry


def test_provider_uses_platform_and_writes_real_audio_atomically(monkeypatch, tmp_path):
    monkeypatch.setattr(adapter, 'connection', lambda: ('platform-key', 'https://api.apex-nodes.com/api/v1'))
    class Response:
        headers = Message()
        headers['Content-Type'] = 'audio/mpeg'
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def read(self, limit): return AUDIO
    class Opener:
        def open(self, request, timeout):
            assert request.full_url.endswith('/tools/v1/tts/synthesize')
            assert request.headers['Authorization'] == 'Bearer platform-key'
            assert json.loads(request.data) == {'text': '你好', 'speed': 1.0}
            return Response()
    monkeypatch.setattr(adapter.urllib.request, 'build_opener', lambda *args: Opener())
    output = adapter.DoubaoTTS().synthesize('你好', str(tmp_path / '旁白.wav'))
    assert Path(output).suffix == '.mp3'
    assert Path(output).read_bytes() == AUDIO
    assert [p for p in tmp_path.iterdir() if p.is_file()] == [Path(output)]


def test_network_failure_leaves_no_fake_audio_or_system_fallback(monkeypatch, tmp_path):
    monkeypatch.setattr(adapter, 'connection', lambda: ('key', 'https://api.apex-nodes.com/api/v1'))
    def fail(*args):
        raise OSError('offline')
    monkeypatch.setattr(adapter.urllib.request, 'build_opener', fail)
    with pytest.raises(ValueError, match='未切换其他声音'):
        adapter.DoubaoTTS().synthesize('你好', str(tmp_path / 'out.mp3'))
    assert not any(p.is_file() for p in tmp_path.iterdir())


def test_default_dispatch_and_missing_plugin_fail_closed(monkeypatch, tts_entry):
    from tools import tts_tool, tts_tool_delivery
    monkeypatch.setattr(tts_tool, '_load_tts_config', tts_tool._load_tts_config)
    monkeypatch.setattr(tts_tool, 'DEFAULT_PROVIDER', 'edge')
    monkeypatch.setattr(tts_tool, '_dispatch_to_plugin_provider', lambda *args: None)
    monkeypatch.setattr(tts_tool_delivery, 'PROVIDER_MAX_TEXT_LENGTH', dict(tts_tool_delivery.PROVIDER_MAX_TEXT_LENGTH))
    registered = []
    adapter.apply(SimpleNamespace(register_tts_provider=registered.append))
    assert registered[0].name == 'doubao'
    assert tts_tool._get_provider({}) == 'doubao'
    assert tts_tool._get_provider({'provider': 'openai'}) == 'openai'
    assert tts_tool_delivery._resolve_max_text_length('doubao', {}) == 2000
    with pytest.raises(ValueError, match='未切换其他声音'):
        tts_tool._dispatch_to_plugin_provider('你好', 'out.mp3', 'doubao', {})


def test_foreign_profile_never_borrows_default_key(monkeypatch, tmp_path):
    import hermes_constants
    from hermes_cli import config, env_loader
    current = tmp_path / 'other'
    current.mkdir()
    monkeypatch.setattr(hermes_constants, 'get_hermes_home', lambda: current)
    monkeypatch.setattr(hermes_constants, 'get_process_hermes_home', lambda: tmp_path / 'default')
    monkeypatch.setattr(env_loader, 'hydrate_profile_secret_sources', lambda home: {})
    monkeypatch.setattr(config, 'load_config', dict)
    monkeypatch.setenv('TOOLS_GATEWAY_KEY', 'default-owner-key')
    monkeypatch.setenv('HERMES_PLATFORM_API_BASE', 'http://private-host')
    assert adapter.connection() == ('', adapter.PUBLIC_BASE)
    (current / '.env').write_text('TOOLS_GATEWAY_KEY=other-owner-key\n', encoding='utf-8')
    assert adapter.connection() == ('other-owner-key', adapter.PUBLIC_BASE)


def test_real_plugin_discovery_cached_defaults_and_file_delivery(tmp_path):
    """Real plugin loader + tool + HTTP + filesystem, with only vendor audio stubbed."""
    import os
    import subprocess
    import sys
    script = r'''
import os,json,threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
home=Path(os.environ['HERMES_HOME']);home.mkdir(exist_ok=True)
(home/'config.yaml').write_text('plugins:\n  enabled:\n    - apex-overlay\n',encoding='utf-8')
audio=b'ID3\x04\x00\x00test-audio'
calls=[]
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_POST(self):
  assert self.path=='/tools/v1/tts/synthesize'
  assert self.headers['Authorization']=='Bearer only-this-profile'
  calls.append(json.loads(self.rfile.read(int(self.headers['Content-Length'])))['text'])
  self.send_response(200);self.send_header('Content-Type','audio/mpeg');self.end_headers();self.wfile.write(audio)
server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
os.environ['HERMES_PLATFORM_API_BASE']=f'http://127.0.0.1:{server.server_port}'
threading.Thread(target=server.serve_forever,daemon=True).start()
from tools import tts_tool
assert tts_tool._load_tts_config()['provider']=='edge'
from hermes_cli.plugins import discover_plugins
discover_plugins()
assert tts_tool._load_tts_config()['provider']=='doubao'
assert tts_tool.check_tts_requirements()
result=json.loads(tts_tool.text_to_speech_tool('你好。',output_path=str(home/'旁白.mp3')))
assert result['success'],result
assert result['provider']=='doubao'
assert Path(result['file_path']).read_bytes()==audio
assert calls==['你好。']
from tools.registry import registry
schema=registry.get_definitions({'text_to_speech'},quiet=True)[0]['function']
assert schema['description'].startswith('把文字合成语音，默认用 APEX 平台的豆包配音'),schema['description']
assert 'edge-tts' in schema['description'] and 'say' in schema['description']
assert '0.5–2.0' in schema['parameters']['properties']['speed']['description']
assert str(home) in schema['parameters']['properties']['output_path']['description']
(home/'config.yaml').write_text('plugins:\n  enabled:\n    - apex-overlay\ntts:\n  provider: openai\n',encoding='utf-8')
assert tts_tool._load_tts_config()['provider']=='openai'
upstream=tts_tool._tts_schema_overrides()
assert registry.get_entry('text_to_speech').dynamic_schema_overrides()=={**upstream}
server.shutdown()
'''
    env = {**os.environ, 'HERMES_HOME': str(tmp_path / 'profile'), 'TOOLS_GATEWAY_KEY': 'only-this-profile'}
    result = subprocess.run([sys.executable, '-c', script], env=env,
                            cwd=Path(__file__).resolve().parents[2], capture_output=True, text=True, timeout=35, check=False)
    assert result.returncode == 0, result.stdout + result.stderr


def test_registration_failure_still_blocks_edge_fallback(monkeypatch, tts_entry):
    from tools import tts_tool, tts_tool_delivery
    monkeypatch.setattr(tts_tool, '_load_tts_config', tts_tool._load_tts_config)
    monkeypatch.setattr(tts_tool, 'DEFAULT_PROVIDER', 'edge')
    monkeypatch.setattr(tts_tool, '_dispatch_to_plugin_provider', lambda *args: None)
    monkeypatch.setattr(tts_tool_delivery, 'PROVIDER_MAX_TEXT_LENGTH', dict(tts_tool_delivery.PROVIDER_MAX_TEXT_LENGTH))
    def reject(provider):
        raise RuntimeError('registry unavailable')
    with pytest.raises(RuntimeError, match='registry unavailable'):
        adapter.apply(SimpleNamespace(register_tts_provider=reject))
    assert tts_tool._get_provider({}) == 'doubao'
    with pytest.raises(ValueError, match='未切换其他声音'):
        tts_tool._dispatch_to_plugin_provider('你好', 'out.mp3', 'doubao', {})


def test_model_reads_chinese_narration_text_only_while_doubao_is_active(monkeypatch, tts_entry):
    # hc-1007: upstream's description names Edge; the model must read the Doubao narration rule.
    from tools import tts_tool, tts_tool_delivery
    monkeypatch.setattr(tts_tool, '_load_tts_config', tts_tool._load_tts_config)
    monkeypatch.setattr(tts_tool, 'DEFAULT_PROVIDER', 'edge')
    monkeypatch.setattr(tts_tool, '_dispatch_to_plugin_provider', tts_tool._dispatch_to_plugin_provider)
    monkeypatch.setattr(tts_tool_delivery, 'PROVIDER_MAX_TEXT_LENGTH', dict(tts_tool_delivery.PROVIDER_MAX_TEXT_LENGTH))
    upstream = tts_entry.dynamic_schema_overrides()
    assert 'edge' in tts_tool.TTS_SCHEMA['description']
    adapter.apply(SimpleNamespace(register_tts_provider=lambda provider: None))
    wrapped = tts_entry.dynamic_schema_overrides
    adapter.apply(SimpleNamespace(register_tts_provider=lambda provider: None))
    assert tts_entry.dynamic_schema_overrides is wrapped  # re-apply does not stack wrappers

    config = {}
    monkeypatch.setattr(tts_tool, '_load_tts_config', lambda: dict(config))
    shown = tts_entry.dynamic_schema_overrides()
    assert shown['description'] == adapter.NARRATION_DESCRIPTION
    for phrase in ('豆包配音', '视频配音、旁白、口播、朗读一律调用本工具', 'edge-tts', 'pyttsx3', 'macOS say', '不要换别的声音顶上'):
        assert phrase in shown['description']
    props = shown['parameters']['properties']
    assert set(props) == set(tts_tool.TTS_SCHEMA['parameters']['properties'])
    assert shown['parameters']['required'] == ['text']
    assert '0.5–2.0' in props['speed']['description']
    assert 'Edge' not in json.dumps(shown, ensure_ascii=False)
    assert 'edge/openai' in tts_tool.TTS_SCHEMA['description']  # the static schema is untouched

    config['provider'] = 'openai'  # explicit BYOK keeps upstream's text
    assert tts_entry.dynamic_schema_overrides() == upstream


@pytest.mark.parametrize('speed, sent', [(None, 1.0), (1.25, 1.25), (0.25, 0.5), (4.0, 2.0)])
def test_speed_stays_inside_what_scheduler_accepts(monkeypatch, tmp_path, speed, sent):
    monkeypatch.setattr(adapter, 'connection', lambda: ('key', 'https://api.apex-nodes.com/api/v1'))
    seen = []
    class Response:
        headers = Message()
        headers['Content-Type'] = 'audio/mpeg'
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def read(self, limit): return AUDIO
    class Opener:
        def open(self, request, timeout):
            seen.append(json.loads(request.data)['speed'])
            return Response()
    monkeypatch.setattr(adapter.urllib.request, 'build_opener', lambda *args: Opener())
    adapter.DoubaoTTS().synthesize('你好', str(tmp_path / 'out.mp3'), speed=speed)
    assert seen == [sent]
