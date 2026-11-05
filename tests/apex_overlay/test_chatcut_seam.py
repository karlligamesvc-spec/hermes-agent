"""hc-1122 ChatCut seam: the engine reaches ChatCut only through the Scheduler's proxy, with its own APEX key.

A local fake proxy stands in for apex-nodes' ``/api/v1/chatcut/mcp``; nothing here touches ChatCut. Pinned:

1. With the switch off the seam adds nothing and changes nothing, and it removes the entry an earlier launch left.
2. With the switch on, the entry exists exactly while an APEX account is signed in, and holds placeholders only:
   the APEX key never lands in config.yaml, and there is no ChatCut credential on this computer at all.
3. A developer's own server named ``chatcut`` is never touched.
4. The real engine connects to the proxy with the APEX key, and only the allowlisted tools become tools.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

import hermes_yaml as yaml
from apex_overlay import chatcut

APEX_KEY = "apex-agent-key-SECRET"


class _Recorder:
    """A plugin context that remembers every registration."""

    def __init__(self):
        self.calls: list[str] = []

    def register_tool(self, **kwargs):
        self.calls.append(f"tool:{kwargs['name']}")

    def register_system_prompt_section(self, section_id, render, **_kwargs):
        self.calls.append(f"section:{section_id}")


class FakeProxy:
    """The Scheduler's MCP endpoint: answers the handshake, lists tools (one more than the allowlist admits, to
    show the allowlist holds) and records every request's path and headers."""

    OFFERED = (*chatcut.INCLUDED_TOOLS, "manage_memory")

    def __init__(self):
        self.requests: list[dict] = []
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                fake.requests.append({"path": self.path, "headers": dict(self.headers), "body": body})
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
                                         "inputSchema": {"type": "object", "properties": {"projectId": {"type": "string"}}}}
                                        for name in fake.OFFERED]}
                elif method == "tools/call":
                    result = {"content": [{"type": "text", "text": f"{body['params']['name']} ok"}]}
                else:
                    result = {}
                payload = json.dumps({"jsonrpc": "2.0", "id": body["id"], "result": result}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def do_GET(self):
                self.send_response(405)
                self.send_header("Allow", "POST, DELETE")
                self.end_headers()

            def do_DELETE(self):
                self.send_response(204)
                self.end_headers()

            def log_message(self, format, *args):
                return

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture(autouse=True)
def gate_state(monkeypatch):
    """Each test starts with no kept answer, and the MCP functions ``apply`` wraps come back afterwards."""
    from tools import mcp_tool_config, mcp_tool_registration

    monkeypatch.setattr(chatcut, "_answers", {})
    monkeypatch.setattr(chatcut, "_refreshing", set())
    changes: list[str] = []
    monkeypatch.setattr(chatcut, "_follow_change", lambda: changes.append("changed"))
    monkeypatch.setattr(mcp_tool_config, "_load_mcp_config", mcp_tool_config._load_mcp_config)
    monkeypatch.setattr(mcp_tool_registration, "_make_check_fn", mcp_tool_registration._make_check_fn)
    return changes


@pytest.fixture
def home(tmp_path, monkeypatch):
    path = tmp_path / "apexnodes"
    path.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(path))
    for name in (chatcut.SWITCH_ENV, chatcut.KEY_ENV, chatcut.BASE_ENV):
        monkeypatch.delenv(name, raising=False)
    return path


@pytest.fixture
def signed_in(home, monkeypatch):
    """Signed in to an account the Scheduler has opened ChatCut for (test_chatcut_entitlement.py: one it has not)."""
    monkeypatch.setenv(chatcut.KEY_ENV, APEX_KEY)
    monkeypatch.setenv(chatcut.BASE_ENV, "https://api.apex-nodes.com")
    monkeypatch.setattr(chatcut, "_read_entitlement", lambda base, key: True)


