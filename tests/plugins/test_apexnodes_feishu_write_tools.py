"""hc-581 桌面飞书写入工具——注册面 + 绑定 gate 两态 + 凭据缺失自隐。

背景:hermes-cloud ``app/runtime_plugins/apexnodes-feishu-{doc,bitable}-write``
两个 owner 凭证工具搬进 fork bundle 供桌面用。与云版行为一致(同一 handler /
同一 ``_owner_credentials()``),唯一区别是 ``check_fn`` 的显形闸:

  * 云版:``lark_oapi`` 可导入即注册,凭据缺失在调用时报错。
  * 桌面版(本测):仅当 ``lark_oapi`` 可导入 且 env 里有 owner 飞书凭据
    (``FEISHU_APP_ID`` + ``FEISHU_APP_SECRET``)时显形——桌面只有绑定飞书才把
    owner 凭据注入后端 spawn env(hc-417 IM 入口 / hc-444 bridge),所以「凭据在场」
    就是「飞书已绑定」的判据。未绑定 / SDK 缺失 → 工具自隐,不露一个只会在调用时
    失败的死工具。

样式沿用 hc-565 ``test_apexnodes_image_and_filewrite_tools.py``:``_load_plugin``
按 PluginManager 命名约定装载,``FakeCtx`` 捕获注册面,``importlib.util.find_spec``
打桩控制 lark_oapi 在场与否(避免依赖真实安装)。
"""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]

# owner 飞书凭据 env——每个测试前必须全空,由 gate 逐条置入。
_FEISHU_CRED_ENV = (
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "LARK_APP_ID",
    "LARK_APP_SECRET",
    "OWNER_FEISHU_APP_ID",
    "OWNER_FEISHU_APP_SECRET",
)

_PLUGINS = (
    ("apexnodes-feishu-doc-write", "feishu_doc_write", "_check_feishu_doc_write"),
    ("apexnodes-feishu-bitable-write", "feishu_bitable_write", "_check_feishu_bitable_write"),
)


