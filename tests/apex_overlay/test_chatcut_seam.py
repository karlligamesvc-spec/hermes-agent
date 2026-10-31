"""hc-1122 ChatCut seam. Everything runs against tests/apex_overlay/chatcut_fake_service.py, never the real service.

Pinned here:
1. With the switch off the seam registers nothing and changes nothing, and it clears what an earlier launch left.
2. Connecting asks on the card, signs in through the browser under APEX's own name, and admits only the allowlist.
3. A browser step that runs out never leaves a dead page looking alive.
4. Disconnecting removes the tokens as well as the config entry.
5. A local file leaves only after the user agreed, only through the loopback server, and only if it is media.
"""

from __future__ import annotations

import asyncio
import json
import stat
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

import pytest

import hermes_yaml as yaml
from apex_overlay import chatcut, chatcut_account, chatcut_import
from tests.apex_overlay.chatcut_fake_service import EDITOR_URL, PAID_TOOLS, FakeService


class _Agent:
    """What the inline tools read off the agent: the card callback and the toolset selection."""

    def __init__(self, answer=None, *, card=True):
        self.asked: list[list[dict]] = []
        self.answer = answer
        self.enabled_toolsets = ["terminal"]
        if card:
            self.clarify_callback = self._clarify

    def _clarify(self, questions):
        self.asked.append(questions)
        if self.answer is None:
            return {"answers": {}, "outcome": "timeout"}
        return {"answers": {questions[0]["qid"]: self.answer}, "outcome": "submitted"}


class _Recorder:
    """A plugin context that remembers every registration."""

    def __init__(self):
        self.calls: list[str] = []

    def register_tool(self, **kwargs):
        self.calls.append(f"tool:{kwargs['name']}")

    def register_system_prompt_section(self, section_id, render, **_kwargs):
        self.calls.append(f"section:{section_id}")


@pytest.fixture
def home(tmp_path, monkeypatch):
    path = tmp_path / "apexnodes"
    path.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(path))
    monkeypatch.delenv(chatcut.SWITCH_ENV, raising=False)
    monkeypatch.delenv(chatcut.TEST_URL_ENV, raising=False)
    return path


@pytest.fixture
def service(home, monkeypatch):
    fake = FakeService().start()
    monkeypatch.setenv(chatcut.SWITCH_ENV, "1")
    monkeypatch.setenv(chatcut.TEST_URL_ENV, fake.mcp_url)
    yield fake
    from tools import mcp_tool_lifecycle

    mcp_tool_lifecycle.shutdown_mcp_servers()
    for key in list(chatcut_account._attempts):
        chatcut_account._end_attempt(key)
    fake.stop()


@pytest.fixture
def browser(monkeypatch):
    """The user's browser. By default they approve straight away; ``hold`` keeps them away from the page."""

    class _Browser:
        opened: list[str] = []
        pages: list[bytes] = []
        hold = False

        def open(self, url):
            self.opened.append(url)
            # Only the fake service's sign-in page is ever followed; nothing here touches a network.
            if not self.hold and urlparse(url).hostname == "127.0.0.1":
                self.approve(url)
            return True

        def approve(self, url):
            with urllib.request.urlopen(url, timeout=10) as response:
                self.pages.append(response.read())

    fake = _Browser()
    fake.opened, fake.pages = [], []
    monkeypatch.setattr(chatcut_account.webbrowser, "open", fake.open)
    monkeypatch.setattr(chatcut_import.webbrowser, "open", fake.open)
    return fake


def _config(home: Path) -> dict:
    path = home / "config.yaml"
    return yaml.safe_load(path.read_text(encoding="utf-8")) if path.is_file() else {}


def _write_block(home: Path, url: str = chatcut.MCP_URL) -> None:
    config = _config(home)
    config.setdefault("mcp_servers", {})["chatcut"] = {"url": url, "auth": "oauth"}
    (home / "config.yaml").write_text(yaml.safe_dump(config), encoding="utf-8")


def _write_tokens(home: Path) -> None:
    tokens = home / "mcp-tokens"
    tokens.mkdir(exist_ok=True)
    (tokens / "chatcut.json").write_text(json.dumps({"access_token": "a", "token_type": "Bearer"}), encoding="utf-8")
    (tokens / "chatcut.client.json").write_text(json.dumps({"client_id": "c"}), encoding="utf-8")


