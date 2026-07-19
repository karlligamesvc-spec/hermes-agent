"""平台工具网关 P1——三个 ApexNodes 工具插件的「桌面形态冒烟」与契约测试。

覆盖(DESKTOP-CLOUD-CAPABILITY-PARITY-PD §6 验收守卫):

* 桌面形态冒烟:vendor env 全空、仅 ``TOOLS_GATEWAY_BASE``+key 的环境里,
  apexnodes-douyin-tools / apexnodes-social-tools / apexnodes-video-tools
  三插件经 ``PluginManager.discover_and_load`` 注册成功(14 个工具)。
* 调用路径指向网关:mock httpx,断言每个工具面的 URL / Authorization /
  X-Capability-Version(契约表见 ``plugins/apexnodes_gateway.py``)。
* 显式错误降级:401(重新登录)/402(额度)/429(限流退避)/503(vendor
  不可用)都返回带解释的 tool_error,不静默吞。
* 回退通道:``TOOLS_GATEWAY_DISABLED=1`` 时插件走迁移前的 master 内网端点
  (云端 P1 一键回退,PD §8)。
* 桌面 key 解析:无任何 env 时,从 config.yaml 的 Apex-nodes.com 托管
  custom_providers 条目取 api_key,base 落公网网关。
"""

from __future__ import annotations

import importlib.util
import json
import sys
import types
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
PLUGIN_NAMES = (
    "apexnodes-douyin-tools",
    "apexnodes-social-tools",
    "apexnodes-video-tools",
)
EXPECTED_TOOLS = {
    "apexnodes-douyin-tools": {
        "social_download",
        "media_transcribe",
        "image_ocr",
        "social_batch_submit",
        "social_batch_status",
    },
    "apexnodes-social-tools": {
        "social_content",
        "social_search",
        "social_profile",
        "social_comments",
        "social_trending",
        "social_posts",
        "social_captions",
        "creator_top_posts",
    },
    "apexnodes-video-tools": {"generate_video"},
}

# 桌面机器上不存在的 vendor/master 侧 env——冒烟前必须全空。
_VENDOR_AND_MASTER_ENV = (
    "TIKHUB_API_KEY",
    "VOLC_ACCESS_KEY",
    "VOLC_SECRET_KEY",
    "VOLCENGINE_ASR_APP_ID",
    "DOUBAO_ASR_APP_ID",
    "HERMES_PLATFORM_API_BASE",
    "HERMES_MASTER_API_BASE",
    "HERMES_SCHEDULER_API_BASE",
    "API_SERVER_KEY",
    "MODEL_API_KEY",
    "TOOLS_GATEWAY_BASE",
    "TOOLS_GATEWAY_KEY",
    "TOOLS_GATEWAY_DISABLED",
)

GATEWAY_BASE = "https://gw.test"
GATEWAY_KEY = "test-agent-key"


@pytest.fixture(autouse=True)
def _hermes_home(tmp_path, monkeypatch):
    """Isolated HERMES_HOME + 干净的 vendor/master/gateway env。"""
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    for name in _VENDOR_AND_MASTER_ENV:
        monkeypatch.delenv(name, raising=False)
    yield home


@pytest.fixture
def desktop_env(monkeypatch):
    """桌面形态:仅网关 base + Agent key,别无其它。"""
    monkeypatch.setenv("TOOLS_GATEWAY_BASE", GATEWAY_BASE)
    monkeypatch.setenv("TOOLS_GATEWAY_KEY", GATEWAY_KEY)


def _gateway_module():
    import plugins.apexnodes_gateway as gateway_module

    return gateway_module


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
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def douyin_mod():
    module = _load_plugin("apexnodes-douyin-tools")
    yield module
    sys.modules.pop(module.__name__, None)


@pytest.fixture
def social_mod():
    module = _load_plugin("apexnodes-social-tools")
    yield module
    sys.modules.pop(module.__name__, None)


