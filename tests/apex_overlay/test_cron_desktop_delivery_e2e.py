"""hc-1186 end to end: a real engine against a local fake model, no paid call.

1. A Desktop chat turn (``platform="desktop"``, session vars as tui_gateway binds them): the fake model calls
   ``cronjob_manage`` create, the real tool runs and the job is stored with the chat as its Desktop origin.
2. The scheduler runs the job for real (``cron.scheduler.run_job`` builds its own agent on the same fake model)
   and delivers through the real ``_deliver_result``.
3. The chat's next turn, rebuilt from state.db the way a resumed chat is, sends the model the result: the
   assistant can talk about it, and nothing display-only reaches the provider.
"""

from __future__ import annotations

from contextlib import contextmanager
from types import SimpleNamespace

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

import cron.jobs as jobs_mod
from cron import scheduler
import tools.cronjob_job_args as job_args
from apex_overlay import cron_desktop_delivery as seam
from hermes_state import SessionDB
from tools import cronjob_tools
from tools.registry import get_cached_check_fn_result, invalidate_check_fn_cache

CHAT = "20261108_101500_desk01"
RESULT = "国家统计局公布 10 月 CPI 同比上涨 0.8%（来源：国家统计局，官方）"
CREATE_ARGS = {"action": "create", "prompt": "联网搜一条今天的财经新闻，一句话说标题和来源。", "schedule": "in 30m",
               "name": "今日财经新闻一条"}
# Any one of these makes check_cronjob_requirements say yes; a test without them gets no cronjob tool.
SERVE_ENV = ("HERMES_INTERACTIVE", "HERMES_GATEWAY_SESSION", "HERMES_EXEC_ASK", "HERMES_CRON_SESSION")


@contextmanager
def _tool_checks_from_scratch():
    """The registry keeps each tool's availability check for 30 s per process (hc-1227). An earlier test in the same
    run that built tools without the Desktop serve env leaves the cronjob check's False there, and the chat's first
    turn then goes out with no cronjob tool. Drop the cache on the way in, and again on the way out so the True this
    test caches does not reach the next one."""
    invalidate_check_fn_cache()
    try:
        yield
    finally:
        invalidate_check_fn_cache()


def _cronjob_tool_offered() -> bool:
    """What the agent of a test without our engine gets. The tool may sit in tool_search's deferred catalog."""
    import model_tools

    return "cronjob_manage" in json.dumps(model_tools.get_tool_definitions(enabled_toolsets=["cronjob"], quiet_mode=True))


def _chunk(delta: dict, finish_reason=None) -> bytes:
    body = {"id": "c1", "object": "chat.completion.chunk", "created": 1, "model": "fake-model",
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}]}
    return f"data: {json.dumps(body, ensure_ascii=False)}\n\n".encode()


def _reply_for(body: dict):
    """The scripted answer, chosen by what the request is (side calls such as a title get plain text)."""
    messages = body.get("messages") or []
    text = json.dumps(messages, ensure_ascii=False)
    last = messages[-1] if messages else {}
    if last.get("role") == "tool":
        return "建好了，到点会把结果送回这个对话。"
    if "刚才那条新闻" in str(last.get("content")):
        return "就是这条：国家统计局公布了 10 月 CPI。"
    if "帮我建一个定时任务" in str(last.get("content")) and body.get("tools"):
        return {"name": "cronjob_manage", "args": CREATE_ARGS}
    if "scheduled cron job" in text:
        return RESULT
    return "今日财经"