def _connect(answer=None, agent=None):
    agent = agent or _Agent(answer)
    return agent, json.loads(chatcut.connect(agent, {}, None))


def _connected(browser):
    agent, result = _connect(chatcut.copy("connect_yes"))
    assert result["status"] == "connected", result
    return agent


# ---------------------------------------------------------------------------
# Off: nothing registered, nothing written
# ---------------------------------------------------------------------------


def test_off_registers_nothing_and_writes_nothing(home):
    (home / "config.yaml").write_text("model: {default: x}\n", encoding="utf-8")
    before = (home / "config.yaml").stat()
    ctx = _Recorder()

    assert chatcut.apply(ctx) is True

    assert ctx.calls == []
    after = (home / "config.yaml").stat()
    assert (before.st_mtime_ns, before.st_size) == (after.st_mtime_ns, after.st_size)
    assert not (home / "mcp-tokens").exists()
    assert chatcut.render_section({"platform": "desktop"}) == ""


def test_off_patches_nothing(home):
    from agent.inline_tool_executors import INLINE_TOOL_EXECUTORS
    from hermes_cli import mcp_config

    chatcut.apply(_Recorder())

    assert chatcut.CONNECT_TOOL not in INLINE_TOOL_EXECUTORS
    assert chatcut.IMPORT_TOOL not in INLINE_TOOL_EXECUTORS
    assert not getattr(mcp_config._remove_mcp_server, "_apex_chatcut", False)


def test_off_clears_a_connection_left_from_before(home):
    _write_block(home)
    _write_tokens(home)
    consent = home.joinpath(*chatcut.CONSENT_RELATIVE_PATH)
    consent.parent.mkdir(parents=True)
    consent.write_text("{}", encoding="utf-8")

    chatcut.apply(_Recorder())

    assert "chatcut" not in (_config(home).get("mcp_servers") or {})
    assert not (home / "mcp-tokens" / "chatcut.json").exists()
    assert not (home / "mcp-tokens" / "chatcut.client.json").exists()
    assert not consent.exists()


def test_off_leaves_a_developers_own_server_of_that_name(home):
    _write_block(home, url="https://example.invalid/mcp")
    _write_tokens(home)

    chatcut.apply(_Recorder())

    assert _config(home)["mcp_servers"]["chatcut"]["url"] == "https://example.invalid/mcp"


def test_off_leaves_other_servers_alone(home):
    (home / "config.yaml").write_text(
        yaml.safe_dump({"mcp_servers": {"chatcut": {"url": chatcut.MCP_URL}, "other": {"url": "https://o.invalid"}}}),
        encoding="utf-8")

    chatcut.apply(_Recorder())

    assert list(_config(home)["mcp_servers"]) == ["other"]


@pytest.mark.parametrize("value", ["", "0", "true", "yes", " "])
def test_only_a_literal_one_is_on(home, monkeypatch, value):
    monkeypatch.setenv(chatcut.SWITCH_ENV, value)
    assert chatcut.switch_on() is False


@pytest.mark.parametrize(
    ("override", "expected"),
    [
        ("http://127.0.0.1:9/mcp", "http://127.0.0.1:9/mcp"),
        ("http://localhost:9/mcp", "http://localhost:9/mcp"),
        ("https://attacker.invalid/mcp", chatcut.MCP_URL),
        ("", chatcut.MCP_URL),
    ],
)
def test_the_test_override_only_ever_points_at_loopback(home, monkeypatch, override, expected):
    monkeypatch.setenv(chatcut.TEST_URL_ENV, override)
    assert chatcut.mcp_url() == expected


# ---------------------------------------------------------------------------
# On: the config, the section, the boot rule
# ---------------------------------------------------------------------------


def test_the_config_names_apex_and_never_another_host(home, monkeypatch):
    monkeypatch.setenv(chatcut.SWITCH_ENV, "1")
    config = chatcut.server_config()

    assert config["oauth"]["client_name"] == "APEX Desktop"
    assert config["auth"] == "oauth"
    assert config["headers"] == {"x-chatcut-mcp-client": "apex_desktop", "x-chatcut-mcp-surface": "apex_desktop"}
    blob = json.dumps(config).lower()
    for other in ("kimi", "claude", "codex", "grok", "cursor", "workbuddy", "embedded-preview", "plugin-version"):
        assert other not in blob


