"""hc-1297: the user's own voice on Desktop (the hosted twin is apex-nodes' ``apexnodes-doubao-tts``).

A user reads a passage the platform names, the platform makes a voice only that account can use, and
narration is then spoken in it as ``voice: 我的声音``. Scheduler decides who may record, use and delete
(apex-nodes ``app/services/voice_clone.py``); this side

1. sends ``我的声音`` as ``my-voice``, never an id, and does not deliver audio spoken in another voice;
2. offers the tool ``own_voice`` (status, record, delete) with the account's own key, sends nothing for
   a request that cannot work, reads only a file that names itself a recording, and never follows a
   redirect with the key or the recording;
3. shows the tool and the name only to an account the platform opened it for, or one that still has a
   voice to delete; a change is followed without a restart once the kept answers run out.
"""

from __future__ import annotations

import hashlib
import json
import os
import socket
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

import pytest

from apex_overlay import doubao_tts as adapter

AUDIO = b'ID3\x04\x00\x00test-audio'
PASSAGE = '我确认这是我本人的声音。'
OPEN = {'enabled': True, 'voice': None, 'passage': PASSAGE, 'min_seconds': 8.0, 'max_seconds': 30.0}
HAS_VOICE = {**OPEN, 'voice': {'name': '我的声音', 'voice': 'my-voice', 'seconds': 15.0}}
CLOSED = {**OPEN, 'enabled': False}
CLOSED_WITH_VOICE = {**HAS_VOICE, 'enabled': False}
# sha256 of OWN_VOICE_SCHEMA as JSON (sorted keys): what the model reads about the tool, the same on both sides.
TWIN_SCHEMA_SHA256 = 'a7a3fa37555cd5b8acf47a7746296ac236feb02aa2abc6f2062680fd2755ebef'


class Scheduler:
    """Scheduler's speech routes on a real local port: every request is kept, the answers are set by the test."""

    def __init__(self):
        self.calls: list[dict] = []
        self.state: dict = dict(OPEN)
        self.refusal: tuple[int, dict] | None = None
        self.redirect_to: str | None = None
        self.spoken_in: str | None = None
        scheduler = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _answer(self, status: int, payload: dict):
                body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _handle(self, method: str):
                length = int(self.headers.get('Content-Length') or 0)
                raw = self.rfile.read(length) if length else b''
                scheduler.calls.append({'method': method, 'path': self.path, 'auth': self.headers.get('Authorization'),
                                        'type': self.headers.get('Content-Type') or '', 'raw': raw})
                if scheduler.redirect_to:
                    self.send_response(302)
                    self.send_header('Location', scheduler.redirect_to)
                    self.end_headers()
                    return
                if scheduler.refusal:
                    status, detail = scheduler.refusal
                    return self._answer(status, {'detail': detail})
                if self.path.endswith('/tools/v1/tts/synthesize'):
                    self.send_response(200)
                    self.send_header('Content-Type', 'audio/mpeg')
                    if scheduler.spoken_in:
                        self.send_header('X-TTS-Voice', scheduler.spoken_in)
                    self.end_headers()
                    self.wfile.write(AUDIO)
                    return
                if method == 'GET':
                    return self._answer(200, {'ok': True, 'data': scheduler.state})
                if method == 'POST':
                    return self._answer(200, {'ok': True, 'data': {'voice': HAS_VOICE['voice']}})
                return self._answer(200, {'ok': True, 'data': {'deleted': True}})

            def do_GET(self):
                self._handle('GET')

            def do_POST(self):
                self._handle('POST')

            def do_DELETE(self):
                self._handle('DELETE')

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.base = f'http://127.0.0.1:{self.server.server_port}/api/v1'
        threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': 0.05}, daemon=True).start()

    def own_voice_calls(self) -> list[dict]:
        return [call for call in self.calls if call['path'].endswith('/tools/v1/tts/own-voice')]