class FakeModel:
    """Answers each chat-completions request by what it asks for (a tool call or text)."""

    def __init__(self):
        self.requests = []
        model = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_a):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
                if not self.path.endswith("/chat/completions"):  # the engine's /api/show probe and the like
                    self.send_response(404)
                    self.send_header("content-length", "0")
                    self.end_headers()
                    return
                model.requests.append(body)
                reply = _reply_for(body)
                if isinstance(reply, dict):
                    delta = {"role": "assistant", "tool_calls": [{"index": 0, "id": "call_1", "type": "function",
                             "function": {"name": reply["name"], "arguments": json.dumps(reply["args"], ensure_ascii=False)}}]}
                    payload = _chunk(delta) + _chunk({}, "tool_calls")
                else:
                    payload = _chunk({"role": "assistant", "content": reply}) + _chunk({}, "stop")
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.end_headers()
                self.close_connection = True
                self.wfile.write(payload + b"data: [DONE]\n\n")
                self.wfile.flush()

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.05), daemon=True).start()
        self.base_url = f"http://127.0.0.1:{self.server.server_address[1]}/v1"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def engine(tmp_path, monkeypatch):
    home = tmp_path / "apexnodes"
    (home / "cron" / "output").mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    monkeypatch.setenv("HERMES_GATEWAY_SESSION", "1")  # what the Desktop serve process runs with
    monkeypatch.setenv("HERMES_DESKTOP", "1")
    for name in ("HERMES_SESSION_PLATFORM", "HERMES_SESSION_CHAT_ID", "FEISHU_HOME_CHANNEL", "WEIXIN_HOME_CHANNEL"):
        monkeypatch.delenv(name, raising=False)
    for name, value in (("HERMES_DIR", home), ("CRON_DIR", home / "cron"), ("JOBS_FILE", home / "cron" / "jobs.json"),
                        ("OUTPUT_DIR", home / "cron" / "output")):
        monkeypatch.setattr(jobs_mod, name, value)
    monkeypatch.setitem(cronjob_tools._JOBLESS_ACTIONS, "create", cronjob_tools._JOBLESS_ACTIONS["create"])
    monkeypatch.setitem(cronjob_tools._JOB_ACTIONS, "update", cronjob_tools._JOB_ACTIONS["update"])
    for module, name in ((cronjob_tools, "_action_create"), (cronjob_tools, "_action_update"),
                         (cronjob_tools, "_local_delivery_notice"), (job_args, "_local_delivery_notice"),
                         (scheduler, "_deliver_result")):
        monkeypatch.setattr(module, name, getattr(module, name))
    assert seam._install_args(job_args) and seam._install_tool(cronjob_tools) and seam._install_scheduler(scheduler)
    assert getattr(scheduler._deliver_result, seam._MARK, False)
    model = FakeModel()
    with _tool_checks_from_scratch():
        yield home, model
    model.close()


def _desktop_agent(model: FakeModel, db: SessionDB):
    import run_agent

    agent = run_agent.AIAgent(api_key="test-key", base_url=model.base_url, model="fake-model", provider="custom",
                              platform="desktop", quiet_mode=True, skip_context_files=True, skip_memory=True,
                              enabled_toolsets=["cronjob"], session_id=CHAT, session_db=db, max_iterations=4)
    agent.api_mode = "chat_completions"
    return agent


def _desktop_turn(agent, text: str, history=None):
    from gateway.session_context import clear_session_vars, set_session_vars

    tokens = set_session_vars(session_key=CHAT, session_id=CHAT, source="desktop", profile="default",
                              ui_session_id="ui-1", cron_session="")
    try:
        return agent.run_conversation(text, conversation_history=history)
    finally:
        clear_session_vars(tokens)


def test_a_cronjob_check_cached_by_an_earlier_test_does_not_hide_the_tool(monkeypatch, request):
    """hc-1227: what an earlier test in the same process leaves behind. It built tool definitions without the Desktop
    serve env, so the cronjob check said False and the registry kept that for 30 s. The engine set up right after
    must still offer the tool on the chat's first turn."""
    invalidate_check_fn_cache()  # start from a known cache, whatever ran before
    for name in SERVE_ENV:
        monkeypatch.delenv(name, raising=False)
    assert not _cronjob_tool_offered()
    assert get_cached_check_fn_result(cronjob_tools.check_cronjob_requirements) is False  # the stale verdict is in

    home, model = request.getfixturevalue("engine")  # set up only now, after the stale verdict
    db = SessionDB(db_path=home / "state.db")
    first = _desktop_turn(_desktop_agent(model, db), "帮我建一个定时任务：30 分钟后搜一条今天的财经新闻。")
    # The tool may sit in the deferred catalog that tool_search's description lists, so look at the whole field.
    offered = json.dumps([r.get("tools") for r in model.requests], ensure_ascii=False)
    assert "cronjob_manage" in offered, f"the first turn offered {offered[:200]}"
    assert first["final_response"].startswith("建好了")
    db.close()


