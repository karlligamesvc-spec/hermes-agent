"""hc-1296: the model can name one of the platform's system voices for a text_to_speech call.

The narration text used to say 「声音由用户的设置决定，不由你选择」: upstream takes a plugin provider's
voice from ``tts.voice`` in the config and the registered handler drops every argument it does not
know. The overlay holds the call's ``voice`` while the handler runs and puts it into a copy of the
config that call loads, so every chunk is spoken in it; only the names in ``VOICES`` are sent, and
audio Scheduler says it spoke in another voice is not delivered. The hosted twin is apex-nodes'
``app/runtime_plugins/apexnodes-doubao-tts``.
"""

import inspect
import json
import os
import subprocess
import sys
from email.message import Message
from pathlib import Path
from types import SimpleNamespace

import pytest

from apex_overlay import doubao_tts as adapter

AUDIO = b'ID3\x04\x00\x00test-audio'


def test_the_voice_the_model_names_reaches_scheduler_for_every_chunk_and_only_for_its_call(tmp_path):
    """Real plugin loader, the real text_to_speech entry the model calls, real HTTP; only Scheduler is faked."""
    script = r'''
import os,json,threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
home=Path(os.environ['HERMES_HOME']);home.mkdir(exist_ok=True)
(home/'config.yaml').write_text('plugins:\n  enabled:\n    - apex-overlay\ntts:\n  doubao:\n    max_text_length: 12\n',encoding='utf-8')
bodies=[];used=[None]
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers['Content-Length'])));bodies.append(body)
  self.send_response(200);self.send_header('Content-Type','audio/mpeg')
  spoke=used[0] or body.get('voice') or 'longanhuan_v3.1'   # like Scheduler: the voice it spoke in
  self.send_header('X-TTS-Voice',spoke);self.end_headers();self.wfile.write(b'ID3\x04\x00\x00test-audio')
server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
os.environ['HERMES_PLATFORM_API_BASE']=f'http://127.0.0.1:{server.server_port}'
threading.Thread(target=server.serve_forever,daemon=True).start()
from tools.registry import registry
from tools import tts_tool
from hermes_cli.plugins import discover_plugins
from apex_overlay import doubao_tts as adapter
discover_plugins()
entry=registry.get_entry('text_to_speech')
def call(args): return json.loads(registry.dispatch('text_to_speech',args))
# what the model reads: a voice is offered, in the platform's words
schema=registry.get_definitions({'text_to_speech'},quiet=True)[0]['function']
assert schema['parameters']['properties']['voice']=={'type':'string','description':adapter.VOICE_DESCRIPTION},schema
assert adapter.VOICE_SENTENCE in schema['description'] and adapter.FIXED_VOICE_SENTENCE not in schema['description'],schema
# a long narration is split; every chunk is spoken in the voice the model named
result=call({'text':'今天做一道菜, 先切葱花, 再下锅翻炒, 最后装盘.','output_path':str(home/'a.mp3'),'voice':'男声'})
assert result['success'] and result['provider']=='doubao',result
assert len(bodies)>=2,bodies
assert [b.get('voice') for b in bodies]==['xunanchuan_v3.1']*len(bodies),bodies
# once the call is over, a config read outside it (a streamed reply, voice mode) is the user's own
assert 'voice' not in tts_tool._load_tts_config(),tts_tool._load_tts_config()
# the next call names none and carries none; the config the engine loads is the user's own again
del bodies[:]
assert call({'text':'好的.','output_path':str(home/'b.mp3')})['success']
assert call({'text':'好的.','output_path':str(home/'c.mp3'),'voice':'  '})['success']
assert bodies==[{'text':'好的.','speed':1.0}]*2,bodies
assert 'voice' not in tts_tool._load_tts_config(),tts_tool._load_tts_config()
# a name that is not offered: an error, nothing sent, no file
del bodies[:]
result=call({'text':'好的.','output_path':str(home/'d.mp3'),'voice':'御姐音'})
assert result['success'] is False and '默认女声' in result['error'] and '没有换成别的声音' in result['error'],result
assert bodies==[] and not (home/'d.mp3').exists()
# Scheduler spoke in another voice: not delivered as the chosen one
used[0]='longanhuan_v3.1'
result=call({'text':'好的.','output_path':str(home/'e.mp3'),'voice':'女声二'})
assert result['success'] is False and '女声二' in result['error'] and '没有交付' in result['error'],result
assert not (home/'e.mp3').exists()
server.shutdown()
'''
    env = {**os.environ, 'HERMES_HOME': str(tmp_path / 'profile'), 'TOOLS_GATEWAY_KEY': 'only-this-profile',
           'HERMES_DISABLE_LAZY_INSTALLS': '1', 'NO_PROXY': '127.0.0.1,localhost', 'no_proxy': '127.0.0.1,localhost'}
    script = "import sys\nsys.modules['edge_tts']=None\nsys.modules['neutts']=None\n" + script
    result = subprocess.run([sys.executable, '-c', script], env=env,
                            cwd=Path(__file__).resolve().parents[2], capture_output=True, text=True, timeout=60, check=False)
    assert result.returncode == 0, result.stdout + result.stderr


