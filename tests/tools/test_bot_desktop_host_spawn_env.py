"""ApexNodes hc-1274 (GHSA-p22p-9ph6-gmrh): no process this machine starts takes values from a backend-hosted screen.

With ``terminal.backend`` docker or ssh, Bot Desktop's screen runs inside the backend (``bot_desktop.placement``
``auto``). Its env file sits in a directory any process in the backend can write. Before upstream #154487 the
agent read every ``KEY=VALUE`` line back and merged it into the env of processes it starts on its own machine,
so code in the backend could set ``LD_PRELOAD`` (Linux), ``DYLD_INSERT_LIBRARIES`` (macOS), ``PATH`` or the
harness's CDP variables and run code here as the agent's user. The APEX Desktop sets ``browser.headed: true``, so
under such a backend the first browser call starts that screen by itself.

The backported upstream file ``tests/tools/test_bot_desktop_published_env.py`` pins the reader and
``desktop_env`` / ``build_browser_env`` / ``cua_driver_child_env(base)`` / ``_make_run_env``. This file adds:

- the spawn sites that test does not call: the ``browser_exec`` harness (the advisory's own reproduction), the
  Lightpanda engine, cua-driver's status / doctor / install env, its install probe and the spawn env of the
  embedded daemon (unrestricted mode, where no approval stands between the model and the driver);
- a census of every caller of the raw published env, so a new caller (from an upstream sync or a fork change)
  is reviewed before it can hand backend values to a process on this machine.
"""
from __future__ import annotations

import ast
import json
import subprocess
from pathlib import Path

import pytest

from tools.bot_desktop import placement, runtime, sandbox_host
from tools.environments import streams

_REPO = Path(__file__).resolve().parents[2]
_TAG = "sbx-7f3a"  # in every value the fake backend publishes: any occurrence in a host env is a leak

# What launcher.sh writes (paths inside the backend) ...
LAUNCHER_VALUES = {
    "DISPLAY": ":20",
    "XAUTHORITY": f"/{_TAG}/hermes-bot-desktop/default/Xauthority",
    "DBUS_SESSION_BUS_ADDRESS": f"unix:path=/{_TAG}/hermes-bot-desktop/default/bus",
    "XDG_CONFIG_HOME": f"/{_TAG}/hermes-bot-desktop/default/xdg/config",
    "XDG_CACHE_HOME": f"/{_TAG}/hermes-bot-desktop/default/xdg/cache",
    "XDG_DATA_HOME": f"/{_TAG}/hermes-bot-desktop/default/xdg/data",
}
# ... and what code in the backend appends: the advisory's keys, one per host platform the Desktop ships on.
APPENDED_LINES = {
    "LD_PRELOAD": f"/{_TAG}/workspace/x.so",
    "DYLD_INSERT_LIBRARIES": f"/{_TAG}/workspace/x.dylib",
    "NODE_OPTIONS": f"--require=/{_TAG}/workspace/x.js",
    "PATH": f"/{_TAG}/workspace/bin",
    "HTTPS_PROXY": f"http://proxy.{_TAG}.invalid:3128",
    "BU_CDP_URL": f"http://cdp.{_TAG}.invalid:9222",
}
_SEAT = {"DISPLAY": ":0", "XAUTHORITY": "/home/u/.Xauthority", "DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/u/bus"}


class _FakeSandbox:
    """Stand-in for a docker terminal environment (what ``streams`` and ``sandbox_host`` read)."""
    _docker_exe = "docker"
    _container_id = "c0ffee"

    def get_temp_dir(self):
        return f"/{_TAG}"


