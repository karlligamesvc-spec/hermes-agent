"""hc-1207: a folder handed over in Desktop is granted to that one session, and nothing else widens.

Desktop's main process signs the folder with the per-launch key it gives its engines
(``apps/desktop/electron/apex-reference-grants.ts``); ``folder.attach`` checks the signature,
refuses folders too broad to hand over or on the credential deny-list, and records the folder on
the session dict. Only that session's Desktop turns resolve references under it. Typed and
autocompleted references elsewhere, other sessions and IM turns keep the workspace refusal.

The turn tests run the real ``prompt.submit`` → ``_prepare_turn_input`` → ``agent.context_references``
path with a fake agent that records the prompt it is given.
"""

from __future__ import annotations

import asyncio
import inspect
import threading
from pathlib import Path

import pytest

from agent import context_references, model_metadata
from apex_overlay import folder_grants
from tui_gateway import server
from tui_gateway.contracts import registry

KEY = bytes(range(32))
_REAL_THREAD = threading.Thread
OUTSIDE = "path is outside the allowed workspace"
SENSITIVE = "sensitive credential"


class _Agent:
    model = "test/model"
    base_url = ""
    api_key = ""

    def __init__(self):
        self.prompts: list[str] = []

    def run_conversation(self, prompt, conversation_history=None, stream_callback=None, **_kwargs):
        self.prompts.append(prompt)
        return {"final_response": "ok", "messages": [{"role": "assistant", "content": "ok"}]}


class _ImmediateThread:
    def __init__(self, target=None, daemon=None, **_options):
        self._target = target

    def start(self):
        self._target()


class Tree:
    """home/ with work/ (the chat's cwd), Downloads/素材 一批 (handed over), Other/ (never), .ssh/."""

    def __init__(self, root: Path):
        self.home = root / "home"
        self.work = self.home / "work"
        self.folder = self.home / "Downloads" / "素材 一批"
        self.other = self.home / "Other"
        self.ssh = self.home / ".ssh"
        self.hermes_home = self.home / ".apexnodes"
        for directory in (self.work / "sub", self.folder, self.other, self.ssh, self.hermes_home):
            directory.mkdir(parents=True)
        (self.folder / "镜头1.mp4").write_bytes(b"\x00fixture")
        (self.folder / "说明.txt").write_text("FOLDER-NOTE-MARKER\n", encoding="utf-8")
        (self.folder / ".env").write_text("API_KEY=secret\n", encoding="utf-8")
        (self.other / "a.txt").write_text("OTHER-MARKER\n", encoding="utf-8")
        (self.ssh / "id_ed25519").write_text("PRIVATE-KEY\n", encoding="utf-8")
        (self.folder / "link-out").symlink_to(self.other, target_is_directory=True)
        (self.home / "Downloads" / "ssh-link").symlink_to(self.ssh, target_is_directory=True)


@pytest.fixture
def tree(tmp_path, monkeypatch):
    built = Tree(tmp_path.resolve())
    monkeypatch.setenv("HOME", str(built.home))
    monkeypatch.setenv("HERMES_HOME", str(built.hermes_home))
    monkeypatch.setenv(folder_grants.GRANT_KEY_ENV, KEY.hex())
    return built


@pytest.fixture
def seam(monkeypatch):
    """The seam on the real modules; every patched attribute and both global tables are restored."""
    monkeypatch.setattr(context_references, "_resolve_path", context_references._resolve_path)
    monkeypatch.setattr(server, "_prepare_turn_input", server._prepare_turn_input)
    methods, contracts = dict(server._methods), dict(registry.METHODS)
    assert folder_grants._install_resolve(context_references)
    assert folder_grants._install_server(server)
    yield
    server._methods.clear()
    server._methods.update(methods)
    registry.METHODS.clear()
    registry.METHODS.update(contracts)