def test_the_bridge_sits_where_upstream_still_takes_the_voice_from_the_config_only():
    """The seam: the registered handler passes on a fixed list of arguments without ``voice``, and
    the plugin dispatch reads the voice from the config the call loaded. When upstream gives plugin
    providers a per-call voice itself, delete install_voice_bridge and this test."""
    from tools import tts_tool, tts_tool_plugins
    from tools.registry import registry
    handler = registry.get_entry('text_to_speech').handler
    while getattr(handler, '__wrapped__', None) is not None:  # under any bridge another test left
        handler = handler.__wrapped__
    assert "'voice'" not in inspect.getsource(handler) and '"voice"' not in inspect.getsource(handler)
    assert 'voice' not in inspect.signature(tts_tool.text_to_speech_tool).parameters
    assert tts_tool_plugins._plugin_voice_kwargs({'voice': 'longanhuan_v3.1'})['voice'] == 'longanhuan_v3.1'
    assert '_load_tts_config()' in inspect.getsource(tts_tool.text_to_speech_tool)


@pytest.fixture
def tts_tool(monkeypatch):
    """The real tools.tts_tool; every symbol apply() rewires is put back after the test."""
    from tools import tts_tool, tts_tool_delivery
    from tools.registry import registry
    entry = registry.get_entry('text_to_speech')
    monkeypatch.setattr(entry, 'dynamic_schema_overrides', entry.dynamic_schema_overrides)
    monkeypatch.setattr(entry, 'handler', entry.handler)
    for name in ('_load_tts_config', '_select_builtin_engine', '_dispatch_to_plugin_provider',
                 '_text_to_speech_single', 'DEFAULT_PROVIDER'):
        monkeypatch.setattr(tts_tool, name, getattr(tts_tool, name))
    monkeypatch.setattr(tts_tool_delivery, 'PROVIDER_MAX_TEXT_LENGTH', dict(tts_tool_delivery.PROVIDER_MAX_TEXT_LENGTH))
    return tts_tool


def test_apply_installs_the_bridge_once_and_the_handler_keeps_upstreams_face(tts_tool):
    from tools.registry import registry
    entry = registry.get_entry('text_to_speech')
    upstream = entry.handler
    assert not adapter._bridged(upstream, adapter._CALL_VOICE, '_apex_tts_voice')  # nothing left over from another test
    adapter.apply(SimpleNamespace(register_tts_provider=lambda provider: None))
    bridged, load = entry.handler, tts_tool._load_tts_config
    adapter.apply(SimpleNamespace(register_tts_provider=lambda provider: None))
    assert entry.handler is bridged and tts_tool._load_tts_config is load  # re-apply does not stack wrappers
    assert bridged is not upstream and bridged.__wrapped__ is upstream
    # the registry filters kwargs by the handler's signature and asks which module owns it
    assert inspect.signature(bridged) == inspect.signature(upstream)
    assert bridged.__module__ == upstream.__module__
    assert adapter.voice_reaches_platform() is True


