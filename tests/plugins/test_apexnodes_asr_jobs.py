"""hc-978: Desktop transcription submits a job and polls it.

Incident (2026-10-22, APEX Desktop 0.17.61 test copy, Mac on Shanghai home broadband):
``media_transcribe`` held one request to api.apex-nodes.com open while Volcengine
worked. Nothing crossed the connection for 6 minutes; a middlebox on the way to Tencent
HK/SG dropped it. The scheduler answered 200 (nginx logged 699 bytes sent), the answer
never arrived, and the tool sat until its 7800 s timeout. A second call's 503 was lost
the same way and its socket was still ESTABLISHED on the Mac an hour later.

The first tests run a real local HTTP gateway through the real ``request_json``, so a
lost answer is a request the server accepts and never answers, exactly as the client
experienced it. The rest drive ``_await_asr_job`` through a scripted ``request_json``
and a fake clock.
"""

from __future__ import annotations

import json
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from tests.plugins.test_apexnodes_gateway_tools import GATEWAY_KEY, _gateway_module, _load_plugin

HANG = "hang"
RUNNING = {"ok": True, "job_id": "job-1", "status": "running", "poll_after_seconds": 0, "max_wait_seconds": 1800}
DONE = {"ok": True, "job_id": "job-1", "status": "done", "text": "大家好，今天做三道菜。", "duration_seconds": 37.82,
        "cost_cents": 6, "cache_hit": False}