def _load_plugin(name: str):
    """按 PluginManager 的命名约定加载插件模块(hermes_plugins.<slug>)。"""
    slug = name.replace("-", "_")
    module_name = f"hermes_plugins.{slug}"
    plugin_dir = REPO_ROOT / "plugins" / name
    if "hermes_plugins" not in sys.modules:
        namespace = types.ModuleType("hermes_plugins")
        namespace.__path__ = []  # type: ignore[attr-defined]
        sys.modules["hermes_plugins"] = namespace
    spec = importlib.util.spec_from_file_location(
        module_name,
        plugin_dir / "__init__.py",
        submodule_search_locations=[str(plugin_dir)],
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


class FakeCtx:
    def __init__(self):
        self.tools: dict[str, dict] = {}

    def register_tool(self, *, name, toolset=None, schema=None, handler=None, check_fn=None, **_kwargs):
        self.tools[name] = {"toolset": toolset, "schema": schema, "handler": handler, "check_fn": check_fn}


def _register(name: str) -> FakeCtx:
    ctx = FakeCtx()
    _load_plugin(name).register(ctx)
    return ctx


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    """每个测试从「无凭据」起步,gate 断言各自置入需要的键。"""
    for name in _FEISHU_CRED_ENV:
        monkeypatch.delenv(name, raising=False)


def _force_lark(monkeypatch, present: bool):
    """打桩 importlib.util.find_spec,使 lark_oapi 在场/缺失可控,不依赖真实安装。"""
    real = importlib.util.find_spec

    def fake_find_spec(name, *a, **k):
        if name == "lark_oapi":
            return object() if present else None
        return real(name, *a, **k)

    monkeypatch.setattr("importlib.util.find_spec", fake_find_spec)


# ── ① 注册面 ─────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(("plugin", "tool", "_check_name"), _PLUGINS)
def test_feishu_plugin_registers(plugin, tool, _check_name):
    tools = _register(plugin).tools
    assert set(tools) == {tool}
    assert tools[tool]["toolset"] == "feishu_doc"
    assert tools[tool]["schema"]["name"] == tool
    assert callable(tools[tool]["check_fn"])


# ── ② 绑定 gate 两态 + 凭据缺失自隐 ──────────────────────────────────────────


@pytest.mark.parametrize(("plugin", "_tool", "check_name"), _PLUGINS)
def test_surfaces_when_feishu_bound(monkeypatch, plugin, _tool, check_name):
    """lark 在场 + owner 凭据在场(= 已绑定飞书)→ 显形。"""
    mod = _load_plugin(plugin)
    _force_lark(monkeypatch, True)
    monkeypatch.setenv("FEISHU_APP_ID", "cli_desktop_app")
    monkeypatch.setenv("FEISHU_APP_SECRET", "s3cret")
    assert getattr(mod, check_name)() is True


@pytest.mark.parametrize(("plugin", "_tool", "check_name"), _PLUGINS)
def test_hidden_when_feishu_unbound(monkeypatch, plugin, _tool, check_name):
    """lark 在场但无 owner 凭据(= 未绑定飞书)→ 自隐(未绑定不露出)。"""
    mod = _load_plugin(plugin)
    _force_lark(monkeypatch, True)
    # _clean_env 已清空所有飞书凭据键。
    assert getattr(mod, check_name)() is False


@pytest.mark.parametrize(("plugin", "_tool", "check_name"), _PLUGINS)
def test_hidden_when_only_app_id_present(monkeypatch, plugin, _tool, check_name):
    """半套凭据(只有 app_id、无 secret)也算未绑定 → 自隐(凭据缺失自隐)。"""
    mod = _load_plugin(plugin)
    _force_lark(monkeypatch, True)
    monkeypatch.setenv("FEISHU_APP_ID", "cli_desktop_app")
    assert getattr(mod, check_name)() is False


@pytest.mark.parametrize(("plugin", "_tool", "check_name"), _PLUGINS)
def test_hidden_when_lark_absent_even_if_bound(monkeypatch, plugin, _tool, check_name):
    """凭据在场但 SDK 缺失 → 自隐(不露一个连 SDK 都没有的死工具)。"""
    mod = _load_plugin(plugin)
    _force_lark(monkeypatch, False)
    monkeypatch.setenv("FEISHU_APP_ID", "cli_desktop_app")
    monkeypatch.setenv("FEISHU_APP_SECRET", "s3cret")
    assert getattr(mod, check_name)() is False


@pytest.mark.parametrize(("plugin", "_tool", "check_name"), _PLUGINS)
def test_lark_alias_credentials_also_surface(monkeypatch, plugin, _tool, check_name):
    """国际站 LARK_APP_ID/SECRET 亦是合法 owner 凭据形态(与云版候选表一致)。"""
    mod = _load_plugin(plugin)
    _force_lark(monkeypatch, True)
    monkeypatch.setenv("LARK_APP_ID", "lark_app")
    monkeypatch.setenv("LARK_APP_SECRET", "s3cret")
    assert getattr(mod, check_name)() is True


# ── ③ handler 防线:凭据缺失即报错、绝不出网 ─────────────────────────────────


def test_doc_handler_errors_without_credentials(monkeypatch):
    """即便被显形,handler 也自守:无 owner 凭据 → 显式报错,不构建 client / 不出网。"""
    mod = _load_plugin("apexnodes-feishu-doc-write")
    called = {"build": False}
    monkeypatch.setattr(mod, "_build_client", lambda *a, **k: called.__setitem__("build", True))
    result = mod._handle_feishu_doc_write({"content": "hi"})
    assert "error" in result
    assert called["build"] is False


def test_bitable_handler_errors_without_credentials(monkeypatch):
    mod = _load_plugin("apexnodes-feishu-bitable-write")
    called = {"build": False}
    monkeypatch.setattr(mod, "_build_client", lambda *a, **k: called.__setitem__("build", True))
    result = mod._handle_feishu_bitable_write({"bitable_url": "https://x/base/app1?table=tbl1", "fields": {"a": 1}})
    assert "error" in result
    assert called["build"] is False
