"""hc-604——桌面注入面与插件所需 env 必须一致,且对**还没写出来的插件**也成立。

要防的不是「某个函数返回错字符串」,而是 hc-604 本身的形状:云端容器每次
create 都注入 ``API_SERVER_KEY``/``HERMES_PLATFORM_API_BASE`` 并有专门的
``entry_connectivity_gate`` 守着它别丢,桌面端则一个字也没注入过——``apps/desktop``
全仓 0 处出现这些键——于是图片生成 / 视频生成 / 图片 OCR / 媒体转写四条能力在
桌面**从来没能用过**,而用户看到的是「密钥已过期,请重新登录」这条必然无效的指引。

所以本文件的断言刻意**不是**「插件的 helper 返回了什么」,而是一条类级不变量:

    只把桌面 spawn 注入的那几个 env 设进环境(别的一律清空),
    磁盘上**每一个** ``plugins/apexnodes-*`` 插件都必须能解析出凭据,
    并且请求落在公网平台域上——包括本测试从没听说过的插件。

两个机制让它随代码生长而保持诚实:

1. 插件清单来自 ``plugins/`` 目录的 glob,不是手写常量。新增第 N 个平台工具
   插件**自动**被纳管:它不需要在任何地方登记就会被这里跑到,若它自造一套
   凭据查找而桌面没注入,第一次运行就红。
2. 注入面来自 ``apexnodes_gateway.DESKTOP_SPAWN_ENV_CONTRACT`` 这**唯一一处**
   声明。TS 侧(``apps/desktop/electron/apex-platform-tools.test.ts``)从同一个
   .py 文件里读同一个字面量去比对它的 builder,两种语言、两条独立路径,谁也
   不引用谁的实现——这正是 hc-602「验证者不得复用写入者的判断」的同一条纪律。

反向验证是本文件的价值来源:``test_dropping_any_injected_env_breaks_a_capability``
逐个抽掉注入项并断言确实有能力塌掉。
"""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
PLUGINS_ROOT = REPO_ROOT / "plugins"

# 桌面机器上确实不存在的 env——不清空就会「借」到本机残留而假绿。
_ENV_TO_CLEAR = (
    "API_SERVER_KEY",
    "MODEL_API_KEY",
    "TOOLS_GATEWAY_BASE",
    "TOOLS_GATEWAY_KEY",
    "TOOLS_GATEWAY_DISABLED",
    "HERMES_PLATFORM_API_BASE",
    "HERMES_MASTER_API_BASE",
    "HERMES_SCHEDULER_API_BASE",
    "HERMES_DESKTOP",
)

# 桌面 spawn 实际会注入的值(apex-platform-tools.ts::buildPlatformToolSpawnEnv)。
DESKTOP_API_HOST = "https://api.apex-nodes.com"
DESKTOP_INJECTED = {
    "TOOLS_GATEWAY_KEY": "sk-Fake000000000000000000000000000",
    "TOOLS_GATEWAY_BASE": DESKTOP_API_HOST,
    "HERMES_PLATFORM_API_BASE": f"{DESKTOP_API_HOST}/api/v1",
}


def _gateway_module():
    import plugins.apexnodes_gateway as gateway_module

    return gateway_module


def platform_tool_plugin_dirs() -> list[str]:
    """磁盘上每一个 ApexNodes 平台工具插件目录(glob,不是手写清单)。

    判据取「源码里出现共用网关客户端」——本地文档导出类插件
    (xlsx/pptx/doc/feishu-*)不打平台工具网关,自然落选,无需维护排除名单。
    """
    found = []
    for path in sorted(PLUGINS_ROOT.glob("apexnodes-*")):
        init = path / "__init__.py"
        if not init.is_file():
            continue
        if "apexnodes_gateway" not in init.read_text(encoding="utf-8"):
            continue
        found.append(path.name)
    return found


PLATFORM_TOOL_PLUGINS = platform_tool_plugin_dirs()


