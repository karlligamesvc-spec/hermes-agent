"""Real loopback side writers preserve a later model/credential commit.

Only fixture discovery, prompts and restarts are stubbed. The HTTP routes,
profile/auth resolution, YAML/.env writers and existing SQLite journal are real.
No gateway lifespan, external network, provider key or user HOME is used.
"""

from concurrent.futures import ThreadPoolExecutor
import contextlib
from contextvars import ContextVar
import inspect
import ipaddress
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading
import time
from types import SimpleNamespace

import httpx
import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
AUTHORITY = "90300000-0000-4000-8000-000000000015"
JOURNAL = ".desktop-model-mutations.sqlite3"


def _fixture_services():
    from hermes_cli import mcp_catalog, mcp_config, plugins_cmd
    from hermes_cli.web_routers import dashboard_ui, memory_providers, messaging, ops
    from plugins.memory.config_schema import ProviderConfigSchema, ProviderField
    from plugins.memory.openviking import OpenVikingMemoryProvider

    for module in (dashboard_ui, memory_providers, ops):
        module._require_memory_provider_ready = lambda *_: None
    memory_providers.get_provider_config_schema = lambda name: ProviderConfigSchema(
        name=name, label="Fixture", fields=(ProviderField("endpoint", "Endpoint"),))
    memory_providers._normalize_memory_provider_schema = lambda *_: [
        {"key": "endpoint", "kind": "text", "default": "", "label": "Endpoint"}]
    memory_providers._read_memory_provider_existing_values = lambda *_: {}
    memory_providers._install_memory_provider_setup = lambda *_: {"fixture_install": "not-run"}
    memory_providers._load_memory_provider = lambda name: (
        OpenVikingMemoryProvider() if name == "openviking" else None)
    # None exercises the production fallback rather than a plugin override.
    original_load = memory_providers._load_memory_provider
    from agent.memory_provider import MemoryProvider

    class FixtureMemoryProvider(MemoryProvider):
        name = "fixture"

        def is_available(self):
            return True

        def initialize(self, *_args, **_kwargs):
            pass

        def get_tool_schemas(self):
            return []

    memory_providers._load_memory_provider = lambda name: (
        FixtureMemoryProvider() if name == "fixture" else original_load(name))
    messaging._whatsapp_record_or_404 = lambda *_: SimpleNamespace(
        status="connected", mode="bot", allowed_users="15555550123", account_phone="", account_id="", profile=None)
    messaging._telegram_record_or_404 = lambda *_: SimpleNamespace(
        bot_token="123456:hc903-fixture-bot", bot_username="hc903_fixture_bot")
    messaging._restart_gateway_after = lambda *_args, **_kw: {"restart_started": False}
    messaging._restart_gateway_after_whatsapp_onboarding = lambda *_: {"restart_started": False}
    messaging._multiplex_port_binding_conflict = lambda *_: None
    messaging._notify_multiplexer_hot_serve = lambda *_: False
    entry = mcp_catalog.CatalogEntry("fixture-catalog", "Fixture", "fixture",
        mcp_catalog.TransportSpec("http", url="https://fixture.invalid/mcp"), mcp_catalog.AuthSpec("none"))
    mcp_catalog.get_entry = lambda name: entry if name == entry.name else None
    mcp_catalog._apply_tool_selection = lambda *_args, **_kw: None
    mcp_config._probe_single_server = lambda *_args, **_kw: [("keep", "Fixture"), ("drop", "Fixture")]
    from hermes_cli import curses_ui
    curses_ui.curses_checklist = lambda *_args, **_kw: {0}
    sys.stdin = SimpleNamespace(isatty=lambda: True)
    plugins_cmd._resolve_plugin_key = lambda name: (name, "user")
    plugins_cmd._get_plugin_toolset_key = lambda *_: "fixture_tools"


def _publish_runtime_ready(ready: Path, port: int):
    pending = ready.with_name(f".{ready.name}.{os.getpid()}.tmp")
    pending.write_text(json.dumps({"port": port}), encoding="utf-8")
    pending.replace(ready)


