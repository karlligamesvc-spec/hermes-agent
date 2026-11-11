"""hc-1122 ChatCut per account: the engine shows ChatCut only while the Scheduler has opened it for this account.

The Scheduler answers ``chatcut.enabled`` on ``/tools/v1/check`` per APEX key (apex-nodes ``chatcut_access``); a
local fake stands in for it and for the MCP proxy. Nothing here touches ChatCut. Pinned:

1. The answer is read with this assistant's own key when it is needed, kept for a minute, and counts as no when it
   cannot be read, when nobody is signed in and with the switch off. An older read landing last never replaces
   the answer to a newer one.
2. The prompt section, the two file tools and the MCP server exist only while it is yes; a developer's own
   ``chatcut`` server is never hidden.
3. The MCP paths never wait for the Scheduler.
4. A change while running re-checks the tool lists and brings the MCP connection in line, both ways, in the real
   engine.
"""

from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

import hermes_yaml as yaml
from apex_overlay import chatcut, chatcut_files
from tests.waiting import wait_until

APEX_KEY = "apex-agent-key-SECRET"


class FakeScheduler:
    """``/tools/v1/check`` with this account's answer, and the MCP proxy behind ``/api/v1/chatcut/mcp``, which
    refuses (403) whenever the account is closed, as the real one does."""

    def __init__(self):
        self.enabled = False
        self.status = 200
        self.body: bytes | None = None
        self.hold = threading.Event()
        self.hold.set()
        self.checks: list[dict] = []
        self.mcp: list[dict] = []
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def _send(self, status, payload: bytes):
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def do_GET(self):
                if self.path != chatcut.CHECK_PATH:
                    self.send_response(405)
                    self.end_headers()
                    return
                fake.hold.wait(10)
                fake.checks.append({"headers": dict(self.headers)})
                body = fake.body if fake.body is not None else json.dumps(
                    {"ok": True, "chatcut": {"enabled": fake.enabled}}).encode()
                self._send(fake.status, body)

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                fake.mcp.append(body)
                if not fake.enabled:
                    self._send(403, json.dumps({"error": {"code": "chatcut_not_enabled"}}).encode())
                    return
                if "id" not in body:
                    self.send_response(202)
                    self.end_headers()
                    return
                method = body.get("method")
                if method == "initialize":
                    result = {"protocolVersion": body["params"]["protocolVersion"],
                              "capabilities": {"tools": {"listChanged": False}},
                              "serverInfo": {"name": "apex-chatcut", "version": "1.0"}}
                elif method == "tools/list":
                    result = {"tools": [{"name": name, "description": name,
                                         "inputSchema": {"type": "object", "properties": {}}}
                                        for name in chatcut.INCLUDED_TOOLS]}
                else:
                    result = {}
                self._send(200, json.dumps({"jsonrpc": "2.0", "id": body["id"], "result": result}).encode())

            def do_DELETE(self):
                self.send_response(204)
                self.end_headers()

            def log_message(self, format, *args):
                return

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def stop(self):
        self.hold.set()
        self.server.shutdown()
        self.server.server_close()


class Clock:
    def __init__(self):
        self.now = 1000.0

    def monotonic(self):
        return self.now


@pytest.fixture
def scheduler(tmp_path, monkeypatch):
    from tools import mcp_tool_config, mcp_tool_registration

    home = tmp_path / "apexnodes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    fake = FakeScheduler()
    monkeypatch.setenv(chatcut.SWITCH_ENV, "1")
    monkeypatch.setenv(chatcut.KEY_ENV, APEX_KEY)
    monkeypatch.setenv(chatcut.BASE_ENV, fake.base)
    monkeypatch.setattr(chatcut, "_answers", {})
    monkeypatch.setattr(chatcut, "_refreshing", set())
    # apply() wraps these two module functions; each test gets the originals back.
    monkeypatch.setattr(mcp_tool_config, "_load_mcp_config", mcp_tool_config._load_mcp_config)
    monkeypatch.setattr(mcp_tool_registration, "_make_check_fn", mcp_tool_registration._make_check_fn)
    fake.home = home
    yield fake
    fake.stop()


