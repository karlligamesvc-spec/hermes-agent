"""hc-1131 身份层 golden: the whole system prompt on every surface, recorded on clean fork main.

result_delivery_probe.py builds each platform's prompt with a real agent and the real apex-overlay plugin in a
fresh process. The golden was recorded before hc-1131 changed anything, in that branch's first commit, so these
prompts are byte for byte what those surfaces built before it. Only product mode's chat differs, and only by the
one section. Developer mode has no golden of its own: clean main had no marker, so a marker must read exactly
like the same surface without one did.

Set APEX_WRITE_IDENTITY_GOLDENS=1 to rewrite it; CI never does.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

import pytest

from apex_overlay import browser_login_prompt, result_delivery_prompt
from hermes_cli.plugins_dispatch import PLUGIN_SECTIONS_END, format_system_prompt_section

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
GOLDEN = HERE / "__identity__" / "result-delivery-off" / "before-hc1131.json"
PROBE = HERE / "result_delivery_probe.py"
PLATFORMS = ("desktop", "tui", "cli", "subagent", "cron", "webhook", "api_server", "feishu", "weixin")
SURFACE_VARIABLES = ("APEX_SINGLE_THREAD_ACTIVE", "HERMES_DESKTOP", "HERMES_DESKTOP_TERMINAL", "HERMES_MANAGED_RUNTIME")
DESKTOP = {"HERMES_DESKTOP": "1"}
SINGLE_THREAD = {**DESKTOP, "APEX_SINGLE_THREAD_ACTIVE": "1"}


@dataclass(frozen=True)
class Surface:
    env: dict[str, str]
    golden: str
    marker: bool = False


GOLDEN_SURFACES = ("desktop-single-thread-off", "desktop-single-thread", "cloud")
SURFACES = {
    "desktop-single-thread-off": Surface(DESKTOP, "desktop-single-thread-off"),
    "desktop-single-thread-off-marker": Surface(DESKTOP, "desktop-single-thread-off", marker=True),
    "desktop-product-mode": Surface(SINGLE_THREAD, "desktop-single-thread"),
    "desktop-developer-mode": Surface(SINGLE_THREAD, "desktop-single-thread", marker=True),
    "cloud": Surface({"HERMES_MANAGED_RUNTIME": "1"}, "cloud"),
}

_cache: dict[str, dict[str, str]] = {}


def _without_machine_lines(prompt: str) -> str:
    """Its OS, the wall clock and its Python tools. The tools line is there only when the probe has something to
    say (tools/env_probe.py), so it goes whole, with the blank line after it."""
    prompt = re.sub(r"(?m)^Host: .*$", "Host: <pinned>", prompt)
    prompt = re.sub(r"(?m)^Conversation started: .*$", "Conversation started: <pinned>", prompt)
    return re.sub(r"(?m)^Python toolchain: .*\n+", "", prompt)


def _normalized(prompt: str, home: Path) -> str:
    """The prompt without what belongs to this machine: its folders and _without_machine_lines."""
    prompt = prompt.replace(str(home), "<HERMES_HOME>").replace(str(ROOT), "<CHECKOUT>")
    return _without_machine_lines(prompt.replace(str(Path.home()), "<USER_HOME>"))


def _prompts(tmp_path_factory, name: str) -> dict[str, str]:
    if name not in _cache:
        surface = SURFACES[name]
        home = tmp_path_factory.mktemp(f"hc1131-{name}")
        (home / "SOUL.md").write_text("SOUL.md as the user's home has it.\n", encoding="utf-8")
        if surface.marker:
            marker = home.joinpath(*result_delivery_prompt.DEVELOPER_MODE_MARKER)
            marker.parent.mkdir()
            marker.write_text("1\n", encoding="utf-8")
        base = {k: v for k, v in os.environ.items() if k not in SURFACE_VARIABLES}
        proc = subprocess.run([sys.executable, str(PROBE)], capture_output=True, text=True, timeout=180, check=False,
                              env={**base, **surface.env, "HERMES_HOME": str(home)}, cwd=ROOT)
        assert proc.returncode == 0, proc.stderr[-3000:]
        printed = json.loads(proc.stdout.strip().splitlines()[-1])
        _cache[name] = {platform: _normalized(prompt, home) for platform, prompt in printed.items()}
    return _cache[name]


def _golden() -> dict[str, dict[str, str]]:
    """As recorded on clean main, whose machine had a Python tools line; the file itself is never rewritten for that."""
    recorded = json.loads(GOLDEN.read_text(encoding="utf-8"))
    return {
        surface: {platform: _without_machine_lines(prompt) for platform, prompt in prompts.items()}
        for surface, prompts in recorded.items()
    }


def _heading(section_id: str) -> str:
    """The ``## Plugin Context: <id>`` line a section renders under, from the real formatter."""
    return format_system_prompt_section(section_id, "").split("\n", 1)[0]


