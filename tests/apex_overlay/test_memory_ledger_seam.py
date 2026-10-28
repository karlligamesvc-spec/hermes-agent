"""hc-1016 记得你 v1: the account's memory ledger reaches each new Desktop session.

Desktop's main process mirrors the cloud's rendered ledger segment into
``<root>/apex/memory-ledger-prompt.md`` while ``desktop_features.single_thread``
is on (electron/apex-memory-ledger.ts). The apex-overlay seam turns that file
into a plugin system-prompt section and offers the ``apex_memory`` tool that
writes the ledger. These tests pin that the file is the only switch (no file:
no section, no tool), that a real agent's prompt and tool list follow it, and
what the tool sends and answers.
"""

from __future__ import annotations

import json

import pytest

from agent.system_prompt import build_system_prompt
from apex_overlay import memory_ledger
from hermes_cli import plugins
from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest
from plugins import apexnodes_gateway
from run_agent import AIAgent
from tools.registry import registry

SEGMENT = (
    "【APEX 记得的 · 记忆底账】\n"
    "下面是这位用户在 APEX 里的记忆底账。\n"
    "关于你：\n"
    "- [3f2a9c1d] 不露脸，女声配音\n"
    "最近发生的（新的在前，日期是北京时间）：\n"
    "- 10-21 [ab12cd34] 交付了收纳三样的成片\n"
    "【APEX 记得的 · 完】"
)


@pytest.fixture
def root(tmp_path, monkeypatch):
    home = tmp_path / "apexnodes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    return home


def _write(root, text):
    target = root / "apex" / "memory-ledger-prompt.md"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")
    return target


def test_section_and_switch_read_the_one_account_file(root, monkeypatch):
    assert memory_ledger.ledger_on() is False
    _write(root, SEGMENT + "\n")
    profile_home = root / "profiles" / "work"
    profile_home.mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(profile_home))
    assert memory_ledger.prompt_path() == root / "apex" / "memory-ledger-prompt.md"
    assert memory_ledger.ledger_on() is True
    assert memory_ledger.render_section({}) == SEGMENT


@pytest.mark.parametrize(
    "setup",
    [
        lambda root: None,  # feature off, or signed out
        lambda root: _write(root, "   \n"),
        lambda root: _write(root, "记" * (memory_ledger.MAX_CHARS + 1)),
        lambda root: (root / "apex" / "memory-ledger-prompt.md").mkdir(parents=True),
    ],
    ids=["missing", "blank", "oversized", "unreadable"],
)
def test_no_usable_file_means_no_section(root, setup):
    setup(root)
    assert memory_ledger.render_section({}) == ""


def _manager_with_seam() -> PluginManager:
    manager = PluginManager()
    manager._discovered = True
    ctx = PluginContext(PluginManifest(name="apex-overlay", key="apex-overlay", source="bundled"), manager)
    assert memory_ledger.apply(ctx) is True
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


def _tool_names(agent: AIAgent) -> set[str]:
    return {tool["function"]["name"] for tool in (agent.tools or [])}


def _callable_names(agent: AIAgent) -> set[str]:
    """Visible tools plus the deferred ones the session may reach through ``tool_call``."""
    from agent.tool_executor import _tool_search_scoped_names

    return _tool_names(agent) | set(_tool_search_scoped_names(agent))


def test_a_new_session_carries_the_ledger_and_the_tool_only_with_the_file(root, monkeypatch):
    monkeypatch.setattr(
        "agent.coding_context.build_coding_workspace_block",
        lambda cwd=None: "Workspace (snapshot at session start):\n- Root: /pinned",
    )
    monkeypatch.setattr(plugins, "_plugin_manager", _manager_with_seam())
    try:
        before = _real_agent("feature-off")
        assert "apex.memory-ledger" not in build_system_prompt(before)
        assert "apex_memory" not in _callable_names(before)
        assert "memory" in _tool_names(before), "the memory toolset must be on for this check to mean anything"

        _write(root, SEGMENT)
        after = _real_agent("feature-on")
        prompt = build_system_prompt(after)
        assert "## Plugin Context: apex.memory-ledger" in prompt
        assert "- [3f2a9c1d] 不露脸，女声配音" in prompt
        assert "apex_memory" in _callable_names(after)
    finally:
        registry.deregister(memory_ledger.TOOL_NAME)


class _FakeGateway:
    GatewayError = apexnodes_gateway.GatewayError

    def __init__(self, reply=None, error=None):
        self.calls = []
        self.reply = reply or {}
        self.error = error

    def agent_api_key(self):
        return "agent-key"

    def request_json(self, method, path, payload=None, **kwargs):
        self.calls.append((method, path, payload))
        if self.error is not None:
            raise self.error
        return self.reply


@pytest.fixture
def gateway(monkeypatch, root):
    holder = {}
    _write(root, SEGMENT)

    def install(**kwargs):
        fake = _FakeGateway(**kwargs)
        fake.refreshes = []
        monkeypatch.setattr(memory_ledger, "_gateway", lambda: fake)
        # hc-1097 re-reads the ledger in the background after a change; test_memory_ledger_live_seam covers it.
        monkeypatch.setattr(memory_ledger, "refresh_mirror_soon", lambda: fake.refreshes.append(True))
        holder["fake"] = fake
        return fake

    return install


