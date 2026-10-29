"""hc-1103 身份层 goldens: who the engine says it is and which version it reports, on every surface.

identity_exits_probe.py loads the bundled apex-overlay plugin in a fresh process and prints every exit an
APEX user can read: the identity and help line at the top of a session's and a subagent's prompt, the
help line's skill variant, ``/version`` in IM and in Desktop/CLI (the same text ``hermes --version``
prints), and the realtime voice persona. These goldens were recorded on clean fork main before hc-1103
changed anything. Off surfaces (plain engine, Desktop with single-thread mode off) must stay byte for byte
what they were; a change on an APEX surface shows up as a reviewed diff of its golden.

Set APEX_WRITE_IDENTITY_GOLDENS=1 to rewrite them; CI never does.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
GOLDEN = HERE / "__identity__" / "hc1103"
PROBE = HERE / "identity_exits_probe.py"
EXITS = (
    "session-identity-and-help",
    "subagent-identity-and-help",
    "help-line-with-hermes-agent-skill",
    "slash-version-im",
    "slash-version-desktop-and-cli",
    "voice-live-persona",
)
DESKTOP_STATE = {
    "schema": 1,
    "app_version": "0.17.67",
    "engine": {"version": "v2026.10.27-fork.aa8e554e", "commit": "aa8e554e3878d08d3448474290bc0eb07a1e3f78"},
    "update": {"status": "downloaded", "version": "0.17.68", "reason": None},
}

# surface -> (environment, whether Desktop wrote its version file)
SURFACES = {
    "engine": ({}, True),
    "desktop-single-thread": ({"APEX_SINGLE_THREAD_ACTIVE": "1"}, True),
    "desktop-single-thread-no-file": ({"APEX_SINGLE_THREAD_ACTIVE": "1"}, False),
    "cloud": ({"HERMES_MANAGED_RUNTIME": "1"}, False),
}
# Environments that must read exactly like the plain engine.
OFF_ENVIRONMENTS = {
    "single-thread-zero": {"APEX_SINGLE_THREAD_ACTIVE": "0"},
    "single-thread-word": {"APEX_SINGLE_THREAD_ACTIVE": "true"},
    "managed-zero": {"HERMES_MANAGED_RUNTIME": "0"},
    "managed-empty": {"HERMES_MANAGED_RUNTIME": ""},
}

_cache: dict[str, dict[str, str]] = {}


def _exits(tmp_path_factory, key: str, env: dict[str, str], with_file: bool) -> dict[str, str]:
    if key not in _cache:
        home = tmp_path_factory.mktemp(f"hc1103-{key}")
        (home / "SOUL.md").write_text("SOUL.md as the user's home has it.\n", encoding="utf-8")
        if with_file:
            (home / "apex").mkdir()
            (home / "apex" / "desktop-version.json").write_text(json.dumps(DESKTOP_STATE), encoding="utf-8")
        base = {k: v for k, v in os.environ.items() if k not in ("APEX_SINGLE_THREAD_ACTIVE", "HERMES_MANAGED_RUNTIME")}
        proc = subprocess.run([sys.executable, str(PROBE)], capture_output=True, text=True, timeout=120, check=False,
                              env={**base, **env, "HERMES_HOME": str(home)}, cwd=HERE.parents[1])
        assert proc.returncode == 0, proc.stderr[-3000:]
        _cache[key] = json.loads(proc.stdout.strip().splitlines()[-1])
    return _cache[key]


@pytest.mark.parametrize("surface", list(SURFACES))
def test_each_surface_reads_like_its_golden(tmp_path_factory, surface):
    env, with_file = SURFACES[surface]
    exits = _exits(tmp_path_factory, surface, env, with_file)
    assert sorted(exits) == sorted(EXITS)
    for name in EXITS:
        path = GOLDEN / surface / f"{name}.txt"
        if os.environ.get("APEX_WRITE_IDENTITY_GOLDENS") == "1":
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(exits[name], encoding="utf-8")
        assert exits[name] == path.read_text(encoding="utf-8"), f"{surface}/{name}"


@pytest.mark.parametrize("environment", list(OFF_ENVIRONMENTS))
def test_a_switch_that_is_not_on_reads_like_the_plain_engine(tmp_path_factory, environment):
    exits = _exits(tmp_path_factory, environment, OFF_ENVIRONMENTS[environment], True)
    for name in EXITS:
        assert exits[name] == (GOLDEN / "engine" / f"{name}.txt").read_text(encoding="utf-8"), f"{environment}/{name}"