@pytest.fixture
def scheduler(monkeypatch):
    fake = Scheduler()
    account = {'key': 'desktop-key'}
    fake.account = account
    monkeypatch.setattr(adapter, 'connection', lambda: (account['key'], fake.base))
    for name in ('HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv('NO_PROXY', '127.0.0.1')
    monkeypatch.setattr(adapter, '_listed', {})  # each test asks afresh
    yield fake
    fake.server.shutdown()


def _own_voice(**args) -> dict:
    return json.loads(adapter.own_voice(args))


# ── 1. Speaking in it ────────────────────────────────────────────────────────


@pytest.mark.parametrize('named', ['我的声音', 'my-voice'])
def test_my_voice_is_a_name_the_tool_takes_and_goes_out_as_my_voice(scheduler, tmp_path, named):
    assert adapter.voice_id(named) == 'my-voice' and adapter.voice_name('my-voice') == '我的声音'
    scheduler.spoken_in = 'my-voice'

    target = adapter.DoubaoTTS().synthesize('你好', str(tmp_path / 'a.mp3'), voice=adapter.voice_id(named))

    assert Path(target).read_bytes() == AUDIO
    [call] = scheduler.calls
    assert json.loads(call['raw']) == {'text': '你好', 'speed': 1.0, 'voice': 'my-voice'}
    assert call['auth'] == 'Bearer desktop-key'


def test_audio_that_came_back_in_another_voice_is_not_passed_off_as_the_users(scheduler, tmp_path):
    scheduler.spoken_in = 'longanhuan_v3.1'  # an older Scheduler that swaps what it does not know

    with pytest.raises(ValueError, match='我的声音.*没有交付'):
        adapter.DoubaoTTS().synthesize('你好', str(tmp_path / 'a.mp3'), voice='my-voice')

    assert not list(tmp_path.glob('*.mp3'))


def test_why_scheduler_refused_the_users_voice_reaches_the_model(scheduler, tmp_path):
    scheduler.refusal = (409, {'code': 'voice_clone_missing', 'message': '这个账号还没有录过自己的声音。'})

    with pytest.raises(ValueError) as refused:
        adapter.DoubaoTTS().synthesize('你好', str(tmp_path / 'a.mp3'), voice='my-voice')
    assert str(refused.value) == '配音失败：这个账号还没有录过自己的声音。（未切换其他声音）'

    # a system voice keeps the sentence Desktop always gave for a refusal
    with pytest.raises(ValueError) as refused:
        adapter.DoubaoTTS().synthesize('你好', str(tmp_path / 'b.mp3'), voice='xunanchuan_v3.1')
    assert str(refused.value) == '配音请求失败（HTTP 409），请重试或联系平台管理员；未切换其他声音。'
    assert not list(tmp_path.glob('*.mp3'))


# ── 2. The own_voice tool ────────────────────────────────────────────────────


def test_status_says_what_to_read_and_whether_a_voice_exists(scheduler):
    assert _own_voice(action='status') == {
        'success': True, 'enabled': True, 'has_voice': False, 'voice': None,
        'passage': PASSAGE, 'min_seconds': 8.0, 'max_seconds': 30.0,
    }
    scheduler.state = dict(HAS_VOICE)
    assert _own_voice(action='status')['has_voice'] is True
    assert [(call['method'], call['auth']) for call in scheduler.own_voice_calls()] == [('GET', 'Bearer desktop-key')] * 2


def test_record_hands_the_recording_in_as_a_file(scheduler, tmp_path):
    recording = tmp_path / '我的录音.M4A'
    recording.write_bytes(b'\x00\x01recording bytes\r\n--not-a-boundary\xff')

    result = _own_voice(action='record', audio_path=str(recording))

    assert result['success'] is True and result['voice']['name'] == '我的声音'
    assert 'voice 填「我的声音」' in result['message']
    [call] = scheduler.own_voice_calls()
    assert (call['method'], call['auth']) == ('POST', 'Bearer desktop-key')
    boundary = call['type'].split('boundary=')[1]
    head, _, rest = call['raw'].partition(b'\r\n\r\n')
    assert head.startswith(f'--{boundary}\r\n'.encode()) and b'name="file"; filename="recording.m4a"' in head
    assert rest == recording.read_bytes() + f'\r\n--{boundary}--\r\n'.encode()  # the bytes as they are, name not leaked


def _a_file_that_is_not_a_recording(name: str):
    def prepare(tmp_path, monkeypatch) -> dict:
        # Desktop reads the user's own disk: a file that does not name itself a recording stays unread.
        private = tmp_path / name
        private.write_bytes(b'private')
        monkeypatch.setattr(Path, 'read_bytes', lambda self: pytest.fail(f'read {self}'))
        return {'action': 'record', 'audio_path': str(private)}

    return prepare


def _a_recording_over_the_limit(tmp_path, monkeypatch) -> dict:
    big = tmp_path / 'big.wav'
    big.write_bytes(b'x' * 2048)
    monkeypatch.setattr(adapter, 'MAX_RECORDING_BYTES', 1024)
    return {'action': 'record', 'audio_path': str(big)}


@pytest.mark.parametrize(
    ('prepare', 'says'),
    [
        pytest.param(lambda tmp_path, _: {'action': 'record', 'audio_path': str(tmp_path / 'nope.m4a')},
                     '找不到这个录音文件', id='missing-file'),
        pytest.param(lambda tmp_path, _: {'action': 'record'}, '找不到这个录音文件', id='no-path'),
        pytest.param(lambda tmp_path, _: {'action': 'record', 'audio_path': str(tmp_path)}, '找不到这个录音文件', id='a-folder'),
        pytest.param(_a_file_that_is_not_a_recording('合同.pdf'), '只收 WAV、MP3 或 M4A', id='not-a-recording'),
        pytest.param(_a_file_that_is_not_a_recording('id_rsa'), '只收 WAV、MP3 或 M4A', id='no-suffix'),
        pytest.param(_a_recording_over_the_limit, '10 MB 以内', id='too-large'),
        pytest.param(lambda tmp_path, _: {'action': 'clone', 'audio_path': str(tmp_path / 'nope.m4a')},
                     'action 只能是', id='unknown-action'),
    ],
)
def test_nothing_is_read_or_sent_for_a_request_that_cannot_work(monkeypatch, scheduler, tmp_path, prepare, says):
    result = _own_voice(**prepare(tmp_path, monkeypatch))

    assert result['success'] is False and says in result['error']
    assert scheduler.calls == []


def test_delete_asks_scheduler_to_delete(scheduler):
    result = _own_voice(action='delete')
    assert result['success'] is True and '删掉' in result['message']
    assert [(call['method'], call['auth']) for call in scheduler.own_voice_calls()] == [('DELETE', 'Bearer desktop-key')]


@pytest.mark.parametrize('action', ['status', 'record', 'delete'])
def test_schedulers_refusal_reaches_the_model_in_its_own_words(scheduler, tmp_path, action):
    scheduler.refusal = (422, {'code': 'voice_clone_passage_mismatch', 'message': '录音里读的不是要求的那段话。这次没有生成声音。'})
    recording = tmp_path / 'me.wav'
    recording.write_bytes(b'RIFF')

    result = _own_voice(action=action, audio_path=str(recording))

    assert result == {'success': False, 'error': '录音里读的不是要求的那段话。这次没有生成声音。'}


def test_a_redirect_never_carries_the_key_or_the_recording_on(scheduler, tmp_path):
    scheduler.redirect_to = scheduler.base + '/tools/v1/tts/synthesize'
    recording = tmp_path / 'me.wav'
    recording.write_bytes(b'RIFF')

    result = _own_voice(action='record', audio_path=str(recording))

    assert result['success'] is False
    assert len(scheduler.calls) == 1  # the redirect was not followed


def test_an_answer_that_is_not_http_reads_as_the_platform_being_unreachable(monkeypatch, scheduler):
    listener = socket.create_server(('127.0.0.1', 0))

    def answer_once():
        connection, _ = listener.accept()
        connection.recv(65536)
        connection.sendall(b'not http at all\r\n\r\n')
        connection.close()

    threading.Thread(target=answer_once, daemon=True).start()
    base = f'http://127.0.0.1:{listener.getsockname()[1]}/api/v1'
    monkeypatch.setattr(adapter, 'connection', lambda: ('desktop-key', base))

    assert _own_voice(action='status') == {'success': False, 'error': '连不上平台，过一会儿再试。'}
    listener.close()


def test_signed_out_nothing_is_sent(scheduler):
    scheduler.account['key'] = ''
    result = _own_voice(action='status')
    assert result == {'success': False, 'error': '请先登录 APEX，再用「我的声音」。'}
    assert adapter.own_voice_listed() is False
    assert scheduler.calls == []


# ── 3. Who is shown it ───────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ('state', 'shown'),
    [
        pytest.param(OPEN, True, id='opened'),
        pytest.param(HAS_VOICE, True, id='opened-with-a-voice'),
        pytest.param(CLOSED_WITH_VOICE, True, id='closed-again-but-a-voice-to-delete'),
        pytest.param(CLOSED, False, id='not-opened'),
        pytest.param(None, False, id='scheduler-refuses'),
    ],
)
def test_the_tool_and_the_voice_name_are_shown_only_where_they_can_be_used(scheduler, state, shown):
    if state is None:
        scheduler.refusal = (503, {'code': 'down', 'message': 'down'})
    else:
        scheduler.state = dict(state)
    parameters = {'properties': {name: {} for name in ('text', 'output_path', 'speed', 'instructions')}}

    assert adapter.own_voice_listed() is shown
    described = adapter.narration_parameters(parameters, '~/.apex', voice=True, own=adapter.own_voice_listed())
    described = described['properties']['voice']['description']
    assert ('我的声音' in described) is shown
    assert all(name in described for name, _ in adapter.VOICES)
    # One question to Scheduler answers both for a minute: the schema is built on every turn.
    assert len(scheduler.own_voice_calls()) == 1