def test_add_posts_to_the_agent_key_route_and_returns_the_entry(gateway):
    entry = {"id": "3f2a9c1d-0000-4000-8000-000000000001", "ref": "3f2a9c1d", "kind": "about_you",
             "content": "不露脸", "source": "desktop", "created_at": "x", "updated_at": "x"}
    fake = gateway(reply={"entry": entry, "created": True})
    result = json.loads(memory_ledger.handle({"action": "add", "kind": "about_you", "content": " 不露脸 "}))
    assert fake.calls == [("POST", "/api/v1/media/memory-ledger/entries", {"kind": "about_you", "content": "不露脸"})]
    assert fake.refreshes == [True]
    assert result == {"ok": True, "action": "add", "created": True,
                      "entry": {"id": entry["id"], "ref": "3f2a9c1d", "kind": "about_you", "content": "不露脸"}}


def test_forget_deletes_by_ref(gateway):
    fake = gateway(reply={"deleted": "3f2a9c1d-0000-4000-8000-000000000001"})
    result = json.loads(memory_ledger.handle({"action": "forget", "ref": "3f2a9c1d"}))
    assert fake.calls == [("DELETE", "/api/v1/media/memory-ledger/entries/3f2a9c1d", None)]
    assert fake.refreshes == [True]
    assert result == {"ok": True, "action": "forget", "deleted": "3f2a9c1d-0000-4000-8000-000000000001"}


@pytest.mark.parametrize(
    "args",
    [
        {},
        {"action": "replace"},
        {"action": "add", "kind": "works", "content": "x"},
        {"action": "add", "kind": "recent", "content": "  "},
        {"action": "forget"},
    ],
)
def test_bad_calls_never_reach_the_cloud(gateway, args):
    fake = gateway()
    result = json.loads(memory_ledger.handle(args))
    assert "error" in result and fake.calls == [] and fake.refreshes == []


@pytest.mark.parametrize("code", sorted(memory_ledger.REFUSALS))
def test_cloud_refusals_are_said_in_words(gateway, code):
    gateway(error=apexnodes_gateway.GatewayError("服务端返回 422", status=422, code=code))
    result = json.loads(memory_ledger.handle({"action": "add", "kind": "recent", "content": "x"}))
    assert result == {"error": memory_ledger.REFUSALS[code], "code": code}


def test_other_gateway_failures_pass_the_gateways_own_sentence(gateway):
    gateway(error=apexnodes_gateway.GatewayError("网络不通，稍后再试", code="network_unreachable"))
    result = json.loads(memory_ledger.handle({"action": "forget", "ref": "3f2a9c1d"}))
    assert result == {"error": "网络不通，稍后再试", "code": "network_unreachable"}


def test_the_tool_refuses_without_the_mirror_and_sends_nothing(gateway, root):
    fake = gateway(reply={"entry": {}, "created": True})
    (root / "apex" / "memory-ledger-prompt.md").unlink()
    result = json.loads(memory_ledger.handle({"action": "add", "kind": "about_you", "content": "不露脸"}))
    assert result == {"error": memory_ledger.LEDGER_OFF}
    assert fake.calls == []


def test_a_flip_of_the_mirror_refreshes_the_memoized_tool_list(root, monkeypatch):
    import model_tools

    cleared = []
    monkeypatch.setattr(model_tools, "_clear_tool_defs_cache", lambda: cleared.append(True))
    monkeypatch.setattr(memory_ledger, "_last_seen", None)
    memory_ledger.render_section({})  # first look: nothing to compare with
    memory_ledger.render_section({})  # unchanged
    assert cleared == []
    _write(root, SEGMENT)
    memory_ledger.render_section({})  # appeared
    memory_ledger.render_section({})
    (root / "apex" / "memory-ledger-prompt.md").unlink()
    memory_ledger.render_section({})  # went away
    assert cleared == [True, True]


def test_the_runtime_still_has_the_memo_this_seam_clears():
    import model_tools

    assert callable(getattr(model_tools, "_clear_tool_defs_cache", None))
    assert hasattr(model_tools, "_tool_defs_cache")


def test_registering_twice_or_without_a_host_reports_false():
    manager = _manager_with_seam()
    try:
        ctx = PluginContext(PluginManifest(name="apex-overlay", key="apex-overlay", source="bundled"), manager)
        assert memory_ledger.apply(ctx) is False
        assert memory_ledger.apply(None) is False
    finally:
        registry.deregister(memory_ledger.TOOL_NAME)


def test_plugin_register_applies_the_seam():
    from tests.apex_overlay.conftest import run_plugin_register_with_stubbed_seams

    called = run_plugin_register_with_stubbed_seams("_memory_ledger_plugin_under_test")
    assert "memory_ledger" in called