def _serve():
    """Owned child process; publish only its loopback port."""
    home, ready = map(Path, sys.argv[1:3])
    os.environ.update(HERMES_HOME=str(home), HOME=str(home.parent), HERMES_TEST_ISOLATION=str(home),
                      HERMES_DASHBOARD_SESSION_TOKEN="hc903-side-fixture-session")
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(128)
    port = listener.getsockname()[1]
    connect = socket.socket.connect

    def owned_only(sock, address):
        assert isinstance(address, tuple) and ipaddress.ip_address(address[0]).is_loopback and address[1] == port
        return connect(sock, address)

    socket.socket.connect = owned_only
    socket.socket.connect_ex = lambda sock, address: owned_only(sock, address) or 0
    import uvicorn
    from hermes_cli import config, mcp_catalog, mcp_config, plugins_cmd, web_server
    from hermes_cli.web_routers import dashboard_ui, memory_providers, ops
    _fixture_services()
    entered, release = threading.Event(), threading.Event()
    paused = ContextVar("fixture_side_pause", default=False)
    once = threading.Event()

    def gate():
        if paused.get() and not once.is_set():
            once.set()
            entered.set()
            assert release.wait(15), "Side writer barrier was not released"

    original_mutate = config.mutate_config

    def mutate(callback, **kwargs):
        # Pause before the real writer takes either lock or reads latest YAML.
        gate()
        return original_mutate(callback, **kwargs)

    config.mutate_config = mutate
    for module in (mcp_config, mcp_catalog):
        module.mutate_config = mutate
    original_load = config.load_config
    owned_files = {Path(module.__file__).resolve() for module in
                   (mcp_config, mcp_catalog, plugins_cmd, dashboard_ui, memory_providers, ops)}
    owned_files.add(ROOT / "plugins/memory/openviking/__init__.py")

    def load(*args, **kwargs):
        result = original_load(*args, **kwargs)
        caller = inspect.currentframe().f_back
        # A removed RMW fix must reach the same test barrier AFTER capturing
        # its stale document. Correct mutate_config reads never use this gate.
        if Path(caller.f_code.co_filename).resolve() in owned_files:
            gate()
        return result

    config.load_config = load
    mcp_config.load_config = load
    mcp_catalog.load_config = load

    @web_server.app.middleware("http")
    async def fixture_scope(request, call_next):
        token = paused.set(request.headers.get("X-Hc903-Fixture-Pause") == "yes")
        try:
            return await call_next(request)
        finally:
            paused.reset(token)

    @web_server.app.get("/__fixture/state")
    async def state():
        return {"entered": entered.is_set()}

    @web_server.app.post("/__fixture/release")
    async def release_writer():
        release.set()
        return {"ok": True}

    @web_server.app.post("/__fixture/cli/{operation}")
    async def cli(operation: str):
        import asyncio

        def run():
            if operation == "save":
                return mcp_config._save_mcp_server("fixture-cli", {"url": "https://fixture.invalid/mcp"})
            if operation == "remove":
                return mcp_config._remove_mcp_server("existing")
            if operation == "replace":
                return mcp_config._replace_mcp_servers({"fixture-cli": {"url": "https://fixture.invalid/mcp"}})[0]
            if operation == "configure":
                mcp_config.cmd_mcp_configure(SimpleNamespace(name="existing", exclude=False))
            elif operation == "filter":
                mcp_catalog._write_tools_filter("existing", "include", ["keep"])
            elif operation == "plugin-field":
                plugins_cmd._write_config_value("context", "engine", "fixture-plugin")
            elif operation == "plugin-flag":
                plugins_cmd._set_plugin_entry_flag("fixture-owned", "allow_tool_override", True)
            elif operation in {"plugin-toolset", "plugin-toolset-noop"}:
                plugins_cmd._toggle_plugin_toolset("fixture-owned", enable=operation.endswith("noop"))
            return True

        return {"ok": await asyncio.to_thread(run)}

    controls = [route for route in web_server.app.routes if getattr(route, "path", "").startswith("/__fixture/")]
    for route in controls:
        web_server.app.router.routes.remove(route)
    web_server.app.router.routes[:0] = controls
    _publish_runtime_ready(ready, port)
    uvicorn.Server(uvicorn.Config(web_server.app, lifespan="off", log_level="critical", access_log=False)).run(sockets=[listener])


def disk(home):
    return yaml.safe_load((home / "config.yaml").read_text())


def _mcp_child():
    """Exercise the same CLI writer in another process without a real MCP."""
    _, home, ready, released = sys.argv[1:5]
    os.environ.update(HERMES_HOME=home, HERMES_TEST_ISOLATION=home, HOME=str(Path(home).parent))
    from hermes_cli import config, mcp_config
    original = config.mutate_config

    def mutate(callback, **kwargs):
        Path(ready).touch()
        deadline = time.monotonic() + 10
        while not Path(released).exists():
            assert time.monotonic() < deadline, "CLI barrier was not released"
            time.sleep(.01)
        return original(callback, **kwargs)

    mcp_config.mutate_config = mutate
    assert mcp_config._save_mcp_server("fixture-background", {"url": "https://fixture.invalid/mcp"})


