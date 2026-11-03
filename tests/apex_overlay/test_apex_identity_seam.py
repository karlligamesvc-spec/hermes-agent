"""hc-1103: who the engine says it is and which version it reports, on APEX surfaces (apex_overlay/apex_identity.py).

test_apex_identity_exits.py pins every exit's words per surface against goldens from clean main. These
tests pin the mechanics behind them: which environment is which surface; that the identity keeps
upstream's behavior rules; that a moved upstream line is reported, not guessed; that every way ``/version``
reaches a user goes through the seam (IM executor, Desktop's slash worker, ``hermes --version`` started
by the agent's own terminal commands); that the cloud keeps the engine's ``hermes --version`` for
operators; and that plugin discovery never imports what it patches.
"""

from __future__ import annotations

import json
import logging
import re
import subprocess
import sys
import types
from pathlib import Path

import pytest

from agent import prompt_builder, system_prompt
from apex_overlay import apex_identity, desktop_version, post_import, single_thread_prompt
from hermes_cli import slash_exec
from hermes_cli.slash_exec import CommandContext, execute_command
from tools import voice_live

ROOT = Path(__file__).resolve().parents[2]
STATE = {
    "schema": 1,
    "app_version": "0.17.67",
    "engine": {"version": "v2026.10.27-fork.aa8e554e", "commit": "aa8e554e"},
    "update": {"status": "latest", "version": None, "reason": None},
}
DESKTOP_REPLY = "APEX 0.17.67（自带的 AI 引擎 2026.10.27，跟着 APEX 一起更新）\n更新：已经是最新版本。"


@pytest.fixture(autouse=True)
def _home(monkeypatch, tmp_path):
    monkeypatch.delenv(single_thread_prompt.SWITCH_ENV, raising=False)
    monkeypatch.delenv(apex_identity.MANAGED_ENV, raising=False)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    # The seam patches these in place; restore upstream's after every test.
    monkeypatch.setattr(system_prompt, "DEFAULT_AGENT_IDENTITY", prompt_builder.DEFAULT_AGENT_IDENTITY)
    for name in desktop_version._HELP_ATTRS:
        monkeypatch.setattr(system_prompt, name, getattr(prompt_builder, name))
    monkeypatch.setitem(slash_exec.EXECUTORS, "version", slash_exec._exec_version)
    monkeypatch.setattr("hermes_cli.banner.format_banner_version_label", lambda: "Hermes Agent v0.22.5 · stable")
    return tmp_path / "home"


def _write_state(home: Path) -> None:
    (home / "apex").mkdir(parents=True, exist_ok=True)
    (home / "apex" / "desktop-version.json").write_text(json.dumps(STATE), encoding="utf-8")


def _switch(monkeypatch, name: str, value: str = "1") -> None:
    monkeypatch.setenv(name, value)


# ── 1. which surface ────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("env", "where"),
    [
        ({}, None),
        ({"APEX_SINGLE_THREAD_ACTIVE": "0"}, None),
        ({"APEX_SINGLE_THREAD_ACTIVE": "true"}, None),
        ({"HERMES_MANAGED_RUNTIME": "0"}, None),
        ({"HERMES_MANAGED_RUNTIME": ""}, None),
        ({"APEX_SINGLE_THREAD_ACTIVE": "1"}, "desktop"),
        ({"HERMES_MANAGED_RUNTIME": "1"}, "cloud"),
        ({"HERMES_MANAGED_RUNTIME": " Yes "}, "cloud"),
        ({"HERMES_MANAGED_RUNTIME": "on"}, "cloud"),
        ({"APEX_SINGLE_THREAD_ACTIVE": "1", "HERMES_MANAGED_RUNTIME": "1"}, "desktop"),
    ],
)
def test_which_surface(monkeypatch, env, where):
    for name, value in env.items():
        _switch(monkeypatch, name, value)
    assert apex_identity.surface() == where


def test_off_an_apex_surface_nothing_is_patched_or_armed():
    before = (system_prompt.DEFAULT_AGENT_IDENTITY, system_prompt.HERMES_AGENT_HELP_GUIDANCE,
              system_prompt.HERMES_AGENT_HELP_GUIDANCE_NO_SKILLS, slash_exec.EXECUTORS["version"])
    pending = set(post_import.pending_modules())

    assert apex_identity.apply() is True

    assert (system_prompt.DEFAULT_AGENT_IDENTITY, system_prompt.HERMES_AGENT_HELP_GUIDANCE,
            system_prompt.HERMES_AGENT_HELP_GUIDANCE_NO_SKILLS, slash_exec.EXECUTORS["version"]) == before
    assert set(post_import.pending_modules()) == pending
    assert execute_command("version", CommandContext(surface="gateway")).text == "Hermes Agent v0.22.5 · stable"


# ── 2. the identity ─────────────────────────────────────────────────────────