def test_the_allowlist_keeps_generation_and_raw_import_out(home):
    allowed = set(chatcut.INCLUDED_TOOLS)

    assert not allowed & {"import_media", "submit_video", "submit_image", "submit_music", "submit_sound",
                          "submit_voice", "submit_shader", "submit_avatar_video", "submit_lipsync",
                          "video_translation", "isolate_voice", "manage_custom_voice", "show_preview",
                          "report_user_friction", "call_connector_tool", "delete_project"}
    assert {"read_script", "apply_script", "edit_captions", "submit_export", "track_export"} <= allowed


@pytest.mark.parametrize("platform", sorted(chatcut.NON_INTERACTIVE_PLATFORMS))
def test_no_section_where_nobody_is_there_to_answer_a_card(home, monkeypatch, platform):
    monkeypatch.setenv(chatcut.SWITCH_ENV, "1")
    assert chatcut.render_section({"platform": platform}) == ""


def test_section_says_how_to_connect_until_connected(home, monkeypatch):
    monkeypatch.setenv(chatcut.SWITCH_ENV, "1")
    section = chatcut.render_section({"platform": "desktop"})

    assert "chatcut_connect" in section
    assert "chatcut_import_files" in section
    assert len(section) <= chatcut.MAX_SECTION_CHARS

    _write_block(home)
    _write_tokens(home)
    assert "还没连接" not in chatcut.render_section({"platform": "desktop"})


@pytest.mark.parametrize(
    ("block", "tokens", "kept"),
    [(True, False, False), (False, True, False), (True, True, True), (False, False, False)],
)
def test_on_at_boot_the_two_halves_stay_together(home, monkeypatch, block, tokens, kept):
    """A new assistant clones its config from another, tokens not included: that is not a connection."""
    monkeypatch.setenv(chatcut.SWITCH_ENV, "1")
    if block:
        _write_block(home)
    if tokens:
        _write_tokens(home)

    chatcut.reconcile_at_boot()

    assert ("chatcut" in (_config(home).get("mcp_servers") or {})) is kept
    assert (home / "mcp-tokens" / "chatcut.json").exists() is kept


def _real_agent(platform: str = "cli"):
    from run_agent import AIAgent

    return AIAgent(api_key="test-key", base_url="https://openrouter.ai/api/v1", model="test/model",
                   provider="openrouter", platform=platform, quiet_mode=True, skip_context_files=True,
                   skip_memory=True, session_id="s")


def _callable_names(agent) -> set[str]:
    from agent.tool_executor import _tool_search_scoped_names

    return {tool["function"]["name"] for tool in (agent.tools or [])} | set(_tool_search_scoped_names(agent))


@pytest.fixture
def plugin_manager(home, monkeypatch):
    """A real plugin context with only this seam registered; registrations undone after."""
    import model_tools
    from agent.inline_tool_executors import INLINE_TOOL_EXECUTORS
    from hermes_cli import plugins
    from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest
    from tools.registry import registry

    manager = PluginManager()
    manager._discovered = True
    monkeypatch.setattr(plugins, "_plugin_manager", manager)
    context = PluginContext(PluginManifest(name="apex-overlay", key="apex-overlay", source="bundled"), manager)
    yield context
    model_tools._clear_tool_defs_cache()
    registry.deregister(chatcut.CONNECT_TOOL)
    registry.deregister(chatcut.IMPORT_TOOL)
    INLINE_TOOL_EXECUTORS.pop(chatcut.CONNECT_TOOL, None)
    INLINE_TOOL_EXECUTORS.pop(chatcut.IMPORT_TOOL, None)


def test_a_real_agent_reaches_both_tools_with_the_switch_on(home, monkeypatch, plugin_manager):
    import model_tools

    monkeypatch.setenv(chatcut.SWITCH_ENV, "1")
    assert chatcut.apply(plugin_manager) is True
    model_tools._clear_tool_defs_cache()

    names = _callable_names(_real_agent())

    assert {chatcut.CONNECT_TOOL, chatcut.IMPORT_TOOL} <= names


def test_a_real_agent_sees_no_trace_with_the_switch_off(home, plugin_manager):
    import model_tools

    assert chatcut.apply(plugin_manager) is True
    model_tools._clear_tool_defs_cache()

    assert not [name for name in _callable_names(_real_agent()) if "chatcut" in name]


