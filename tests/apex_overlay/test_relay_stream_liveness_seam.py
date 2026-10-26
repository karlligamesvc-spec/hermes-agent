"""hc-1032: a platform-relay stream whose bytes stop arriving is retried in about a minute.

2026-10-22: four Desktop ``deepseek-v4-pro-APEX`` streams finished on the server in 3-15 s,
but the bytes stopped reaching the Mac. The engine noticed only when its 600 s stale timer
(the DeepSeek reasoning floor; the read timeout is raised to match) ran out, and the re-send
was metered a second time. These tests pin the engine half of the fix:

  1. A relay response announcing ``X-APEX-Stream-Keepalive`` lowers that request's read
     deadline to max(45 s, 6 beats); no header, no change; never raised.
  2. End to end through the real streaming call: the silent first attempt ends on that
     deadline, not on the 600 s timer, and the retry carries the same call id.
  3. The real OpenAI SDK skips the relay's ``: keep-alive`` comments.
  4. Relay connections carry TCP keepalive (read back from the real socket).
  5. The call id: same call -> same id, platform relay only.
  6. The id is stable across retries because ``api_request_id`` is set once per call,
     before the retry loop.
"""
from __future__ import annotations

import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from agent import process_bootstrap
from apex_overlay import relay_stream_liveness as seam

REPO = Path(__file__).resolve().parents[2]
RELAY_URL = "https://apex-nodes.com/relay/v1"


def _chunk(delta: dict, finish_reason=None) -> bytes:
    body = {"id": "c1", "object": "chat.completion.chunk", "created": 1, "model": "deepseek-v4-pro-APEX",
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}]}
    return f"data: {json.dumps(body, ensure_ascii=False)}\n\n".encode()


class FakeRelay:
    """Attempt 1: heartbeat header, two reasoning chunks, then silence on an open socket (the
    server finished, the bytes never arrive). Later attempts: the whole answer, with beats."""

    def __init__(self, beat: str | None = "0.1"):
        self.requests: list[dict] = []
        self.release = threading.Event()
        relay = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_a):
                pass

            def do_GET(self):
                self.send_response(200)
                self.send_header("content-length", "2")
                self.end_headers()
                self.wfile.write(b"{}")

            def do_POST(self):
                size = int(self.headers.get("content-length", 0))
                body = json.loads(self.rfile.read(size) or b"{}")
                if not self.path.endswith("/chat/completions"):  # e.g. the engine's /api/show probe
                    self.send_response(404)
                    self.send_header("content-length", "0")
                    self.end_headers()
                    return
                relay.requests.append({"body": body, "call_id": self.headers.get(seam.CALL_ID_HEADER)})
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                if beat is not None:
                    self.send_header("X-APEX-Stream-Keepalive", beat)
                self.end_headers()
                self.close_connection = True  # no length: the body ends when the socket closes
                try:
                    if len(relay.requests) == 1:
                        self.wfile.write(_chunk({"reasoning_content": "先想"}) + _chunk({"reasoning_content": "一想"}))
                        self.wfile.flush()
                        relay.release.wait(timeout=30.0)  # bounded, so teardown never hangs
                        return
                    self.wfile.write(_chunk({"reasoning_content": "先想一想"}) + b": keep-alive\n\n"
                                     + b": keep-alive\n\n" + _chunk({"content": "写好了。"}) + b": keep-alive\n\n"
                                     + _chunk({}, finish_reason="stop") + b"data: [DONE]\n\n")
                    self.wfile.flush()
                except OSError:
                    pass  # the client gave up on this attempt (expected)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.05), daemon=True).start()
        self.base_url = f"http://127.0.0.1:{self.server.server_address[1]}/relay/v1"

    def close(self):
        self.release.set()
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def installed(monkeypatch):
    """The seam applied for real, the local fake standing in for the relay URL."""
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    monkeypatch.setattr(process_bootstrap, "build_keepalive_http_client",
                        process_bootstrap.build_keepalive_http_client)
    monkeypatch.setattr(seam, "is_platform_relay", lambda url: str(url or "").startswith("http://127.0.0.1:"))
    monkeypatch.setattr(seam, "MIN_READ_DEADLINE_SECONDS", 0.5)
    process_bootstrap.close_shared_transports()
    assert seam.apply() is True
    yield
    process_bootstrap.close_shared_transports()