def _expected(name: str, platform: str) -> str:
    golden = _golden()[SURFACES[name].golden][platform]
    if (name, platform) != ("desktop-product-mode", "desktop"):
        return golden
    # Sections render in sorted-id order (plugins_dispatch.render_system_prompt_sections).
    # hc-1179 apex.browser-login sorts between apex.approval-rules and apex.honesty, so it goes
    # in just before the apex.honesty heading.
    honesty = _heading("apex.honesty")
    assert golden.count(honesty) == 1
    browser = format_system_prompt_section(
        browser_login_prompt.SECTION_ID, browser_login_prompt.BROWSER_LOGIN_PROMPT)
    golden = golden.replace(honesty, f"{browser}\n\n{honesty}")
    # hc-1131 apex.user-results sorts after every other section: the last block before END.
    end = f"\n{PLUGIN_SECTIONS_END}"
    assert golden.count(end) == 1
    results = format_system_prompt_section(
        result_delivery_prompt.SECTION_ID, result_delivery_prompt.RESULT_DELIVERY_PROMPT)
    return golden.replace(end, f"\n\n{results}{end}")


def test_write_goldens_when_asked(tmp_path_factory):
    if os.environ.get("APEX_WRITE_IDENTITY_GOLDENS") != "1":
        pytest.skip("goldens are only rewritten on request")
    GOLDEN.parent.mkdir(parents=True, exist_ok=True)
    recorded = {name: _prompts(tmp_path_factory, name) for name in GOLDEN_SURFACES}
    GOLDEN.write_text(json.dumps(recorded, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


@pytest.mark.parametrize(
    "tools_line",
    [
        "Python toolchain: python3=3.14.7 (no pip module), pip=missing, PEP 668=yes (use venv or uv), uv=installed.\n\n",
        "Python toolchain: python3=3.14.7 (no pip module), pip→python3.14, uv=installed.\n\n",
        "",
    ],
    ids=["this-mac", "ci-linux", "nothing-to-say"],
)
def test_a_machines_python_tools_do_not_count(tools_line):
    prompt = f"Before.\n\n{tools_line}You are chatting inside the desktop app."
    assert _without_machine_lines(prompt) == "Before.\n\nYou are chatting inside the desktop app."


def test_only_the_tools_line_goes():
    """A prompt that merely mentions the words keeps them, and a real difference elsewhere still shows."""
    assert _without_machine_lines("See Python toolchain: below.\n") == "See Python toolchain: below.\n"
    assert _without_machine_lines("A\n") != _without_machine_lines("B\n")


def test_the_golden_covers_every_surface_and_platform():
    golden = _golden()
    assert sorted(golden) == sorted(GOLDEN_SURFACES)
    for name in GOLDEN_SURFACES:
        assert sorted(golden[name]) == sorted(PLATFORMS)


@pytest.mark.parametrize("platform", PLATFORMS)
@pytest.mark.parametrize("name", list(SURFACES))
def test_each_prompt_reads_like_its_golden(tmp_path_factory, name, platform):
    assert _prompts(tmp_path_factory, name)[platform] == _expected(name, platform)


def test_only_product_modes_chat_carries_the_rule(tmp_path_factory):
    carrying = {
        (name, platform)
        for name in SURFACES
        for platform, prompt in _prompts(tmp_path_factory, name).items()
        if result_delivery_prompt.RESULT_DELIVERY_PROMPT in prompt
    }
    assert carrying == {("desktop-product-mode", "desktop")}


def test_only_product_mode_desktop_carries_the_browser_login_rule(tmp_path_factory):
    """hc-1179: the browser-login handoff, exactly like the result-delivery rule, appears in one
    surface only — product-mode desktop — and never in developer mode, IM, the terminal, cron,
    the cloud, or any non-desktop platform."""
    carrying = {
        (name, platform)
        for name in SURFACES
        for platform, prompt in _prompts(tmp_path_factory, name).items()
        if browser_login_prompt.BROWSER_LOGIN_PROMPT in prompt
    }
    assert carrying == {("desktop-product-mode", "desktop")}