def _switch_on(monkeypatch):
    monkeypatch.setenv(chatcut.SWITCH_ENV, "1")


def _config(home: Path) -> dict:
    path = home / "config.yaml"
    return yaml.safe_load(path.read_text(encoding="utf-8")) if path.is_file() else {}


def _servers(home: Path) -> dict:
    return _config(home).get("mcp_servers") or {}


def _write_servers(home: Path, servers: dict) -> None:
    config = _config(home)
    config["mcp_servers"] = servers
    (home / "config.yaml").write_text(yaml.safe_dump(config), encoding="utf-8")


# ---------------------------------------------------------------------------
# 1. Off: nothing added, nothing written, leftovers taken back
# ---------------------------------------------------------------------------


def test_off_adds_nothing_and_writes_nothing(home, signed_in):
    recorder = _Recorder()

    assert chatcut.apply(recorder) is True

    assert recorder.calls == []
    assert not (home / "config.yaml").exists()
    assert chatcut.render_section({"platform": "cli"}) == ""


def test_off_takes_back_the_entry_an_earlier_launch_wrote(home, signed_in):
    _write_servers(home, {"chatcut": chatcut.server_config(), "other": {"url": "https://other.example/mcp"}})

    chatcut.apply(_Recorder())

    assert _servers(home) == {"other": {"url": "https://other.example/mcp"}}


def test_off_with_ours_the_only_server_leaves_no_empty_block(home):
    _write_servers(home, {"chatcut": chatcut.server_config()})

    chatcut.reconcile_at_boot()

    assert "mcp_servers" not in _config(home)


# ---------------------------------------------------------------------------
# 2. On: the entry follows the APEX sign-in, and holds no secret
# ---------------------------------------------------------------------------


def test_on_and_signed_in_writes_the_proxy_entry_with_placeholders_only(home, signed_in, monkeypatch):
    _switch_on(monkeypatch)
    recorder = _Recorder()

    assert chatcut.apply(recorder) is True

    assert recorder.calls == [f"section:{chatcut.SECTION_ID}", "tool:chatcut_upload_files", "tool:chatcut_save_export"]
    block = _servers(home)["chatcut"]
    assert block["url"] == "${TOOLS_GATEWAY_BASE}/api/v1/chatcut/mcp"
    assert block["headers"] == {"Authorization": "Bearer ${TOOLS_GATEWAY_KEY}"}
    assert block["tools"]["include"] == list(chatcut.INCLUDED_TOOLS)
    assert APEX_KEY not in (home / "config.yaml").read_text(encoding="utf-8")
    assert not (home / "mcp-tokens").exists()


def test_on_but_signed_out_there_is_no_entry_and_no_section(home, monkeypatch):
    _switch_on(monkeypatch)
    _write_servers(home, {"chatcut": chatcut.server_config()})

    chatcut.apply(_Recorder())

    assert "chatcut" not in _servers(home)
    assert chatcut.render_section({"platform": "cli"}) == ""


def test_an_older_entry_is_rewritten_and_a_current_one_left_as_it_is(home, signed_in, monkeypatch):
    _switch_on(monkeypatch)
    old = {**chatcut.server_config(), "tools": {"include": ["read_project", "manage_memory"]}}
    _write_servers(home, {"chatcut": old})

    chatcut.reconcile_at_boot()
    assert _servers(home)["chatcut"] == chatcut.server_config()

    written = (home / "config.yaml").stat().st_mtime_ns
    chatcut.reconcile_at_boot()
    assert (home / "config.yaml").stat().st_mtime_ns == written


def test_the_allowlist_is_editing_only():
    included = set(chatcut.INCLUDED_TOOLS)
    assert not {name for name in included if name.startswith("submit_") and name != "submit_export"}
    assert not included & {"import_media", "get_editor_url", "request_asset_download", "read_billing",
                            "manage_memory", "manage_skill", "manage_user_files", "delete_project", "show_preview"}