def test_the_inline_table_is_what_runs_them_with_the_switch_on(home, monkeypatch, plugin_manager):
    """Registry dispatch has no card callback: a call that fell through there must refuse, not act."""
    from agent.inline_tool_executors import INLINE_TOOL_EXECUTORS
    from tools.registry import registry

    monkeypatch.setenv(chatcut.SWITCH_ENV, "1")
    chatcut.apply(plugin_manager)

    assert INLINE_TOOL_EXECUTORS[chatcut.CONNECT_TOOL] is chatcut.connect
    assert INLINE_TOOL_EXECUTORS[chatcut.IMPORT_TOOL] is chatcut_import.import_files
    assert "error" in json.loads(registry.dispatch(chatcut.CONNECT_TOOL, {}))


@pytest.fixture
def clip(tmp_path):
    path = tmp_path / "口播 take1.mp4"
    path.write_bytes(b"fake-video-bytes" * 4096)
    return path


def _import(agent, *paths):
    args = {"project_id": "p-1", "timeline_id": "t-1", "paths": [str(path) for path in paths]}
    return json.loads(chatcut_import.import_files(agent, args, None))


# ---------------------------------------------------------------------------
# Connecting
# ---------------------------------------------------------------------------


def test_declining_touches_nothing(service, browser, home):
    _, result = _connect(chatcut.copy("connect_no"))

    assert result["status"] == "declined"
    assert browser.opened == []
    assert service.clients == {}
    assert not (home / "config.yaml").exists() or "chatcut" not in (_config(home).get("mcp_servers") or {})


def test_no_answer_is_not_a_yes(service, browser):
    _, result = _connect(None)

    assert result["status"] == "declined"
    assert browser.opened == []


def test_without_a_card_it_refuses_and_opens_nothing(service, browser):
    _, result = _connect(agent=_Agent(card=False))

    assert "error" in result
    assert browser.opened == []
    assert service.clients == {}


def test_each_card_gets_its_own_clarify_row_that_opens_and_closes(service, browser, clip):
    """Found in the UI walk: without this the upload card landed on the connect card's row, already answered."""
    events: list[tuple] = []
    agent = _Agent(chatcut.copy("connect_yes"))
    agent.tool_start_callback = lambda row, name, args: events.append(("start", row, name))
    agent.tool_complete_callback = lambda row, name, args, result: events.append(("done", row, name))

    assert json.loads(chatcut.connect(agent, {}, None))["status"] == "connected"
    agent.answer = chatcut.copy("upload_yes")
    assert _import(agent, clip)["status"] == "imported"

    assert [event[0] for event in events] == ["start", "done", "start", "done"]
    assert {event[2] for event in events} == {"clarify"}
    assert events[0][1] == events[1][1] != events[2][1] == events[3][1]


def test_a_different_account_source_changes_nothing_above_the_seam(service, browser, home, clip):
    """An issued credential instead of the user's OAuth: no card, no browser, no registration, and everything else
    (the allowlist, who we say we are, the upload card, disconnecting) exactly as it was. Per user, never shared."""
    from hermes_cli import mcp_config
    from hermes_cli.config import get_env_value, save_env_value
    from tools.registry import registry

    env_name = "APEX_CHATCUT_ISSUED_TOKEN"

    class IssuedForThisUser:
        upload_question_key = "upload_question"
        forgot = 0

        def server_entry(self):
            return {"headers": {"Authorization": f"Bearer ${{{env_name}}}"}}

        def has_credential(self):
            return bool(get_env_value(env_name))

        def connect(self, agent):
            token = "issued-for-this-apex-user"
            service.tokens.add(token)
            save_env_value(env_name, token)
            mcp_config._save_mcp_server(chatcut.SERVER_NAME, chatcut.server_config())
            return {"status": "connected"}

        def forget(self):
            type(self).forgot += 1
            save_env_value(env_name, "")

    chatcut._install_disconnect(mcp_config)
    previous = chatcut_account.use_account(IssuedForThisUser())
    try:
        agent, result = _connect(None)

        assert result["status"] == "connected"
        assert agent.asked == [], "this source has nothing to ask"
        assert browser.opened == []
        assert service.clients == {}, "no dynamic registration"
        assert {h["x-chatcut-mcp-client"] for h in service.mcp_headers} == {"apex_desktop"}
        names = {name.rsplit("__", 1)[-1] for name in registry.get_tool_names_for_toolset("mcp-chatcut")}
        assert names == {"read_script", "apply_script", "submit_export", "get_editor_url"}
        assert chatcut.is_connected()

        # The upload consent does not depend on how the user was signed in.
        declined = _Agent(chatcut.copy("upload_no"))
        assert _import(declined, clip)["status"] == "declined"
        assert len(declined.asked) == 1
        assert service.fetched == {}
        assert _import(_Agent(chatcut.copy("upload_yes")), clip)["status"] == "imported"

        assert mcp_config._remove_mcp_server(chatcut.SERVER_NAME) is True
        assert IssuedForThisUser.forgot == 1
        assert not chatcut.is_connected()
        assert not chatcut.has_upload_consent()
    finally:
        chatcut_account.use_account(previous)