@pytest.fixture
def video_mod():
    module = _load_plugin("apexnodes-video-tools")
    yield module
    sys.modules.pop(module.__name__, None)


# ---------------------------------------------------------------------------
# httpx mock(网关调用路径断言的探针)
# ---------------------------------------------------------------------------


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
        self.data = kwargs.get("data")
        self.files = kwargs.get("files")


@pytest.fixture
def fake_httpx(monkeypatch):
    """把 gw 模块用的 httpx.Client 换成录制型 fake;队列供给响应。"""
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


# ---------------------------------------------------------------------------
# 桌面形态冒烟:vendor env 全空 + 仅网关配置 → 三插件注册成功
# ---------------------------------------------------------------------------


class TestDesktopSmokeRegistration:
    def _write_enabled_config(self, hermes_home: Path):
        import yaml

        (hermes_home / "config.yaml").write_text(
            yaml.safe_dump({"plugins": {"enabled": list(PLUGIN_NAMES)}}),
            encoding="utf-8",
        )

    def test_all_three_plugins_register_with_gateway_env_only(
        self, _hermes_home, desktop_env
    ):
        self._write_enabled_config(_hermes_home)
        from hermes_cli import plugins as plugins_module

        manager = plugins_module.PluginManager()
        manager.discover_and_load()
        for name in PLUGIN_NAMES:
            assert name in manager._plugins, f"{name} 未被发现(bundled 扫描)"
            loaded = manager._plugins[name]
            assert loaded.enabled, f"{name} 未启用: {loaded.error}"
            assert loaded.error is None, f"{name} 装载报错: {loaded.error}"
            assert set(loaded.tools_registered) == EXPECTED_TOOLS[name]

    def test_gateway_mode_active_in_desktop_env(self, desktop_env):
        gateway_module = _gateway_module()
        assert gateway_module.use_gateway() is True
        assert gateway_module.gateway_base() == GATEWAY_BASE
        assert gateway_module.agent_api_key() == GATEWAY_KEY

    def test_check_fns_need_no_network_in_gateway_mode(
        self, desktop_env, douyin_mod, social_mod, video_mod
    ):
        # 注册期可用性=配置齐;不发任何网络探测(桌面离线启动不受影响)。
        assert douyin_mod._check() is True
        assert douyin_mod._check_image() is True
        assert social_mod._check() is True
        assert video_mod._check() is True


# ---------------------------------------------------------------------------
# 调用路径指向网关:URL / 头
# ---------------------------------------------------------------------------