class Runtime:
    def __init__(self, home, evidence):
        self.home = home
        self.log = (evidence / "server.log").open("w")
        ready = evidence / "ready.json"
        env = {key: os.environ[key] for key in ("PATH", "SYSTEMROOT", "PYTHONUTF8") if key in os.environ}
        env.update(PYTHONPATH=str(ROOT), HOME=str(home.parent), HERMES_HOME=str(home), HERMES_TEST_ISOLATION=str(home))
        self.process = subprocess.Popen([sys.executable, str(Path(__file__)), str(home), str(ready)],
            cwd=ROOT, env=env, stdout=self.log, stderr=self.log)
        self.client = None
        try:
            deadline = time.monotonic() + 10
            while not ready.exists():
                assert self.process.poll() is None, (evidence / "server.log").read_text()
                assert time.monotonic() < deadline
                time.sleep(.01)
            self.client = httpx.Client(base_url=f"http://127.0.0.1:{json.loads(ready.read_text())['port']}",
                headers={"X-Hermes-Session-Token": "hc903-side-fixture-session"}, timeout=10, trust_env=False)
            self.wait("listening")
        except BaseException:
            self.close()
            raise

    def wait(self, key):
        deadline = time.monotonic() + 10
        while True:
            try:
                response = self.client.get("/__fixture/state")
                if response.status_code == 200 and (key == "listening" or response.json()[key]):
                    return
            except httpx.HTTPError:
                pass
            assert self.process.poll() is None
            assert time.monotonic() < deadline, f"Runtime did not reach {key}"
            time.sleep(.01)

    def close(self):
        if self.client:
            with contextlib.suppress(httpx.HTTPError):
                self.client.post("/__fixture/release")
            self.client.close()
        self.process.terminate()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)
        self.log.close()


def test_runtime_ready_json_is_not_visible_until_complete(tmp_path, monkeypatch):
    ready = tmp_path / "ready.json"
    entered, release = threading.Event(), threading.Event()
    write_text = Path.write_text

    def interrupted_write(destination, contents, **kwargs):
        write_text(destination, "", **kwargs)
        entered.set()
        assert release.wait(5), "Ready publication barrier was not released"
        return write_text(destination, contents, **kwargs)

    monkeypatch.setattr(Path, "write_text", interrupted_write)
    with ThreadPoolExecutor(max_workers=1) as pool:
        publishing = pool.submit(_publish_runtime_ready, ready, 12345)
        try:
            assert entered.wait(5), "Ready publisher did not enter the write"
            assert not ready.exists(), "Ready JSON was visible before its contents were complete"
        finally:
            release.set()
        publishing.result(timeout=5)
    assert json.loads(ready.read_text()) == {"port": 12345}


@pytest.fixture
def runtime(tmp_path):
    home = tmp_path / "runtime"
    home.mkdir()
    (home / "config.yaml").write_text(yaml.safe_dump({
        "model": {"default": "owner-old", "provider": "custom", "api_key": "hc903-fixture-old"},
        "custom_providers": [{"name": "fixture", "base_url": "https://fixture.invalid/v1", "api_key": "hc903-fixture-old"}],
        "hooks": {"pre_tool_call": [{"command": "echo fixture-old"}]},
        "mcp_servers": {"existing": {"url": "https://fixture.invalid/mcp", "enabled": True}},
        "plugins": {"enabled": ["fixture-owned"], "disabled": []},
        "platform_toolsets": {"cli": ["fixture_tools", "fixture_unrelated"]},
        "memory": {"fixture": {"keep": "latest-independent-field"}, "openviking": {"keep": "latest-independent-field"}}}))
    server = Runtime(home, tmp_path)
    try:
        yield server
    finally:
        server.close()


