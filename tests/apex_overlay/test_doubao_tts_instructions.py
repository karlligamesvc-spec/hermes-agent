"""hc-1283: the tone line the model gives text_to_speech reaches Scheduler on APEX's own voice.

Upstream hands a plugin TTS provider voice, model, speed and format only, so ``instructions``
(语气、情绪、快慢、方言) stopped at the runtime and the narration text had to say the parameter was
unused. The overlay holds each call's ``instructions`` while ``_text_to_speech_single`` runs and
``DoubaoTTS`` sends them; the model is offered the parameter only while that is true.
"""

import inspect
import json
import os
import subprocess
import sys
import threading
from email.message import Message
from pathlib import Path
from types import SimpleNamespace

import pytest

from apex_overlay import doubao_tts as adapter

AUDIO = b'ID3\x04\x00\x00test-audio'


@pytest.fixture
def sent(monkeypatch):
    """Request bodies DoubaoTTS sends to Scheduler (no network)."""
    bodies = []
    monkeypatch.setattr(adapter, 'connection', lambda: ('key', 'https://api.apex-nodes.com/api/v1'))

    class Response:
        headers = Message()
        headers['Content-Type'] = 'audio/mpeg'
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def read(self, limit): return AUDIO

    class Opener:
        def open(self, request, timeout):
            bodies.append(json.loads(request.data))
            return Response()

    monkeypatch.setattr(adapter.urllib.request, 'build_opener', lambda *args: Opener())
    return bodies


@pytest.fixture
def tts_tool(monkeypatch):
    """The real tools.tts_tool; every symbol apply() rewires is put back after the test."""
    from tools import tts_tool, tts_tool_delivery
    from tools.registry import registry
    entry = registry.get_entry('text_to_speech')
    monkeypatch.setattr(entry, 'dynamic_schema_overrides', entry.dynamic_schema_overrides)
    for name in ('_load_tts_config', '_select_builtin_engine', '_dispatch_to_plugin_provider',
                 '_text_to_speech_single', 'DEFAULT_PROVIDER'):
        monkeypatch.setattr(tts_tool, name, getattr(tts_tool, name))
    monkeypatch.setattr(tts_tool_delivery, 'PROVIDER_MAX_TEXT_LENGTH', dict(tts_tool_delivery.PROVIDER_MAX_TEXT_LENGTH))
    return tts_tool


def test_the_model_s_tone_line_reaches_scheduler_for_every_chunk_and_only_for_its_call(tmp_path):
    """Real plugin loader, the real text_to_speech entry the model calls, real HTTP; only Scheduler is faked."""
    script = r'''
import os,json,threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
home=Path(os.environ['HERMES_HOME']);home.mkdir(exist_ok=True)
(home/'config.yaml').write_text('plugins:\n  enabled:\n    - apex-overlay\ntts:\n  doubao:\n    max_text_length: 12\n',encoding='utf-8')
bodies=[]
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_POST(self):
  bodies.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
  self.send_response(200);self.send_header('Content-Type','audio/mpeg');self.end_headers();self.wfile.write(b'ID3\x04\x00\x00test-audio')
server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
os.environ['HERMES_PLATFORM_API_BASE']=f'http://127.0.0.1:{server.server_port}'
threading.Thread(target=server.serve_forever,daemon=True).start()
from tools.registry import registry
from hermes_cli.plugins import discover_plugins
from apex_overlay import doubao_tts as adapter
discover_plugins()
entry=registry.get_entry('text_to_speech')
def speak(args):
 result=json.loads(entry.handler(args))
 assert result['success'] and result['provider']=='doubao',result
# what the model reads: the tone line is offered, in the platform's words
schema=registry.get_definitions({'text_to_speech'},quiet=True)[0]['function']
assert schema['parameters']['properties']['instructions']['description']==adapter.TONE_DESCRIPTION,schema
# a long narration is split; every chunk is read the way the model asked
speak({'text':'今天做一道菜, 先切葱花, 再下锅翻炒, 最后装盘.','output_path':str(home/'a.mp3'),'instructions':' 用粤语读，热情一点 '})
assert len(bodies)>=2,bodies
assert [b.get('instructions') for b in bodies]==['用粤语读，热情一点']*len(bodies),bodies
# the next call without a tone line carries none, and a blank one is not sent
del bodies[:]
speak({'text':'好的.','output_path':str(home/'b.mp3')})
speak({'text':'好的.','output_path':str(home/'c.mp3'),'instructions':'   '})
assert bodies==[{'text':'好的.','speed':1.0}]*2,bodies
server.shutdown()
'''
    env = {**os.environ, 'HERMES_HOME': str(tmp_path / 'profile'), 'TOOLS_GATEWAY_KEY': 'only-this-profile',
           'HERMES_DISABLE_LAZY_INSTALLS': '1', 'NO_PROXY': '127.0.0.1,localhost', 'no_proxy': '127.0.0.1,localhost'}
    script = "import sys\nsys.modules['edge_tts']=None\nsys.modules['neutts']=None\n" + script
    result = subprocess.run([sys.executable, '-c', script], env=env,
                            cwd=Path(__file__).resolve().parents[2], capture_output=True, text=True, timeout=60, check=False)
    assert result.returncode == 0, result.stdout + result.stderr