class TestGatewayCallSurface:
    def test_social_search_url_headers_and_result_face(
        self, desktop_env, fake_httpx, social_mod
    ):
        fake_httpx.responses.append(
            FakeResponse(200, {"data": {"items": [{"id": 1}]}, "cost_cents": 2})
        )
        result = _parse(
            social_mod._handler("search")({"platform": "douyin", "query": "咖啡"})
        )
        request = fake_httpx.requests[0]
        assert request.method == "POST"
        assert request.url == f"{GATEWAY_BASE}/tools/v1/social/douyin/search"
        assert request.headers["Authorization"] == f"Bearer {GATEWAY_KEY}"
        assert request.headers["X-Capability-Version"]
        assert request.json["query"] == "咖啡"
        assert result["items"] == [{"id": 1}]
        assert result["cost_cents"] == 2

    @pytest.mark.parametrize(
        ("capability", "args"),
        [
            ("content", {"platform": "bilibili", "url": "https://b23.tv/x"}),
            ("profile", {"platform": "xiaohongshu", "user_id": "u1"}),
            ("comments", {"platform": "kuaishou", "item_id": "i1"}),
            ("trending", {"platform": "tiktok"}),
            ("posts", {"platform": "instagram", "user_id": "u2"}),
            ("captions", {"platform": "youtube", "url": "https://youtu.be/x"}),
        ],
    )
    def test_capability_actions_map_one_to_one(
        self, desktop_env, fake_httpx, social_mod, capability, args
    ):
        fake_httpx.responses.append(FakeResponse(200, {"data": {}, "cost_cents": 1}))
        social_mod._handler(capability)(args)
        assert fake_httpx.requests[0].url == (
            f"{GATEWAY_BASE}/tools/v1/social/{args['platform']}/{capability}"
        )

    def test_platform_whitelist_enforced(self, desktop_env, fake_httpx, social_mod):
        result = _parse(
            social_mod._handler("search")({"platform": "myspace", "query": "x"})
        )
        assert "不支持的平台" in result["error"]
        assert not fake_httpx.requests  # 白名单外不出网

    def test_creator_top_posts_detects_platform_from_url(
        self, desktop_env, fake_httpx, social_mod
    ):
        fake_httpx.responses.append(FakeResponse(200, {"data": {"posts": []}}))
        social_mod._creator_handler(
            {"url": "https://v.douyin.com/abcd/", "min_likes": 100000}
        )
        assert fake_httpx.requests[0].url == (
            f"{GATEWAY_BASE}/tools/v1/social/douyin/top-posts"
        )
        assert fake_httpx.requests[0].json["min_likes"] == 100000

    def test_social_download_resolves_then_fetches_direct_link(
        self, desktop_env, fake_httpx, douyin_mod, monkeypatch, tmp_path
    ):
        gateway_module = _gateway_module()
        fake_httpx.responses.append(
            FakeResponse(
                200,
                {
                    "data": {
                        "title": "示例视频",
                        "download_url": "https://cdn.example/v.mp4",
                        "download_headers": {"Referer": "https://www.douyin.com/"},
                    },
                    "cost_cents": 3,
                },
            )
        )
        downloaded = tmp_path / "v.mp4"
        downloaded.write_bytes(b"fake-video")
        seen = {}

        def fake_download(url, *, headers=None, **kwargs):
            seen["url"] = url
            seen["headers"] = headers
            return downloaded

        monkeypatch.setattr(gateway_module, "download_media", fake_download)
        result = _parse(
            douyin_mod._handle_social_download({"url": "https://v.douyin.com/xyz/"})
        )
        assert fake_httpx.requests[0].url == (
            f"{GATEWAY_BASE}/tools/v1/social/douyin/download"
        )
        assert seen["url"] == "https://cdn.example/v.mp4"
        assert seen["headers"] == {"Referer": "https://www.douyin.com/"}
        assert result["video_path"] == str(downloaded)
        assert result["title"] == "示例视频"
        assert result["cost_cents"] == 3
        assert "download_headers" not in result  # 内部细节不进结果面

    def test_social_download_unrecognized_platform_is_explicit(
        self, desktop_env, fake_httpx, douyin_mod
    ):
        result = _parse(
            douyin_mod._handle_social_download({"url": "https://example.com/foo"})
        )
        assert "无法从链接识别社媒平台" in result["error"]
        assert not fake_httpx.requests

    def test_media_transcribe_uploads_local_file_multipart(
        self, desktop_env, fake_httpx, douyin_mod, monkeypatch, tmp_path
    ):
        gateway_module = _gateway_module()
        # 桌面无 ffmpeg 的最保守形态:抽音轨失败 → 上传原文件(仍是 multipart)。
        monkeypatch.setattr(gateway_module, "extract_audio_for_asr", lambda _p: None)
        video = tmp_path / "clip.mp4"
        video.write_bytes(b"fake-bytes")
        fake_httpx.responses.append(
            FakeResponse(
                200, {"text": "大家好，今天聊三件事。", "duration_seconds": 12.5, "cost_cents": 8}
            )
        )
        result = _parse(
            douyin_mod._handle_media_transcribe({"video_path": str(video)})
        )
        request = fake_httpx.requests[0]
        assert request.url == f"{GATEWAY_BASE}/tools/v1/asr/transcribe"
        assert request.files and "file" in request.files  # multipart 形态(PD §8)
        assert request.json is None
        assert request.headers["Authorization"] == f"Bearer {GATEWAY_KEY}"
        assert result["transcript"] == "大家好，今天聊三件事。"
        assert result["audio_duration_seconds"] == 12.5
        assert result["cost_cents"] == 8
        transcript_path = Path(result["transcript_path"])
        assert transcript_path.exists()
        assert transcript_path.read_text(encoding="utf-8") == "大家好，今天聊三件事。"

    def test_media_transcribe_share_url_resolves_then_transcribes(
        self, desktop_env, fake_httpx, douyin_mod, monkeypatch, tmp_path
    ):
        gateway_module = _gateway_module()
        downloaded = tmp_path / "d.mp4"
        downloaded.write_bytes(b"x")
        monkeypatch.setattr(
            gateway_module, "download_media", lambda *a, **k: downloaded
        )
        monkeypatch.setattr(gateway_module, "extract_audio_for_asr", lambda _p: None)
        fake_httpx.responses.extend(
            [
                FakeResponse(
                    200,
                    {"data": {"title": "标题", "download_url": "https://cdn.example/d.mp4"}},
                ),
                FakeResponse(200, {"text": "转写正文", "duration_seconds": 3.0}),
            ]
        )
        result = _parse(
            douyin_mod._handle_media_transcribe(
                {"url": "看看 https://v.douyin.com/abc/ 复制此链接"}
            )
        )
        assert [r.url for r in fake_httpx.requests] == [
            f"{GATEWAY_BASE}/tools/v1/social/douyin/download",
            f"{GATEWAY_BASE}/tools/v1/asr/transcribe",
        ]
        assert result["transcript"] == "转写正文"
        assert result["title"] == "标题"
        assert result["video_path"] == str(downloaded)

    def test_image_ocr_platform_segment_and_fallback(
        self, desktop_env, fake_httpx, douyin_mod
    ):
        fake_httpx.responses.append(FakeResponse(200, {"data": {"texts": ["菜单"]}}))
        douyin_mod._handle_image_ocr({"url": "https://xhslink.com/abc"})
        assert fake_httpx.requests[0].url == (
            f"{GATEWAY_BASE}/tools/v1/social/xiaohongshu/image-ocr"
        )
        # 裸图片 URL 识别不出平台 → 回退 douyin 路由段(契约表注明)。
        fake_httpx.responses.append(FakeResponse(200, {"data": {"texts": []}}))
        douyin_mod._handle_image_ocr({"image_urls": ["https://cdn.example/a.jpg"]})
        assert fake_httpx.requests[1].url == (
            f"{GATEWAY_BASE}/tools/v1/social/douyin/image-ocr"
        )

    def test_batch_submit_and_status_endpoints(
        self, desktop_env, fake_httpx, douyin_mod
    ):
        fake_httpx.responses.append(
            FakeResponse(200, {"data": {"job_id": "j1", "status": "queued"}})
        )
        submit = _parse(
            douyin_mod._handle_social_batch_submit(
                {"urls": ["https://v.douyin.com/a/"]}
            )
        )
        assert fake_httpx.requests[0].method == "POST"
        assert fake_httpx.requests[0].url == (
            f"{GATEWAY_BASE}/tools/v1/social/batch/submit"
        )
        # 桌面形态没有 IM 会话 env → delivery_target=None → 轮询模式提示。
        assert fake_httpx.requests[0].json["delivery_target"] is None
        # hc-562 回归锚:未显式传参时缺省字段保持 None(不补默认值)。
        assert fake_httpx.requests[0].json["delivery_format"] is None
        assert "routed_intent" not in fake_httpx.requests[0].json
        assert submit["job_id"] == "j1"
        assert "social_batch_status" in submit["_instruction"]

    def test_batch_submit_forwards_delivery_format_and_routed_intent(
        self, desktop_env, fake_httpx, douyin_mod
    ):
        # hc-562 回归锚 ①:delivery_format 桌面网关腿透传(hc-450 PR2 云侧字段,
        # /tools/v1/social/batch/submit 服务端已收;此前 fork schema/payload 双缺)。
        assert "delivery_format" in (
            douyin_mod.SOCIAL_BATCH_SUBMIT_SCHEMA["parameters"]["properties"]
        )
        fake_httpx.responses.append(
            FakeResponse(200, {"data": {"job_id": "j2", "status": "queued"}})
        )
        douyin_mod._handle_social_batch_submit(
            {
                "urls": ["https://v.douyin.com/a/"],
                "delivery_format": "XLSX",
                "routed_intent": "single_transcribe_xlsx",
            }
        )
        body = fake_httpx.requests[0].json
        assert body["delivery_format"] == "xlsx"  # 归一化小写后透传
        assert body["routed_intent"] == "single_transcribe_xlsx"

        fake_httpx.responses.append(
            FakeResponse(200, {"data": {"status": "completed", "product": {}}})
        )
        status = _parse(douyin_mod._handle_social_batch_status({"job_id": "j1"}))
        assert fake_httpx.requests[1].method == "GET"
        assert fake_httpx.requests[1].url == (
            f"{GATEWAY_BASE}/tools/v1/social/batch/status/j1"
        )
        assert "任务已完成" in status["_instruction"]

    # hc-562 回归锚 ④:generate_video 网关腿绝不输出非本机路径——master 返回的
    # video_path/media_tag 是 master 本机路径(云侧共享卷语义),桌面必须用
    # video_url 直链本地落地后再出 MEDIA 标签。
    _MASTER_VIDEO_PATH = "/data/hermes/agents/a1/media/jobs/j1/video_1.mp4"

    def test_generate_video_gateway_lands_video_locally(
        self, desktop_env, fake_httpx, video_mod, monkeypatch, tmp_path
    ):
        gateway_module = _gateway_module()
        fake_httpx.responses.append(
            FakeResponse(
                200,
                {
                    "data": {
                        "video_url": "https://cdn.example/o.mp4",
                        "video": "https://cdn.example/o.mp4",
                        "video_path": self._MASTER_VIDEO_PATH,
                        "media_tag": f"MEDIA:{self._MASTER_VIDEO_PATH}",
                    },
                    "cost_cents": 40,
                },
            )
        )
        downloaded = tmp_path / "gen.mp4"
        downloaded.write_bytes(b"fake-video")
        seen = {}

        def fake_download(url, **kwargs):
            seen["url"] = url
            return downloaded

        monkeypatch.setattr(gateway_module, "download_media", fake_download)
        raw = video_mod._handle_generate_video({"prompt": "一只猫在弹钢琴"})
        result = _parse(raw)
        request = fake_httpx.requests[0]
        assert request.url == f"{GATEWAY_BASE}/tools/v1/video/generate"
        assert request.json["prompt"] == "一只猫在弹钢琴"
        assert request.headers["X-Capability-Version"]
        assert seen["url"] == "https://cdn.example/o.mp4"
        assert result["video_path"] == str(downloaded)
        assert result["media_tag"] == f"MEDIA:{downloaded}"
        assert result["video_url"] == "https://cdn.example/o.mp4"
        assert result["cost_cents"] == 40
        assert self._MASTER_VIDEO_PATH not in raw  # master 本机路径绝不进结果面

    def test_generate_video_gateway_download_failure_keeps_url_with_expiry_note(
        self, desktop_env, fake_httpx, video_mod, monkeypatch
    ):
        gateway_module = _gateway_module()
        fake_httpx.responses.append(
            FakeResponse(
                200,
                {
                    "data": {
                        "video_url": "https://cdn.example/o.mp4",
                        "video_path": self._MASTER_VIDEO_PATH,
                        "media_tag": f"MEDIA:{self._MASTER_VIDEO_PATH}",
                    },
                    "cost_cents": 40,
                },
            )
        )

        def failing_download(url, **kwargs):
            raise gateway_module.GatewayError("direct link fetch failed")

        monkeypatch.setattr(gateway_module, "download_media", failing_download)
        raw = video_mod._handle_generate_video({"prompt": "一只猫在弹钢琴"})
        result = _parse(raw)
        assert result["video_url"] == "https://cdn.example/o.mp4"
        assert "video_path" not in result
        assert "media_tag" not in result
        assert "有效期" in result["note"]  # 回退=只给 url 并明说链接时效
        assert self._MASTER_VIDEO_PATH not in raw


