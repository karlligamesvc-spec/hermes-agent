"""The two values APEX-hosted Hypit generation reads reach the commands the agent runs.

Desktop main settles `desktop_features.hypihub_apex` into APEX_HYPIHUB_ACTIVE=1 before the
engine spawns, and hc-604 injects the platform-tool credential as TOOLS_GATEWAY_KEY. The
`hypit` wrapper runs inside the terminal tool, so it only sees them if the terminal's
environment scrub lets them through. An upstream scrub of ``*_KEY`` or an ``APEX_`` prefix
would turn hosted generation into "HypiHub apiKey credential is unavailable" with no other sign.
"""

from __future__ import annotations

import os

import pytest

from tools.environments import local as local_mod
from tools.environments.local import _make_run_env, _sanitize_subprocess_env

pytestmark = pytest.mark.platforms("posix")

HOSTED_ENV = {
    "APEX_HYPIHUB_ACTIVE": "1",
    "TOOLS_GATEWAY_KEY": "fake-agent-key-not-a-secret",
    "TOOLS_GATEWAY_BASE": "https://api.apex-nodes.com",
}


@pytest.fixture
def desktop_engine_env(monkeypatch):
    for name, value in HOSTED_ENV.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setattr(local_mod, "_managed_runtime_path_entries", list)
    monkeypatch.setattr(local_mod, "_resolve_hermes_bin_dir", lambda: None)


def test_foreground_terminal_commands_see_the_switch_and_the_platform_credential(desktop_engine_env):
    env = _make_run_env({})
    assert {name: env.get(name) for name in HOSTED_ENV} == HOSTED_ENV


def test_background_spawns_see_the_switch_and_the_platform_credential(desktop_engine_env):
    env = _sanitize_subprocess_env(dict(os.environ))
    assert {name: env.get(name) for name in HOSTED_ENV} == HOSTED_ENV