def test_the_cronjob_check_a_chat_cached_does_not_reach_the_next_test(monkeypatch):
    """hc-1227, the other direction: the engine's True stays with it. A test after it, run without the Desktop serve
    env within the 30 s, gets no cronjob tool."""
    with monkeypatch.context() as serve, _tool_checks_from_scratch():
        serve.setenv("HERMES_GATEWAY_SESSION", "1")
        assert _cronjob_tool_offered()  # what the chat's agent got, now cached
    for name in SERVE_ENV:
        monkeypatch.delenv(name, raising=False)
    try:
        assert not _cronjob_tool_offered()
    finally:
        invalidate_check_fn_cache()  # nor does the False this test just cached


def test_a_job_made_in_a_desktop_chat_brings_its_result_back_into_that_chat(engine, monkeypatch):
    home, model = engine
    db = SessionDB(db_path=home / "state.db")

    # 1. the Desktop chat turn makes the job through the real tool
    first = _desktop_turn(_desktop_agent(model, db), "帮我建一个定时任务：30 分钟后搜一条今天的财经新闻。")
    assert first["final_response"].startswith("建好了")
    [job] = jobs_mod.list_jobs(include_disabled=True)
    assert job[seam.ORIGIN_KEY]["session_id"] == CHAT and job["deliver"] == "origin"
    tool_result = next(m for r in model.requests for m in r["messages"] if m.get("role") == "tool")
    assert "posted back into this Desktop conversation" in tool_result["content"]

    # 2. the scheduler runs it on the same fake model and delivers for real
    monkeypatch.setattr("hermes_cli.runtime_provider.resolve_runtime_provider", lambda requested=None, **_k: {
        "provider": "custom", "api_mode": "chat_completions", "base_url": model.base_url, "api_key": "test-key"})
    monkeypatch.setattr("hermes_cli.runtime_provider.format_runtime_provider_error", lambda exc: str(exc))
    monkeypatch.setattr("model_tools.get_tool_definitions", lambda **_k: [])
    # v0.23.0: an agent fire runs inside the gateway's cron execution; outside one, run_job hands the job to
    # the gateway over RPC. Bind the owner execution the gateway's executor binds (hc-1203).
    from gateway import session_cron
    from hermes_state_registry import acquire, release_or_close

    owner_db = acquire(home / "state.db")  # the registry's canonical store, as the gateway owner holds it
    token = session_cron.bind_execution(SimpleNamespace(db=owner_db), f"cron_{job['id']}_e2e", job["id"], None)
    try:
        success, _output, final_response, error = scheduler.run_job({**job, "model": "fake-model"})
    finally:
        session_cron._execution.reset(token)
        release_or_close(owner_db)
    assert (success, error) == (True, None) and final_response == RESULT
    assert scheduler._deliver_result({**job, "execution_id": "exec-e2e"}, final_response) is None

    rows = [m for m in db.get_messages(CHAT) if m.get("display_kind") == seam.DISPLAY_KIND]
    assert len(rows) == 1 and rows[0]["content"].endswith(RESULT)

    # 3. the chat's next turn, rebuilt from state.db, hands the model the result
    history = db.get_messages_as_conversation(CHAT, repair_alternation=True)
    second = _desktop_turn(_desktop_agent(model, db), "刚才那条新闻说的是什么？", history)
    assert second["final_response"].startswith("就是这条")
    # The turn's own request carries the question; a side call (the chat's title) may carry it too, alone. The
    # engine folds the result row and the question into one user message (strict alternation), so look in all.
    asking = [r for r in model.requests if any("刚才那条新闻" in str(m.get("content")) for m in r["messages"])]
    assert any(RESULT in str(m.get("content")) for r in asking for m in r["messages"]), "the model never saw the result"
    every = [m for r in model.requests for m in r["messages"]]
    assert not any("display_metadata" in m or "display_kind" in m for m in every), "display fields reached the model"
    db.close()
