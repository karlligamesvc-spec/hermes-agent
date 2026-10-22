"""Input images for the Desktop generate_image / generate_video (参考图、首帧、首尾帧).

The platform side and the design live in apex-nodes (docs/design/generation-input-images.md,
contract ``generation-input-images``). generate_video's behaviors are pinned by the shared
plugin contract v11 (tests/plugins/test_apexnodes_plugin_contract.py, both legs);
generate_image is not in that contract, so its copy of the same rules is pinned here,
with the shared helper in plugins/apexnodes_gateway.py:

* each ``source`` becomes what the platform takes: a handle and a platform link pass as
  they are, a local file or a foreign link is uploaded first, a path that is not here
  fails on the Desktop (there are no master paths to name) and passes on the legacy leg;
* nothing goes out before the check confirms the platform takes images, and an image
  that cannot be used fails the call instead of a request without it;
* the handles the platform returns (``image_ref``, ``last_frame_ref``) survive the
  Desktop's localizing of results.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import types
from pathlib import Path

import httpx
import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
GATEWAY_BASE = "https://gw.test"
LEGACY_BASE = "http://master.test/api/v1"
UPLOADED = "media:" + "f" * 32 + "/ref_1.png"
REF_A = "media:" + "a" * 32 + "/image_1.png"
SIGNED = "https://apex-nodes.com/api/v1/media/image/" + "t" * 32
ROLES = ["first_frame", "last_frame", "reference"]
KINDS = ["person", "product", "scene", "style", "other"]


def _load_plugin(name: str):
    slug = name.replace("-", "_")
    module_name = f"hermes_plugins.{slug}_inputs"
    plugin_dir = REPO_ROOT / "plugins" / name
    if "hermes_plugins" not in sys.modules:
        namespace = types.ModuleType("hermes_plugins")
        namespace.__path__ = []  # type: ignore[attr-defined]
        sys.modules["hermes_plugins"] = namespace
    spec = importlib.util.spec_from_file_location(
        module_name, plugin_dir / "__init__.py", submodule_search_locations=[str(plugin_dir)]
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def _gateway():
    import plugins.apexnodes_gateway as gateway_module

    return gateway_module


@pytest.fixture(autouse=True)
def _env(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    for name in ("TOOLS_GATEWAY_DISABLED", "HERMES_PLATFORM_API_BASE", "API_SERVER_KEY", "MODEL_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("TOOLS_GATEWAY_BASE", GATEWAY_BASE)
    monkeypatch.setenv("TOOLS_GATEWAY_KEY", "test-agent-key")
    return home


class Gateway:
    """Fake gateway leg: records request_json calls, answers like the platform."""

    def __init__(self, monkeypatch, *, supported: bool = True, upload=None, generate=None):
        self.calls: list[dict] = []
        gateway = _gateway()

        def request_json(method, path, payload=None, *, timeout=90, files=None, form_data=None):
            self.calls.append({"method": method, "path": path, "payload": payload, "files": files})
            if path == "/tools/v1/check":
                section = {"configured": True, "serving": True, "legs": {}}
                if supported:
                    section["input_images"] = {"supported": True}
                return {"ok": True, "image": section, "video": section}
            if path == "/tools/v1/media/reference-upload":
                if isinstance(upload, BaseException):
                    raise upload
                return {"ok": True, "data": {"image_ref": UPLOADED}}
            return generate or {"ok": True, "data": {"image_url": "https://cdn.example/i.png", "image_ref": "media:" + "e" * 32 + "/image_1.png"}}

        monkeypatch.setattr(gateway, "request_json", request_json)
        monkeypatch.setattr(gateway, "download_media", lambda url, **_kw: Path(_kw.get("filename_hint") or "x"))
        monkeypatch.setattr(gateway, "_download_input_image", lambda url, index: b"\x89PNG-remote")

    def paths(self) -> list[str]:
        return [call["path"] for call in self.calls]

    def generate(self, path: str) -> dict:
        (call,) = [c for c in self.calls if c["path"] == path]
        return call["payload"]


@pytest.fixture
def image_mod(monkeypatch):
    module = _load_plugin("apexnodes-image-tools")
    monkeypatch.setattr(module, "_desktop_image_model", lambda: None)
    yield module
    sys.modules.pop(module.__name__, None)


@pytest.fixture
def video_mod(monkeypatch):
    module = _load_plugin("apexnodes-video-tools")
    monkeypatch.setattr(module, "_desktop_video_model", lambda: None)
    yield module
    sys.modules.pop(module.__name__, None)


def test_desktop_image_sources_become_what_the_platform_takes(monkeypatch, tmp_path, image_mod):
    fake = Gateway(monkeypatch)
    attached = tmp_path / "attached.jpg"
    attached.write_bytes(b"\xff\xd8-attached")
    sources = [REF_A, SIGNED, str(attached), "https://example.com/product.png"]
    result = json.loads(
        image_mod._handle_generate_image({"prompt": "x", "images": [{"source": s, "kind": "product", "role": "first_frame"} for s in sources]})
    )
    assert "error" not in result, result
    sent = fake.generate("/tools/v1/image/generate")["images"]
    assert sent == [
        {"ref": REF_A, "kind": "product"},
        {"url": SIGNED, "kind": "product"},
        {"ref": UPLOADED, "kind": "product"},
        {"ref": UPLOADED, "kind": "product"},
    ], "an image call sends no role"
    uploads = [c for c in fake.calls if c["path"] == "/tools/v1/media/reference-upload"]
    assert [u["files"]["file"][1] for u in uploads] == [b"\xff\xd8-attached", b"\x89PNG-remote"]
    assert result["image_ref"].startswith("media:"), "the handle survives the Desktop's localizing"


def test_a_path_that_is_not_here_fails_on_the_desktop(monkeypatch, image_mod):
    fake = Gateway(monkeypatch)
    result = json.loads(image_mod._handle_generate_image({"prompt": "x", "images": ["/data/hermes/u/a/workspace/media/j/image_1.png"]}))
    assert "error" in result and "找不到第 1 张图" in result["error"]
    assert "/tools/v1/image/generate" not in fake.paths()


def test_nothing_goes_out_before_the_platform_says_it_takes_images(monkeypatch, image_mod, video_mod):
    for module, handler in ((image_mod, "_handle_generate_image"), (video_mod, "_handle_generate_video")):
        fake = Gateway(monkeypatch, supported=False)
        result = json.loads(getattr(module, handler)({"prompt": "x", "images": [{"source": REF_A, "role": "first_frame"}]}))
        assert "error" in result and "平台还不支持带图生成" in result["error"]
        assert all(call["method"] == "GET" for call in fake.calls), fake.paths()


def test_an_upload_failure_fails_the_image_call(monkeypatch, tmp_path, image_mod):
    failure = _gateway().GatewayError("媒体空间满了", status=503, code="vendor_unavailable")
    fake = Gateway(monkeypatch, upload=failure)
    photo = tmp_path / "photo.jpg"
    photo.write_bytes(b"\xff\xd8")
    result = json.loads(image_mod._handle_generate_image({"prompt": "x", "images": [str(photo)]}))
    assert "error" in result and "媒体空间满了" in result["error"] and "不会改成不带图" in result["error"]
    assert "/tools/v1/image/generate" not in fake.paths()


def test_a_text_only_image_call_sends_no_image_fields_and_rights_need_an_explicit_true(monkeypatch, image_mod):
    fake = Gateway(monkeypatch)
    image_mod._handle_generate_image({"prompt": "x"})
    body = fake.generate("/tools/v1/image/generate")
    assert "images" not in body and "rights_confirmed" not in body
    for given, sent in (("true", False), (True, True)):
        fake.calls.clear()
        image_mod._handle_generate_image({"prompt": "x", "images": [REF_A], "rights_confirmed": given})
        assert fake.generate("/tools/v1/image/generate")["rights_confirmed"] is sent


def test_the_last_frame_handle_survives_the_desktop_video_localizing(monkeypatch, video_mod):
    generate = {"ok": True, "data": {"video_url": "https://cdn.example/o.mp4", "video_path": "/data/x.mp4", "last_frame_ref": "media:" + "e" * 32 + "/last_frame.jpg"}}
    Gateway(monkeypatch, generate=generate)
    result = json.loads(video_mod._handle_generate_video({"prompt": "x"}))
    assert result["last_frame_ref"].endswith("/last_frame.jpg")
    assert result["video_path"] != "/data/x.mp4", "master paths are still replaced"


def test_the_legacy_leg_passes_a_master_path_to_the_platform(monkeypatch, image_mod):
    monkeypatch.setenv("TOOLS_GATEWAY_DISABLED", "1")
    monkeypatch.setenv("HERMES_PLATFORM_API_BASE", LEGACY_BASE)
    monkeypatch.setenv("API_SERVER_KEY", "legacy-key")
    sent: list[dict] = []

    def request(method, path, payload=None, timeout=180):
        if path.endswith("/check"):
            return {"ok": True, "input_images": {"supported": True}, "legs": {}}
        sent.append(payload)
        return {"ok": True, "image_url": "https://x/i.png"}

    monkeypatch.setattr(image_mod, "_request", request)
    master_path = "/data/hermes/u/a/workspace/media/" + "b" * 32 + "/image_1.png"
    image_mod._handle_generate_image({"prompt": "x", "images": [master_path]})
    assert sent[-1]["images"] == [{"path": master_path}]


class _Stream:
    def __init__(self, status: int, chunks: list[bytes]):
        self.status_code, self._chunks = status, chunks

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def iter_bytes(self):
        yield from self._chunks


class _Client:
    stream_answer: _Stream

    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def stream(self, method, url, headers=None):
        return type(self).stream_answer


@pytest.mark.parametrize(
    ("status", "chunks", "message"),
    [(200, [b"x" * 3, b"x" * 3], "超过"), (404, [], "HTTP 404")],
    ids=["over-the-cap", "http-error"],
)
def test_a_foreign_link_is_capped_and_its_failure_named(monkeypatch, status, chunks, message):
    gateway = _gateway()
    monkeypatch.setattr(gateway, "INPUT_IMAGE_MAX_BYTES", 5)
    _Client.stream_answer = _Stream(status, chunks)
    monkeypatch.setattr(gateway.httpx, "Client", _Client)
    with pytest.raises(gateway.InputImageError) as exc:
        gateway._download_input_image("https://example.com/big.png", 1)
    assert message in str(exc.value)


def test_a_dropped_connection_on_a_foreign_link_is_an_input_image_error(monkeypatch):
    gateway = _gateway()

    class Broken(_Client):
        def stream(self, method, url, headers=None):
            raise httpx.ConnectError("refused")

    monkeypatch.setattr(gateway.httpx, "Client", Broken)
    with pytest.raises(gateway.InputImageError):
        gateway._download_input_image("https://example.com/x.png", 2)


@pytest.mark.parametrize("plugin", ["apexnodes-image-tools", "apexnodes-video-tools"])
def test_the_schemas_offer_what_the_platform_takes(plugin):
    module = _load_plugin(plugin)
    schema = getattr(module, "GENERATE_IMAGE_SCHEMA" if "image" in plugin else "GENERATE_VIDEO_SCHEMA")
    images = schema["parameters"]["properties"]["images"]
    assert images["items"]["properties"]["kind"]["enum"] == KINDS
    assert schema["parameters"]["properties"]["rights_confirmed"]["type"] == "boolean"
    if "image" in plugin:
        assert images["maxItems"] == 4 and "role" not in images["items"]["properties"]
    else:
        assert images["maxItems"] == 9 and images["items"]["properties"]["role"]["enum"] == ROLES
    sys.modules.pop(module.__name__, None)


def test_an_upload_answer_without_a_handle_fails_the_call(monkeypatch, tmp_path, image_mod):
    fake = Gateway(monkeypatch)
    gateway = _gateway()
    real = gateway.request_json

    def no_handle(method, path, payload=None, **kwargs):
        if path == "/tools/v1/media/reference-upload":
            fake.calls.append({"method": method, "path": path, "payload": payload, "files": kwargs.get("files")})
            return {"ok": True, "data": {"image_ref": "/tmp/not-a-handle.png"}}
        return real(method, path, payload, **kwargs)

    monkeypatch.setattr(gateway, "request_json", no_handle)
    photo = tmp_path / "photo.jpg"
    photo.write_bytes(b"\xff\xd8")
    result = json.loads(image_mod._handle_generate_image({"prompt": "x", "images": [str(photo)]}))
    assert "error" in result and "no image_ref" in result["error"]
    assert "/tools/v1/image/generate" not in fake.paths()