def _load_plugin(name: str):
    """按 PluginManager 的命名约定加载插件模块(hermes_plugins.<slug>)。"""
    slug = name.replace("-", "_")
    module_name = f"hermes_plugins.{slug}"
    plugin_dir = PLUGINS_ROOT / name
    if "hermes_plugins" not in sys.modules:
        namespace = types.ModuleType("hermes_plugins")
        namespace.__path__ = []  # type: ignore[attr-defined]
        sys.modules["hermes_plugins"] = namespace
    spec = importlib.util.spec_from_file_location(
        module_name,
        plugin_dir / "__init__.py",
        submodule_search_locations=[str(plugin_dir)],
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(module_name, None)
        raise
    return module


@pytest.fixture(autouse=True)
def _clean_env(tmp_path, monkeypatch):
    """隔离的 HERMES_HOME(**没有** config.yaml)+ 全空的平台 env。

    刻意不放 config.yaml:插件对 ``custom_providers`` 的兜底扫描必须**不能**
    成为本测试的通过理由——要断言的正是「只靠注入就够」。
    """
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    for name in _ENV_TO_CLEAR:
        monkeypatch.delenv(name, raising=False)
    yield home


@pytest.fixture
def desktop_spawn_env(monkeypatch):
    """桌面 spawn 注入面——**只有**契约里那几个键。"""
    for name, value in DESKTOP_INJECTED.items():
        monkeypatch.setenv(name, value)


def test_injected_contract_matches_the_declaration():
    """注入的键集合 == apexnodes_gateway 里那唯一一处声明。"""
    assert set(_gateway_module().DESKTOP_SPAWN_ENV_CONTRACT) == set(DESKTOP_INJECTED)


def test_plugin_glob_is_not_empty():
    """守卫的守卫:清单一旦扫空,下面全部断言都会真空通过。"""
    assert len(PLATFORM_TOOL_PLUGINS) >= 4, PLATFORM_TOOL_PLUGINS


@pytest.mark.parametrize("plugin_name", PLATFORM_TOOL_PLUGINS)
def test_plugin_resolves_credential_from_desktop_injection(plugin_name, desktop_spawn_env):
    """每个平台工具插件都能只凭桌面注入解析出凭据 + 公网 base。

    两条路径都要成立:网关路径(``_gateway.agent_api_key`` / ``gateway_base``)
    与各插件自己的 legacy 直连路径(``_agent_api_key`` / ``_api_base``)。
    hc-604 之前 legacy 路径在桌面必挂——它的 base 默认值是
    ``host.docker.internal``,一个桌面上根本不解析的 Docker 内部地址。
    """
    module = _load_plugin(plugin_name)
    try:
        gateway = _gateway_module()
        assert gateway.use_gateway() is True
        assert gateway.gateway_base() == DESKTOP_API_HOST
        key, source = gateway.resolve_agent_api_key()
        assert key == DESKTOP_INJECTED["TOOLS_GATEWAY_KEY"]
        assert source == gateway.SOURCE_ENV

        # legacy 直连路径同样必须可用(TOOLS_GATEWAY_DISABLED=1 的回退通道)。
        assert module._agent_api_key() == DESKTOP_INJECTED["TOOLS_GATEWAY_KEY"]
        assert module._api_base() == DESKTOP_INJECTED["HERMES_PLATFORM_API_BASE"]
        assert "host.docker.internal" not in module._api_base()
    finally:
        sys.modules.pop(module.__name__, None)


@pytest.mark.parametrize("dropped", sorted(DESKTOP_INJECTED))
def test_dropping_any_injected_env_breaks_a_capability(dropped, monkeypatch):
    """反向验证:抽掉任意一项注入,都必须有东西塌掉——没有一项是装饰。"""
    for name, value in DESKTOP_INJECTED.items():
        if name != dropped:
            monkeypatch.setenv(name, value)
        else:
            monkeypatch.delenv(name, raising=False)

    gateway = _gateway_module()
    module = _load_plugin(PLATFORM_TOOL_PLUGINS[0])
    try:
        if dropped == "TOOLS_GATEWAY_KEY":
            # 没有凭据:网关路径拒绝出网,legacy 路径拿到空 key。
            assert gateway.resolve_agent_api_key() == ("", gateway.SOURCE_NONE)
            assert module._agent_api_key() == ""
        elif dropped == "TOOLS_GATEWAY_BASE":
            # 没有 base:网关模式关掉(config.yaml 里也没有托管条目)。
            assert gateway.gateway_base() is None
            assert gateway.use_gateway() is False
        else:
            # 没有 legacy base:回退通道指回 Docker 内网地址,桌面上必然打不通。
            assert "host.docker.internal" in module._api_base()
    finally:
        sys.modules.pop(module.__name__, None)


# ---------------------------------------------------------------------------
# 错误文案分档——「从未配置」/「已失效」/「网络失败」三种,各给真正有用的下一步
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("desktop", [False, True])
def test_missing_credential_never_says_expired_or_relogin(desktop, monkeypatch):
    """从未配置 ≠ 已过期。对没登录过的人说「重新登录」,只会让他白折腾。

    桌面与云端两种措辞都要过这一关——hc-604 现场的那句「已过期,请重新登录」
    正是在「压根没配过」的情况下发出来的。
    """
    if desktop:
        monkeypatch.setenv("HERMES_DESKTOP", "1")
    message = str(_gateway_module().missing_credential_error())

    assert "过期" not in message
    assert "重新登录" not in message
    # 而且必须给出**这个环境**里真正能解决问题的那一步。
    assert ("设置" in message and "账户" in message) if desktop else ("容器" in message)


def test_missing_credential_on_desktop_points_at_the_account_page(monkeypatch):
    monkeypatch.setenv("HERMES_DESKTOP", "1")
    message = str(_gateway_module().missing_credential_error())

    assert "设置" in message and "账户" in message
    assert "TOOLS_GATEWAY_KEY" not in message  # 用户不该看到 env 名


def test_missing_credential_on_cloud_points_at_the_container_env():
    message = str(_gateway_module().missing_credential_error())

    assert "TOOLS_GATEWAY_KEY" in message
    assert "容器" in message


def test_stale_credential_from_config_copy_does_not_send_the_user_to_relogin():
    """现场那一档:env 没注入 → 读到 config.yaml 副本 → 401。

    此时「重新登录」修不好那份副本(0.17.1 的自愈只同步 model.api_key、漏掉
    custom_providers 条目),必须先给出「更新/重启」这条真正有效的下一步。
    """
    gateway = _gateway_module()
    message = gateway.stale_credential_message(gateway.SOURCE_CONFIG)

    assert "更新" in message and "重启" in message
    assert message.index("更新") < message.index("重新登录")


def test_network_failure_never_mentions_credentials(monkeypatch):
    """第三档:网络失败——绝不提登录,否则用户会为一次断网反复重登。"""
    import httpx

    gateway = _gateway_module()
    monkeypatch.setenv("TOOLS_GATEWAY_KEY", DESKTOP_INJECTED["TOOLS_GATEWAY_KEY"])
    monkeypatch.setenv("TOOLS_GATEWAY_BASE", DESKTOP_API_HOST)

    class ExplodingClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def request(self, *args, **kwargs):
            raise httpx.ConnectError("nodename nor servname provided")

    monkeypatch.setattr(gateway.httpx, "Client", ExplodingClient)

    with pytest.raises(gateway.GatewayError) as excinfo:
        gateway.request_json("GET", "/tools/v1/check")

    message = str(excinfo.value)
    assert excinfo.value.code == "network_unreachable"
    assert "网络" in message
    assert "登录" not in message
    assert "过期" not in message


def test_missing_credential_wins_over_missing_base(monkeypatch):
    """两者在桌面总是一起缺;对用户有意义的那句是「去登录」,不是「缺某个 env」。"""
    gateway = _gateway_module()

    with pytest.raises(gateway.GatewayError) as excinfo:
        gateway.request_json("GET", "/tools/v1/check")

    assert excinfo.value.code == "credential_missing"


@pytest.mark.parametrize("plugin_name", PLATFORM_TOOL_PLUGINS)
def test_legacy_path_missing_key_message_is_human(plugin_name):
    """legacy 直连路径的缺失文案也必须是人话——原文是 "Agent API key is missing"。"""
    module = _load_plugin(plugin_name)
    try:
        message = module._missing_credential_message()
        assert "Agent API key is missing" not in message
        assert "登录" in message or "容器" in message
    finally:
        sys.modules.pop(module.__name__, None)