@pytest.mark.parametrize("switch", ["APEX_SINGLE_THREAD_ACTIVE", "HERMES_MANAGED_RUNTIME"])
def test_the_identity_names_apex_and_keeps_upstreams_rules(monkeypatch, switch):
    _switch(monkeypatch, switch)
    assert apex_identity.apply() is True

    identity = system_prompt.DEFAULT_AGENT_IDENTITY
    upstream = prompt_builder.DEFAULT_AGENT_IDENTITY
    assert identity.startswith(apex_identity.APEX_IDENTITY)
    assert identity[len(apex_identity.APEX_IDENTITY):] == upstream[len(apex_identity.UPSTREAM_IDENTITY):]
    assert not re.search(r"Hermes|Nous", identity)
    # Applying twice (a second plugin manager) changes nothing more.
    assert apex_identity.apply() is True
    assert system_prompt.DEFAULT_AGENT_IDENTITY == identity


def test_the_identity_is_the_first_sentence_of_apex_desktops_own_soul():
    source = (ROOT / "apps" / "desktop" / "shared" / "apex-default-soul.ts").read_text(encoding="utf-8")
    first = re.search(r"APEX_DESKTOP_DEFAULT_SOUL =\s*'([^']+?\.) ", source).group(1)
    assert first == apex_identity.APEX_IDENTITY


def test_a_moved_upstream_identity_is_reported_not_guessed(caplog):
    module = types.SimpleNamespace(DEFAULT_AGENT_IDENTITY="You are Hermes, the agent from Nous. Be direct.")
    with caplog.at_level(logging.ERROR, logger="apex_overlay.apex_identity"):
        assert apex_identity._install_identity(module) is False
    assert module.DEFAULT_AGENT_IDENTITY == "You are Hermes, the agent from Nous. Be direct."
    assert "DEFAULT_AGENT_IDENTITY" in caplog.text


def test_the_cloud_help_line_is_apexs_in_both_variants(monkeypatch):
    _switch(monkeypatch, "HERMES_MANAGED_RUNTIME")
    assert apex_identity.apply() is True
    assert system_prompt.HERMES_AGENT_HELP_GUIDANCE == desktop_version.APEX_HELP_GUIDANCE
    assert system_prompt.HERMES_AGENT_HELP_GUIDANCE_NO_SKILLS == desktop_version.APEX_HELP_GUIDANCE


def test_desktop_leaves_the_help_line_to_the_version_seam(monkeypatch):
    _switch(monkeypatch, "APEX_SINGLE_THREAD_ACTIVE")
    assert apex_identity.apply() is True
    assert system_prompt.HERMES_AGENT_HELP_GUIDANCE_NO_SKILLS == prompt_builder.HERMES_AGENT_HELP_GUIDANCE_NO_SKILLS


# ── 3. /version, every way it reaches a user ────────────────────────────────


@pytest.mark.parametrize(
    ("switch", "with_file", "reply"),
    [
        ("APEX_SINGLE_THREAD_ACTIVE", True, DESKTOP_REPLY),
        ("APEX_SINGLE_THREAD_ACTIVE", False, apex_identity.DESKTOP_VERSION_UNKNOWN),
        ("HERMES_MANAGED_RUNTIME", False, None),
    ],
    ids=["desktop", "desktop-no-file", "cloud"],
)
def test_im_version_says_apex(monkeypatch, _home, switch, with_file, reply):
    monkeypatch.setattr("hermes_cli.__release_date__", "2026.8.31")
    _switch(monkeypatch, switch)
    if with_file:
        _write_state(_home)
    assert apex_identity.apply() is True

    text = execute_command("version", CommandContext(surface="gateway")).text

    assert text == (reply or apex_identity.CLOUD_VERSION.format(release="2026.8.31"))
    assert not re.search(r"(?i)hermes|nous|fork", text)


def test_im_version_from_the_gateway_handler(monkeypatch, _home):
    from gateway.slash_commands import _execute

    _switch(monkeypatch, "APEX_SINGLE_THREAD_ACTIVE")
    _write_state(_home)
    assert apex_identity.apply() is True
    assert _execute("version").text == DESKTOP_REPLY


def test_im_version_falls_back_when_the_surface_goes_away(monkeypatch):
    _switch(monkeypatch, "HERMES_MANAGED_RUNTIME")
    assert apex_identity.apply() is True
    wrapped = slash_exec.EXECUTORS["version"]
    assert apex_identity.apply() is True
    assert slash_exec.EXECUTORS["version"] is wrapped  # a second plugin manager wraps nothing more
    monkeypatch.delenv(apex_identity.MANAGED_ENV)
    assert execute_command("version", CommandContext(surface="gateway")).text == "Hermes Agent v0.22.5 · stable"


def test_cloud_version_without_a_release_date(monkeypatch):
    _switch(monkeypatch, "HERMES_MANAGED_RUNTIME")
    monkeypatch.setattr("hermes_cli.__release_date__", "")
    assert apex_identity.cloud_version_reply() == apex_identity.CLOUD_VERSION_NO_RELEASE