@pytest.fixture
def changes(monkeypatch):
    seen: list[str] = []
    monkeypatch.setattr(chatcut, "_follow_change", lambda: seen.append("changed"))
    return seen


@pytest.fixture
def clock(monkeypatch):
    fake = Clock()
    monkeypatch.setattr(chatcut, "time", fake)
    return fake


@pytest.fixture
def inline(monkeypatch):
    """Background work runs on the spot, so a test can count it without waiting."""
    monkeypatch.setattr(chatcut, "_spawn", lambda target, *, name, args=(): target(*args))


class _Recorder:
    def __init__(self):
        self.tools: dict[str, dict] = {}
        self.sections: dict[str, object] = {}

    def register_tool(self, **kwargs):
        self.tools[kwargs["name"]] = kwargs

    def register_system_prompt_section(self, section_id, render, **_kwargs):
        self.sections[section_id] = render


# ---------------------------------------------------------------------------
# 1. The answer
# ---------------------------------------------------------------------------


def test_the_answer_is_read_with_this_assistants_key_and_kept_for_a_minute(scheduler, changes, clock):
    scheduler.enabled = True

    assert chatcut.entitled() is True
    assert chatcut.entitled() is True
    assert [check["headers"].get("Authorization") for check in scheduler.checks] == [f"Bearer {APEX_KEY}"]
    scheduler.enabled = False
    clock.now += chatcut.ENTITLEMENT_TTL_SECONDS - 1
    assert chatcut.entitled() is True
    clock.now += 2
    assert chatcut.entitled() is False
    assert len(scheduler.checks) == 2


@pytest.mark.parametrize(("status", "body"), [
    pytest.param(500, None, id="server-error"),
    pytest.param(200, b"not json", id="not-json"),
    pytest.param(200, json.dumps({"ok": True}).encode(), id="a-scheduler-without-the-answer"),
    pytest.param(200, json.dumps({"chatcut": {"enabled": "yes"}}).encode(), id="not-a-plain-true"),
])
def test_an_unreadable_answer_counts_as_no(scheduler, changes, status, body):
    scheduler.enabled, scheduler.status, scheduler.body = True, status, body

    assert chatcut.entitled() is False


@pytest.mark.parametrize("unset", [chatcut.SWITCH_ENV, chatcut.KEY_ENV, chatcut.BASE_ENV])
def test_switch_off_or_signed_out_is_no_without_asking(scheduler, changes, monkeypatch, unset):
    scheduler.enabled = True
    monkeypatch.delenv(unset)

    assert chatcut.entitled() is False and chatcut.known_entitled() is False
    assert scheduler.checks == [] and chatcut._refreshing == set()  # no background read started either


def test_another_account_signed_in_is_asked_afresh(scheduler, changes, monkeypatch):
    scheduler.enabled = True
    assert chatcut.entitled() is True
    monkeypatch.setenv(chatcut.KEY_ENV, "someone-elses-key")
    scheduler.enabled = False

    assert chatcut.entitled() is False
    assert [c["headers"]["Authorization"] for c in scheduler.checks] == [f"Bearer {APEX_KEY}", "Bearer someone-elses-key"]


def test_an_answer_asked_for_later_is_never_replaced_by_an_older_one(scheduler, changes, clock, monkeypatch):
    """``known_entitled`` reads in the background while ``entitled`` reads on the spot, so two reads can overlap.
    The older one landing last (a read that timed out counts as no, five seconds on) leaves the newer answer."""
    background_asked, background_lands = threading.Event(), threading.Event()
    answers = iter([False, True])  # the background read times out; the one asked after it says yes

    def read(_base, _key):
        answer = next(answers)
        if answer is False:
            background_asked.set()
            assert background_lands.wait(10)
        return answer

    monkeypatch.setattr(chatcut, "_read_entitlement", read)
    assert chatcut.known_entitled() is False  # nothing kept: asked in the background
    assert background_asked.wait(10)
    clock.now += 1
    assert chatcut.entitled() is True  # asked later, answered first
    background_lands.set()
    wait_until(lambda: not chatcut._refreshing, what="the background read")

    assert chatcut.entitled() is True and chatcut.known_entitled() is True