@pytest.fixture
def backend_screen(tmp_path, monkeypatch):
    """A screen started inside a docker backend under the default ``auto`` placement: the host-side marker is
    written, and the backend's env file holds the launcher's lines plus the appended ones."""
    home = tmp_path / ".hermes"
    (home / "bot-desktop").mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(runtime, "state_dir", lambda: home / "bot-desktop")
    monkeypatch.setattr(runtime, "_profile_name", lambda: "default")
    monkeypatch.setattr(sandbox_host, "_REPORTED_DROPS", set(), raising=False)  # absent before the fix
    env_file = "".join(f"{k}={v}\n" for k, v in {**LAUNCHER_VALUES, **APPENDED_LINES}.items()).encode()

    def run_in(env, argv, *, child_env=None, user=None, timeout=None, **_kw):
        script = argv[-1] if argv else ""
        if "/env" in script and "launcher.pid" in script:
            return subprocess.CompletedProcess(argv, 0, env_file, b"")
        return subprocess.CompletedProcess(argv, 1, b"", b"")

    sandbox = _FakeSandbox()
    monkeypatch.setattr(streams, "run_in", run_in)
    monkeypatch.setattr(sandbox_host, "_user_for", lambda env: None)
    monkeypatch.setattr(runtime, "_sandbox_env", lambda *, create: sandbox)
    monkeypatch.setattr(placement, "_setting", lambda: "auto")
    monkeypatch.setattr(placement, "_terminal_backend", lambda: "docker")
    sandbox_host._marker().write_text(json.dumps({"display": ":20", "dir": f"/{_TAG}/hermes-bot-desktop/default",
                                                  "profile": "default", "backend": "DockerEnvironment",
                                                  "container": sandbox._container_id, "docker": "docker"}))
    for key, value in _SEAT.items():
        monkeypatch.setenv(key, value)
    for key in APPENDED_LINES.keys() - {"PATH"}:
        monkeypatch.delenv(key, raising=False)
    return sandbox


def _harness_env():
    from tools.browser_use_cli import _base_subprocess_env
    return _base_subprocess_env()


def _lightpanda_env():
    from tools.browser_lightpanda import _browser_env
    return _browser_env()


def _cua_status_env():
    from tools.computer_use.cua_backend import sanitized_cua_driver_env
    return sanitized_cua_driver_env()


def _cua_install_probe_env():
    from pm.packages import CuaDriver
    return CuaDriver()._probe_env()


def _cua_embedded_daemon_env():
    from tools.computer_use.cua_backend import CuaDriverBackend
    return CuaDriverBackend("unrestricted")._embedded_daemon._sanitized_env()


# Every spawn on this machine whose env the upstream file does not build. Each is a GUI-capable child, so with the
# screen in the backend it also gets no display at all (upstream's rule): that half shows the backend branch ran.
_HOST_SPAWN_ENVS = {
    "browser_exec harness (browser_use_cli._base_subprocess_env)": _harness_env,
    "Lightpanda engine (browser_lightpanda._browser_env)": _lightpanda_env,
    "cua-driver status / doctor / install (cua_backend.sanitized_cua_driver_env)": _cua_status_env,
    "cua-driver install probe (pm.packages.CuaDriver._probe_env)": _cua_install_probe_env,
    "approval-bypassed embedded cua-driver daemon (_EmbeddedCuaDaemon._sanitized_env)": _cua_embedded_daemon_env,
}


def test_the_fake_backend_publishes_a_running_screen(backend_screen):
    """Control (green with or without the fix): the backend side really answers, so a clean host env below is
    the fix at work, not a dead fixture. What the reader keeps is the upstream file's business."""
    published = runtime.published_env()
    assert {key: published.get(key) for key in LAUNCHER_VALUES} == LAUNCHER_VALUES
    assert runtime.is_running()


@pytest.mark.parametrize("build", _HOST_SPAWN_ENVS.values(), ids=_HOST_SPAWN_ENVS.keys())
def test_a_host_spawn_takes_nothing_from_the_backend_screen(backend_screen, build):
    env = build()
    assert {k: v for k, v in env.items() if _TAG in v} == {}
    assert not {"LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS", "BU_CDP_URL"} & set(env)
    assert not {"DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS"} & set(env)


# ---- census: every caller of the raw published env -------------------------------------------------------------

