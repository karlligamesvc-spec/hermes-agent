"""hc-1275: the assistant's own plugin, skill and MCP installs ask the user first.

``apex_overlay.install_approval`` appends four rules to
``tools.approval_detection.DANGEROUS_PATTERNS_COMPILED``: three install families and the settings
that switch the same things (and approvals) on or off. Every test here applies the seam to a
private copy of that list (the ``applied`` fixture), so nothing leaks into later test files.
"""

from __future__ import annotations

import pytest

from tools import approval_context
import tools.approval_detection as detection
from apex_overlay import install_approval
from tools.approval import check_all_command_guards

PLUGIN = install_approval.PLUGIN_DESCRIPTION
SKILL = install_approval.SKILL_DESCRIPTION
MCP = install_approval.MCP_DESCRIPTION
SETTINGS = install_approval.SETTINGS_DESCRIPTION
OURS = {PLUGIN, SKILL, MCP, SETTINGS}


@pytest.fixture
def applied(monkeypatch):
    monkeypatch.setattr(detection, "DANGEROUS_PATTERNS_COMPILED", list(detection.DANGEROUS_PATTERNS_COMPILED))
    assert install_approval.apply() is True
    return detection.DANGEROUS_PATTERNS_COMPILED


def _ours(rules) -> list[str]:
    return [description for _, description in rules if description in OURS]


def test_the_engine_alone_lets_the_install_through(monkeypatch):
    """The gap this seam closes, measured on the engine without it (2026-11-22 audit)."""
    monkeypatch.setattr(detection, "DANGEROUS_PATTERNS_COMPILED", list(detection.DANGEROUS_PATTERNS_COMPILED))
    assert _ours(detection.DANGEROUS_PATTERNS_COMPILED) == []
    assert detection.detect_dangerous_command("hermes plugins install kinocut --enable --yes-deps") == (False, None, None)


def test_apply_appends_each_rule_once(applied):
    assert sorted(_ours(applied)) == sorted(OURS)
    assert install_approval.apply() is True
    assert sorted(_ours(applied)) == sorted(OURS)


@pytest.mark.parametrize(("command", "description"), [
    ("hermes plugins install kinocut --enable --yes-deps", PLUGIN),
    ("hermes plugins install someone/hermes-plugin-x --force --enable --yes-deps", PLUGIN),
    ("hermes -p work plugins install https://github.com/someone/x.git", PLUGIN),
    ("hermes --profile=work plugins enable parkedmem", PLUGIN),
    ("/Users/me/.apexnodes/versions/0.18.2/venv/bin/hermes plugins update", PLUGIN),
    ("python3 -m hermes_cli.main plugins install x", PLUGIN),
    ("HERMES_HOME=~/.apexnodes hermes plugins install x", PLUGIN),
    ("cd /tmp && hermes plugins pack install https://example.com/pack.yaml", PLUGIN),
    ("hermes plugins auto-update on", PLUGIN),
    ("hermes plugins autoupdate on", PLUGIN),
    ("hermes plugins adopt my-clone", PLUGIN),
    ("hermes plugins trust-update-url my-clone", PLUGIN),
    ("hermes plugins validate ./p --install-deps", PLUGIN),
    ("ls; HERMES.EXE Plugins Install x", PLUGIN),
    ("hermes skills install official/red-teaming/godmode --yes", SKILL),
    ("hermes skills install https://example.com/SKILL.md", SKILL),
    ("hermes skills update", SKILL),
    ("hermes skills tap add owner/repo", SKILL),
    ("hermes skills snapshot import skills.json", SKILL),
    ("hermes mcp add fs --command npx --args -y @someone/server", MCP),
    ("hermes mcp install deepwiki", MCP),
    ("hermes config set approvals.mode off", SETTINGS),
    ("hermes -p work config set approvals.mode off", SETTINGS),
    ("hermes config set command_allowlist '[\"npm test\"]'", SETTINGS),
    ("hermes config set plugins.enabled '[apex-overlay, kinocut]'", SETTINGS),
    ("hermes config set --force plugins.auto_apply true", SETTINGS),
    ("hermes config set skills.disabled '[]'", SETTINGS),
    ("hermes config set \"skills.external_dirs\" '[~/x]'", SETTINGS),
    ("hermes config set mcp_servers.fs.command npx", SETTINGS),
    ("hermes config unset agent.disabled_toolsets", SETTINGS),
])
def test_install_commands_ask(applied, command, description):
    assert detection.detect_dangerous_command(command) == (True, description, description)


@pytest.mark.parametrize("command", [
    "hermes plugins list",
    "hermes plugins search video",
    "hermes plugins browse",
    "hermes plugins check-updates",
    "hermes plugins auto-update",
    "hermes plugins auto-update off",
    "hermes plugins show kinocut",
    "hermes plugins validate ./p",
    "hermes plugins disable x",
    "hermes plugins pack show pack.yaml",
    "hermes skills list",
    "hermes skills search video",
    "hermes skills inspect x",
    "hermes skills tap list",
    "hermes mcp list",
    "hermes mcp test x",
    "hermes mcp catalog",
    "hermes config set display.skin mono",
    "hermes config set memory.provider honcho",
    "hermes config set agent.max_turns 100",
    "hermes config show",
    "hermes config path",
    "pip install left-pad",
    "cat ~/.apexnodes/plugins/x/README.md",
])
def test_reading_and_switching_off_stay_unprompted(applied, command):
    assert detection.detect_dangerous_command(command)[1] not in OURS


def test_the_desktop_card_carries_the_install_description(applied, monkeypatch):
    """End to end through the gate APEX Desktop's terminal calls (approvals.mode manual)."""
    monkeypatch.setattr(approval_context, "_get_approval_mode", lambda: "manual")
    monkeypatch.setenv("HERMES_INTERACTIVE", "1")
    monkeypatch.delenv("HERMES_CRON_SESSION", raising=False)
    asked = []

    def deny(*args, **kwargs):
        asked.append((args, kwargs))
        return "deny"

    result = check_all_command_guards("hermes plugins install kinocut --enable --yes-deps", "local",
                                      approval_callback=deny)
    assert result["approved"] is False
    assert len(asked) == 1
    assert any(PLUGIN in str(value) for value in (*asked[0][0], *asked[0][1].values()))


def test_approvals_off_still_runs_without_asking(applied, monkeypatch):
    """Cloud native agents run with approvals off; the seam changes nothing there."""
    monkeypatch.setattr(approval_context, "_get_approval_mode", lambda: "off")
    monkeypatch.setenv("HERMES_INTERACTIVE", "1")
    asked = []
    result = check_all_command_guards("hermes plugins install kinocut", "local",
                                      approval_callback=lambda *a, **k: asked.append(a) or "deny")
    assert result["approved"] is True
    assert asked == []


def test_only_the_install_descriptions_carry_the_desktop_risk_word():
    """step-intent.ts RISKS maps /third-party/i to the card's install warning; a settings change
    installs nothing, so its card keeps the plain sentence."""
    assert all("third-party" in description for description in (PLUGIN, SKILL, MCP))
    assert "third-party" not in SETTINGS


def test_a_missing_rule_list_reports_false(monkeypatch):
    monkeypatch.delattr(detection, "DANGEROUS_PATTERNS_COMPILED")
    assert install_approval.apply() is False


def test_plugin_register_applies_the_seam():
    from tests.apex_overlay.conftest import run_plugin_register_with_stubbed_seams

    assert "install_approval" in run_plugin_register_with_stubbed_seams("_install_approval_plugin_under_test")