def test_a_question_that_blows_up_hides_the_tool_and_never_reaches_the_tool_list(monkeypatch, scheduler):
    """own_voice_listed runs while text_to_speech's schema is built: whatever goes wrong in it, narration is unaffected."""
    def boom(*args, **kwargs):
        raise RuntimeError('unexpected')

    monkeypatch.setattr(adapter, 'own_voice_request', boom)
    assert adapter.own_voice_listed() is False
    monkeypatch.setattr(adapter, 'connection', boom)
    assert adapter.own_voice_listed() is False


def test_the_kept_answer_belongs_to_the_account_that_asked(scheduler):
    assert adapter.own_voice_listed() is True
    scheduler.state = dict(CLOSED)
    assert adapter.own_voice_listed() is True  # still the first account's kept answer
    scheduler.account['key'] = 'another-account'  # signed out and in as somebody else
    assert adapter.own_voice_listed() is False
    assert [call['auth'] for call in scheduler.own_voice_calls()] == ['Bearer desktop-key', 'Bearer another-account']


@pytest.mark.parametrize('action', ['record', 'delete'])
def test_after_a_voice_is_made_or_deleted_scheduler_is_asked_again(scheduler, tmp_path, action):
    scheduler.state = dict(CLOSED_WITH_VOICE)
    assert adapter.own_voice_listed() is True
    recording = tmp_path / 'me.wav'
    recording.write_bytes(b'RIFF')
    assert _own_voice(action=action, audio_path=str(recording))['success'] is True
    scheduler.state = dict(CLOSED)  # deleted, and the account is not opened: nothing left to offer
    assert adapter.own_voice_listed() is False


