"""hc-926: the tool env APEX Desktop hands the runtime reaches the agent's commands.

``apps/desktop/electron/backend-env.ts`` puts uv's writable dirs inside the Hermes root
(``UV_*``) and names the runtime's own interpreter, which ships Pillow
(``APEX_PYTHON``). Both only help if the terminal tool's environment scrub lets them
through to the commands the agent runs; an upstream scrub of ``UV_*`` or an
``APEX_`` prefix would silently bring back the 0.17.58 failures (``uv venv``
EACCES on a root-owned ``~/.local/share``; ``python3`` = system 3.9 without Pillow).
"""

from __future__ import annotations

import os

import pytest

from tools.environments import local as local_mod
from tools.environments.local import _make_run_env, _sanitize_subprocess_env

pytestmark = pytest.mark.platforms("posix")

DESKTOP_TOOL_ENV = {
    "UV_CACHE_DIR": "/Users/test/.apexnodes/cache/uv",
    "UV_PYTHON_INSTALL_DIR": "/Users/test/.apexnodes/uv/python",
    "UV_PYTHON_BIN_DIR": "/Users/test/.apexnodes/uv/bin",
    "UV_TOOL_DIR": "/Users/test/.apexnodes/uv/tools",
    "UV_TOOL_BIN_DIR": "/Users/test/.apexnodes/uv/bin",
    "APEX_PYTHON": "/Users/test/.apexnodes/versions/abc/venv/bin/python",
}


@pytest.fixture
def desktop_backend_env(monkeypatch):
    for name, value in DESKTOP_TOOL_ENV.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setattr(local_mod, "_managed_runtime_path_entries", list)
    monkeypatch.setattr(local_mod, "_resolve_hermes_bin_dir", lambda: None)


def test_foreground_terminal_commands_keep_the_desktop_tool_env(desktop_backend_env):
    env = _make_run_env({})
    assert {name: env.get(name) for name in DESKTOP_TOOL_ENV} == DESKTOP_TOOL_ENV


def test_background_and_script_spawns_keep_the_desktop_tool_env(desktop_backend_env):
    env = _sanitize_subprocess_env(dict(os.environ))
    assert {name: env.get(name) for name in DESKTOP_TOOL_ENV} == DESKTOP_TOOL_ENV