@pytest.fixture
def desk(seam, tree, monkeypatch):
    """Open Desktop sessions (cwd = tree.work) whose turns run inline with a recording agent."""
    monkeypatch.setattr(server, "_sessions", {})
    monkeypatch.setattr(server.threading, "Thread", _ImmediateThread)
    monkeypatch.setattr(server, "_emit", lambda *args, **kwargs: None)
    monkeypatch.setattr(server, "make_stream_renderer", lambda cols: None)
    monkeypatch.setattr(server, "render_message", lambda raw, cols: None)
    monkeypatch.setattr(model_metadata, "get_model_context_length", lambda *args, **kwargs: 100_000)

    def open_session(sid: str) -> _Agent:
        agent = _Agent()
        server._sessions[sid] = {
            "agent": agent, "session_key": f"key-{sid}", "history": [], "history_lock": threading.Lock(),
            "history_version": 0, "running": False, "attached_images": [], "image_counter": 0, "cols": 80,
            "slash_worker": None, "show_reasoning": False, "tool_progress_mode": "all", "cwd": str(tree.work),
        }
        return agent

    return open_session


def attach(sid: str, path: str, grant: str | None = None) -> dict:
    params = {"session_id": sid, "path": path, "grant": folder_grants.sign(path, KEY) if grant is None else grant}
    return server.handle_request({"id": "1", "method": "folder.attach", "params": params})


def turn(agent: _Agent, sid: str, text: str) -> str:
    response = server.handle_request({"id": "2", "method": "prompt.submit", "params": {"session_id": sid, "text": text}})
    assert "error" not in (response or {}), response
    return agent.prompts[-1]


@pytest.mark.parametrize(("path", "signature"), [
    ("/Users/me/Downloads/素材 一批", "3df70a3b88a4a444918e1aeac32b2e3e3d69c2b8fff4e323899e4d78edbda5be"),
    ("C:\\Users\\me\\Downloads\\素材", "7d2eee05da52b5768a603851e6c8cf07f2343e97f88c917ff63ecc76841cd8ea"),
])
def test_signatures_match_desktop_main(path, signature):
    """The same vectors pin electron/apex-reference-grants.ts signFolderGrant: the two signers are twins."""
    assert folder_grants.sign(path, KEY) == signature


def test_seam_targets_keep_their_shape():
    """The patched symbols still exist with the shapes the wrappers assume."""
    resolve = inspect.signature(context_references._resolve_path)
    assert list(resolve.parameters) == ["cwd", "target", "allowed_root"]
    assert resolve.parameters["allowed_root"].kind is inspect.Parameter.KEYWORD_ONLY
    assert list(inspect.signature(server._prepare_turn_input).parameters)[:2] == ["sid", "session"]
    for helper in ("_sess_building", "_ok", "_err", "_attachment_ref_path", "_format_ref_value", "_session_cwd",
                   "register_method"):
        assert callable(getattr(server, helper)), helper


def test_handler_and_contract_are_installed_together(seam):
    assert folder_grants.METHOD in server._methods
    assert folder_grants.METHOD in registry.METHODS
    # Installing again changes nothing (apply() can run once per plugin load).
    handler = server._methods[folder_grants.METHOD]
    assert folder_grants._install_server(server)
    assert server._methods[folder_grants.METHOD] is handler


def test_a_handed_over_folder_reaches_the_agent_as_a_listing(desk, tree):
    agent = desk("desk")
    result = attach("desk", str(tree.folder))["result"]

    assert result["attached"] is True
    assert result["path"] == str(tree.folder)
    assert result["ref_text"] == f"@folder:`{tree.folder}`"
    prompt = turn(agent, "desk", f"看看这个文件夹 {result['ref_text']}")
    assert OUTSIDE not in prompt
    assert f"📁 {result['ref_text']}" in prompt
    assert "- 镜头1.mp4" in prompt and "- 说明.txt" in prompt


def test_a_file_inside_a_handed_over_folder_resolves(desk, tree):
    agent = desk("desk")
    attach("desk", str(tree.folder))

    prompt = turn(agent, "desk", f"读一下 @file:`{tree.folder / '说明.txt'}`")
    assert OUTSIDE not in prompt
    assert "FOLDER-NOTE-MARKER" in prompt