def test_connect_signs_in_under_apexs_name_and_admits_only_the_allowlist(service, browser, home):
    from tools.registry import registry

    agent, result = _connect(chatcut.copy("connect_yes"))

    assert result["status"] == "connected"
    assert len(browser.opened) == 1
    # Dynamic registration, as a public client, under our own name.
    [client] = service.clients.values()
    assert client["client_name"] == "APEX Desktop"
    assert client["token_endpoint_auth_method"] == "none"
    # What the service sees on every MCP request.
    assert service.mcp_headers
    assert {h["x-chatcut-mcp-client"] for h in service.mcp_headers} == {"apex_desktop"}
    # The page the browser lands on says APEX.
    assert b"APEX" in browser.pages[0]
    assert b"Hermes" not in browser.pages[0]
    # Only what the allowlist admits became a tool, callable in this very turn.
    names = registry.get_tool_names_for_toolset("mcp-chatcut")
    assert names
    short = {name.rsplit("__", 1)[-1] for name in names}
    assert short == {"read_script", "apply_script", "submit_export", "get_editor_url"}
    assert not short & set(PAID_TOOLS)
    assert "import_media" not in short
    assert "chatcut" in agent.enabled_toolsets
    # The entry landed in this assistant's config; tokens beside it, private.
    block = _config(home)["mcp_servers"]["chatcut"]
    assert block["url"] == service.mcp_url
    assert block["tools"]["include"] == list(chatcut.INCLUDED_TOOLS)
    token_file = home / "mcp-tokens" / "chatcut.json"
    assert stat.S_IMODE(token_file.stat().st_mode) == 0o600
    assert chatcut.is_connected()


def test_connecting_again_asks_nothing(service, browser):
    _connected(browser)
    agent, result = _connect(None)

    assert result["status"] == "connected"
    assert agent.asked == []
    assert len(browser.opened) == 1


def test_a_slow_browser_step_keeps_one_flow_and_finishes_later(service, browser, monkeypatch):
    monkeypatch.setattr(chatcut_account, "WAIT_SECONDS", 0.2)
    browser.hold = True

    agent, first = _connect(chatcut.copy("connect_yes"))
    assert first["status"] == "waiting"
    assert len(agent.asked) == 1
    assert len(browser.opened) == 1

    again, second = _connect(None)
    assert second["status"] == "waiting"
    assert again.asked == [], "a flow already in flight does not ask again"
    assert len(browser.opened) == 1, "and does not open a second page"

    browser.approve(browser.opened[0])
    monkeypatch.setattr(chatcut_account, "WAIT_SECONDS", 15)
    _, third = _connect(None)
    assert third["status"] == "connected"


def test_a_flow_past_its_time_is_called_expired_not_waiting(service, browser, monkeypatch):
    monkeypatch.setattr(chatcut_account, "WAIT_SECONDS", 0.2)
    monkeypatch.setattr(chatcut_account, "AUTHORIZE_SECONDS", 0.2)
    browser.hold = True

    _, result = _connect(chatcut.copy("connect_yes"))

    assert result["status"] == "expired"
    assert chatcut_account._attempts == {}


def test_a_reminted_page_is_expired_not_waiting(service, browser, monkeypatch):
    """After its wait runs out the SDK retries with a new state, so the page the user holds is dead."""
    from tui_gateway import mcp_oauth_sessions

    browser.hold = True
    real_poll = mcp_oauth_sessions.poll_flow

    def reminted(session_id, name):
        state = real_poll(session_id, name)
        state["auth_url"] = "http://127.0.0.1:1/authorize?state=new"
        return state

    monkeypatch.setattr(mcp_oauth_sessions, "poll_flow", reminted)
    _, result = _connect(chatcut.copy("connect_yes"))

    assert result["status"] == "expired"