# ---------------------------------------------------------------------------
# 显式错误降级(401/402/429/503)
# ---------------------------------------------------------------------------


class TestExplicitErrorDegradation:
    @pytest.mark.parametrize(
        ("status", "marker"),
        [
            (401, "重新登录"),
            (402, "额度不足"),
            (503, "平台能力暂不可用"),
        ],
    )
    def test_http_errors_map_to_explicit_chinese_guidance(
        self, desktop_env, fake_httpx, social_mod, status, marker
    ):
        fake_httpx.responses.append(
            FakeResponse(status, {"detail": {"message": "server says no"}})
        )
        result = _parse(
            social_mod._handler("search")({"platform": "douyin", "query": "x"})
        )
        assert str(status) in result["error"]
        assert marker in result["error"]
        assert "server says no" in result["error"]  # 服务端 detail 透传,不吞

    def test_429_bounded_backoff_then_explicit_message(
        self, desktop_env, fake_httpx, social_mod
    ):
        gateway_module = _gateway_module()
        fake_httpx.responses.extend(
            [FakeResponse(429, {}, headers={"Retry-After": "0"})]
            * (gateway_module._MAX_429_RETRIES + 1)
        )
        result = _parse(
            social_mod._handler("search")({"platform": "douyin", "query": "x"})
        )
        # 初次 + 2 次退避重试,仍限流 → 显式文案。
        assert len(fake_httpx.requests) == gateway_module._MAX_429_RETRIES + 1
        assert "429" in result["error"]
        assert "频繁" in result["error"]

    def test_missing_key_is_explicit_not_silent(self, monkeypatch, fake_httpx, social_mod):
        monkeypatch.setenv("TOOLS_GATEWAY_BASE", GATEWAY_BASE)
        result = _parse(
            social_mod._handler("search")({"platform": "douyin", "query": "x"})
        )
        assert "缺少平台密钥" in result["error"]
        assert not fake_httpx.requests