# The complete short-root writer family: HTTP entry points plus the MCP CLI
# writers used by background catalog installation/configure/uninstall.
CASES = [
    ("theme", "PUT", "/api/dashboard/theme", {"name": "fixture"}),
    ("font", "PUT", "/api/dashboard/font", {"font": "system-serif"}),
    ("visibility", "POST", "/api/dashboard/plugins/fixture/visibility", {"hidden": True}),
    ("plugin-providers", "PUT", "/api/dashboard/plugin-providers", {"context_engine": "fixture"}),
    ("plugin-enable", "POST", "/api/dashboard/agent-plugins/fixture-new/enable", None),
    ("plugin-disable", "POST", "/api/dashboard/agent-plugins/fixture-owned/disable", None),
    ("memory-select", "PUT", "/api/memory/provider", {"provider": "built-in"}),
    ("hook-add", "POST", "/api/ops/hooks", {"event": "pre_tool_call", "command": "echo fixture-new", "approve": False}),
    ("hook-delete", "DELETE", "/api/ops/hooks", {"event": "pre_tool_call", "command": "echo fixture-old"}),
    ("mcp-add", "POST", "/api/mcp/servers", {"name": "fixture-new", "url": "https://fixture.invalid/mcp"}),
    ("mcp-bearer", "POST", "/api/mcp/servers", {"name": "fixture-bearer", "url": "https://fixture.invalid/mcp", "auth": "header", "bearer_token": "hc903-fixture-bearer"}),
    ("mcp-replace", "PUT", "/api/mcp/servers", {"servers": {"fixture-new": {"url": "https://fixture.invalid/mcp"}}}),
    ("mcp-remove", "DELETE", "/api/mcp/servers/existing", None),
    ("mcp-enabled", "PUT", "/api/mcp/servers/existing/enabled", {"enabled": False}),
    ("mcp-catalog", "POST", "/api/mcp/catalog/install", {"name": "fixture-catalog"}),
    *[(f"cli-{op}", "POST", f"/__fixture/cli/{op}", None) for op in ("save", "remove", "replace", "configure", "filter")],
    *[(f"cli-{op}", "POST", f"/__fixture/cli/{op}", None) for op in ("plugin-field", "plugin-flag", "plugin-toolset")],
    ("memory-declared", "PUT", "/api/memory/providers/fixture/config?surface=declared", {"values": {"endpoint": "https://fixture.invalid"}}),
    ("memory-native", "PUT", "/api/memory/providers/fixture/config", {"values": {"endpoint": "https://fixture.invalid"}}),
    ("memory-openviking", "PUT", "/api/memory/providers/openviking/config", {"values": {"endpoint": "https://fixture.invalid"}}),
    ("memory-setup", "POST", "/api/memory/providers/fixture/setup", {"values": {"endpoint": "https://fixture.invalid"}}),
    ("openviking-setup", "POST", "/api/memory/providers/openviking/setup", {"values": {"endpoint": "https://fixture.invalid"}}),
    ("whatsapp", "POST", "/api/messaging/whatsapp/onboarding/fixture/apply", {}),
    ("telegram", "POST", "/api/messaging/telegram/onboarding/fixture/apply", {"allowed_user_ids": ["123456"]}),
    ("messaging-update", "PUT", "/api/messaging/platforms/telegram", {"enabled": True}),
]