def test_the_callback_waiter_honours_oauth_timeout(home):
    """A first sign-in can take longer than the engine's default 300 s; the seam asks for more through config."""
    from tools.mcp_dashboard_oauth import DashboardOAuthFlow, dashboard_oauth_flow
    from tools.mcp_oauth import _make_callback_waiter

    flow = DashboardOAuthFlow(flow_id="f", server_name="s", profile=None, hermes_home=str(home), redirect_uri="")
    seen: list[float] = []

    async def wait(timeout=300.0):
        seen.append(timeout)
        return ("code", "state", None)

    flow.wait_for_callback = wait  # type: ignore[method-assign]
    with dashboard_oauth_flow(flow):
        asyncio.run(_make_callback_waiter(0, timeout=900.0)())

    assert seen == [900.0]


# ---------------------------------------------------------------------------
# Disconnecting
# ---------------------------------------------------------------------------


def test_disconnect_removes_the_tokens_the_entry_and_the_consent(service, browser, home):
    from hermes_cli import mcp_config

    chatcut._install_disconnect(mcp_config)
    _connected(browser)
    chatcut.record_upload_consent()

    assert mcp_config._remove_mcp_server("chatcut") is True

    assert "chatcut" not in (_config(home).get("mcp_servers") or {})
    assert not chatcut.is_connected()
    assert not chatcut.has_upload_consent()
    leftovers = [p.name for p in (home / "mcp-tokens").glob("chatcut*")] if (home / "mcp-tokens").exists() else []
    assert leftovers == []


def test_disconnect_stops_the_live_connection(service, browser):
    from hermes_cli import mcp_config
    from tools import mcp_tool as core
    from tools.mcp_tool_scope import _resolve_server_key

    chatcut._install_disconnect(mcp_config)
    _connected(browser)
    key = _resolve_server_key("chatcut")
    assert key in core._servers

    mcp_config._remove_mcp_server("chatcut")

    assert key not in core._servers


def test_removing_another_server_keeps_its_tokens(service, browser, home):
    from hermes_cli import mcp_config

    chatcut._install_disconnect(mcp_config)
    config = _config(home)
    config.setdefault("mcp_servers", {})["other"] = {"url": "https://other.invalid/mcp"}
    (home / "config.yaml").write_text(yaml.safe_dump(config), encoding="utf-8")
    _connected(browser)

    assert mcp_config._remove_mcp_server("other") is True

    assert chatcut.is_connected()


# ---------------------------------------------------------------------------
# Importing
# ---------------------------------------------------------------------------


def test_import_before_connecting_is_refused(service, browser, clip):
    result = _import(_Agent(chatcut.copy("upload_yes")), clip)

    assert "chatcut_connect" in result["error"]
    assert service.calls == []


def test_declining_the_upload_sends_nothing(service, browser, clip):
    _connected(browser)
    agent = _Agent(chatcut.copy("upload_no"))

    result = _import(agent, clip)

    assert result["status"] == "declined"
    assert len(agent.asked) == 1
    assert "import_media" not in service.tool_calls
    assert service.fetched == {}
    assert not chatcut.has_upload_consent()


def test_no_answer_to_the_upload_card_sends_nothing(service, browser, clip):
    _connected(browser)

    result = _import(_Agent(None), clip)

    assert result["status"] == "declined"
    assert service.fetched == {}


def test_without_a_card_a_first_upload_is_refused(service, browser, clip):
    _connected(browser)

    result = _import(_Agent(card=False), clip)

    assert "error" in result
    assert service.fetched == {}


def test_the_card_says_where_it_goes_and_whose_credits(service, browser, clip):
    _connected(browser)
    agent = _Agent(chatcut.copy("upload_no"))

    _import(agent, clip)

    question = agent.asked[0][0]["question"]
    assert clip.name in question
    assert "ChatCut" in question
    assert "美国" in question or "United States" in question
    assert "你自己的" in question or "your own" in question


def test_agreeing_uploads_through_loopback_and_is_not_asked_twice(service, browser, clip):
    _connected(browser)
    agent = _Agent(chatcut.copy("upload_yes"))

    first = _import(agent, clip)

    assert first["status"] == "imported"
    assert first["assets"][0]["status"] == "locally_imported"
    assert service.fetched[clip.name] == clip.read_bytes()
    assert chatcut.has_upload_consent()
    _, arguments = next(call for call in service.calls if call[0] == "import_media")
    assert arguments["action"] == "from_editor"
    assert arguments["projectId"] == "p-1"
    assert arguments["timelineId"] == "t-1"
    assert arguments["files"][0]["url"].startswith("http://127.0.0.1:")
    assert arguments["files"][0]["sizeBytes"] == clip.stat().st_size

    second_agent = _Agent(None)
    second = _import(second_agent, clip)

    assert second["status"] == "imported"
    assert second_agent.asked == []
    _, retried = [call for call in service.calls if call[0] == "import_media"][1]
    assert retried["files"][0]["assetId"] == arguments["files"][0]["assetId"], "a retry keeps its asset id"