def test_the_bridge_sits_where_upstream_still_drops_the_tone_line():
    """The seam: the chunk loop hands _text_to_speech_single a keyword-only ``instructions`` and
    upstream's plugin dispatch still passes no tone line. When upstream passes ``instructions`` to
    plugin providers itself, delete install_instructions_bridge and this test."""
    from tools import tts_tool, tts_tool_plugins
    parameter = inspect.signature(tts_tool._text_to_speech_single).parameters['instructions']
    assert parameter.kind is inspect.Parameter.KEYWORD_ONLY
    assert 'instructions' not in inspect.signature(tts_tool_plugins._dispatch_to_plugin_provider).parameters
    assert set(tts_tool_plugins._plugin_voice_kwargs({'voice': 'v', 'model': 'm', 'speed': 1.0})) == {'voice', 'model', 'speed'}


def test_apply_installs_the_bridge_once_and_the_provider_says_it_carries_the_line(tts_tool):
    original = tts_tool._text_to_speech_single
    assert not adapter._bridged(original, adapter._CALL_INSTRUCTIONS)  # nothing left over from another test
    registered = []
    adapter.apply(SimpleNamespace(register_tts_provider=registered.append))
    bridged = tts_tool._text_to_speech_single
    adapter.apply(SimpleNamespace(register_tts_provider=registered.append))
    assert tts_tool._text_to_speech_single is bridged  # re-apply does not stack wrappers
    assert bridged is not original and bridged.__wrapped__ is original
    assert [provider.carries_instructions for provider in registered] == [True, True]


def test_without_a_keyword_only_instructions_the_line_is_neither_offered_nor_sent(monkeypatch, tts_tool, sent, tmp_path):
    """A runtime whose _text_to_speech_single might get ``instructions`` positionally gets no bridge:
    the provider still speaks, sends no tone line, and the model reads that the parameter is unused."""
    from agent import tts_registry
    from tools.registry import registry
    registered = []

    def text_to_speech_single(text, file_str, instructions=None):
        return registered[0].synthesize(text, file_str)  # upstream's dispatch: no tone line

    monkeypatch.setattr(tts_tool, '_text_to_speech_single', text_to_speech_single)
    adapter.apply(SimpleNamespace(register_tts_provider=registered.append))
    assert tts_tool._text_to_speech_single is text_to_speech_single
    assert registered[0].carries_instructions is False
    monkeypatch.setitem(tts_registry._providers, 'doubao', registered[0])
    monkeypatch.setattr(tts_tool, '_load_tts_config', dict)  # nothing chosen: APEX's voice
    shown = registry.get_entry('text_to_speech').dynamic_schema_overrides()
    assert shown['parameters']['properties']['instructions']['description'] == adapter.UNUSED_TONE_DESCRIPTION
    tts_tool._text_to_speech_single('你好', str(tmp_path / 'out.mp3'), instructions='热情一点')
    assert sent == [{'text': '你好', 'speed': 1.0}]


@pytest.mark.parametrize('passed, held, expected', [
    (None, '热情一点', '热情一点'),    # the model's line, held for this call
    (' 慢一点 ', None, '慢一点'),       # a runtime that passes it itself
    ('慢一点', '热情一点', '慢一点'),   # the runtime's own value wins
    (None, '   ', None),                # blank: nothing sent
    (None, None, None),
    (7, None, None),                    # not text: nothing sent
], ids=['held', 'passed-stripped', 'passed-wins', 'blank', 'none', 'not-text'])
def test_what_goes_to_scheduler_as_the_tone_line(sent, tmp_path, passed, held, expected):
    token = adapter._CALL_INSTRUCTIONS.set(held)
    try:
        extra = {} if passed is None else {'instructions': passed}
        adapter.DoubaoTTS().synthesize('你好', str(tmp_path / 'out.mp3'), **extra)
    finally:
        adapter._CALL_INSTRUCTIONS.reset(token)
    assert sent[0].get('instructions') == expected
    assert ('instructions' in sent[0]) is (expected is not None)


def test_each_call_keeps_its_own_line_and_nothing_outlives_it(sent, tmp_path):
    """Two text_to_speech calls of one turn can run on two threads at once; each is read its own way.
    A voice spoken after a call, outside the tool, inherits nothing from it."""
    together = threading.Barrier(2, timeout=5)

    def concurrent(text, file_str, *, instructions=None):
        together.wait()  # both calls hold their line before either is spoken
        return adapter.DoubaoTTS().synthesize(text, file_str)

    tool = SimpleNamespace(_text_to_speech_single=concurrent)
    assert adapter.install_instructions_bridge(tool)
    calls = [threading.Thread(target=tool._text_to_speech_single, args=(text, str(tmp_path / f'{text}.mp3')),
                              kwargs={'instructions': line})
             for text, line in [('一', '热情一点'), ('二', '用粤语读')]]
    for call in calls:
        call.start()
    for call in calls:
        call.join(10)
    assert sorted((body['text'], body['instructions']) for body in sent) == [('一', '热情一点'), ('二', '用粤语读')]

    def sequential(text, file_str, *, instructions=None):
        return adapter.DoubaoTTS().synthesize(text, file_str)

    later = SimpleNamespace(_text_to_speech_single=sequential)
    assert adapter.install_instructions_bridge(later)
    del sent[:]
    later._text_to_speech_single('三', str(tmp_path / '3.mp3'), instructions='轻声')
    adapter.DoubaoTTS().synthesize('四', str(tmp_path / '4.mp3'))
    assert sent == [{'text': '三', 'speed': 1.0, 'instructions': '轻声'}, {'text': '四', 'speed': 1.0}]
