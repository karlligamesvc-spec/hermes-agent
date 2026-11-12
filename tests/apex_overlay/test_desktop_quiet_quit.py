"""hc-1217: quitting APEX Desktop tells only the Feishu chats whose task is running.

Every case runs upstream's real ``_notify_active_sessions_of_shutdown`` (and, for cron, the real
``_notify_interrupted_cron_jobs``) against recording Feishu adapters. On Desktop the Feishu home
channel is the owner's own direct chat, the open_id below.
"""

from __future__ import annotations

import ast
import inspect
import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

import gateway.drain_control as dc
from agent.i18n import t
from apex_overlay import desktop_quiet_quit
from gateway.config import GatewayConfig, HomeChannel, Platform, PlatformConfig
from gateway.run import GatewayRunner
from gateway.session import SessionSource, build_session_key
from tests.gateway.restart_test_helpers import RestartTestAdapter, make_restart_runner

_REPO = Path(__file__).resolve().parents[2]
OWNER = "ou_owner_open_id"
GROUP = "oc_team_group"


class FeishuAdapter(RestartTestAdapter):
    def __init__(self):
        super().__init__()
        self.platform = Platform.FEISHU


def _feishu_config(home: str | None = OWNER) -> PlatformConfig:
    return PlatformConfig(
        enabled=True,
        home_channel=HomeChannel(platform=Platform.FEISHU, chat_id=home, name="Home") if home else None,
    )


def _runner(home: str | None = OWNER):
    runner, _ = make_restart_runner()
    adapter = FeishuAdapter()
    runner.config = GatewayConfig(platforms={Platform.FEISHU: _feishu_config(home)})
    runner.adapters = {Platform.FEISHU: adapter}
    return runner, adapter


def _running_chat(runner, chat_id: str, *, chat_type: str = "dm", message_id: str | None = None) -> SessionSource:
    source = SessionSource(platform=Platform.FEISHU, chat_id=chat_id, chat_type=chat_type, user_id="u1",
                           message_id=message_id)
    key = build_session_key(source)
    runner._running_agents[key] = MagicMock()
    runner._cache_session_source(key, source)
    return source


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    return tmp_path


def _seam_landed() -> bool:
    return bool(getattr(dc.drain_notification_suppressed, desktop_quiet_quit._MARK, False))


@pytest.fixture
def desktop(home, monkeypatch):
    """The gateway as Desktop spawns it: the mark in its environment, the seam applied at boot."""
    monkeypatch.setattr(dc, "drain_notification_suppressed", dc.drain_notification_suppressed)
    monkeypatch.setenv(desktop_quiet_quit.ENV_NAME, "1")
    assert desktop_quiet_quit.apply() is True
    return home


@pytest.fixture
def cloud(home, monkeypatch):
    """Any gateway Desktop did not start: no mark in its environment."""
    monkeypatch.setattr(dc, "drain_notification_suppressed", dc.drain_notification_suppressed)
    monkeypatch.delenv(desktop_quiet_quit.ENV_NAME, raising=False)
    assert desktop_quiet_quit.apply() is True
    return home


@pytest.mark.asyncio
async def test_quit_with_nothing_running_sends_nothing_to_feishu(desktop):
    runner, adapter = _runner()
    assert _seam_landed()

    await runner._notify_active_sessions_of_shutdown()

    assert adapter.sent_calls == []
    # Quiet without the drain marker: nothing is left behind to hold the next launch in "draining".
    assert not dc.drain_request_path(desktop).exists()
    assert dc.drain_requested(home=desktop) is False


@pytest.mark.asyncio
async def test_a_cloud_gateway_still_broadcasts_to_its_home_channel(cloud):
    runner, adapter = _runner()

    await runner._notify_active_sessions_of_shutdown()

    assert not _seam_landed(), "apply() patched a gateway Desktop did not start"

    assert adapter.sent_calls == [(OWNER, t("gateway.shutdown.notice_shutdown"), adapter.sent_calls[0][2])]


@pytest.mark.asyncio
@pytest.mark.parametrize("running", [GROUP, OWNER], ids=["group-chat", "owner-direct-chat"])
async def test_a_chat_whose_task_is_running_still_gets_the_interrupt_notice(desktop, running):
    runner, adapter = _runner()
    _running_chat(runner, running, chat_type="group" if running == GROUP else "dm")
    assert _seam_landed()

    await runner._notify_active_sessions_of_shutdown()

    assert [(chat, text) for chat, text, _meta in adapter.sent_calls] == [
        (running, t("gateway.shutdown.notice_shutdown"))
    ]