class LocalGateway:
    """A scheduler stand-in. ``plan[(method, path)]`` is a list of answers used in
    order (the last one repeats); ``HANG`` accepts the request and never answers."""

    def __init__(self):
        self.plan: dict[tuple[str, str], list] = {}
        self.seen: list[tuple[str, str]] = []
        self.on_request = None
        self.release = threading.Event()
        gateway = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def _serve(self):
                length = int(self.headers.get("Content-Length") or 0)
                if length:
                    self.rfile.read(length)
                gateway.seen.append((self.command, self.path))
                if gateway.on_request is not None:
                    gateway.on_request(self)
                answers = gateway.plan.get((self.command, self.path)) or [(404, {"detail": "Not Found"})]
                answer = answers.pop(0) if len(answers) > 1 else answers[0]
                if answer == HANG:
                    gateway.release.wait(30)
                    self.close_connection = True
                    return
                status, body = answer
                raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            do_GET = do_POST = _serve

            def log_message(self, *_args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.release.set()
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def gateway_module(monkeypatch, tmp_path):
    module = _gateway_module()
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("TOOLS_GATEWAY_KEY", GATEWAY_KEY)
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        monkeypatch.delenv(name, raising=False)
    # An env with only NO_PROXY keeps urllib off the Mac's system proxy settings.
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")
    # Seconds instead of minutes; the logic under test is unchanged.
    monkeypatch.setattr(module, "_ASR_JOB_POLL_TIMEOUT_SECONDS", 0.3)
    monkeypatch.setattr(module, "_ASR_JOB_POLL_GAP_SECONDS", (0.01, 0.01, 0.05))
    monkeypatch.setattr(module, "_ASR_JOB_UNREACHABLE_SECONDS", 1.0)
    return module


def _run_bounded(fn, seconds: float):
    """Run ``fn`` in a thread; (finished, result or exception). A hang reads as unfinished."""
    box: dict = {}

    def target():
        try:
            box["result"] = fn()
        except BaseException as exc:  # handed back to the test
            box["error"] = exc

    worker = threading.Thread(target=target, daemon=True)
    worker.start()
    worker.join(seconds)
    return not worker.is_alive(), box


def test_lost_answers_on_a_silent_path_cost_one_poll_not_the_transcription(gateway_module, monkeypatch):
    """The incident: the synchronous call's answer never arrives. The job flow still
    gets the result although two of its polls are lost the same way."""
    with LocalGateway() as gw:
        monkeypatch.setenv("TOOLS_GATEWAY_BASE", gw.base)
        gw.plan[("POST", "/tools/v1/asr/transcribe")] = [HANG]  # the 2026-10-22 answer
        gw.plan[("POST", "/tools/v1/asr/jobs")] = [(202, RUNNING)]
        gw.plan[("GET", "/tools/v1/asr/jobs/job-1")] = [HANG, HANG, (200, DONE)]
        finished, box = _run_bounded(
            lambda: gateway_module.transcribe_media_url("https://cos.example/a.m4a", timeout=7800), 10
        )
    assert finished, "the transcription hung on a lost answer"
    assert "error" not in box, box.get("error")
    assert box["result"]["text"] == DONE["text"]
    assert ("POST", "/tools/v1/asr/transcribe") not in gw.seen
    assert gw.seen.count(("GET", "/tools/v1/asr/jobs/job-1")) == 3


def test_a_dead_path_surfaces_in_minutes_with_words_the_agent_can_act_on(gateway_module, monkeypatch):
    with LocalGateway() as gw:
        monkeypatch.setenv("TOOLS_GATEWAY_BASE", gw.base)
        gw.plan[("POST", "/tools/v1/asr/transcribe")] = [HANG]
        gw.plan[("POST", "/tools/v1/asr/jobs")] = [(202, RUNNING)]
        gw.plan[("GET", "/tools/v1/asr/jobs/job-1")] = [HANG]
        started = time.monotonic()
        finished, box = _run_bounded(
            lambda: gateway_module.transcribe_media_url("https://cos.example/a.m4a", timeout=7800), 10
        )
        elapsed = time.monotonic() - started
    assert finished, "a dead path must end the wait, not the tool's 7800 s budget"
    error = box["error"]
    assert isinstance(error, gateway_module.GatewayError)
    assert error.code == "asr_job_unreachable"
    assert "连续" in str(error) and "media_transcribe" in str(error) and "同一个文件" in str(error)
    assert elapsed < 5


def test_old_gateway_without_jobs_gets_the_synchronous_call(gateway_module, monkeypatch):
    with LocalGateway() as gw:
        monkeypatch.setenv("TOOLS_GATEWAY_BASE", gw.base)
        gw.plan[("POST", "/tools/v1/asr/transcribe")] = [(200, {"ok": True, "text": "旧网关", "duration_seconds": 3.0})]
        finished, box = _run_bounded(
            lambda: gateway_module.transcribe_media_url("https://cos.example/a.m4a", timeout=7800), 10
        )
    assert finished and box["result"]["text"] == "旧网关"
    assert gw.seen == [("POST", "/tools/v1/asr/jobs"), ("POST", "/tools/v1/asr/transcribe")]


def test_gateway_connections_carry_tcp_keepalive(gateway_module, monkeypatch):
    """Video/image generation and the old synchronous ASR still wait silently; keepalive
    probes keep NAT state alive and turn a dead path into an error. Read from the real
    client socket while its request is in flight."""
    created: list[socket.socket] = []
    real_create = socket.create_connection

    def recording_create(*args, **kwargs):
        sock = real_create(*args, **kwargs)
        created.append(sock)
        return sock

    monkeypatch.setattr(socket, "create_connection", recording_create)
    observed: dict = {}
    idle_option = getattr(socket, "TCP_KEEPIDLE", None) or getattr(socket, "TCP_KEEPALIVE", None)

    def inspect(_handler):
        sock = created[-1]
        observed["keepalive"] = sock.getsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE)
        if idle_option is not None:
            observed["idle"] = sock.getsockopt(socket.IPPROTO_TCP, idle_option)

    with LocalGateway() as gw:
        monkeypatch.setenv("TOOLS_GATEWAY_BASE", gw.base)
        gw.on_request = inspect
        gw.plan[("GET", "/tools/v1/check")] = [(200, {"ok": True})]
        assert gateway_module.request_json("GET", "/tools/v1/check", timeout=5) == {"ok": True}
    assert observed["keepalive"]
    if idle_option is not None:
        assert observed["idle"] == gateway_module._KEEPALIVE_IDLE_SECONDS