@pytest.mark.parametrize("case,method,path,body", CASES, ids=[case[0] for case in CASES])
def test_prepared_side_write_preserves_later_model_and_key(runtime, case, method, path, body):
    target = runtime.client.get("/api/model/mutation").json()["target_id"]
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(runtime.client.request, method, path, json=body, headers={"X-Hc903-Fixture-Pause": "yes"})
        try:
            runtime.wait("entered")
            latest = disk(runtime.home)
            latest["model"] = {"default": "owner-b", "provider": "custom:fixture", "base_url": "https://fixture.invalid/v1", "api_key": "hc903-fixture-b"}
            latest["custom_providers"][0]["api_key"] = "hc903-fixture-b"
            latest["fixture_unrelated"] = {"saved_by": "owner-b"}
            for name in ("fixture", "openviking"):
                latest["memory"][name]["keep"] = "owner-b-independent-field"
            latest["mcp_servers"]["existing"]["fixture_b"] = "owner-b-independent-field"
            response = runtime.client.put("/api/config/raw", json={"yaml_text": yaml.safe_dump(latest)}, headers={
                "X-Apex-Model-Authority": AUTHORITY, "X-Apex-Model-Revision": "1", "X-Apex-Model-Target": target})
            assert response.status_code == 200, response.text
            assert disk(runtime.home)["model"] == latest["model"]
        finally:
            runtime.client.post("/__fixture/release")
        response = future.result()
    assert response.status_code == 200, response.text
    saved = disk(runtime.home)
    assert saved["model"] == latest["model"]
    assert saved["custom_providers"] == latest["custom_providers"]
    assert saved["fixture_unrelated"] == latest["fixture_unrelated"]
    if case == "theme":
        assert saved["dashboard"]["theme"] == "fixture"
    elif case == "font":
        assert saved["dashboard"]["font"] == "system-serif"
    elif case == "visibility":
        assert saved["dashboard"]["hidden_plugins"] == ["fixture"]
    elif case == "plugin-providers":
        assert saved["context"]["engine"] == "fixture"
    elif case == "plugin-enable":
        assert "fixture-new" in saved["plugins"]["enabled"]
        assert "fixture-new" not in saved["plugins"].get("disabled", [])
    elif case == "plugin-disable":
        assert "fixture-owned" not in saved["plugins"].get("enabled", [])
        assert "fixture-owned" in saved["plugins"]["disabled"]
        assert saved["platform_toolsets"]["cli"] == ["fixture_unrelated"]
    elif case == "cli-plugin-field":
        assert saved["context"]["engine"] == "fixture-plugin"
    elif case == "cli-plugin-flag":
        assert saved["plugins"]["entries"]["fixture-owned"]["allow_tool_override"] is True
    elif case == "cli-plugin-toolset":
        assert saved["platform_toolsets"]["cli"] == ["fixture_unrelated"]
    elif case == "memory-select":
        assert saved.get("memory", {}).get("provider", "") == ""
    elif case == "hook-add":
        assert saved["hooks"]["pre_tool_call"] == [{"command": "echo fixture-old"}, {"command": "echo fixture-new"}]
    elif case == "hook-delete":
        assert "pre_tool_call" not in saved.get("hooks", {})
    elif case in {"mcp-add", "mcp-replace", "cli-save", "cli-replace"}:
        name = "fixture-cli" if case.startswith("cli-") else "fixture-new"
        assert saved["mcp_servers"][name] == {"url": "https://fixture.invalid/mcp"}
        if case.endswith("replace"):
            assert "existing" not in saved["mcp_servers"]
    elif case == "mcp-bearer":
        assert saved["mcp_servers"]["fixture-bearer"]["headers"] == {"Authorization": "Bearer ${MCP_FIXTURE_BEARER_API_KEY}"}
        assert "hc903-fixture-bearer" not in (runtime.home / "config.yaml").read_text()
        line = next(line for line in (runtime.home / ".env").read_text().splitlines() if line.startswith("MCP_FIXTURE_BEARER_API_KEY="))
        assert line.split("=", 1)[1].strip("\"'") == "hc903-fixture-bearer"
    elif case in {"mcp-remove", "cli-remove"}:
        assert "existing" not in saved.get("mcp_servers", {})
    elif case == "mcp-enabled":
        assert saved["mcp_servers"]["existing"]["enabled"] is False
    elif case == "mcp-catalog":
        assert saved["mcp_servers"]["fixture-catalog"] == {"url": "https://fixture.invalid/mcp", "enabled": True}
    elif case == "memory-declared":
        assert saved["memory"]["provider"] == "fixture"
        assert json.loads((runtime.home / "fixture/config.json").read_text()) == {"endpoint": "https://fixture.invalid"}
    elif case in {"memory-native", "memory-setup"}:
        assert saved["memory"]["fixture"] == {"keep": "owner-b-independent-field", "endpoint": "https://fixture.invalid"}
    elif case in {"memory-openviking", "openviking-setup"}:
        assert saved["memory"]["openviking"] == {"keep": "owner-b-independent-field", "endpoint": "https://fixture.invalid"}
    elif case in {"cli-configure", "cli-filter"}:
        assert saved["mcp_servers"]["existing"]["tools"]["include"] == ["keep"]
        assert saved["mcp_servers"]["existing"]["fixture_b"] == "owner-b-independent-field"
    elif case in {"whatsapp", "telegram", "messaging-update"}:
        platform = "whatsapp" if case == "whatsapp" else "telegram"
        assert saved["platforms"][platform]["enabled"] is True


