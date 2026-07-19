"""hc-563 云桌插件双端契约测试(fork/desktop 侧)——工具面漂移在 CI 变红灯。

背景(hc-561 审计):fork ``plugins/apexnodes-*`` 与 hermes-cloud
``app/runtime_plugins/`` 是同一批 14 个工具的两份接线,07-05 对拍后曾单向漂移
12 天无人发现(hc-562 已回灌止血)。本契约把「两侧已对齐」锁进 CI:锁行为不锁字节。

⚠ 同步纪律(a 案:双仓副本 + 指纹;cloud 是私仓,本仓 CI 拉不到 → b 案否决):
  * 金样例:tests/contracts/plugin_tools_contract.json(本仓副本,byte-identical);
    单一事实源在 hermes-cloud 同路径(cloud 侧测试:tests/test_hc563_plugin_tools_contract.py)。
  * 两侧契约测试内嵌同一个 EXPECTED_CONTRACT_SHA256(sha256 of file bytes)。
  * 改契约 = contract_version+1 + 双仓成对 PR 同步 JSON+指纹(cloud 先行,
    fork 搭下一列引擎车)。单边改插件 → 本仓契约测试红;单边改契约 → 指纹红。
  * 跨仓核对一条命令:两个检出各跑 `shasum -a 256 tests/contracts/plugin_tools_contract.json`。

断言的三层(与金样例字段一一对应):
  * schema  —— 注册面参数名/类型/required/enum 的规范化投影(忽略 description 文案);
  * endpoints —— 每工具允许打的端点族;fork 双腿都跑:legacy(TOOLS_GATEWAY_DISABLED=1
    回退 master 内网端点)+ gateway(/tools/v1/* 公网网关,传输腿差异是合理适配);
  * behaviors —— 关键行为断言键;media_transcribe 的 asr_upload_modes 容纳
    multipart-file / json-media-url / presign-json 三形态(hc-560 大文件直传预留,
    不锁死单一形状);generate_video 的 no_foreign_paths_in_result 钉死 hc-562
    「master 本机路径绝不进桌面结果面」。
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
import types
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
CONTRACT_PATH = REPO_ROOT / "tests" / "contracts" / "plugin_tools_contract.json"

# 与 cloud 侧 tests/test_hc563_plugin_tools_contract.py 内嵌的是同一个值。
EXPECTED_CONTRACT_SHA256 = "ca3f7dbb5523269b5ba4bc6592f1ddb410b450edf19d001d09f7baaa9071529d"
EXPECTED_CONTRACT_VERSION = 1

CONTRACT = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))

LEGACY_BASE = "http://master.test/api/v1"
GATEWAY_BASE = "https://gw.test"
GATEWAY_KEY = "test-agent-key"
SHARE_URL = "https://v.douyin.com/hc563/"

# 各工具的最小合法调用参数(与 cloud 侧同表;gateway 腿个别工具在 harness 里以
# 本地临时文件替换,见 GatewayHarness.probe_args)。
PROBES: dict[str, dict] = {
    "social_download": {"url": SHARE_URL},
    "media_transcribe": {"url": SHARE_URL},
    "image_ocr": {"image_urls": ["https://cdn.example/a.jpg"]},
    "social_batch_submit": {"urls": [SHARE_URL]},
    "social_batch_status": {"job_id": "j1"},
    "social_content": {"platform": "douyin", "url": SHARE_URL},
    "social_search": {"platform": "douyin", "query": "咖啡"},
    "social_profile": {"platform": "douyin", "user_id": "u1"},
    "social_comments": {"platform": "douyin", "item_id": "i1"},
    "social_trending": {"platform": "douyin"},
    "social_posts": {"platform": "douyin", "user_id": "u1"},
    "social_captions": {"platform": "youtube", "url": "https://youtu.be/x"},
    "creator_top_posts": {"url": SHARE_URL, "min_likes": 100000},
    "generate_video": {"prompt": "一只猫在弹钢琴"},
}


# ── 插件装载(PluginManager 命名约定;注册面经 FakeCtx 捕获)────────────────────


def _load_plugin(name: str):
    slug = name.replace("-", "_")
    module_name = f"hc563_contract.{slug}"
    plugin_dir = REPO_ROOT / "plugins" / name
    if "hc563_contract" not in sys.modules:
        namespace = types.ModuleType("hc563_contract")
        namespace.__path__ = []  # type: ignore[attr-defined]
        sys.modules["hc563_contract"] = namespace
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
    """记录 register(ctx) 的注册面:name → {schema, handler, check_fn}。"""

    def __init__(self):
        self.tools: dict[str, dict] = {}

    def register_tool(self, *, name, schema, handler, check_fn=None, **_kwargs):
        assert name not in self.tools, f"duplicate tool registration: {name}"
        self.tools[name] = {"schema": schema, "handler": handler, "check_fn": check_fn}


def _build_registry() -> dict[str, dict]:
    by_plugin: dict[str, dict] = {}
    for plugin_name in CONTRACT["plugins"]:
        ctx = FakeCtx()
        _load_plugin(plugin_name).register(ctx)
        by_plugin[plugin_name] = ctx.tools
    return by_plugin


REGISTRY_BY_PLUGIN = _build_registry()
REGISTRY: dict[str, dict] = {
    name: entry for tools in REGISTRY_BY_PLUGIN.values() for name, entry in tools.items()
}


def _gateway_module():
    import plugins.apexnodes_gateway as gateway_module

    return gateway_module


# ── 契约工具函数(投影 / 端点族匹配)——与 cloud 侧测试保持逐字一致 ────────────────


def project_schema(schema: dict) -> dict:
    """注册 schema → 契约投影:参数名/类型/enum/items.type + required(忽略 description)。"""
    parameters = schema.get("parameters") or {}
    props = parameters.get("properties") or {}
    projected: dict[str, dict] = {}
    for pname in sorted(props):
        spec = props[pname] or {}
        entry: dict = {"type": spec.get("type")}
        if "enum" in spec:
            entry["enum"] = list(spec["enum"])
        items = spec.get("items")
        if isinstance(items, dict) and items.get("type"):
            entry["items"] = {"type": items["type"]}
        projected[pname] = entry
    return {"params": projected, "required": sorted(parameters.get("required") or [])}


def endpoint_matches(pattern: str, path: str) -> bool:
    """端点族匹配:`{seg}` 占位一个非空路径段;尾部 `/*` 匹配 ≥1 个后续段。"""
    if pattern.endswith("/*"):
        prefix = pattern[:-2]
        return path.startswith(prefix + "/") and len(path) > len(prefix) + 1
    pattern_segments = pattern.strip("/").split("/")
    path_segments = path.strip("/").split("/")
    if len(pattern_segments) != len(path_segments):
        return False
    return all(
        expected == actual or (expected.startswith("{") and expected.endswith("}") and actual)
        for expected, actual in zip(pattern_segments, path_segments)
    )


def assert_paths_in_family(observed: list[str], family: list[str], tool_name: str) -> None:
    assert observed, f"{tool_name}: probe issued no call — probe args stale?"
    for path in observed:
        assert any(endpoint_matches(pattern, path) for pattern in family), (
            f"{tool_name}: called {path} outside contract endpoint family {family}"
        )


# ── 双腿 harness ──────────────────────────────────────────────────────────────


class RecordedCall:
    """统一的出网记录:legacy=urlopen(body=JSON 请求体);gateway=request_json
    (body=payload,files=multipart)。path 一律相对各自 base。"""

    def __init__(self, *, method: str, path: str, body=None, files=None):
        self.method = method
        self.path = path
        self.body = body
        self.files = files


class LegacyHarness:
    leg = "legacy"

    def __init__(self, monkeypatch, tmp_path):
        self.calls: list[RecordedCall] = []
        self.tmp_path = tmp_path
        monkeypatch.setenv("TOOLS_GATEWAY_DISABLED", "1")
        monkeypatch.delenv("TOOLS_GATEWAY_BASE", raising=False)
        monkeypatch.delenv("TOOLS_GATEWAY_KEY", raising=False)
        monkeypatch.setenv("HERMES_PLATFORM_API_BASE", LEGACY_BASE)
        monkeypatch.setenv("API_SERVER_KEY", "legacy-key")
        harness = self

        class _Response:
            def __init__(self, body: dict):
                self._body = json.dumps(body, ensure_ascii=False).encode("utf-8")

            def read(self):
                return self._body

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        def _fake_urlopen(request, timeout=None):
            assert request.full_url.startswith(LEGACY_BASE), request.full_url
            path = request.full_url[len(LEGACY_BASE):]
            body = json.loads(request.data.decode("utf-8")) if request.data else None
            harness.calls.append(RecordedCall(method=request.get_method(), path=path, body=body))
            return _Response(harness._canned(path))

        monkeypatch.setattr("urllib.request.urlopen", _fake_urlopen)

    @staticmethod
    def _canned(path: str) -> dict:
        if "/media/batch/status/" in path:
            return {"ok": True, "job_id": "j1", "status": "completed", "product": None}
        if path.endswith("/media/batch/submit"):
            return {"ok": True, "job_id": "j1", "status": "queued"}
        if path.endswith("/media/transcribe"):
            return {"ok": True, "transcript": "", "title": ""}
        return {"ok": True}

    def probe_args(self, tool_name: str) -> dict:
        return dict(PROBES[tool_name])

    def invoke(self, tool_name: str, args: dict) -> tuple[dict, list[RecordedCall]]:
        before = len(self.calls)
        raw = REGISTRY[tool_name]["handler"](args)
        return json.loads(raw), self.calls[before:]


class GatewayHarness:
    leg = "gateway"

    def __init__(self, monkeypatch, tmp_path):
        self.calls: list[RecordedCall] = []
        self.tmp_path = tmp_path
        self.download_media_fails = False
        monkeypatch.delenv("TOOLS_GATEWAY_DISABLED", raising=False)
        monkeypatch.setenv("TOOLS_GATEWAY_BASE", GATEWAY_BASE)
        monkeypatch.setenv("TOOLS_GATEWAY_KEY", GATEWAY_KEY)
        gateway_module = _gateway_module()
        harness = self

        def _fake_request_json(method, path, payload=None, *, timeout=90, files=None, form_data=None):
            harness.calls.append(RecordedCall(method=method, path=path, body=payload, files=files))
            return harness._canned(path)

        def _fake_download_media(url, *, headers=None, filename_hint=""):
            if harness.download_media_fails:
                raise gateway_module.GatewayError("direct link fetch failed (test)")
            downloaded = harness.tmp_path / "downloaded.mp4"
            downloaded.write_bytes(b"fake-media")
            return downloaded

        monkeypatch.setattr(gateway_module, "request_json", _fake_request_json)
        monkeypatch.setattr(gateway_module, "download_media", _fake_download_media)
        # 桌面最保守形态:无 ffmpeg → 抽音轨失败 → 原文件上传(hc-560 已知语境)。
        monkeypatch.setattr(gateway_module, "extract_audio_for_asr", lambda _p, **_kw: None)

    @staticmethod
    def _canned(path: str) -> dict:
        # 按服务端真实线形 can 响应(app/routers/tools_gateway.py):
        # /social/{p}/{action}、/video/generate = {ok, data, cost_cents} 信封;
        # /asr/transcribe、/social/batch/* = 平铺。
        if path.startswith("/tools/v1/asr/"):
            return {"ok": True, "text": "转写正文", "duration_seconds": 3.0, "cost_cents": 8}
        if path == "/tools/v1/social/batch/submit":
            return {"ok": True, "async_delivery": False, "job_id": "j1", "status": "queued"}
        if path.startswith("/tools/v1/social/batch/status/"):
            return {"ok": True, "job_id": "j1", "status": "completed", "product": None}
        if path.endswith("/download"):
            return {
                "ok": True,
                "data": {"title": "标题", "download_url": "https://cdn.example/v.mp4"},
                "cost_cents": 3,
            }
        if path == "/tools/v1/video/generate":
            return {
                "ok": True,
                "data": {"video_url": "https://cdn.example/o.mp4"},
                "cost_cents": 40,
            }
        return {"ok": True, "data": {"items": []}, "cost_cents": 1}

    def probe_args(self, tool_name: str) -> dict:
        if tool_name == "media_transcribe":
            # url 形态:一次探针同时走 download 解析 + ASR 上传两个端点族成员。
            return {"url": SHARE_URL}
        return dict(PROBES[tool_name])

    def invoke(self, tool_name: str, args: dict) -> tuple[dict, list[RecordedCall]]:
        before = len(self.calls)
        raw = REGISTRY[tool_name]["handler"](args)
        return json.loads(raw), self.calls[before:]

    def invoke_raw(self, tool_name: str, args: dict) -> tuple[str, list[RecordedCall]]:
        before = len(self.calls)
        raw = REGISTRY[tool_name]["handler"](args)
        return raw, self.calls[before:]


@pytest.fixture
def legacy(monkeypatch, tmp_path) -> LegacyHarness:
    return LegacyHarness(monkeypatch, tmp_path)


@pytest.fixture
def gateway(monkeypatch, tmp_path) -> GatewayHarness:
    return GatewayHarness(monkeypatch, tmp_path)


# ── ① 指纹 + 版本(同步纪律的机器面)───────────────────────────────────────────


def test_contract_fingerprint_and_version_pinned():
    digest = hashlib.sha256(CONTRACT_PATH.read_bytes()).hexdigest()
    assert digest == EXPECTED_CONTRACT_SHA256, (
        "契约金样例被修改但指纹未更新。同步纪律:bump contract_version,"
        "在 cloud 与 fork 两仓成对 PR 里同时更新 JSON 与 EXPECTED_CONTRACT_SHA256"
        f"(新指纹 {digest});单一事实源在 hermes-cloud。"
    )
    assert CONTRACT["contract_version"] == EXPECTED_CONTRACT_VERSION


# ── ② 注册面:插件 → 工具集合 ─────────────────────────────────────────────────


@pytest.mark.parametrize("plugin_name", sorted(CONTRACT["plugins"]))
def test_registered_tool_set_matches_contract(plugin_name):
    assert set(REGISTRY_BY_PLUGIN[plugin_name]) == set(CONTRACT["plugins"][plugin_name])


def test_contract_covers_exactly_the_shared_tool_surface():
    contract_tools = set(CONTRACT["tools"])
    assert contract_tools == set(REGISTRY)
    assert contract_tools == {t for tools in CONTRACT["plugins"].values() for t in tools}
    assert len(contract_tools) == 14
    assert set(PROBES) == contract_tools


# ── ③ schema 投影 ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize("tool_name", sorted(CONTRACT["tools"]))
def test_schema_projection_matches_contract(tool_name):
    projected = project_schema(REGISTRY[tool_name]["schema"])
    assert projected == CONTRACT["tools"][tool_name]["schema"], (
        f"{tool_name}: 注册 schema 投影偏离金样例——若是有意上新,"
        "走双仓契约同步 PR(见文件头纪律)。"
    )
    assert REGISTRY[tool_name]["schema"]["name"] == tool_name


# ── ④ 端点族(fork 双腿都锁)──────────────────────────────────────────────────


@pytest.mark.parametrize("tool_name", sorted(CONTRACT["tools"]))
def test_legacy_endpoints_stay_in_contract_family(legacy, tool_name):
    _result, calls = legacy.invoke(tool_name, legacy.probe_args(tool_name))
    assert_paths_in_family(
        [c.path for c in calls], CONTRACT["tools"][tool_name]["endpoints"]["legacy"], tool_name
    )


@pytest.mark.parametrize("tool_name", sorted(CONTRACT["tools"]))
def test_gateway_endpoints_stay_in_contract_family(gateway, tool_name):
    _result, calls = gateway.invoke(tool_name, gateway.probe_args(tool_name))
    assert_paths_in_family(
        [c.path for c in calls], CONTRACT["tools"][tool_name]["endpoints"]["gateway"], tool_name
    )


# ── ⑤ behaviors(每个行为键 × 契约声明的每条腿)────────────────────────────────


def _check_routed_intent_passthrough(h, tool_name, _spec):
    stamped = h.probe_args(tool_name)
    stamped["routed_intent"] = "hc563_probe"
    _result, calls = h.invoke(tool_name, stamped)
    assert calls and calls[-1].body["routed_intent"] == "hc563_probe"
    _result, plain_calls = h.invoke(tool_name, h.probe_args(tool_name))
    assert all("routed_intent" not in (c.body or {}) for c in plain_calls), (
        f"{tool_name}: 未命中路由时不得注入 routed_intent(缺省字段不补)"
    )


def _check_delivery_format_normalized_passthrough(h, tool_name, _spec):
    args = h.probe_args(tool_name)
    args["delivery_format"] = " XLSX "
    _result, calls = h.invoke(tool_name, args)
    assert calls[-1].body["delivery_format"] == "xlsx"  # 归一化小写后透传
    _result, plain_calls = h.invoke(tool_name, h.probe_args(tool_name))
    assert plain_calls[-1].body["delivery_format"] is None  # 显式 None,不造默认值


def _required_args_check(error_args: dict):
    def check(h, tool_name, _spec):
        result, calls = h.invoke(tool_name, dict(error_args))
        assert "error" in result, f"{tool_name}: 缺必要参数必须显式报错"
        assert not calls, f"{tool_name}: 缺必要参数不得出网"

    return check


def _check_instruction_decoration(h, tool_name, _spec):
    result, _calls = h.invoke(tool_name, h.probe_args(tool_name))
    assert "_instruction" in result  # 状态结果面带给模型的下一步指令


def _check_aspect_ratio_defaults_landscape(h, tool_name, _spec):
    _result, calls = h.invoke(tool_name, h.probe_args(tool_name))
    assert calls[-1].body["aspect_ratio"] == "landscape"


def _check_asr_upload_modes(h, tool_name, spec):
    assert h.leg == "gateway"
    video = h.tmp_path / "clip.mp4"
    video.write_bytes(b"fake-bytes")
    _result, calls = h.invoke(tool_name, {"video_path": str(video)})
    asr_calls = [c for c in calls if c.path.startswith("/tools/v1/asr/")]
    assert asr_calls, f"{tool_name}: gateway 腿未发出任何 /tools/v1/asr/* 调用"
    call = asr_calls[0]
    if call.files is not None:
        mode = "multipart-file"
    elif isinstance(call.body, dict) and "media_url" in call.body:
        mode = "json-media-url"
    else:
        mode = "presign-json"
    assert mode in spec["allowed_modes"], (
        f"{tool_name}: ASR 上传形态 {mode} 不在契约允许集 {spec['allowed_modes']}"
    )


def _check_gateway_platform_fallback_douyin(h, tool_name, spec):
    assert h.leg == "gateway"
    _result, calls = h.invoke(tool_name, {"image_urls": ["https://cdn.example/a.jpg"]})
    assert calls[-1].path == f"/tools/v1/social/{spec['fallback_platform']}/image-ocr"


def _check_no_foreign_paths_in_result(h, tool_name, spec):
    assert h.leg == "gateway"
    poison = spec["poison_path"]

    def canned_with_poison(path: str) -> dict:
        if path == "/tools/v1/video/generate":
            return {
                "ok": True,
                "data": {
                    "video_url": "https://cdn.example/o.mp4",
                    "video_path": poison,
                    "media_tag": f"MEDIA:{poison}",
                },
                "cost_cents": 40,
            }
        return GatewayHarness._canned(path)

    h._canned = canned_with_poison  # type: ignore[method-assign]
    # a) 直链本地落地成功:结果面只允许本机路径。
    raw, _calls = h.invoke_raw(tool_name, h.probe_args(tool_name))
    result = json.loads(raw)
    assert poison not in raw, f"{tool_name}: master 本机路径泄入桌面结果面"
    assert result["video_path"].startswith(str(h.tmp_path))
    assert result["media_tag"] == f"MEDIA:{result['video_path']}"
    # b) 本地落地失败:只保留 video_url,绝不回退到 master 路径。
    h.download_media_fails = True
    raw, _calls = h.invoke_raw(tool_name, h.probe_args(tool_name))
    result = json.loads(raw)
    assert poison not in raw
    assert "video_path" not in result and "media_tag" not in result
    assert result["video_url"] == "https://cdn.example/o.mp4"


# name → callable;跑腿集合 = 契约行为声明的 legs(fork 双腿都在场)。
BEHAVIOR_CHECKS = {
    "routed_intent_passthrough": _check_routed_intent_passthrough,
    "delivery_format_normalized_passthrough": _check_delivery_format_normalized_passthrough,
    "urls_or_creator_url_required": _required_args_check({}),
    "url_or_image_urls_required": _required_args_check({}),
    "job_id_required": _required_args_check({}),
    "platform_arg_required": _required_args_check({}),
    "url_or_user_id_required": _required_args_check({}),
    "prompt_required": _required_args_check({}),
    "instruction_decoration": _check_instruction_decoration,
    "aspect_ratio_defaults_landscape": _check_aspect_ratio_defaults_landscape,
    "asr_upload_modes": _check_asr_upload_modes,
    "gateway_platform_fallback_douyin": _check_gateway_platform_fallback_douyin,
    "no_foreign_paths_in_result": _check_no_foreign_paths_in_result,
}

BEHAVIOR_CASES = [
    (tool_name, behavior_name, leg)
    for tool_name in sorted(CONTRACT["tools"])
    for behavior_name in sorted(CONTRACT["tools"][tool_name]["behaviors"])
    for leg in CONTRACT["tools"][tool_name]["behaviors"][behavior_name]["legs"]
]


@pytest.mark.parametrize(("tool_name", "behavior_name", "leg"), BEHAVIOR_CASES,
                         ids=[f"{t}-{b}-{leg}" for t, b, leg in BEHAVIOR_CASES])
def test_behavior_contract(request, tool_name, behavior_name, leg):
    spec = CONTRACT["tools"][tool_name]["behaviors"][behavior_name]
    assert behavior_name in BEHAVIOR_CHECKS, (
        f"契约新增行为键 {behavior_name},本侧测试必须实现断言"
    )
    # 只实例化本条腿的 harness(两腿 env 互斥:legacy 靠 TOOLS_GATEWAY_DISABLED=1)。
    BEHAVIOR_CHECKS[behavior_name](request.getfixturevalue(leg), tool_name, spec)