async def _in_chat_restart_sends(runner, adapter):
    source = _running_chat(runner, GROUP, chat_type="group", message_id="restart-command")
    runner._restart_requested = True
    runner._restart_command_source = source
    await runner._notify_active_sessions_of_shutdown()
    return [(chat, text) for chat, text, _meta in adapter.sent_calls]


@pytest.mark.asyncio
async def test_an_in_chat_restart_notice_is_unchanged(home, monkeypatch):
    monkeypatch.setattr(dc, "drain_notification_suppressed", dc.drain_notification_suppressed)
    upstream = await _in_chat_restart_sends(*_runner())

    monkeypatch.setenv(desktop_quiet_quit.ENV_NAME, "1")
    assert desktop_quiet_quit.apply() is True and _seam_landed()
    on_desktop = await _in_chat_restart_sends(*_runner())

    assert upstream == on_desktop == [(GROUP, t("gateway.shutdown.notice_restart"))]


@pytest.mark.asyncio
async def test_every_served_profiles_home_channel_stays_quiet(desktop):
    """Several assistants on one gateway: no served profile's home channel hears the quit, and a
    running chat of a secondary assistant is still told, through that assistant's own bot."""
    runner, launch = _runner()
    second, third = FeishuAdapter(), FeishuAdapter()
    runner._profile_configs = {
        "writer": GatewayConfig(platforms={Platform.FEISHU: _feishu_config("ou_writer_owner")}),
        "editor": GatewayConfig(platforms={Platform.FEISHU: _feishu_config("ou_editor_owner")}),
    }
    runner._profile_adapters = {"writer": {Platform.FEISHU: second}, "editor": {Platform.FEISHU: third}}
    runner._served_profile_homes = {}
    runner._running_agents["agent:writer:feishu:group:oc_writer_group"] = MagicMock()
    assert _seam_landed()

    await runner._notify_active_sessions_of_shutdown()

    assert launch.sent_calls == [] and third.sent_calls == []
    assert [(chat, text) for chat, text, _meta in second.sent_calls] == [
        ("oc_writer_group", t("gateway.shutdown.notice_shutdown"))
    ]


@pytest.mark.asyncio
async def test_the_same_served_profiles_all_hear_it_without_the_mark(cloud):
    """Control for the case above: what upstream does with three served home channels."""
    runner, launch = _runner()
    second, third = FeishuAdapter(), FeishuAdapter()
    runner._profile_configs = {
        "writer": GatewayConfig(platforms={Platform.FEISHU: _feishu_config("ou_writer_owner")}),
        "editor": GatewayConfig(platforms={Platform.FEISHU: _feishu_config("ou_editor_owner")}),
    }
    runner._profile_adapters = {"writer": {Platform.FEISHU: second}, "editor": {Platform.FEISHU: third}}
    runner._served_profile_homes = {}

    await runner._notify_active_sessions_of_shutdown()

    sent = [chat for adapter in (launch, second, third) for chat, _text, _meta in adapter.sent_calls]
    assert sent == [OWNER, "ou_writer_owner", "ou_editor_owner"]


@pytest.mark.asyncio
async def test_a_running_scheduled_task_still_reports_its_interruption_to_the_home_channel(desktop):
    """Scheduled-task delivery keeps the home channel: a job killed by the quit still says so there."""
    runner, adapter = _runner()
    job = {"id": "job-1", "name": "daily-digest", "deliver": "feishu"}
    target = {"platform": "feishu", "chat_id": OWNER, "thread_id": None}
    assert _seam_landed()

    with patch("cron.jobs.get_job", return_value=job), \
         patch("cron.scheduler._resolve_delivery_targets", return_value=[target]):
        assert await runner._notify_interrupted_cron_jobs([job["id"]]) == 1

    assert [chat for chat, _text, _meta in adapter.sent_calls] == [OWNER]
    assert "daily-digest" in adapter.sent_calls[0][1]


def test_apply_is_idempotent(desktop):
    patched = dc.drain_notification_suppressed
    assert desktop_quiet_quit.apply() is True
    assert dc.drain_notification_suppressed is patched


def test_the_patched_check_keeps_its_upstream_shape():
    original = inspect.unwrap(dc.drain_notification_suppressed)
    params = inspect.signature(original).parameters
    assert list(params) == ["home"]
    assert params["home"].kind is inspect.Parameter.KEYWORD_ONLY and params["home"].default is None