def test_the_tool_is_registered_next_to_text_to_speech_with_its_check():
    registered: list[dict] = []
    assert adapter.register_own_voice(SimpleNamespace(register_tool=lambda **kwargs: registered.append(kwargs))) is True
    [tool] = registered
    assert (tool['name'], tool['toolset']) == ('own_voice', 'tts')
    assert tool['check_fn'] is adapter.own_voice_listed and tool['handler'] is adapter.own_voice
    assert tool['schema'] is adapter.OWN_VOICE_SCHEMA and tool['description'] == adapter.OWN_VOICE_SCHEMA['description']
    # a plugin host that cannot register tools: said, not raised
    assert adapter.register_own_voice(SimpleNamespace()) is False


def test_the_name_the_route_and_the_tools_text_are_the_hosted_twins():
    """apex-nodes pins the same values (tests/test_hc1297_own_voice_plugin.py): change both sides together."""
    assert adapter.OWN_VOICE == ('我的声音', 'my-voice')
    assert adapter.OWN_VOICE_PATH == '/tools/v1/tts/own-voice'
    assert adapter.MAX_RECORDING_BYTES == 10 * 1024 * 1024
    assert adapter.OWN_VOICE_DESCRIPTION == '用户用 own_voice 录过自己的声音时，还可以填「我的声音」。'
    schema = json.dumps(adapter.OWN_VOICE_SCHEMA, ensure_ascii=False, sort_keys=True)
    assert hashlib.sha256(schema.encode('utf-8')).hexdigest() == TWIN_SCHEMA_SHA256



