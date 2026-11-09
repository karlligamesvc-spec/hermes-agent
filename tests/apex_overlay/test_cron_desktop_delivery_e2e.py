"""hc-1186 end to end: a real engine against a local fake model, no paid call.

1. A Desktop chat turn (``platform="desktop"``, session vars as tui_gateway binds them): the fake model calls
   ``cronjob_manage`` create, the real tool runs and the job is stored with the chat as its Desktop origin.
2. The scheduler runs the job for real (``cron.scheduler.run_job`` builds its own agent on the same fake model)
   and delivers through the real ``_deliver_result``.
3. The chat's next turn, rebuilt from state.db the way a resumed chat is, sends the model the result: the
   assistant can talk about it, and nothing display-only reaches the provider.
"""

from __future__ import annotations

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

CHAT = "20261108_101500_desk01"
RESULT = "国家统计局公布 10 月 CPI 同比上涨 0.8%（来源：国家统计局，官方）"
CREATE_ARGS = {"action": "create", "prompt": "联网搜一条今天的财经新闻，一句话说标题和来源。", "schedule": "in 30m",
               "name": "今日财经新闻一条"}


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
    success, _output, final_response, error = scheduler.run_job({**job, "model": "fake-model"})
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