@pytest.mark.parametrize("name", ["config.yaml", "secrets.env", "notes.txt", "id_rsa", "dump.sql"])
def test_only_media_can_be_imported(service, browser, tmp_path, name):
    _connected(browser)
    chatcut.record_upload_consent()
    path = tmp_path / name
    path.write_text("api_key: secret", encoding="utf-8")

    result = _import(_Agent(None), path)

    assert result["status"] == "partial"
    assert result["failed"][0]["file"] == str(path)
    assert "import_media" not in service.tool_calls


def test_a_good_file_still_goes_when_another_is_refused(service, browser, tmp_path, clip):
    _connected(browser)
    chatcut.record_upload_consent()

    result = _import(_Agent(None), clip, tmp_path / "missing.mp4")

    assert result["status"] == "partial"
    assert [asset["file"] for asset in result["assets"]] == [clip.name]
    assert result["failed"][0]["file"].endswith("missing.mp4")


def test_relative_paths_are_refused(service, browser):
    _connected(browser)
    chatcut.record_upload_consent()

    result = _import(_Agent(None), "relative/clip.mp4")

    assert result["status"] == "partial"
    assert "import_media" not in service.tool_calls


def test_no_browser_opens_the_editor_once_and_retries(service, browser, clip, monkeypatch):
    _connected(browser)
    chatcut.record_upload_consent()
    monkeypatch.setattr(chatcut_import, "EDITOR_CONNECT_SECONDS", 0.1)
    service.browser_connected = False
    opened_before = len(browser.opened)

    def connect_on_open(url):
        browser.opened.append(url)
        service.browser_connected = True
        return True

    monkeypatch.setattr(chatcut_import.webbrowser, "open", connect_on_open)

    result = _import(_Agent(None), clip)

    assert result["status"] == "imported"
    assert service.import_attempts == 2
    assert len(browser.opened) == opened_before + 1
    assert "editor-boot-token" not in browser.opened[-1]
    assert result["editor_url"] == browser.opened[-1]


def test_the_editor_opens_in_the_panel_where_there_is_one(service, browser, clip, monkeypatch):
    """Desktop has a panel beside the chat: the system browser is only for where it does not."""
    from tools import open_preview_tool as preview

    opened: list[str] = []

    def panel(url, label=""):
        opened.append(url)
        service.browser_connected = True
        return json.dumps({"success": True, "url": url, "label": label})

    _connected(browser)
    chatcut.record_upload_consent()
    monkeypatch.setattr(chatcut_import, "EDITOR_CONNECT_SECONDS", 0.1)
    monkeypatch.setattr(preview, "open_preview_tool", panel)
    service.browser_connected = False
    in_browser = len(browser.opened)

    result = _import(_Agent(None), clip)

    assert result["status"] == "imported"
    assert len(opened) == 1
    assert "editor-boot-token" not in opened[0]
    assert len(browser.opened) == in_browser, "the panel answered, so the system browser stays out of it"


def test_no_panel_falls_back_to_the_browser(service, browser, clip, monkeypatch):
    from tools import open_preview_tool as preview

    _connected(browser)
    chatcut.record_upload_consent()
    monkeypatch.setattr(chatcut_import, "EDITOR_CONNECT_SECONDS", 0.1)
    monkeypatch.setattr(preview, "open_preview_tool", lambda url, label="": json.dumps({"error": "desktop only"}))
    service.browser_connected = False
    in_browser = len(browser.opened)

    _import(_Agent(None), clip)

    assert len(browser.opened) == in_browser + 1


def test_still_no_browser_says_so_and_hands_a_clean_link(service, browser, clip, monkeypatch):
    _connected(browser)
    chatcut.record_upload_consent()
    monkeypatch.setattr(chatcut_import, "EDITOR_CONNECT_SECONDS", 0.1)
    service.browser_connected = False

    result = _import(_Agent(None), clip)

    assert result["status"] == "needs_editor"
    assert service.import_attempts == 2, "one retry, not a loop"
    assert result["editor_url"].startswith("https://editor.invalid/editor/p-1")
    for private in ("editor-boot-token", "SECRET", "theme="):
        assert private not in result["editor_url"]
    assert service.fetched == {}