# ── 4. The real engine ───────────────────────────────────────────────────────


def test_a_real_engine_offers_records_and_speaks_in_the_users_voice(tmp_path):
    """Real plugin loader, real registry, a real agent's tool list, real HTTP; only Scheduler is faked."""
    script = r'''
import os,json,threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
home=Path(os.environ['HERMES_HOME']);home.mkdir(exist_ok=True)
(home/'config.yaml').write_text('plugins:\n  enabled:\n    - apex-overlay\ntts:\n  doubao:\n    max_text_length: 12\n',encoding='utf-8')
calls=[];state={'enabled':False,'voice':None,'passage':'我确认这是我本人的声音。','min_seconds':8.0,'max_seconds':30.0}
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def _json(self,payload):
  body=json.dumps(payload,ensure_ascii=False).encode('utf-8')
  self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
 def _take(self,method):
  raw=self.rfile.read(int(self.headers.get('Content-Length') or 0))
  calls.append((method,self.path,self.headers.get('Authorization'),raw))
  return raw
 def do_GET(self):
  self._take('GET');self._json({'ok':True,'data':state})
 def do_DELETE(self):
  self._take('DELETE');state['voice']=None;self._json({'ok':True,'data':{'deleted':True}})
 def do_POST(self):
  raw=self._take('POST')
  if self.path.endswith('/own-voice'):
   state['voice']={'name':'我的声音','voice':'my-voice','seconds':15.0}
   return self._json({'ok':True,'data':{'voice':state['voice']}})
  body=json.loads(raw)
  self.send_response(200);self.send_header('Content-Type','audio/mpeg')
  self.send_header('X-TTS-Voice',body.get('voice') or 'longanhuan_v3.1');self.end_headers();self.wfile.write(b'ID3\x04\x00\x00test-audio')
server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
os.environ['HERMES_PLATFORM_API_BASE']=f'http://127.0.0.1:{server.server_port}/api/v1'
threading.Thread(target=server.serve_forever,daemon=True).start()
from tools.registry import registry,invalidate_check_fn_cache
from tools import tts_tool
from hermes_cli.plugins import discover_plugins
from apex_overlay import doubao_tts as adapter
discover_plugins()
def shown(): return {d['function']['name'] for d in registry.get_definitions({'own_voice','text_to_speech'},quiet=True)}
def voice_text(): return registry.get_definitions({'text_to_speech'},quiet=True)[0]['function']['parameters']['properties']['voice']['description']
def reachable(session):
 from run_agent import AIAgent
 from agent.tool_executor import _tool_search_scoped_names
 agent=AIAgent(api_key='test-key',base_url='https://openrouter.ai/api/v1',model='test/model',provider='openrouter',platform='cli',
               quiet_mode=True,skip_context_files=True,skip_memory=True,session_id=session)
 return {t['function']['name'] for t in (agent.tools or [])}|set(_tool_search_scoped_names(agent))
entry=registry.get_entry('own_voice')
assert entry is not None and entry.toolset=='tts',entry
# an account the platform has not opened it for: neither the tool nor the name is offered
assert shown()=={'text_to_speech'},shown()
assert voice_text()==adapter.VOICE_DESCRIPTION,voice_text()
before=reachable('closed')
assert 'text_to_speech' in before and 'own_voice' not in before,sorted(before)
asked=[c for c in calls if c[0]=='GET']
assert asked and {c[2] for c in asked}=={'Bearer only-this-profile'},asked   # the account's own key, read by connection()
# the platform opens it: once the kept answers run out (a minute here, 30 s in the registry; dropped by
# hand in this test) a new session is offered both, with no restart
state['enabled']=True;adapter._listed.clear();invalidate_check_fn_cache()
assert shown()=={'own_voice','text_to_speech'},shown()
assert voice_text()==adapter.VOICE_DESCRIPTION+adapter.OWN_VOICE_DESCRIPTION,voice_text()
assert 'own_voice' in reachable('opened')
def own(args): return json.loads(registry.dispatch('own_voice',args))
status=own({'action':'status'})
assert status['success'] and status['enabled'] and not status['has_voice'] and status['passage']=='我确认这是我本人的声音。',status
recording=home/'录音.m4a';recording.write_bytes(b'\x00\x01recording')
made=own({'action':'record','audio_path':str(recording)})
assert made['success'] and made['voice']['voice']=='my-voice',made
posted=[c for c in calls if c[0]=='POST' and c[1].endswith('/tools/v1/tts/own-voice')]
assert len(posted)==1 and posted[0][2]=='Bearer only-this-profile',posted
assert b'\x00\x01recording' in posted[0][3] and b'filename="recording.m4a"' in posted[0][3],posted
# speaking in it: every chunk of a long narration goes out as my-voice, never an id
del calls[:]
result=json.loads(registry.dispatch('text_to_speech',{'text':'今天做一道菜, 先切葱花, 再下锅翻炒, 最后装盘.','output_path':str(home/'a.mp3'),'voice':'我的声音'}))
assert result['success'] and result['provider']=='doubao',result
spoken=[json.loads(c[3]) for c in calls if c[1].endswith('/synthesize')]
assert len(spoken)>=2 and {b.get('voice') for b in spoken}=={'my-voice'},spoken
# and deleting it
assert own({'action':'delete'})['success']
assert [c[0] for c in calls if c[1].endswith('/tools/v1/tts/own-voice')][-1]=='DELETE',calls
server.shutdown()
'''
    env = {**os.environ, 'HERMES_HOME': str(tmp_path / 'profile'), 'TOOLS_GATEWAY_KEY': 'only-this-profile',
           'HERMES_DISABLE_LAZY_INSTALLS': '1', 'NO_PROXY': '127.0.0.1,localhost', 'no_proxy': '127.0.0.1,localhost'}
    for name in ('HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'):
        env.pop(name, None)
    script = "import sys\nsys.modules['edge_tts']=None\nsys.modules['neutts']=None\n" + script
    result = subprocess.run([sys.executable, '-c', script], env=env,
                            cwd=Path(__file__).resolve().parents[2], capture_output=True, text=True, timeout=120, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