# ---------------------------------------------------------------------------
# 3. A developer's own server of that name
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("switch", [True, False])
def test_a_developers_own_chatcut_server_is_never_touched(home, signed_in, monkeypatch, switch):
    if switch:
        _switch_on(monkeypatch)
    mine = {"url": "https://mine.example/mcp", "auth": "oauth"}
    _write_servers(home, {"chatcut": mine})

    chatcut.reconcile_at_boot()

    assert _servers(home) == {"chatcut": mine}


# ---------------------------------------------------------------------------
# The prompt section
# ---------------------------------------------------------------------------


def test_the_section_says_how_to_reach_it_and_what_it_cannot_do(home, signed_in, monkeypatch):
    _switch_on(monkeypatch)

    text = chatcut.render_section({"platform": "cli"})

    assert "skill_view" in text and "name 填 chatcut" in text
    assert "mcp__chatcut__" in text
    assert "chatcut_upload_files" in text and "chatcut_save_export" in text
    assert "不需要 ChatCut 账号" in text
    assert "先经过 APEX 的服务器，再存到 ChatCut 在美国的服务器上，放在 APEX 使用的 ChatCut 账号下" in text
    assert len(text) <= chatcut.MAX_SECTION_CHARS


@pytest.mark.parametrize("platform", sorted(chatcut.NON_INTERACTIVE_PLATFORMS))
def test_no_section_where_nobody_is_there(home, signed_in, monkeypatch, platform):
    _switch_on(monkeypatch)
    assert chatcut.render_section({"platform": platform}) == ""


# ---------------------------------------------------------------------------
# 4. The real engine against the proxy
# ---------------------------------------------------------------------------


@pytest.fixture
def proxy(home, monkeypatch):
    fake = FakeProxy()
    _switch_on(monkeypatch)
    monkeypatch.setenv(chatcut.KEY_ENV, APEX_KEY)
    monkeypatch.setenv(chatcut.BASE_ENV, fake.base)
    yield fake
    from tools import mcp_tool_lifecycle

    mcp_tool_lifecycle.shutdown_mcp_servers()
    fake.stop()


def test_the_engine_reaches_the_proxy_with_the_apex_key_and_admits_only_the_allowlist(proxy, home):
    from tools.connectors.mcp import _registered_tool_names
    from tools.mcp_tool_config import _load_mcp_config
    from tools.mcp_tool_discovery import register_mcp_servers
    from tools.registry import registry

    chatcut.reconcile_at_boot()
    config = _load_mcp_config()[chatcut.SERVER_NAME]
    register_mcp_servers({chatcut.SERVER_NAME: config})
    names = _registered_tool_names(chatcut.SERVER_NAME)

    assert {name.rsplit("__", 1)[-1] for name in names} == set(chatcut.INCLUDED_TOOLS)
    answer = json.loads(registry.dispatch("mcp__chatcut__read_project", {"projectId": "p"}))
    assert "read_project ok" in json.dumps(answer, ensure_ascii=False)
    assert proxy.requests
    assert {request["path"] for request in proxy.requests} == {"/api/v1/chatcut/mcp"}
    assert {request["headers"].get("Authorization") for request in proxy.requests} == {f"Bearer {APEX_KEY}"}
    assert APEX_KEY not in (home / "config.yaml").read_text(encoding="utf-8")


def test_a_real_agent_sees_no_trace_with_the_switch_off(home, signed_in):
    from run_agent import AIAgent

    assert chatcut.apply(_Recorder()) is True
    agent = AIAgent(api_key="test-key", base_url="https://openrouter.ai/api/v1", model="test/model",
                    provider="openrouter", platform="cli", quiet_mode=True, skip_context_files=True,
                    skip_memory=True, session_id="s")

    assert not [tool for tool in (agent.tools or []) if "chatcut" in tool["function"]["name"]]
    assert not (home / "config.yaml").exists()