# ---------------------------------------------------------------------------
# 回退通道:TOOLS_GATEWAY_DISABLED=1 → 迁移前 master 直连路径
# ---------------------------------------------------------------------------


class _FakeUrlopenResponse:
    def __init__(self, body: dict):
        self._body = json.dumps(body).encode("utf-8")

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class TestGatewayDisabledFallback:
    @pytest.fixture
    def legacy_env(self, monkeypatch, desktop_env):
        monkeypatch.setenv("TOOLS_GATEWAY_DISABLED", "1")
        monkeypatch.setenv("HERMES_PLATFORM_API_BASE", "http://master.test/api/v1")
        monkeypatch.setenv("API_SERVER_KEY", "legacy-key")

    @pytest.fixture
    def fake_urlopen(self, monkeypatch):
        calls = []

        def _fake(request, timeout=None):
            calls.append(request)
            return _FakeUrlopenResponse({"ok": True, "items": []})

        monkeypatch.setattr("urllib.request.urlopen", _fake)
        return calls

    def test_social_search_falls_back_to_master_endpoint(
        self, legacy_env, fake_urlopen, fake_httpx, social_mod
    ):
        social_mod._handler("search")({"platform": "douyin", "query": "x"})
        assert fake_urlopen[0].full_url == "http://master.test/api/v1/data/social/search"
        assert fake_urlopen[0].get_header("Authorization") == "Bearer legacy-key"
        assert not fake_httpx.requests  # 一个字节都不走网关

    def test_social_download_falls_back_to_master_endpoint(
        self, legacy_env, fake_urlopen, fake_httpx, douyin_mod
    ):
        douyin_mod._handle_social_download({"url": "https://v.douyin.com/abc/"})
        assert fake_urlopen[0].full_url == "http://master.test/api/v1/media/social-download"
        # hc-562 回归锚:未被路由命中时不注入 routed_intent(缺省字段不补)。
        assert "routed_intent" not in json.loads(fake_urlopen[0].data.decode("utf-8"))
        assert not fake_httpx.requests

    def test_social_download_forwards_routed_intent(
        self, legacy_env, fake_urlopen, fake_httpx, douyin_mod
    ):
        # hc-562 回归锚 ②:intent-router 命中标记透传 master(hc-450 PR1,
        # master 端点据此打 intent_router_hit 结构化日志)。
        douyin_mod._handle_social_download(
            {"url": "https://v.douyin.com/abc/", "routed_intent": "single_download"}
        )
        body = json.loads(fake_urlopen[0].data.decode("utf-8"))
        assert body == {"url": "https://v.douyin.com/abc/", "routed_intent": "single_download"}

    def test_media_transcribe_forwards_routed_intent(
        self, legacy_env, fake_urlopen, fake_httpx, douyin_mod
    ):
        # hc-562 回归锚 ③:transcribe 同样透传命中标记(url 一步转写形态)。
        douyin_mod._handle_media_transcribe(
            {"url": "https://v.douyin.com/abc/", "routed_intent": "single_transcribe"}
        )
        assert fake_urlopen[0].full_url == "http://master.test/api/v1/media/transcribe"
        body = json.loads(fake_urlopen[0].data.decode("utf-8"))
        assert body["url"] == "https://v.douyin.com/abc/"
        assert body["routed_intent"] == "single_transcribe"

    def test_generate_video_falls_back_to_master_endpoint(
        self, legacy_env, fake_urlopen, fake_httpx, video_mod
    ):
        video_mod._handle_generate_video({"prompt": "x"})
        assert fake_urlopen[0].full_url == "http://master.test/api/v1/media/video-generate"
        assert not fake_httpx.requests

    def test_no_gateway_config_at_all_behaves_like_before_migration(self, social_mod):
        # 云容器零新 env(base/key 都没有)时不进入网关模式——行为与迁移前一致。
        gateway_module = _gateway_module()
        assert gateway_module.use_gateway() is False


