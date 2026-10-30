"""hc-1116 身份层 goldens: the engine's own wording an APEX user can meet, on every surface.

upstream_copy_probe.py loads the bundled apex-overlay plugin in a fresh process and prints every exit: both
first-contact notes, the Desktop platform hint and the steering note as the system prompt reads them, every
zh and en catalog line that names Hermes, a ``hermes`` command, Nous, /help, /model or /login, and the
no-home-channel notice as WeChat gets it. These goldens were recorded on clean fork main before hc-1116
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
GOLDEN = HERE / "__identity__" / "hc1116"
PROBE = HERE / "upstream_copy_probe.py"
EXITS = (
    "first-contact-note",
    "first-contact-profile-offer",
    "desktop-platform-hint",
    "steer-note",
    "catalog-zh",
    "catalog-en",
    "cn-im-no-home-channel",
)
SURFACES = {
    "engine": {},
    "desktop-single-thread": {"APEX_SINGLE_THREAD_ACTIVE": "1"},
    "cloud": {"HERMES_MANAGED_RUNTIME": "1"},
}
# Environments that must read exactly like the plain engine.
OFF_ENVIRONMENTS = {
    "single-thread-zero": {"APEX_SINGLE_THREAD_ACTIVE": "0"},
    "single-thread-word": {"APEX_SINGLE_THREAD_ACTIVE": "true"},
    "managed-zero": {"HERMES_MANAGED_RUNTIME": "0"},
    "managed-empty": {"HERMES_MANAGED_RUNTIME": ""},
}

_cache: dict[str, dict[str, str]] = {}


def _exits(tmp_path_factory, key: str, env: dict[str, str]) -> dict[str, str]:
    if key not in _cache:
        home = tmp_path_factory.mktemp(f"hc1116-{key}")
        base = {k: v for k, v in os.environ.items()
                if k not in ("APEX_SINGLE_THREAD_ACTIVE", "HERMES_MANAGED_RUNTIME", "HERMES_LANGUAGE")}
        proc = subprocess.run([sys.executable, str(PROBE)], capture_output=True, text=True, timeout=120, check=False,
                              env={**base, **env, "HERMES_HOME": str(home)}, cwd=HERE.parents[1])
        assert proc.returncode == 0, proc.stderr[-3000:]
        _cache[key] = json.loads(proc.stdout.strip().splitlines()[-1])
    return _cache[key]


@pytest.mark.parametrize("surface", list(SURFACES))
def test_each_surface_reads_like_its_golden(tmp_path_factory, surface):
    exits = _exits(tmp_path_factory, surface, SURFACES[surface])
    assert sorted(exits) == sorted(EXITS)
    for name in EXITS:
        path = GOLDEN / surface / f"{name}.txt"
        if os.environ.get("APEX_WRITE_IDENTITY_GOLDENS") == "1":
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(exits[name], encoding="utf-8")
        assert exits[name] == path.read_text(encoding="utf-8"), f"{surface}/{name}"


@pytest.mark.parametrize("environment", list(OFF_ENVIRONMENTS))
def test_a_switch_that_is_not_on_reads_like_the_plain_engine(tmp_path_factory, environment):
    exits = _exits(tmp_path_factory, environment, OFF_ENVIRONMENTS[environment])
    for name in EXITS:
        assert exits[name] == (GOLDEN / "engine" / f"{name}.txt").read_text(encoding="utf-8"), f"{environment}/{name}"