def test_a_read_landing_after_a_newer_answer_answers_with_the_newer_one(scheduler, changes, clock, monkeypatch):
    """The other way round: ``entitled`` asks first and lands last, after a background read asked later found the
    account closed. It answers no, as the kept answer does, not the yes it read."""
    asked, lands = threading.Event(), threading.Event()
    answers = iter([True, False])  # asked first: still open; asked after it: closed

    def read(_base, _key):
        answer = next(answers)
        if answer is True:
            asked.set()
            assert lands.wait(10)
        return answer

    def a_background_read_meanwhile():
        assert asked.wait(10)
        clock.now += 1
        chatcut.known_entitled()  # nothing kept yet: asks in the background
        wait_until(lambda: not chatcut._refreshing, what="the background read")
        lands.set()

    monkeypatch.setattr(chatcut, "_read_entitlement", read)
    meanwhile = threading.Thread(target=a_background_read_meanwhile, daemon=True)
    meanwhile.start()

    assert chatcut.entitled() is False
    meanwhile.join(10)
    assert chatcut.known_entitled() is False


# ---------------------------------------------------------------------------
# 2. What follows it
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("enabled", [False, True])
def test_the_section_and_the_file_tools_exist_only_while_it_is_yes(scheduler, changes, enabled):
    scheduler.enabled = enabled
    recorder = _Recorder()
    chatcut_files.register(recorder)

    assert bool(chatcut.render_section({"platform": "cli"})) is enabled
    for name in (chatcut_files.UPLOAD_TOOL, chatcut_files.SAVE_TOOL):
        assert recorder.tools[name]["check_fn"]() is enabled


def _ours_and_others() -> dict:
    return {chatcut.SERVER_NAME: {"url": f"https://api.apex-nodes.com{chatcut.PROXY_PATH}"},
            "notion": {"url": "https://mcp.notion.example/mcp"}}


def test_the_mcp_server_is_left_out_while_the_account_is_closed(scheduler, changes):
    load = chatcut.hide_unless_entitled(_ours_and_others)

    assert set(load()) == {"notion"}  # nothing known yet: no
    # ...and asked in the background. Wait until that read has kept its no, not just until the Scheduler saw it:
    # the no is kept after the answer arrives, and kept after the yes below it would replace it.
    wait_until(lambda: len(scheduler.checks) == 1 and not chatcut._refreshing, what="the background read")
    scheduler.enabled = True
    chatcut._answers.clear()
    chatcut._store(chatcut._account()[2], True, time.monotonic())
    assert set(load()) == {chatcut.SERVER_NAME, "notion"}


def test_a_developers_own_chatcut_server_is_never_hidden(scheduler, changes):
    theirs = {chatcut.SERVER_NAME: {"url": "http://localhost:9000/mcp"}}
    load = chatcut.hide_unless_entitled(lambda: dict(theirs))

    assert load() == theirs


def test_registered_mcp_tools_go_quiet_as_soon_as_the_account_closes(scheduler, changes):
    chatcut.reconcile_at_boot()  # our entry in config.yaml
    make = chatcut.gate_mcp_tools(lambda name: (lambda: True))
    slot = chatcut._account()[2]
    chatcut._store(slot, True, time.monotonic())
    ours, other = make(chatcut.SERVER_NAME), make("notion")

    assert ours() is True and other() is True
    chatcut._store(slot, False, time.monotonic())
    assert ours() is False and other() is True