@pytest.fixture
def relay():
    fake = FakeRelay()
    yield fake
    fake.close()


def _response(headers: dict, read):
    request = httpx.Request("POST", RELAY_URL, extensions={"timeout": {"read": read, "connect": 30.0}})
    return SimpleNamespace(headers=httpx.Headers(headers), request=request)


# ── 0. the patched symbol keeps its shape ─────────────────────────────────────

def test_the_wrapped_builder_keeps_its_signature():
    """The seam wraps ``build_keepalive_http_client`` and passes ``base_url`` positionally and
    ``async_mode`` by keyword; a rename or reshape upstream must fail here, not disarm silently."""
    import inspect

    params = inspect.signature(process_bootstrap.build_keepalive_http_client).parameters
    assert list(params)[:1] == ["base_url"]
    assert params["async_mode"].kind is inspect.Parameter.KEYWORD_ONLY
    assert params["verify"].kind is inspect.Parameter.KEYWORD_ONLY


# ── 1. the deadline ───────────────────────────────────────────────────────────

@pytest.mark.parametrize("headers, read, expected", [
    ({"X-APEX-Stream-Keepalive": "10"}, 600.0, 60.0),
    ({"X-APEX-Stream-Keepalive": "2"}, 600.0, 45.0),
    ({"X-APEX-Stream-Keepalive": "10"}, None, 60.0),
    ({"X-APEX-Stream-Keepalive": "10"}, 30.0, 30.0),
    ({}, 600.0, 600.0),
    ({"X-APEX-Stream-Keepalive": "soon"}, 600.0, 600.0),
    ({"X-APEX-Stream-Keepalive": "0"}, 600.0, 600.0),
    ({"X-APEX-Stream-Keepalive": "3600"}, 600.0, 600.0),
])
def test_the_relay_beat_sets_the_read_deadline_and_never_raises_it(headers, read, expected):
    response = _response(headers, read)
    seam._tighten_read_timeout(response)
    assert response.request.extensions["timeout"]["read"] == expected


# ── 2. end to end through the engine's own streaming call ────────────────────

def test_a_silent_relay_stream_is_retried_on_the_byte_deadline_with_the_same_call_id(installed, relay, monkeypatch):
    import run_agent

    monkeypatch.delenv("HERMES_STREAM_STALE_TIMEOUT", raising=False)
    monkeypatch.delenv("HERMES_STREAM_READ_TIMEOUT", raising=False)
    monkeypatch.setenv("HERMES_STREAM_RETRIES", "1")
    agent = run_agent.AIAgent(
        api_key="test-key", base_url=relay.base_url, model="deepseek-v4-pro-APEX", provider="custom",
        platform="cli", quiet_mode=True, skip_context_files=True, skip_memory=True, enabled_toolsets=[],
        max_iterations=1,
    )
    agent.api_mode = "chat_completions"
    agent._interrupt_requested = False
    request = {"model": "deepseek-v4-pro-APEX", "messages": [{"role": "user", "content": "继续"}]}
    named = seam.name_relay_call(request=request, base_url=relay.base_url, session_id="s1",
                                 api_request_id="s1:task:abcd1234:api:3")
    assert named is not None

    started = time.time()
    response = agent._interruptible_streaming_api_call(named["request"])
    elapsed = time.time() - started

    assert len(relay.requests) == 2, "the silent attempt was never retried"
    assert response.choices[0].message.content == "写好了。"
    ids = {entry["call_id"] for entry in relay.requests}
    assert len(ids) == 1 and None not in ids, "both attempts must name the same call"
    # The engine's own patience for this model is 600 s (stale) and the read timeout is raised
    # to match; the fake relay lets go after 30 s. Only the byte deadline ends it this fast.
    assert elapsed < 10.0, f"the dead stream took {elapsed:.1f}s to give up"


# ── 3. the SDK skips the beats ────────────────────────────────────────────────

def test_the_openai_sdk_skips_relay_keepalive_comments(installed, relay):
    from openai import OpenAI

    relay.requests.append({"body": {}, "call_id": None})  # serve the full answer straight away
    http_client = process_bootstrap.build_keepalive_http_client(relay.base_url)
    client = OpenAI(api_key="k", base_url=relay.base_url, http_client=http_client, max_retries=0)
    chunks = list(client.chat.completions.create(model="m", messages=[{"role": "user", "content": "hi"}],
                                                 stream=True))
    assert [c.choices[0].delta.content for c in chunks] == [None, "写好了。", None]
    assert chunks[-1].choices[0].finish_reason == "stop"