_RAW_READERS = {"published_env", "_sandbox_published_env", "parse_published"}
_SCANNED = ("agent", "apex_overlay", "gateway", "hermes_cli", "plugins", "pm", "tools", "tui_gateway")
# (file, enclosing function, callee) -> why the backend's values cannot reach a process started on this machine.
_REVIEWED_CALLERS = {
    ("agent/prompt_builder.py", "_bot_screen_hint", "_bd_runtime.published_env"):
        "DISPLAY into the prompt's screen note; parse_published admits only ':N' / ':N.M'",
    ("tools/bot_desktop/runtime.py", "host_published_env", "published_env"):
        "the host gate: {} while the host-side marker routes the screen to the backend",
    ("tools/bot_desktop/runtime.py", "published_env", "_sandbox_published_env"): "the reader itself",
    ("tools/bot_desktop/runtime.py", "_sandbox_published_env", "sandbox_host.published_env"): "the reader itself",
    ("tools/bot_desktop/sandbox_host.py", "_published", "parse_published"): "the reader itself",
    ("tools/bot_desktop/runtime.py", "ensure_started_for_tool", "published_env"): "is a screen up (truth value)",
    ("tools/bot_desktop/runtime.py", "tool_placement", "published_env"): "is a screen up (truth value)",
    ("tools/bot_desktop/runtime.py", "is_running", "published_env"): "is a screen up (truth value)",
    ("tools/bot_desktop/runtime.py", "start", "published_env"): "is a screen up (truth value)",
    ("tools/bot_desktop/runtime.py", "status", "published_env"):
        "status of a gateway-hosted screen (a backend-hosted one returns _sandbox_status first)",
    ("tools/bot_desktop/runtime.py", "_sandbox_status", "sandbox_host.published_env"): "status fields only",
    ("tools/bot_desktop/thumbnail.py", "thumbnail_data_url", "runtime.published_env"):
        "a backend-hosted screen is grabbed inside the backend; the local grab needs a local launcher",
    ("tools/browser_session.py", "shares_bot_desktop_browser", "_bd_runtime.published_env"): "truth value",
    ("tools/browser_session.py", "_bot_desktop_target", "_bd_runtime.published_env"): "truth value",
    ("tools/browser_session_sandbox.py", "_sandbox", "_bd_runtime.published_env"):
        "handed to the browser that runs inside the backend",
    ("tools/computer_use/cua_backend.py", "desktop_identity", "_bd_runtime.published_env"):
        "DISPLAY compared as the cached driver's identity, never exported",
    ("tools/computer_use/cua_backend.py", "sandbox_mcp_invocation", "_bd_runtime.published_env"):
        "exported inside the backend (docker exec / ssh); the local child env is PATH only",
}


def _raw_reader_calls() -> set[tuple[str, str, str]]:
    found: set[tuple[str, str, str]] = set()
    for path in sorted(p for top in _SCANNED for p in (_REPO / top).rglob("*.py")):
        text = path.read_text(encoding="utf-8", errors="replace")
        if not any(name in text for name in _RAW_READERS):
            continue
        tree = ast.parse(text)
        aliases = {a.asname for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)
                   for a in node.names if a.name in _RAW_READERS and a.asname}
        rel = path.relative_to(_REPO).as_posix()

        def visit(node, owner):
            for child in ast.iter_child_nodes(node):
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    visit(child, child.name)
                    continue
                if isinstance(child, ast.Call):
                    func = child.func
                    name = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", None)
                    if name in _RAW_READERS or name in aliases:
                        found.add((rel, owner, ast.unparse(func)))
                visit(child, owner)

        visit(tree, "<module>")
    return found


def test_every_caller_of_the_raw_published_env_is_reviewed():
    """A process started on this machine takes the screen's values only through ``runtime.host_published_env()``
    (``desktop_env`` and the local terminal overlay do). A caller missing below has not been checked: if it builds
    an env for a process here, call ``desktop_env`` / ``host_published_env`` instead; if the values stay inside the
    backend or are only tested for truth, add it with the reason. A caller listed but gone is stale: remove it."""
    found = _raw_reader_calls()
    assert sorted(found - _REVIEWED_CALLERS.keys()) == [], "callers nobody has reviewed"
    assert sorted(_REVIEWED_CALLERS.keys() - found) == [], "reviewed callers that no longer exist"
