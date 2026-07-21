"""hc-565 桌面能力面补齐第一批——image 生成族网关腿 + xlsx/pptx/doc 本地导出。

覆盖:
* image-tools 网关腿:调用打 ``/tools/v1/image/generate``,转发 provider/purpose/n;
  收尾同 hc-562 视频腿——master 本机 ``image_path``/``media_tag`` 绝不进桌面结果面,
  用 ``image_url`` 直链本地落地后重建 MEDIA 标签(多图逐张;落地失败保留 url+时效提示)。
* image-tools legacy 腿:``TOOLS_GATEWAY_DISABLED=1`` 回退 ``/media/image-generate``。
* 本地文档导出插件(xlsx/pptx/doc)注册面 + 渲染冒烟(依赖随桌面装机自带,缺则 skip)。
* doc_file_write 桌面入口 gate:``HERMES_DESKTOP=1`` 显形(hc-565),非飞书 IM env 亦显形,
  两者都无则隐藏(与云容器语义一致)。
"""

from __future__ import annotations

import importlib.util
import json
import sys
import types
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
GATEWAY_BASE = "https://gw.test"
GATEWAY_KEY = "test-agent-key"
LEGACY_BASE = "http://master.test/api/v1"
_MASTER_IMAGE_PATH = "/data/hermes/agents/a1/media/jobs/j1/image_1.png"