def test_the_voice_goes_only_to_apexs_own_provider_and_leaves_the_loaded_config_alone(monkeypatch, tts_tool):
    loaded = {'provider': 'openai', 'voice': 'alloy'}
    monkeypatch.setattr(tts_tool, '_load_tts_config', lambda: loaded)
    assert adapter.install_voice_bridge(tts_tool) is True
    token = adapter._CALL_VOICE.set('xunanchuan_v3.1')
    try:
        assert tts_tool._load_tts_config() is loaded  # a BYOK provider keeps the user's voice
        loaded['provider'] = 'doubao'
        assert tts_tool._load_tts_config() == {'provider': 'doubao', 'voice': 'xunanchuan_v3.1'}
        assert loaded == {'provider': 'doubao', 'voice': 'alloy'}  # a copy went out
    finally:
        adapter._CALL_VOICE.reset(token)
    assert tts_tool._load_tts_config() is loaded


@pytest.mark.parametrize('header, delivered', [('xunanchuan_v3.1', True), (None, True), ('longanhuan_v3.1', False)])
def test_audio_spoken_in_another_voice_is_not_delivered(monkeypatch, tmp_path, header, delivered):
    monkeypatch.setattr(adapter, 'connection', lambda: ('key', 'https://api.apex-nodes.com/api/v1'))

    class Response:
        headers = Message()
        headers['Content-Type'] = 'audio/mpeg'
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def read(self, limit): return AUDIO

    if header:
        Response.headers['X-TTS-Voice'] = header
    monkeypatch.setattr(adapter.urllib.request, 'build_opener', lambda *args: SimpleNamespace(open=lambda request, timeout: Response()))
    target = tmp_path / 'out.mp3'
    if delivered:
        assert adapter.DoubaoTTS().synthesize('你好', str(target), voice='xunanchuan_v3.1') == str(target)
    else:
        with pytest.raises(ValueError, match='男声.*没有交付'):
            adapter.DoubaoTTS().synthesize('你好', str(target), voice='xunanchuan_v3.1')
    assert target.exists() is delivered
    # no voice chosen: whatever the platform's default is, it is delivered
    assert adapter.DoubaoTTS().synthesize('你好', str(tmp_path / 'plain.mp3')) == str(tmp_path / 'plain.mp3')


def test_the_table_is_the_platforms_four_system_voices_and_the_first_is_the_default():
    assert [platform_id for _, platform_id in adapter.VOICES] == [
        'longanhuan_v3.1', 'longanlingxin_v3.1', 'longanfengyue_v3.1', 'xunanchuan_v3.1']
    names = [name for name, _ in adapter.VOICES]
    assert len(set(names)) == 4 and all(name in adapter.VOICE_DESCRIPTION for name in names)
    assert [adapter.voice_id(name) for name in names] == [platform_id for _, platform_id in adapter.VOICES]
    assert adapter.voice_id(None) is None and adapter.voice_id('  ') is None
    assert adapter.voice_name('xunanchuan_v3.1') == '男声' and adapter.VOICE_HEADER == 'X-TTS-Voice'
    with pytest.raises(ValueError, match='没有「zh_female_vv_uranus_」这个声音'):  # an older Doubao id; shown cut to 20
        adapter.voice_id('zh_female_vv_uranus_bigtts')


def test_without_the_bridge_the_model_reads_that_the_voice_is_fixed(monkeypatch, tts_tool):
    """A runtime with no handler to wrap gets no `voice` parameter and the old sentence."""
    from tools.registry import registry
    entry = registry.get_entry('text_to_speech')
    monkeypatch.setattr(tts_tool, '_load_tts_config', lambda: {'provider': 'doubao'})
    assert adapter.install_narration_schema(tts_tool) is True
    assert not adapter.voice_reaches_platform()
    shown = entry.dynamic_schema_overrides()
    assert 'voice' not in shown['parameters']['properties'] and shown['description'] == adapter.NARRATION_DESCRIPTION
    assert adapter.install_voice_bridge(tts_tool) is True
    shown = entry.dynamic_schema_overrides()
    assert shown['parameters']['properties']['voice']['description'] == adapter.VOICE_DESCRIPTION
    assert adapter.VOICE_SENTENCE in shown['description']