_SKIP_DIRS = {".git", "node_modules", "tests", "apps", "website", "web", "venv", ".venv", "__pycache__"}


def _references(name: str) -> list[tuple[str, str]]:
    """Every call of ``name`` and every import of it in shipped Python: (file, enclosing function)."""
    found = []
    for root, dirs, files in os.walk(_REPO):
        dirs[:] = [d for d in dirs if d not in _SKIP_DIRS and not d.startswith(".")]
        for file in files:
            path = Path(root, file)
            if not file.endswith(".py") or name not in (text := path.read_text(encoding="utf-8", errors="replace")):
                continue
            rel = path.relative_to(_REPO).as_posix()
            tree = ast.parse(text)
            scopes = [("<module>", tree)] + [
                (func.name, func) for func in ast.walk(tree) if isinstance(func, (ast.FunctionDef, ast.AsyncFunctionDef))
            ]
            for scope, owner in scopes:
                body = owner.body if scope == "<module>" else list(ast.walk(owner))
                for node in body:
                    called = isinstance(node, ast.Call) and name in (
                        getattr(node.func, "id", None), getattr(node.func, "attr", None))
                    imported = isinstance(node, ast.ImportFrom) and any(a.name == name for a in node.names)
                    if called or imported:
                        found.append((rel, scope))
    return sorted(found)


def test_only_the_home_channel_broadcast_reads_the_patched_check():
    """The seam answers "quiet" for every caller, so it must have exactly one: the home-channel pass
    of the shutdown notice, which imports it at call time (a module-level import would bind the
    unpatched function). A new upstream caller turns this red instead of silently going quiet."""
    # One import and one call, both inside the home-channel pass's function; none at module level.
    assert _references("drain_notification_suppressed") == [
        ("gateway/run_shutdown.py", "_notify_active_sessions_of_shutdown"),
        ("gateway/run_shutdown.py", "_notify_active_sessions_of_shutdown"),
    ]


def test_desktop_sets_the_mark_this_seam_reads():
    """Desktop's half (apps/desktop/electron/apex-gateway.ts GATEWAY_RUN_ENV; apex-gateway.test.ts
    checks that only the messaging gateway spawn carries it)."""
    gateway_ts = (_REPO / "apps/desktop/electron/apex-gateway.ts").read_text(encoding="utf-8")
    assert f"GATEWAY_RUN_ENV = Object.freeze({{ {desktop_quiet_quit.ENV_NAME}: '1' }})" in gateway_ts


_REGISTER_IN_DESKTOP_GATEWAY = """
import importlib.util, sys, types
spec = importlib.util.spec_from_file_location("_hc1217_apex_overlay_plugin", "plugins/apex-overlay/__init__.py")
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)
plugin.register(types.SimpleNamespace(register_tts_provider=lambda provider: None))

loaded = sorted(m for m in sys.modules if m == "gateway" or m.startswith("gateway."))
assert loaded == [], f"register() imported {loaded}"
from apex_overlay import desktop_quiet_quit, post_import
armed = "gateway.drain_control" in post_import.pending_modules()

import gateway.run  # what `hermes gateway run` does first
from gateway.drain_control import drain_notification_suppressed  # what the home-channel pass does
landed = bool(getattr(drain_notification_suppressed, desktop_quiet_quit._MARK, False))
print(f"HC1217 armed={armed} landed={landed} quiet={drain_notification_suppressed()}")
"""


@pytest.mark.parametrize("marked", [True, False], ids=["desktop-gateway", "unmarked-gateway"])
def test_the_real_plugin_registration_installs_the_seam_only_in_desktops_gateway(tmp_path, marked):
    home = tmp_path / "home"
    home.mkdir()
    env = {key: value for key, value in os.environ.items() if key != desktop_quiet_quit.ENV_NAME}
    env.update(HERMES_HOME=str(home), PYTHONFAULTHANDLER="1")
    if marked:
        env[desktop_quiet_quit.ENV_NAME] = "1"
    result = subprocess.run([sys.executable, "-c", _REGISTER_IN_DESKTOP_GATEWAY], env=env, cwd=_REPO,
                            capture_output=True, text=True, timeout=150, check=False)
    expected = "armed=True landed=True quiet=True" if marked else "armed=False landed=False quiet=False"
    assert result.returncode == 0 and f"HC1217 {expected}" in result.stdout, result.stdout + result.stderr