def test_background_cli_process_preserves_current_model_journal(runtime, tmp_path):
    target = runtime.client.get("/api/model/mutation").json()["target_id"]
    ready, release = tmp_path / "cli-ready", tmp_path / "cli-release"
    env = {key: os.environ[key] for key in ("PATH", "SYSTEMROOT", "PYTHONUTF8") if key in os.environ}
    env.update(PYTHONPATH=str(ROOT), HOME=str(runtime.home.parent), HERMES_HOME=str(runtime.home))
    with (tmp_path / "cli.log").open("w") as log:
        child = subprocess.Popen([sys.executable, str(Path(__file__)), "--mcp-child", str(runtime.home), str(ready), str(release)],
            cwd=ROOT, env=env, stdout=log, stderr=log)
        try:
            deadline = time.monotonic() + 10
            while not ready.exists():
                assert child.poll() is None
                assert time.monotonic() < deadline
                time.sleep(.01)
            latest = disk(runtime.home)
            latest["model"]["default"] = "owner-b-child"
            latest["model"]["api_key"] = "hc903-fixture-child-b"
            response = runtime.client.put("/api/config/raw", json={"yaml_text": yaml.safe_dump(latest)}, headers={
                "X-Apex-Model-Authority": AUTHORITY, "X-Apex-Model-Revision": "1", "X-Apex-Model-Target": target})
            assert response.status_code == 200, response.text
            release.touch()
            assert child.wait(timeout=10) == 0, (tmp_path / "cli.log").read_text()
        finally:
            release.touch()
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=5)
    saved = disk(runtime.home)
    assert saved["model"] == latest["model"]
    assert saved["mcp_servers"]["fixture-background"] == {"url": "https://fixture.invalid/mcp"}
    assert (runtime.home / JOURNAL).exists()


def test_duplicate_mcp_bearer_has_no_credential_or_config_side_effect(runtime):
    response = runtime.client.post("/api/mcp/servers", json={"name": "existing", "url": "https://fixture.invalid/mcp", "auth": "header", "bearer_token": "hc903-fixture-duplicate"})
    assert response.status_code == 409
    assert not (runtime.home / ".env").exists()
    assert not (runtime.home / JOURNAL).exists(), "An ordinary side writer must not create a Desktop owner journal"
    assert disk(runtime.home)["mcp_servers"]["existing"]["enabled"] is True


def test_ordinary_side_write_does_not_create_owner_journal(runtime):
    response = runtime.client.put("/api/dashboard/font", json={"font": "system-mono"})
    assert response.status_code == 200
    assert disk(runtime.home)["dashboard"]["font"] == "system-mono"
    assert not (runtime.home / JOURNAL).exists()


def test_unchanged_plugin_toolsets_does_not_rewrite_yaml(runtime):
    before = (runtime.home / "config.yaml").read_bytes()
    response = runtime.client.post("/__fixture/cli/plugin-toolset-noop")
    assert response.status_code == 200
    assert (runtime.home / "config.yaml").read_bytes() == before


@pytest.mark.parametrize("path,body", [
    ("/api/mcp/servers/missing", None),
    ("/api/ops/hooks", {"event": "post_tool_call", "command": "echo fixture-missing"}),
])
def test_missing_delete_does_not_rewrite_yaml(runtime, path, body):
    before = (runtime.home / "config.yaml").read_bytes()
    response = runtime.client.request("DELETE", path, json=body)
    assert response.status_code == 404
    assert (runtime.home / "config.yaml").read_bytes() == before


@pytest.mark.parametrize("path,body,section", [
    ("/api/mcp/servers", {"name": "fixture-profile", "url": "https://fixture.invalid/mcp", "profile": "worker"}, "mcp_servers"),
    ("/api/messaging/platforms/telegram", {"enabled": True, "profile": "worker"}, "platforms"),
    ("/api/memory/providers/fixture/config?profile=worker&surface=declared", {"values": {"endpoint": "https://fixture.invalid"}}, "memory"),
])
def test_scoped_side_write_preserves_default_home(runtime, path, body, section):
    worker = runtime.home / "profiles/worker"
    worker.mkdir(parents=True)
    (worker / "config.yaml").write_text(yaml.safe_dump({"model": {"default": "worker-model", "provider": "custom", "api_key": "hc903-fixture-worker"}}))
    before = (runtime.home / "config.yaml").read_bytes()
    method = "POST" if section == "mcp_servers" else "PUT"
    response = runtime.client.request(method, path, json=body)
    assert response.status_code == 200, response.text
    assert (runtime.home / "config.yaml").read_bytes() == before
    saved = disk(worker)
    assert saved["model"]["api_key"] == "hc903-fixture-worker"
    assert section in saved
    assert not (worker / JOURNAL).exists()


if __name__ == "__main__":
    if sys.argv[1] == "--mcp-child":
        _mcp_child()
    else:
        _serve()