def test_keepalive_client_still_uses_the_environment_proxy(gateway_module, monkeypatch):
    """httpx drops env proxies once a transport is passed in; users who reach the
    platform through HTTP(S)_PROXY must keep reaching it."""
    with LocalGateway() as proxy:
        monkeypatch.setenv("TOOLS_GATEWAY_BASE", "http://gateway.invalid")
        monkeypatch.setenv("HTTP_PROXY", proxy.base)
        monkeypatch.setenv("http_proxy", proxy.base)
        monkeypatch.setenv("NO_PROXY", "localhost")
        monkeypatch.setenv("no_proxy", "localhost")
        proxy.plan[("GET", "http://gateway.invalid/tools/v1/check")] = [(200, {"ok": True, "via": "proxy"})]
        answer = gateway_module.request_json("GET", "/tools/v1/check", timeout=5)
    assert answer == {"ok": True, "via": "proxy"}
    assert proxy.seen == [("GET", "http://gateway.invalid/tools/v1/check")]


# ── scripted request_json + fake clock ───────────────────────────────────────


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


@pytest.fixture
def scripted(monkeypatch):
    """``answers`` maps (method, path) to a list of answers (dicts, or exceptions to
    raise); ``calls`` records (method, path, timeout)."""
    module = _gateway_module()
    clock = FakeClock()
    monkeypatch.setattr(module, "time", clock)
    state = {"answers": {}, "calls": []}

    def request_json(method, path, payload=None, *, timeout=90, files=None, form_data=None):
        state["calls"].append((method, path, timeout))
        queue = state["answers"][(method, path)]
        answer = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(answer, BaseException):
            raise answer
        clock.now += 1  # every request takes a second
        return dict(answer)

    monkeypatch.setattr(module, "request_json", request_json)
    return module, state, clock


def _not_found(module, code=None):
    return module.GatewayError("HTTP 404", status=404, code=code)


def test_sync_fallback_waits_no_longer_than_nginx_and_the_server_would(scripted):
    module, state, _clock = scripted
    state["answers"][("POST", "/tools/v1/asr/jobs")] = [_not_found(module)]
    state["answers"][("POST", "/tools/v1/asr/transcribe")] = [{"ok": True, "text": "x"}]
    module.transcribe_media_url("https://cos.example/a.m4a", timeout=7800)
    assert state["calls"][-1] == ("POST", "/tools/v1/asr/transcribe", 1850.0)


def test_a_job_the_restarted_server_forgot_is_submitted_once_more(scripted):
    module, state, _clock = scripted
    state["answers"][("POST", "/tools/v1/asr/jobs")] = [RUNNING, {**RUNNING, "job_id": "job-2"}]
    state["answers"][("GET", "/tools/v1/asr/jobs/job-1")] = [_not_found(module, "asr_job_not_found")]
    state["answers"][("GET", "/tools/v1/asr/jobs/job-2")] = [DONE]
    assert module.transcribe_media_url("https://cos.example/a.m4a", timeout=7800)["text"] == DONE["text"]
    assert [c[:2] for c in state["calls"]] == [
        ("POST", "/tools/v1/asr/jobs"),
        ("GET", "/tools/v1/asr/jobs/job-1"),
        ("POST", "/tools/v1/asr/jobs"),
        ("GET", "/tools/v1/asr/jobs/job-2"),
    ]


def test_a_job_lost_twice_says_so(scripted):
    module, state, _clock = scripted
    state["answers"][("POST", "/tools/v1/asr/jobs")] = [RUNNING]
    state["answers"][("GET", "/tools/v1/asr/jobs/job-1")] = [_not_found(module, "asr_job_not_found")]
    with pytest.raises(module.GatewayError) as caught:
        module.transcribe_media_url("https://cos.example/a.m4a", timeout=7800)
    assert caught.value.code == "asr_job_not_found"
    assert "重新提交" in str(caught.value) and "同一个文件" in str(caught.value)
    assert sum(1 for c in state["calls"] if c[0] == "POST") == 2


