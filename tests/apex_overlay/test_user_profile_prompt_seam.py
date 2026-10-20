"""hc-991 first-use creator intake: the account's 用户画像 reaches each new Desktop session.

Desktop's main process mirrors the cloud's rendered segment into
``<root>/apex/user-profile-prompt.md`` (electron/apex-creator-profile.ts); the
apex-overlay seam turns that file into a plugin system-prompt section. These
tests pin where the file is read from, that a real agent's system prompt
carries it, and that no file means no section.
"""

from __future__ import annotations

import pytest

from agent.system_prompt import build_system_prompt
from apex_overlay import user_profile_prompt
from hermes_cli import plugins
from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest
from run_agent import AIAgent

SEGMENT = (
    "【用户画像 · 平台维护】\n"
    "以下是该用户的基础画像（跨该用户的所有助手共享），可能已过时。\n"
    "- 主要做的内容：好物测评\n"
    "- 主要发布平台：抖音、小红书\n"
    "【用户画像结束】"
)


@pytest.fixture
def root(tmp_path, monkeypatch):
    home = tmp_path / "apexnodes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    return home


def _write(root, text):
    target = root / "apex" / "user-profile-prompt.md"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")
    return target


def test_section_reads_the_mirrored_segment_at_the_root(root):
    _write(root, SEGMENT + "\n")
    assert user_profile_prompt.prompt_path() == root / "apex" / "user-profile-prompt.md"
    assert user_profile_prompt.render_section({}) == SEGMENT


def test_every_local_profile_reads_the_one_account_file(root, monkeypatch):
    _write(root, SEGMENT)
    profile_home = root / "profiles" / "work"
    profile_home.mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(profile_home))
    assert user_profile_prompt.prompt_path() == root / "apex" / "user-profile-prompt.md"
    assert user_profile_prompt.render_section({}) == SEGMENT


@pytest.mark.parametrize(
    "setup",
    [
        lambda root: None,  # signed out, or an account that answered nothing
        lambda root: _write(root, "   \n"),
        lambda root: _write(root, "画" * (user_profile_prompt.MAX_CHARS + 1)),
        lambda root: (root / "apex" / "user-profile-prompt.md").mkdir(parents=True),
    ],
    ids=["missing", "blank", "oversized", "unreadable"],
)
def test_no_usable_file_means_no_section(root, setup):
    setup(root)
    assert user_profile_prompt.render_section({}) == ""


def _manager_with_seam() -> PluginManager:
    manager = PluginManager()
    manager._discovered = True
    ctx = PluginContext(PluginManifest(name="apex-overlay", key="apex-overlay", source="bundled"), manager)
    assert user_profile_prompt.apply(ctx) is True
    return manager


def _real_agent(session_id: str) -> AIAgent:
    return AIAgent(
        api_key="test-key",
        base_url="https://openrouter.ai/api/v1",
        model="test/model",
        provider="openrouter",
        platform="cli",
        quiet_mode=True,
        skip_context_files=True,
        skip_memory=True,
        session_id=session_id,
    )


def test_a_new_session_prompt_carries_the_segment(root, monkeypatch):
    monkeypatch.setattr(
        "agent.coding_context.build_coding_workspace_block",
        lambda cwd=None: "Workspace (snapshot at session start):\n- Root: /pinned",
    )
    monkeypatch.setattr(plugins, "_plugin_manager", _manager_with_seam())

    assert "apex.user-profile" not in build_system_prompt(_real_agent("before-answers"))

    _write(root, SEGMENT)
    prompt = build_system_prompt(_real_agent("after-answers"))
    assert "## Plugin Context: apex.user-profile" in prompt
    assert "- 主要做的内容：好物测评" in prompt
    assert "- 主要发布平台：抖音、小红书" in prompt


def test_registering_twice_or_without_a_host_reports_false():
    manager = _manager_with_seam()
    ctx = PluginContext(PluginManifest(name="apex-overlay", key="apex-overlay", source="bundled"), manager)
    assert user_profile_prompt.apply(ctx) is False
    assert user_profile_prompt.apply(None) is False


def test_plugin_register_applies_the_seam():
    from tests.apex_overlay.conftest import run_plugin_register_with_stubbed_seams

    called = run_plugin_register_with_stubbed_seams("_user_profile_prompt_plugin_under_test")
    assert "user_profile_prompt" in called