def test_a_developers_own_chatcut_tools_are_not_gated(scheduler, changes):
    (scheduler.home / "config.yaml").write_text(yaml.safe_dump(
        {"mcp_servers": {chatcut.SERVER_NAME: {"url": "http://localhost:9000/mcp"}}}), encoding="utf-8")
    make = chatcut.gate_mcp_tools(lambda name: (lambda: True))

    assert make(chatcut.SERVER_NAME)() is True


# ---------------------------------------------------------------------------
# 3. The MCP paths never wait
# ---------------------------------------------------------------------------


def test_the_mcp_paths_never_wait_for_the_scheduler(scheduler, changes):
    scheduler.enabled = True
    scheduler.hold.clear()  # the Scheduler is slow to answer
    started = time.monotonic()

    assert chatcut.known_entitled() is False
    assert chatcut.known_entitled() is False
    assert time.monotonic() - started < 1.0
    scheduler.hold.set()
    wait_until(lambda: chatcut.known_entitled() is True, what="the background answer")
    assert len(scheduler.checks) == 1  # one background read, not one per call


# ---------------------------------------------------------------------------
# 4. A change while running
# ---------------------------------------------------------------------------


def test_only_a_change_is_followed(scheduler, changes, clock, inline):
    scheduler.enabled = True
    chatcut.entitled()  # nothing known -> yes: a change
    clock.now += chatcut.ENTITLEMENT_TTL_SECONDS + 1
    chatcut.entitled()  # yes -> yes
    scheduler.enabled = False
    clock.now += chatcut.ENTITLEMENT_TTL_SECONDS + 1
    chatcut.entitled()  # yes -> no: a change

    assert changes == ["changed", "changed"]


def test_a_change_rechecks_the_tool_lists_and_reconciles_the_mcp_servers(scheduler, monkeypatch):
    import tools.mcp_tool_discovery as discovery
    from tools import registry

    seen: list[str] = []
    monkeypatch.setattr(registry, "invalidate_check_fn_cache", lambda: seen.append("tools"))
    monkeypatch.setattr(discovery, "reconcile_mcp_servers_with_config",
                        lambda: seen.append("mcp") or {"removed": [], "added": [], "pending": []})
    chatcut._follow_change()

    assert seen == ["tools", "mcp"]


def test_the_real_engine_connects_only_while_the_account_is_open(scheduler, changes, clock):
    """No connection attempt (which the proxy would refuse and the engine would park) while closed; opened, the
    next reconcile connects and the tools appear; closed again, they go quiet and the connection is dropped."""
    from tools import mcp_tool_lifecycle
    from tools.connectors.mcp import _registered_tool_names
    from tools.mcp_tool_discovery import discover_mcp_tools, reconcile_mcp_servers_with_config
    from tools.registry import registry

    try:
        assert chatcut.apply(_Recorder()) is True
        chatcut.entitled()  # closed: known as no
        discover_mcp_tools()
        assert scheduler.mcp == [] and _registered_tool_names(chatcut.SERVER_NAME) == []

        scheduler.enabled = True
        clock.now += chatcut.ENTITLEMENT_TTL_SECONDS + 1
        assert chatcut.entitled() is True
        reconcile_mcp_servers_with_config()
        names = _registered_tool_names(chatcut.SERVER_NAME)
        assert {name.rsplit("__", 1)[-1] for name in names} == set(chatcut.INCLUDED_TOOLS)
        entry = registry.get_entry(names[0])
        assert entry is not None and entry.check_fn() is True

        scheduler.enabled = False
        clock.now += chatcut.ENTITLEMENT_TTL_SECONDS + 1
        assert chatcut.entitled() is False
        assert entry.check_fn() is False
        reconcile_mcp_servers_with_config()
        assert _registered_tool_names(chatcut.SERVER_NAME) == []
    finally:
        mcp_tool_lifecycle.shutdown_mcp_servers()
