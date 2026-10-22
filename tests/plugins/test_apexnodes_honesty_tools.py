"""apexnodes-honesty-tools on the fork's real plugin path (honesty_verify, hc-1023).

The plugin is a byte-identical copy of apex-nodes ``app/runtime_plugins/apexnodes-honesty-tools``
(apex-nodes CI compares the bytes and runs the behaviour tables against the real lexicon). The
lexicon is not in this repo: APEX Desktop receives it with the copy-compliance-check platform skill
after login, under ``HERMES_HOME/skills/apexnodes/copy-compliance-check/references/ad-lexicon.json``.
Here, with a small lexicon of the same shape:

* a real ``PluginContext`` registers ``honesty_verify`` in the ``skills`` toolset and the registry
  dispatches it;
* with the lexicon under this runtime's ``get_hermes_home()`` (the Desktop layout) a 必须改 hit is
  FAIL and comes back with ``corrected_text``; a 要证据 hit is NEEDS_REVIEW;
* without the lexicon (not signed in yet, old server) the tool answers with an error that says the
  check did not run, never PASS;
* Desktop enables the plugin: ``cli-config.yaml.example`` lists it.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import types
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
PLUGIN_DIR = REPO_ROOT / "plugins" / "apexnodes-honesty-tools"

SCOPE_ALL = {"platforms": ["*"], "scenes": ["*"], "categories": ["*"]}
LEXICON = {
    "schema": "apex-ad-lexicon/1",
    "version": "test",
    "levels": {
        "must_fix": {"column": "必须改"},
        "needs_evidence": {"column": "要证据"},
        "suggest": {"column": "建议改"},
    },
    "platforms": {"douyin": "抖音", "xiaohongshu": "小红书", "other": "其他"},
    "platform_aliases": {"抖音": "douyin"},
    "scenes": {"commerce": "挂车带货", "content": "纯内容"},
    "scene_aliases": {"带货": "commerce"},
    "categories": {"general": {"label": "一般商品"}},
    "category_aliases": {},
    "defaults": {"platform_when_scene_given": "douyin"},
    "legal_review_line": "上线前请法务看一眼。",
    "negation_markers": ["不是", "不"],
    "rules": [
        {
            "id": "T1", "title": "效果保证", "match": "pattern", "patterns": ["100\\s*%"], "exclude": [],
            "negation_exempt": True, "scope": SCOPE_ALL, "level": "must_fix", "overrides": [], "outside_scope": "suggest",
            "why": "效果保证", "fix": {"action": "delete_match", "how": "删掉", "example": ""},
            "basis": [{"code": "L1", "ref": "第28条", "date": "2021-04-29"}],
        },
        {
            "id": "T2", "title": "进口", "match": "pattern", "patterns": ["进口"], "exclude": [],
            "negation_exempt": False, "scope": SCOPE_ALL, "level": "needs_evidence", "overrides": [], "outside_scope": "suggest",
            "why": "要与详情一致", "fix": {"action": "delete_clause", "how": "照详情写", "example": ""},
            "evidence": "商品详情", "basis": [{"code": "P1", "ref": "", "date": "2026-08-06"}],
        },
        {"id": "M1", "title": "画面", "match": "manual", "scope": SCOPE_ALL, "level": "must_fix", "overrides": [], "outside_scope": "suggest",
         "why": "看画面", "fix": {"action": "delete_clause", "how": "删", "example": ""}, "basis": []},
    ],
    "required_notices": [],
    "reminders": [],
}


def _load_plugin():
    if "hermes_plugins" not in sys.modules:
        namespace = types.ModuleType("hermes_plugins")
        namespace.__path__ = []  # type: ignore[attr-defined]
        sys.modules["hermes_plugins"] = namespace
    name = "hermes_plugins.apexnodes_honesty_tools"
    spec = importlib.util.spec_from_file_location(name, PLUGIN_DIR / "__init__.py", submodule_search_locations=[str(PLUGIN_DIR)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def dispatch(monkeypatch, tmp_path):
    from hermes_cli import plugins as plugins_mod
    from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest
    from tools.registry import registry

    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    manager = PluginManager()
    monkeypatch.setattr(plugins_mod, "_plugin_manager", manager)
    module = _load_plugin()
    manifest = PluginManifest(name="apexnodes-honesty-tools", version="0.2.0", description="test", source="bundled")
    module.register(PluginContext(manifest, manager))
    scope = manager.scope_key
    entry = registry.get_entry("honesty_verify", scope=scope)
    assert entry is not None and entry.toolset == "skills"

    def call(args: dict) -> dict:
        return json.loads(registry.dispatch("honesty_verify", args, scope=scope))

    yield call
    registry.deregister("honesty_verify", scope=scope)


def _install_lexicon(home: Path) -> Path:
    from hermes_constants import get_hermes_home

    assert Path(get_hermes_home()) == home
    target = home / "skills" / "apexnodes" / "copy-compliance-check" / "references" / "ad-lexicon.json"
    target.parent.mkdir(parents=True)
    target.write_text(json.dumps(LEXICON, ensure_ascii=False), encoding="utf-8")
    return target


def test_must_fix_fails_with_a_corrected_version_on_the_desktop_layout(dispatch, tmp_path):
    _install_lexicon(tmp_path / "home")

    result = dispatch({"text": "这款面霜100%有效，进口原料。", "platform": "抖音", "scene": "带货"})

    assert result["status"] == "FAIL"
    assert result["context"]["platform"] == "douyin" and result["context"]["scene"] == "commerce"
    assert [row["code"] for row in result["columns"]["必须改"]] == ["T1"]
    assert [row["code"] for row in result["columns"]["要证据"]] == ["T2"]
    assert result["corrected_text"] == "这款面霜有效，进口原料。"


def test_evidence_items_alone_need_review_and_clean_text_passes(dispatch, tmp_path):
    _install_lexicon(tmp_path / "home")

    assert dispatch({"text": "进口原料。", "scene": "commerce"})["status"] == "NEEDS_REVIEW"
    assert dispatch({"text": "效果不是100%，因人而异。", "scene": "commerce"})["status"] == "PASS"
    clean = dispatch({"text": "质地清爽。"})
    assert clean["status"] == "PASS" and clean["issues"] == []


def test_without_the_lexicon_the_check_says_it_did_not_run(dispatch):
    result = dispatch({"text": "这款面霜100%有效。"})

    assert "status" not in result
    assert "合规词库不可用" in result["error"] and "不要当成通过" in result["error"]


def test_desktop_config_example_enables_the_plugin():
    text = (REPO_ROOT / "cli-config.yaml.example").read_text(encoding="utf-8")
    block = text.split("\nplugins:\n  enabled:\n", 1)[1].split("\n  clone_timeout_seconds:", 1)[0]
    enabled = [line.strip()[2:] for line in block.splitlines() if line.startswith("    - ")]

    assert "apexnodes-honesty-tools" in enabled
    assert enabled[0] == "apex-overlay"


def test_plugin_manifest_names_the_tool():
    manifest = (PLUGIN_DIR / "plugin.yaml").read_text(encoding="utf-8")
    assert "name: apexnodes-honesty-tools" in manifest
    assert "provides_tools:\n  - honesty_verify" in manifest