# 桌面机器上不存在的 vendor/master 侧 env——冒烟前必须全空。
_VENDOR_AND_MASTER_ENV = (
    "HERMES_PLATFORM_API_BASE",
    "HERMES_MASTER_API_BASE",
    "HERMES_SCHEDULER_API_BASE",
    "API_SERVER_KEY",
    "MODEL_API_KEY",
    "TOOLS_GATEWAY_BASE",
    "TOOLS_GATEWAY_KEY",
    "TOOLS_GATEWAY_DISABLED",
    "HERMES_DESKTOP",
    "WEIXIN_TOKEN",
    "WECOM_BOT_ID",
    "DINGTALK_CLIENT_ID",
    "QQ_APP_ID",
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


def _gateway_module():
    import plugins.apexnodes_gateway as gateway_module

    return gateway_module


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
def _clean_env(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    for name in _VENDOR_AND_MASTER_ENV:
        monkeypatch.delenv(name, raising=False)
    yield home


@pytest.fixture
def desktop_env(monkeypatch):
    monkeypatch.setenv("TOOLS_GATEWAY_BASE", GATEWAY_BASE)
    monkeypatch.setenv("TOOLS_GATEWAY_KEY", GATEWAY_KEY)


@pytest.fixture
def image_mod():
    module = _load_plugin("apexnodes-image-tools")
    yield module
    sys.modules.pop(module.__name__, None)


class FakeResponse:
    def __init__(self, status_code=200, body=None, headers=None):
        self.status_code = status_code
        self._body = body if body is not None else {}
        self.headers = headers or {}
        self.text = json.dumps(self._body, ensure_ascii=False)

    def json(self):
        return self._body


class RecordedRequest:
    def __init__(self, method, url, kwargs):
        self.method = method
        self.url = url
        self.headers = kwargs.get("headers") or {}
        self.json = kwargs.get("json")


@pytest.fixture
def fake_httpx(monkeypatch):
    gateway_module = _gateway_module()
    state = types.SimpleNamespace(requests=[], responses=[])

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def request(self, method, url, **kwargs):
            state.requests.append(RecordedRequest(method, url, kwargs))
            if not state.responses:
                raise AssertionError("FakeClient: no queued response left")
            return state.responses.pop(0)

    monkeypatch.setattr(gateway_module.httpx, "Client", FakeClient)
    monkeypatch.setattr(gateway_module.time, "sleep", lambda _s: None)
    return state


def _parse(result: str) -> dict:
    return json.loads(result)


# ── image-tools 网关腿 ────────────────────────────────────────────────────────


class TestImageGatewayLeg:
    def test_gateway_lands_image_locally_and_forwards_params(
        self, desktop_env, fake_httpx, image_mod, monkeypatch, tmp_path
    ):
        gateway_module = _gateway_module()
        fake_httpx.responses.append(
            FakeResponse(
                200,
                {
                    "data": {
                        "image_url": "https://cdn.example/i1.png",
                        "image": "https://cdn.example/i1.png",
                        "image_path": _MASTER_IMAGE_PATH,
                        "media_tag": f"MEDIA:{_MASTER_IMAGE_PATH}",
                        "images": [
                            {
                                "image_url": "https://cdn.example/i1.png",
                                "image": "https://cdn.example/i1.png",
                                "image_path": _MASTER_IMAGE_PATH,
                                "media_tag": f"MEDIA:{_MASTER_IMAGE_PATH}",
                            }
                        ],
                    },
                    "cost_cents": 0,
                },
            )
        )
        downloaded = tmp_path / "gen.png"
        downloaded.write_bytes(b"fake-image")
        seen = {}

        def fake_download(url, **kwargs):
            seen["url"] = url
            return downloaded

        monkeypatch.setattr(gateway_module, "download_media", fake_download)
        raw = image_mod._handle_generate_image(
            {"prompt": "柴犬戴墨镜", "aspect_ratio": "portrait", "n": 1, "provider": "agnes", "purpose": "cover"}
        )
        result = _parse(raw)
        request = fake_httpx.requests[0]
        assert request.url == f"{GATEWAY_BASE}/tools/v1/image/generate"
        assert request.json["prompt"] == "柴犬戴墨镜"
        assert request.json["aspect_ratio"] == "portrait"
        assert request.json["provider"] == "agnes" and request.json["purpose"] == "cover"
        assert request.headers["X-Capability-Version"]
        assert seen["url"] == "https://cdn.example/i1.png"
        # 结果面只有本机路径,master 路径绝不泄入。
        assert result["image_path"] == str(downloaded)
        assert result["media_tag"] == f"MEDIA:{downloaded}"
        assert result["images"][0]["image_path"] == str(downloaded)
        assert result["image_url"] == "https://cdn.example/i1.png"
        assert _MASTER_IMAGE_PATH not in raw

    def test_gateway_multi_image_localizes_each(
        self, desktop_env, fake_httpx, image_mod, monkeypatch, tmp_path
    ):
        gateway_module = _gateway_module()
        master2 = "/data/hermes/agents/a1/media/jobs/j1/image_2.png"
        fake_httpx.responses.append(
            FakeResponse(
                200,
                {
                    "data": {
                        "image_url": "https://cdn.example/i1.png",
                        "image_path": _MASTER_IMAGE_PATH,
                        "media_tag": f"MEDIA:{_MASTER_IMAGE_PATH}",
                        "images": [
                            {"image_url": "https://cdn.example/i1.png", "image_path": _MASTER_IMAGE_PATH,
                             "media_tag": f"MEDIA:{_MASTER_IMAGE_PATH}"},
                            {"image_url": "https://cdn.example/i2.png", "image_path": master2,
                             "media_tag": f"MEDIA:{master2}"},
                        ],
                    },
                    "cost_cents": 0,
                },
            )
        )

        def fake_download(url, **kwargs):
            local = tmp_path / (url.rsplit("/", 1)[-1])
            local.write_bytes(b"x")
            return local

        monkeypatch.setattr(gateway_module, "download_media", fake_download)
        raw = image_mod._handle_generate_image({"prompt": "两张图", "n": 2})
        result = _parse(raw)
        assert len(result["images"]) == 2
        assert result["images"][0]["image_path"] == str(tmp_path / "i1.png")
        assert result["images"][1]["image_path"] == str(tmp_path / "i2.png")
        # 顶层取第一张落地图。
        assert result["image_path"] == str(tmp_path / "i1.png")
        assert _MASTER_IMAGE_PATH not in raw and master2 not in raw

    def test_gateway_download_failure_keeps_url_with_expiry_note(
        self, desktop_env, fake_httpx, image_mod, monkeypatch
    ):
        gateway_module = _gateway_module()
        fake_httpx.responses.append(
            FakeResponse(
                200,
                {
                    "data": {
                        "image_url": "https://cdn.example/i1.png",
                        "image_path": _MASTER_IMAGE_PATH,
                        "media_tag": f"MEDIA:{_MASTER_IMAGE_PATH}",
                        "images": [
                            {"image_url": "https://cdn.example/i1.png", "image_path": _MASTER_IMAGE_PATH,
                             "media_tag": f"MEDIA:{_MASTER_IMAGE_PATH}"}
                        ],
                    },
                    "cost_cents": 0,
                },
            )
        )

        def failing_download(url, **kwargs):
            raise gateway_module.GatewayError("direct link fetch failed")

        monkeypatch.setattr(gateway_module, "download_media", failing_download)
        raw = image_mod._handle_generate_image({"prompt": "柴犬戴墨镜"})
        result = _parse(raw)
        assert result["image_url"] == "https://cdn.example/i1.png"
        assert "image_path" not in result and "media_tag" not in result
        assert "有效期" in result["note"]
        assert _MASTER_IMAGE_PATH not in raw

    def test_gateway_mode_active_and_check_needs_no_network(self, desktop_env, image_mod):
        gateway_module = _gateway_module()
        assert gateway_module.use_gateway() is True
        # 网关模式:可用性=有 key,不发任何网络探测。
        assert image_mod._check() is True

    def test_missing_prompt_errors_without_calling(self, desktop_env, fake_httpx, image_mod):
        result = _parse(image_mod._handle_generate_image({}))
        assert "error" in result
        assert not fake_httpx.requests


# ── image-tools legacy 腿 ─────────────────────────────────────────────────────


class TestImageLegacyLeg:
    def test_legacy_hits_media_image_generate(self, image_mod, monkeypatch):
        monkeypatch.setenv("TOOLS_GATEWAY_DISABLED", "1")
        monkeypatch.setenv("HERMES_PLATFORM_API_BASE", LEGACY_BASE)
        monkeypatch.setenv("API_SERVER_KEY", "legacy-key")
        calls = []

        class _Resp:
            def __init__(self, body):
                self._body = json.dumps(body).encode("utf-8")

            def read(self):
                return self._body

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        def fake_urlopen(request, timeout=None):
            calls.append(request.full_url)
            return _Resp({"ok": True, "image_url": "https://cdn.example/i.png", "image_path": "/x", "media_tag": "MEDIA:/x"})

        monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
        raw = image_mod._handle_generate_image({"prompt": "柴犬"})
        assert _parse(raw)["ok"] is True
        assert calls == [f"{LEGACY_BASE}/media/image-generate"]


# ── 注册面(image + 三个本地文档导出插件)──────────────────────────────────────


def test_image_plugin_registers_generate_image():
    tools = _register("apexnodes-image-tools").tools
    assert set(tools) == {"generate_image"}
    assert tools["generate_image"]["schema"]["name"] == "generate_image"


@pytest.mark.parametrize(
    ("plugin", "tool", "toolset"),
    [
        ("apexnodes-xlsx-file-write", "xlsx_file_write", "doc_delivery"),
        ("apexnodes-pptx-file-write", "pptx_file_write", "doc_delivery"),
        ("apexnodes-doc-file-write", "doc_file_write", "doc_delivery"),
    ],
)
def test_filewrite_plugin_registers(plugin, tool, toolset):
    tools = _register(plugin).tools
    assert set(tools) == {tool}
    assert tools[tool]["toolset"] == toolset
    assert tools[tool]["schema"]["name"] == tool


# ── doc_file_write 桌面入口 gate(hc-565)──────────────────────────────────────


class TestDocFileWriteGate:
    def _doc_mod(self):
        return _load_plugin("apexnodes-doc-file-write")

    def _force_docx_present(self, monkeypatch, present: bool):
        mod = self._doc_mod()
        real = importlib.util.find_spec

        def fake_find_spec(name, *a, **k):
            if name == "docx":
                return object() if present else None
            return real(name, *a, **k)

        monkeypatch.setattr("importlib.util.find_spec", fake_find_spec)
        return mod

    def test_surfaces_on_desktop(self, monkeypatch):
        mod = self._force_docx_present(monkeypatch, True)
        monkeypatch.setenv("HERMES_DESKTOP", "1")
        assert mod._check_doc_file_write() is True

    def test_surfaces_on_non_feishu_im(self, monkeypatch):
        mod = self._force_docx_present(monkeypatch, True)
        monkeypatch.setenv("WEIXIN_TOKEN", "tok")
        assert mod._check_doc_file_write() is True

    def test_hidden_without_any_marker(self, monkeypatch):
        mod = self._force_docx_present(monkeypatch, True)
        # 无 HERMES_DESKTOP、无 IM env(_clean_env 已清空)→ 隐藏(云飞书/纯 CLI 语义)。
        assert mod._check_doc_file_write() is False

    def test_hidden_without_docx_even_on_desktop(self, monkeypatch):
        mod = self._force_docx_present(monkeypatch, False)
        monkeypatch.setenv("HERMES_DESKTOP", "1")
        assert mod._check_doc_file_write() is False


# ── 渲染冒烟(依赖随桌面装机自带;本地缺依赖时 skip,CI 全装必跑)────────────────


def test_xlsx_render_produces_file(tmp_path):
    pytest.importorskip("xlsxwriter")
    mod = _load_plugin("apexnodes-xlsx-file-write")
    monkeypatch_home(mod, tmp_path)
    raw = _parse(mod._handle_xlsx_file_write({"sheets": [{"name": "S1", "columns": ["a", "b"], "rows": [[1, 2]]}]}))
    assert raw["success"] is True
    path = Path(raw["file_path"])
    assert path.exists() and path.suffix == ".xlsx"
    assert raw["media_tag"] == f"MEDIA:{path}"


def test_pptx_render_produces_file(tmp_path):
    pytest.importorskip("pptx")
    mod = _load_plugin("apexnodes-pptx-file-write")
    monkeypatch_home(mod, tmp_path)
    raw = _parse(mod._handle_pptx_file_write({"slides": [{"title": "T", "bullets": ["one", "two"]}]}))
    assert raw["success"] is True
    path = Path(raw["file_path"])
    assert path.exists() and path.suffix == ".pptx"


def test_docx_render_produces_file(tmp_path):
    pytest.importorskip("docx")
    mod = _load_plugin("apexnodes-doc-file-write")
    monkeypatch_home(mod, tmp_path)
    raw = _parse(mod._handle_doc_file_write({"content": "# 标题\n\n- 一\n- 二", "title": "报告"}))
    assert raw["success"] is True
    path = Path(raw["file_path"])
    assert path.exists() and path.suffix == ".docx"


def monkeypatch_home(mod, tmp_path):
    """把插件的文档缓存目录钉到 tmp_path(避免写进真实 HERMES_HOME)。"""
    mod._document_cache_dir = lambda: tmp_path  # type: ignore[attr-defined]