# ── 4. TCP keepalive on the relay's sockets ───────────────────────────────────

def test_relay_connections_carry_tcp_keepalive(installed, relay):
    http_client = process_bootstrap.build_keepalive_http_client(relay.base_url)
    with http_client.stream("GET", relay.base_url + "/models") as response:
        sock = response.extensions["network_stream"].get_extra_info("socket")
        assert sock.getsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE) != 0
        idle = getattr(socket, "TCP_KEEPIDLE", None) or getattr(socket, "TCP_KEEPALIVE", None)
        if idle is not None:
            assert sock.getsockopt(socket.IPPROTO_TCP, idle) == seam.KEEPALIVE_IDLE_SECONDS
        assert sock.getsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY) != 0, "httpcore's NODELAY must survive"


def test_other_endpoints_get_no_deadline_hook(installed):
    client = process_bootstrap.build_keepalive_http_client("https://api.deepseek.com/v1")
    assert seam._tighten_read_timeout not in client.event_hooks["response"]
    relay_client = process_bootstrap.build_keepalive_http_client("http://127.0.0.1:9/relay/v1", async_mode=True)
    assert seam._tighten_read_timeout_async in relay_client.event_hooks["response"]


# ── 5. the call id ────────────────────────────────────────────────────────────

def test_the_call_id_is_per_call_and_relay_only():
    request = {"model": "m", "messages": [], "extra_headers": {"X-Other": "1"}}
    first = seam.name_relay_call(request=request, base_url=RELAY_URL, session_id="s", api_request_id="t:api:1")
    again = seam.name_relay_call(request=request, base_url=RELAY_URL, session_id="s", api_request_id="t:api:1")
    other = seam.name_relay_call(request=request, base_url=RELAY_URL, session_id="s", api_request_id="t:api:2")
    headers = first["request"]["extra_headers"]
    assert headers["X-Other"] == "1"
    assert headers[seam.CALL_ID_HEADER] == again["request"]["extra_headers"][seam.CALL_ID_HEADER]
    assert headers[seam.CALL_ID_HEADER] != other["request"]["extra_headers"][seam.CALL_ID_HEADER]
    assert len(headers[seam.CALL_ID_HEADER]) == 32
    assert "extra_headers" not in request or seam.CALL_ID_HEADER not in request["extra_headers"]
    assert seam.name_relay_call(request=request, base_url="https://api.deepseek.com/v1", session_id="s",
                                api_request_id="t:api:1") is None
    assert seam.name_relay_call(request=request, base_url=RELAY_URL, session_id="s", api_request_id="") is None


def test_apply_registers_the_middleware_once_on_the_plugin_context(monkeypatch):
    monkeypatch.setattr(process_bootstrap, "build_keepalive_http_client",
                        process_bootstrap.build_keepalive_http_client)
    registered = []
    ctx = SimpleNamespace(register_middleware=lambda kind, cb: registered.append((kind, cb)))
    assert seam.apply(ctx) is True
    assert registered == [("llm_request", seam.name_relay_call)]
    wrapped = process_bootstrap.build_keepalive_http_client
    assert seam.apply() is True and process_bootstrap.build_keepalive_http_client is wrapped


# ── 6. why the id is stable across retries ────────────────────────────────────

def test_api_request_id_is_fixed_before_the_retry_loop():
    """The call id is a digest of ``api_request_id``; it names the call, not the attempt,
    only because the conversation loop sets the id once per call before retrying."""
    source = (REPO / "agent" / "conversation_loop.py").read_text(encoding="utf-8")
    assign = 's.api_request_id = agent._current_api_request_id = f"{s.turn_id}:api:{s.api_call_count}"'
    assert source.count(assign) == 1
    loop = "early_result = _run_api_retry_loop(agent, s)"
    assert source.count(loop) == 1
    assert source.index(assign) < source.index(loop)
    between = source[source.index(assign):source.index(loop)]
    assert "api_call_count +=" not in between


def test_plugin_register_applies_the_seam():
    from tests.apex_overlay.conftest import run_plugin_register_with_stubbed_seams

    assert "relay_stream_liveness" in run_plugin_register_with_stubbed_seams("apex_overlay_plugin_hc1032")