def test_a_job_still_running_past_the_server_budget_stops_with_a_plain_answer(scripted):
    module, state, clock = scripted
    state["answers"][("POST", "/tools/v1/asr/jobs")] = [{**RUNNING, "max_wait_seconds": 600, "poll_after_seconds": 5}]
    state["answers"][("GET", "/tools/v1/asr/jobs/job-1")] = [{**RUNNING, "poll_after_seconds": 5}]
    started = clock.now
    finished, box = _run_bounded(lambda: module.transcribe_media_url("https://cos.example/a.m4a", timeout=7800), 10)
    waited = clock.now - started
    assert finished, "a job that never finishes must not be polled forever"
    error = box["error"]
    assert isinstance(error, module.GatewayError)
    assert error.code == "asr_job_overdue"
    assert "停止等待" in str(error)
    assert 600 + module._ASR_JOB_DEADLINE_MARGIN_SECONDS <= waited < 600 + module._ASR_JOB_DEADLINE_MARGIN_SECONDS + 30


def test_polls_answer_every_few_seconds_and_each_has_a_short_read_timeout(scripted):
    module, state, _clock = scripted
    state["answers"][("POST", "/tools/v1/asr/jobs")] = [{**RUNNING, "poll_after_seconds": 5}]
    state["answers"][("GET", "/tools/v1/asr/jobs/job-1")] = [{**RUNNING, "poll_after_seconds": 5}] * 3 + [DONE]
    module.transcribe_media_url("https://cos.example/a.m4a", timeout=7800)
    submit, *polls = state["calls"]
    assert submit == ("POST", "/tools/v1/asr/jobs", module._ASR_JOB_SUBMIT_TIMEOUT_SECONDS)
    assert polls == [("GET", "/tools/v1/asr/jobs/job-1", module._ASR_JOB_POLL_TIMEOUT_SECONDS)] * 4
    assert module._ASR_JOB_POLL_TIMEOUT_SECONDS <= 30


@pytest.mark.parametrize(
    ("status", "detail", "expected"),
    [
        (503, {"code": "vendor_unavailable", "message": "ASR 识别失败 (code=55000031): busy", "vendor_code": "asr_failed"},
         "视频转写服务暂不可用(503)"),
        (402, {"code": "quota_exceeded", "message": "本月额度已用完"}, "额度"),
    ],
)
def test_a_failed_job_reads_like_the_synchronous_error(scripted, status, detail, expected):
    module, state, _clock = scripted
    state["answers"][("POST", "/tools/v1/asr/jobs")] = [RUNNING]
    state["answers"][("GET", "/tools/v1/asr/jobs/job-1")] = [
        {"ok": False, "job_id": "job-1", "status": "failed", "error": {"status_code": status, "detail": detail}}
    ]
    with pytest.raises(module.GatewayError) as caught:
        module.transcribe_media_url("https://cos.example/a.m4a", timeout=7800)
    assert caught.value.status == status
    assert expected in str(caught.value)


def test_media_transcribe_tool_reports_the_unreachable_wait_as_its_error(monkeypatch, tmp_path):
    """End to end through the tool: the agent sees the plain sentence, not a hang."""
    module = _gateway_module()
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("TOOLS_GATEWAY_BASE", "https://gw.test")
    monkeypatch.setenv("TOOLS_GATEWAY_KEY", GATEWAY_KEY)
    monkeypatch.setattr(module, "extract_audio_for_asr", lambda _p, **_kw: None)
    monkeypatch.setattr(
        module,
        "_transcribe",
        lambda _send, *, timeout: (_ for _ in ()).throw(
            module.GatewayError(module.say("asr_job_unreachable", minutes=2), code="asr_job_unreachable")
        ),
    )
    douyin = _load_plugin("apexnodes-douyin-tools")
    try:
        clip = tmp_path / "clip.mp4"
        clip.write_bytes(b"x" * 8)
        result = json.loads(douyin._handle_media_transcribe({"video_path": str(clip)}))
    finally:
        sys.modules.pop(douyin.__name__, None)
    assert result["error"].startswith("视频转写失败: 转写任务已经交给平台")
