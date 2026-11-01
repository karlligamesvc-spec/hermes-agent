"""hc-1131 身份层 golden: the whole system prompt on every surface, recorded on clean fork main.

result_delivery_probe.py builds each platform's prompt with a real agent and the real apex-overlay plugin in a
fresh process. The golden was recorded before hc-1131 changed anything, so these prompts are byte for byte what
those surfaces built before it.

Set APEX_WRITE_IDENTITY_GOLDENS=1 to rewrite it; CI never does.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
GOLDEN = HERE / "__identity__" / "result-delivery-off" / "before-hc1131.json"
PROBE = HERE / "result_delivery_probe.py"
PLATFORMS = ("desktop", "tui", "cli", "subagent", "cron", "webhook", "api_server", "feishu", "weixin")
SURFACE_VARIABLES = ("APEX_SINGLE_THREAD_ACTIVE", "HERMES_DESKTOP", "HERMES_DESKTOP_TERMINAL", "HERMES_MANAGED_RUNTIME")

# surface -> its environment
SURFACES = {
    "desktop-single-thread-off": {"HERMES_DESKTOP": "1"},
    "desktop-single-thread": {"HERMES_DESKTOP": "1", "APEX_SINGLE_THREAD_ACTIVE": "1"},
    "cloud": {"HERMES_MANAGED_RUNTIME": "1"},
}

_cache: dict[str, dict[str, str]] = {}


def _normalized(prompt: str, home: Path) -> str:
    """The prompt without what belongs to this machine: its folders, its OS and the wall clock."""
    prompt = prompt.replace(str(home), "<HERMES_HOME>").replace(str(ROOT), "<CHECKOUT>")
    prompt = prompt.replace(str(Path.home()), "<USER_HOME>")
    prompt = re.sub(r"(?m)^Host: .*$", "Host: <pinned>", prompt)
    return re.sub(r"(?m)^Conversation started: .*$", "Conversation started: <pinned>", prompt)


def _prompts(tmp_path_factory, surface: str) -> dict[str, str]:
    if surface not in _cache:
        home = tmp_path_factory.mktemp(f"hc1131-{surface}")
        (home / "SOUL.md").write_text("SOUL.md as the user's home has it.\n", encoding="utf-8")
        base = {k: v for k, v in os.environ.items() if k not in SURFACE_VARIABLES}
        proc = subprocess.run([sys.executable, str(PROBE)], capture_output=True, text=True, timeout=180, check=False,
                              env={**base, **SURFACES[surface], "HERMES_HOME": str(home)}, cwd=ROOT)
        assert proc.returncode == 0, proc.stderr[-3000:]
        printed = json.loads(proc.stdout.strip().splitlines()[-1])
        _cache[surface] = {platform: _normalized(prompt, home) for platform, prompt in printed.items()}
    return _cache[surface]


def _golden() -> dict[str, dict[str, str]]:
    return json.loads(GOLDEN.read_text(encoding="utf-8"))


def test_write_goldens_when_asked(tmp_path_factory):
    if os.environ.get("APEX_WRITE_IDENTITY_GOLDENS") != "1":
        pytest.skip("goldens are only rewritten on request")
    GOLDEN.parent.mkdir(parents=True, exist_ok=True)
    recorded = {surface: _prompts(tmp_path_factory, surface) for surface in SURFACES}
    GOLDEN.write_text(json.dumps(recorded, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def test_the_golden_covers_every_surface_and_platform():
    golden = _golden()
    assert sorted(golden) == sorted(SURFACES)
    for surface in SURFACES:
        assert sorted(golden[surface]) == sorted(PLATFORMS)


@pytest.mark.parametrize("platform", PLATFORMS)
@pytest.mark.parametrize("surface", list(SURFACES))
def test_each_prompt_reads_like_its_golden(tmp_path_factory, surface, platform):
    assert _prompts(tmp_path_factory, surface)[platform] == _golden()[surface][platform]