@pytest.mark.parametrize("ref", [
    pytest.param(lambda t: f"@folder:{t.other}", id="typed-folder-elsewhere"),
    pytest.param(lambda t: f"@file:{t.other / 'a.txt'}", id="typed-file-elsewhere"),
    pytest.param(lambda t: "@file:../Other/a.txt", id="autocomplete-relative"),
    pytest.param(lambda t: f"@file:`{t.folder}/../../Other/a.txt`", id="dotdot-escape"),
    pytest.param(lambda t: f"@file:`{t.folder / 'link-out' / 'a.txt'}`", id="symlink-inside-out"),
])
def test_references_outside_every_granted_folder_stay_refused(desk, tree, ref):
    agent = desk("desk")
    assert attach("desk", str(tree.folder))["result"]["attached"] is True

    prompt = turn(agent, "desk", f"读一下 {ref(tree)}")
    assert OUTSIDE in prompt
    assert "OTHER-MARKER" not in prompt


def test_credential_files_inside_a_handed_over_folder_stay_refused(desk, tree):
    agent = desk("desk")
    attach("desk", str(tree.folder))

    prompt = turn(agent, "desk", f"读一下 @file:`{tree.folder / '.env'}`")
    assert SENSITIVE in prompt
    assert "API_KEY=secret" not in prompt


def test_a_grant_belongs_to_the_session_that_was_handed_the_folder(desk, tree):
    first, second = desk("first"), desk("second")
    attach("first", str(tree.folder))

    assert OUTSIDE not in turn(first, "first", f"@folder:`{tree.folder}`")
    assert OUTSIDE in turn(second, "second", f"@folder:`{tree.folder}`")
    assert folder_grants.SESSION_KEY not in server._sessions["second"]


def _refusal_cases():
    return [
        pytest.param(lambda t: (str(t.folder), folder_grants.sign(str(t.folder), b"\x01" * 32)),
                     ("not_handed_over", "not handed over through Desktop"), id="other-key"),
        pytest.param(lambda t: (str(t.folder), folder_grants.sign(str(t.other), KEY)),
                     ("not_handed_over", "not handed over through Desktop"), id="signature-for-another-path"),
        pytest.param(lambda t: ("/", folder_grants.sign("/", KEY)), ("too_broad", "too broad"), id="disk-root"),
        pytest.param(lambda t: (str(t.home), folder_grants.sign(str(t.home), KEY)), ("too_broad", "too broad"), id="home"),
        pytest.param(lambda t: (str(t.home.parent), folder_grants.sign(str(t.home.parent), KEY)), ("too_broad", "too broad"),
                     id="above-home"),
        pytest.param(lambda t: (str(t.hermes_home), folder_grants.sign(str(t.hermes_home), KEY)), ("too_broad", "too broad"),
                     id="apex-data"),
        pytest.param(lambda t: (str(t.ssh), folder_grants.sign(str(t.ssh), KEY)), ("sensitive", SENSITIVE), id="ssh"),
        pytest.param(lambda t: (str(t.home / "Downloads" / "ssh-link"),
                                folder_grants.sign(str(t.home / "Downloads" / "ssh-link"), KEY)),
                     ("sensitive", SENSITIVE), id="symlink-to-ssh"),
        pytest.param(lambda t: (str(t.folder / "说明.txt"), folder_grants.sign(str(t.folder / "说明.txt"), KEY)),
                     ("not_folder", "not a folder"), id="a-file"),
        pytest.param(lambda t: ("Downloads", folder_grants.sign("Downloads", KEY)), ("unsupported_path", "absolute"), id="relative"),
    ]


@pytest.mark.parametrize(("case", "expected"), _refusal_cases())
def test_folder_attach_refuses_and_records_nothing(desk, tree, case, expected):
    desk("desk")
    path, grant = case(tree)
    reason, message = expected

    result = attach("desk", path, grant)["result"]
    assert (result["attached"], result["reason"]) == (False, reason)
    assert message in result["message"]
    assert not server._sessions["desk"].get(folder_grants.SESSION_KEY)