def test_desktop_slash_version_goes_through_the_cli_handler(monkeypatch, _home, capsys):
    """Desktop sends /version to its slash worker, a HermesCLI whose handler prints print_fast_version_info."""
    from hermes_cli.cli_loops_mixin import CLILoopsMixin

    _switch(monkeypatch, "APEX_SINGLE_THREAD_ACTIVE")
    _write_state(_home)
    monkeypatch.setattr("hermes_cli.source_check.check_for_updates", lambda passive=True: pytest.fail("checked"))

    CLILoopsMixin._cmd_version(None, "/version")

    assert capsys.readouterr().out == DESKTOP_REPLY + "\n"


def _fast_version(env: dict, home: Path) -> subprocess.CompletedProcess:
    script = "import sys; from hermes_cli.main import main; sys.argv = ['hermes', '--version']; main()"
    base = {k: v for k, v in __import__("os").environ.items()
            if k not in (single_thread_prompt.SWITCH_ENV, apex_identity.MANAGED_ENV)}
    return subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, timeout=120, check=False,
                          cwd=ROOT, env={**base, **env, "HERMES_HOME": str(home), "PYTHONPATH": str(ROOT)})


def test_hermes_version_in_desktops_single_thread_mode_is_apexs(_home):
    _write_state(_home)
    proc = _fast_version({single_thread_prompt.SWITCH_ENV: "1"}, _home)
    assert proc.returncode == 0, proc.stderr[-2000:]
    assert proc.stdout == DESKTOP_REPLY + "\n"


def test_hermes_version_in_the_cloud_stays_the_engines(monkeypatch, capsys):
    """Only operators can run it there (hosted agents have no terminal tool); they need the engine's facts."""
    _switch(monkeypatch, "HERMES_MANAGED_RUNTIME")
    from hermes_cli import _startup_fast

    monkeypatch.setattr(_startup_fast, "project_root_str", lambda: "/opt/hermes")
    _startup_fast.print_fast_version_info(check_updates=False)
    out = capsys.readouterr().out
    assert out.startswith("Hermes Agent v0.22.5 · stable\nInstall directory: /opt/hermes\n")


def test_the_agents_own_terminal_commands_keep_the_switch():
    """`hermes --version` run through the terminal tool must see single-thread mode to answer as APEX."""
    from tools.environments.local import _sanitize_subprocess_env

    env = _sanitize_subprocess_env({"PATH": "/usr/bin", single_thread_prompt.SWITCH_ENV: "1"})
    assert env.get(single_thread_prompt.SWITCH_ENV) == "1"


# ── 4. the realtime voice persona ───────────────────────────────────────────


def test_the_voice_persona_carries_apexs_name_in_single_thread_mode(monkeypatch):
    assert voice_live.live_instructions({}) == voice_live.LIVE_PERSONA
    _switch(monkeypatch, "APEX_SINGLE_THREAD_ACTIVE")

    persona = voice_live.live_instructions({"instructions": "Speak Chinese."})

    assert persona.startswith("You are APEX, a calm and friendly voice assistant.")
    assert "- APEX agent: a full AI agent with tools" in persona
    assert "Hermes" not in persona
    assert persona.endswith("\n\nSpeak Chinese.")
    assert persona.replace("APEX", "Hermes").removesuffix("\n\nSpeak Chinese.") == voice_live.LIVE_PERSONA


def test_a_moved_voice_line_keeps_upstreams_persona(monkeypatch, caplog):
    _switch(monkeypatch, "APEX_SINGLE_THREAD_ACTIVE")
    moved = voice_live.LIVE_PERSONA.replace("- Hermes agent:", "- Hermes backend:")
    with caplog.at_level(logging.ERROR, logger="apex_overlay.apex_identity"):
        assert apex_identity.apex_live_persona(moved) == moved
    assert "voice persona" in caplog.text


# ── 5. plugin discovery never imports what it patches ───────────────────────


@pytest.mark.parametrize("switch", ["APEX_SINGLE_THREAD_ACTIVE", "HERMES_MANAGED_RUNTIME"])
def test_apply_arms_without_importing(switch, tmp_path):
    script = (
        "import sys\n"
        "from apex_overlay import apex_identity\n"
        "assert apex_identity.apply() is True\n"
        "loaded = sorted({'agent.system_prompt', 'hermes_cli.slash_exec'} & set(sys.modules))\n"
        "assert loaded == [], loaded\n"
        "from agent import system_prompt\n"
        "from hermes_cli import slash_exec\n"
        "assert system_prompt.DEFAULT_AGENT_IDENTITY.startswith(apex_identity.APEX_IDENTITY)\n"
        "assert getattr(slash_exec.EXECUTORS['version'], apex_identity._MARK)\n"
        "print('ok')\n"
    )
    base = {k: v for k, v in __import__("os").environ.items()
            if k not in (single_thread_prompt.SWITCH_ENV, apex_identity.MANAGED_ENV)}
    proc = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, timeout=120, check=False,
                          cwd=ROOT, env={**base, switch: "1", "HERMES_HOME": str(tmp_path), "PYTHONPATH": str(ROOT)})
    assert proc.stdout.strip() == "ok", proc.stderr[-2000:]