# ---------------------------------------------------------------------------
# 桌面 key 解析:config.yaml 托管 custom_providers 条目(provision-key 写入)
# ---------------------------------------------------------------------------


class TestDesktopManagedKeyResolution:
    def test_key_and_base_resolve_from_managed_custom_provider(self, _hermes_home):
        import yaml

        (Path(_hermes_home) / "config.yaml").write_text(
            yaml.safe_dump(
                {
                    "custom_providers": [
                        {
                            "name": "Apex-nodes.com",
                            "base_url": "https://apex-nodes.com/relay/v1",
                            "model": "deepseek-v4-pro-APEX",
                            "api_key": "sk-desktop-123",
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )
        gateway_module = _gateway_module()
        assert gateway_module.agent_api_key() == "sk-desktop-123"
        assert gateway_module.gateway_base() == gateway_module.GATEWAY_PUBLIC_BASE
        assert gateway_module.use_gateway() is True

    def test_env_key_wins_over_managed_config(self, _hermes_home, monkeypatch):
        monkeypatch.setenv("TOOLS_GATEWAY_KEY", "env-key")
        monkeypatch.setenv("TOOLS_GATEWAY_BASE", GATEWAY_BASE)
        gateway_module = _gateway_module()
        assert gateway_module.agent_api_key() == "env-key"
        assert gateway_module.gateway_base() == GATEWAY_BASE