def test_an_engine_without_the_launch_key_grants_nothing(desk, tree, monkeypatch):
    desk("desk")
    monkeypatch.delenv(folder_grants.GRANT_KEY_ENV)

    result = attach("desk", str(tree.folder))["result"]
    assert (result["attached"], result["reason"]) == (False, "no_key")
    assert "engine this Desktop started" in result["message"]
    assert not server._sessions["desk"].get(folder_grants.SESSION_KEY)


@pytest.mark.parametrize("inside", ["sub", "."], ids=["subfolder", "the-cwd-itself"])
def test_a_folder_inside_the_workspace_needs_no_grant(desk, tree, inside):
    """Inside the cwd the workspace guard already admits it: answered as before, nothing recorded."""
    agent = desk("desk")
    target = (tree.work / inside).resolve()

    result = attach("desk", str(target))["result"]
    assert result["attached"] is True
    assert not server._sessions["desk"].get(folder_grants.SESSION_KEY)
    assert OUTSIDE not in turn(agent, "desk", result["ref_text"])


def test_the_contract_rejects_unknown_params(desk, tree):
    desk("desk")
    response = server.handle_request({"id": "1", "method": "folder.attach", "params": {
        "session_id": "desk", "path": str(tree.folder), "grant": folder_grants.sign(str(tree.folder), KEY),
        "trusted": True}})
    assert response["error"]["code"] == 4000


def test_the_launch_key_never_reaches_agent_subprocesses(monkeypatch):
    from tools.environments.local import _sanitize_subprocess_env, hermes_subprocess_env

    monkeypatch.setenv(folder_grants.GRANT_KEY_ENV, KEY.hex())
    assert folder_grants.GRANT_KEY_ENV not in hermes_subprocess_env()
    assert folder_grants.GRANT_KEY_ENV not in hermes_subprocess_env(inherit_credentials=True)
    assert folder_grants.GRANT_KEY_ENV not in _sanitize_subprocess_env({folder_grants.GRANT_KEY_ENV: KEY.hex()})


def test_im_turns_never_see_desktop_grants(desk, tree, monkeypatch):
    """The IM entry (gateway/run_inbound.py) expands references without the turn wrapper: a folder some
    Desktop session holds stays outside the IM chat's workspace. The Desktop turn is the positive control."""
    import gateway.run as gateway_run
    from gateway.config import GatewayConfig, Platform, PlatformConfig
    from gateway.platforms.event import MessageEvent
    from gateway.run import GatewayRunner
    from gateway.session import SessionSource

    agent = desk("desk")
    assert attach("desk", str(tree.folder))["result"]["attached"] is True
    assert OUTSIDE not in turn(agent, "desk", f"@folder:`{tree.folder}`")

    runner = object.__new__(GatewayRunner)
    runner.config = GatewayConfig(platforms={Platform.TELEGRAM: PlatformConfig(enabled=True, token="fake")})
    runner.adapters = {}
    runner._session_model_overrides = {}
    runner._last_resolved_model = {}
    runner._service_tier = None
    runner._agent_cache = {}
    runner._agent_cache_lock = threading.Lock()
    monkeypatch.setattr(gateway_run, "_resolve_gateway_model", lambda cfg=None: "openai/gpt-4.1-mini")
    monkeypatch.setattr(gateway_run, "_resolve_runtime_agent_kwargs", lambda: {
        "provider": "openai", "api_key": "test-key", "base_url": "https://api.openai.com/v1",
        "api_mode": "chat_completions"})
    monkeypatch.setattr(gateway_run, "_load_gateway_config",
                        lambda: {"model": {"default": "openai/gpt-4.1-mini", "context_length": 128000}})
    monkeypatch.setenv("TERMINAL_CWD", str(tree.work))
    monkeypatch.setattr(threading, "Thread", _REAL_THREAD)  # the IM path runs on a real event loop
    source = SessionSource(platform=Platform.TELEGRAM, chat_id="123", chat_name="DM", chat_type="private",
                           user_name="Alice")

    result = asyncio.run(runner._prepare_inbound_message_text(
        event=MessageEvent(text=f"看看 @folder:`{tree.folder}`", source=source), source=source, history=[]))
    assert OUTSIDE in result
    assert "镜头1.mp4" not in result