def test_a_boot_token_never_reaches_a_link_for_a_person():
    cleaned = chatcut_import.clean_editor_url(EDITOR_URL)

    assert "editor-boot-token" not in cleaned
    assert "SECRET" not in cleaned
    assert "chatcutLaunchClient=unknown" in cleaned


# ---------------------------------------------------------------------------
# The loopback server
# ---------------------------------------------------------------------------


@pytest.fixture
def served(clip):
    import threading

    files, refused = chatcut_import._resolve_files([str(clip)], "p-1")
    assert refused == []
    server = chatcut_import._MediaServer(files, chatcut_import.EDITOR_ORIGIN)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server, files[0]
    server.shutdown()
    server.server_close()
    thread.join(5)


def _get(url, **headers):
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, dict(response.headers), response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers), exc.read()


def test_it_binds_loopback_only(served):
    server, _ = served
    assert server.server_address[0] == "127.0.0.1"


def test_it_serves_the_listed_file_to_the_editor(served, clip):
    server, file = served

    status, headers, body = _get(f"{server.base}{file.route}", Origin=chatcut_import.EDITOR_ORIGIN)

    assert status == 200
    assert body == clip.read_bytes()
    assert headers["Access-Control-Allow-Origin"] == chatcut_import.EDITOR_ORIGIN
    assert headers["Access-Control-Allow-Private-Network"] == "true"


def test_another_site_gets_nothing(served):
    server, file = served

    status, _, body = _get(f"{server.base}{file.route}", Origin="https://evil.invalid")

    assert status == 403
    assert body == b""


def test_a_preflight_from_another_site_is_refused(served):
    server, file = served
    request = urllib.request.Request(f"{server.base}{file.route}", method="OPTIONS",
                                     headers={"Origin": "https://evil.invalid"})
    with pytest.raises(urllib.error.HTTPError) as caught:
        urllib.request.urlopen(request, timeout=5)
    assert caught.value.code == 403


@pytest.mark.parametrize("path", ["/", "/chatcut-local-media-v1/", "/chatcut-local-media-v1/other.mp4", "/etc/passwd"])
def test_nothing_else_is_served(served, path):
    server, _ = served
    assert _get(f"{server.base}{path}")[0] == 404


def test_the_path_cannot_be_guessed(clip):
    first, _ = chatcut_import._resolve_files([str(clip)], "p-1")
    second, _ = chatcut_import._resolve_files([str(clip)], "p-1")

    assert first[0].route != second[0].route
    assert first[0].asset_id == second[0].asset_id


@pytest.mark.parametrize(
    ("header", "status", "start", "end"),
    [("bytes=0-", 206, 0, None), ("bytes=10-19", 206, 10, 19), ("bytes=100-", 206, 100, None)],
)
def test_ranges(served, clip, header, status, start, end):
    server, file = served
    data = clip.read_bytes()

    got, headers, body = _get(f"{server.base}{file.route}", Range=header)

    assert got == status
    last = len(data) - 1 if end is None else end
    assert body == data[start:last + 1]
    assert headers["Content-Range"] == f"bytes {start}-{last}/{len(data)}"


@pytest.mark.parametrize("header", ["bytes=999999999-", "pages=1-2", "bytes=-5"])
def test_a_range_it_cannot_serve(served, header):
    server, file = served
    assert _get(f"{server.base}{file.route}", Range=header)[0] == 416


def test_it_stops_when_the_call_ends(service, browser, clip, monkeypatch):
    _connected(browser)
    chatcut.record_upload_consent()
    _import(_Agent(None), clip)

    _, arguments = next(call for call in service.calls if call[0] == "import_media")
    with pytest.raises(urllib.error.URLError):
        urllib.request.urlopen(arguments["files"][0]["url"], timeout=2)


# ---------------------------------------------------------------------------
# Language
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(("language", "word"), [("zh", "连接"), ("zh-hant", "连接"), ("en", "Connect")])
def test_cards_follow_the_language(home, monkeypatch, language, word):
    monkeypatch.setattr("agent.i18n.get_language", lambda: language)
    assert word in chatcut.copy("connect_question")
