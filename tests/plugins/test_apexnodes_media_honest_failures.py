"""hc-969: the Desktop image/video tools read leg health and say failures honestly.

2026-10-18 review: every Desktop image and video generation failed, and the user was
told "服务繁忙,请稍后重试" and waited. The server side (hc-945, hc-948) now reports
each leg's health on /tools/v1/check and names its failures; this pins the Desktop
side of both plugins, on both transports:

* before generating, the leg the call will use is read from the server's check. A leg
  that is switched off or failing is said at once, with no render request. The tool
  itself stays offered (Kael, 2026-10-19: hiding it makes the assistant believe it
  cannot make videos at all);
* only a failure that clears by itself invites another try. A daily limit says it
  comes back tomorrow and is not retried; switched off / not set up / rejected
  platform credentials say retrying will not help.
"""

from __future__ import annotations

import importlib.util
import io
import json
import sys
import types
import urllib.error
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
GATEWAY_BASE = "https://gw.test"
LEGACY_BASE = "http://master.test/api/v1"
MINI = "doubao-seedance-2-0-mini-260615"
FLARE = "gpt-image-2.5-flare"

# What a "try again later" promise looks like in any of our copy.
RETRY_LATER = ("稍后", "1-2 分钟", "繁忙")

MEDIA = {
    "image": {
        "plugin": "apexnodes-image-tools",
        "handler": "_handle_generate_image",
        "label": "图片",
        "model": FLARE,
        "picker_key": "generation_image_model",
        "generate": "/tools/v1/image/generate",
        "legacy_generate": "/media/image-generate",
        "legacy_check": "/media/image/check",
    },
    "video": {
        "plugin": "apexnodes-video-tools",
        "handler": "_handle_generate_video",
        "label": "视频",
        "model": MINI,
        "picker_key": "generation_video_model",
        "generate": "/tools/v1/video/generate",
        "legacy_generate": "/media/video-generate",
        "legacy_check": "/media/video/check",
    },
}

_ENV = (
    "HERMES_PLATFORM_API_BASE",
    "HERMES_MASTER_API_BASE",
    "HERMES_SCHEDULER_API_BASE",
    "API_SERVER_KEY",
    "MODEL_API_KEY",
    "TOOLS_GATEWAY_BASE",
    "TOOLS_GATEWAY_KEY",
    "TOOLS_GATEWAY_DISABLED",
)


@pytest.fixture(autouse=True)
def _hermes_home(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    for name in _ENV:
        monkeypatch.delenv(name, raising=False)
    return home


@pytest.fixture
def desktop_env(monkeypatch):
    monkeypatch.setenv("TOOLS_GATEWAY_BASE", GATEWAY_BASE)
    monkeypatch.setenv("TOOLS_GATEWAY_KEY", "test-agent-key")


@pytest.fixture
def legacy_env(monkeypatch):
    monkeypatch.setenv("TOOLS_GATEWAY_DISABLED", "1")
    monkeypatch.setenv("HERMES_PLATFORM_API_BASE", LEGACY_BASE)
    monkeypatch.setenv("API_SERVER_KEY", "legacy-key")


def _gateway_module():
    import plugins.apexnodes_gateway as gateway_module

    return gateway_module


def _load_plugin(name: str):
    slug = name.replace("-", "_")
    module_name = f"hermes_plugins.{slug}"
    plugin_dir = REPO_ROOT / "plugins" / name
    if "hermes_plugins" not in sys.modules:
        namespace = types.ModuleType("hermes_plugins")
        namespace.__path__ = []  # type: ignore[attr-defined]
        sys.modules["hermes_plugins"] = namespace
    spec = importlib.util.spec_from_file_location(
        module_name, plugin_dir / "__init__.py", submodule_search_locations=[str(plugin_dir)]
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def _media_plugin(kind: str):
    spec = MEDIA[kind]
    module = _load_plugin(spec["plugin"])
    yield types.SimpleNamespace(kind=kind, module=module, **spec)
    sys.modules.pop(module.__name__, None)


@pytest.fixture(params=sorted(MEDIA))
def media(request):
    yield from _media_plugin(request.param)


@pytest.fixture
def video():
    yield from _media_plugin("video")


@pytest.fixture
def image():
    yield from _media_plugin("image")


def _generate(media, args=None) -> dict:
    return json.loads(getattr(media.module, media.handler)(args or {"prompt": "收纳架开箱"}))


def _pick(home: Path, media, model: str) -> None:
    (home / "config.yaml").write_text(f"apex:\n  {media.picker_key}: {model}\n", encoding="utf-8")


# ── fakes: the gateway (httpx) and the legacy master endpoints (urllib) ────────


class FakeResponse:
    def __init__(self, status_code=200, body=None):
        self.status_code = status_code
        self._body = body if body is not None else {}
        self.headers = {}
        self.text = json.dumps(self._body, ensure_ascii=False)

    def json(self):
        return self._body


@pytest.fixture
def server(monkeypatch):
    """Fake gateway: queue answers per path; records (method, path) of every request."""
    gateway_module = _gateway_module()
    state = types.SimpleNamespace(requests=[], answers={})

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def request(self, method, url, **kwargs):
            path = url[len(GATEWAY_BASE):]
            state.requests.append((method, path))
            queue = state.answers.get(path)
            if not queue:
                raise AssertionError(f"unexpected request {method} {path}")
            return queue.pop(0)

    def answer(path, *responses):
        state.answers.setdefault(path, []).extend(responses)

    state.answer = answer
    monkeypatch.setattr(gateway_module.httpx, "Client", FakeClient)
    monkeypatch.setattr(gateway_module.time, "sleep", lambda _s: None)
    return state


class _UrlopenResponse:
    def __init__(self, body):
        self._body = json.dumps(body, ensure_ascii=False).encode("utf-8")

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture
def master(monkeypatch):
    """Fake legacy master endpoints: path -> body, or (status, body) for an HTTP error."""
    state = types.SimpleNamespace(paths=[], answers={})

    def fake_urlopen(request, timeout=None):
        path = request.full_url[len(LEGACY_BASE):]
        state.paths.append(path)
        answer = state.answers[path]
        if isinstance(answer, tuple):
            status, body = answer
            raw = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode("utf-8")
            raise urllib.error.HTTPError(request.full_url, status, "error", {}, io.BytesIO(raw))
        return _UrlopenResponse(answer)

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    return state


def _vendor_unavailable(vendor_code: str, message: str) -> dict:
    """The gateway folds every media 5xx into 503 vendor_unavailable (tools_gateway._map_vendor_error)."""
    return {"detail": {"code": "vendor_unavailable", "message": message, "vendor_code": vendor_code}}


def _leg(*, configured=True, healthy=True, retry_after=None) -> dict:
    """One /tools/v1/check leg entry as hc-945 reports it (health fields at the top)."""
    return {
        "configured": configured,
        "serving": configured and healthy,
        "state": "ok" if healthy else "failing",
        "healthy": healthy,
        "consecutive_failures": 0 if healthy else 3,
        "last_failure_code": None if healthy else "video_provider_busy",
        "retry_after_seconds": retry_after,
    }


def _check_body(kind: str, *, flat: dict | None = None, legs: dict | None = None) -> dict:
    flat = flat or _leg()
    section = {
        "configured": flat["configured"],
        "serving": flat["serving"],
        "health": {k: v for k, v in flat.items() if k not in {"configured", "serving"}},
        "legs": legs or {},
    }
    return {"ok": True, kind: section}


# ── 1. failure copy: only a failure that clears by itself invites another try ─


GATEWAY_FAILURES = [
    # (status, body, expected sentence after "<label>生成失败: ")
    pytest.param(
        503,
        _vendor_unavailable("video_generation_unavailable", "视频生成暂不可用。"),
        "平台现在暂时关闭了{label}生成，重新开放之前重试也不会成功。",
        id="503-switched-off",
    ),
    pytest.param(
        503,
        _vendor_unavailable("provider_not_configured", "平台未配置生成服务，请联系管理员。"),
        "平台还没有开通{label}生成服务，重试也不会成功。",
        id="503-not-configured",
    ),
    pytest.param(
        503,
        _vendor_unavailable("provider_auth_failed", "平台生成配置不可用，请联系管理员。"),
        "平台的{label}生成服务配置出了问题，要等平台修好才能用，重试也不会成功。",
        id="503-auth-failed",
    ),
]


@pytest.mark.parametrize(("status", "body", "expected"), GATEWAY_FAILURES)
def test_gateway_failures_no_retry_can_fix_say_so(desktop_env, server, media, status, body, expected):
    server.answer("/tools/v1/check", FakeResponse(200, {"ok": True}))
    server.answer(media.generate, FakeResponse(status, body))

    error = _generate(media, {"prompt": "x", "model": media.model})["error"]

    assert error == f"{media.label}生成失败: " + expected.format(label=media.label)
    assert not any(marker in error for marker in RETRY_LATER)


@pytest.mark.parametrize(
    "transport",
    ["gateway", "legacy"],
)
def test_daily_limit_says_tomorrow_and_is_not_retried(transport, request, media, monkeypatch):
    code = f"{media.kind}_daily_limit_reached"
    body = {"detail": {"code": code, "message": f"今日{media.label}生成额度已用完，请明天再试。"}}
    if transport == "gateway":
        request.getfixturevalue("desktop_env")
        server = request.getfixturevalue("server")
        server.answer("/tools/v1/check", FakeResponse(200, {"ok": True}))
        server.answer(media.generate, FakeResponse(429, body), FakeResponse(429, body), FakeResponse(429, body))
        error = _generate(media, {"prompt": "x", "model": media.model})["error"]
        # One render request: backing off cannot bring back a quota that resets tomorrow.
        assert server.requests == [("GET", "/tools/v1/check"), ("POST", media.generate)]
    else:
        request.getfixturevalue("legacy_env")
        master = request.getfixturevalue("master")
        master.answers = {media.legacy_check: {"ok": True}, media.legacy_generate: (429, body)}
        error = _generate(media, {"prompt": "x", "model": media.model})["error"]

    assert error == f"{media.label}生成失败: 今天的{media.label}生成额度用完了，明天恢复。"
    assert not any(marker in error for marker in RETRY_LATER)


def test_a_busy_upstream_keeps_the_servers_own_sentence(desktop_env, server, media):
    """hc-945 wrote each busy/timeout sentence per code; the Desktop no longer wraps it
    in its own "平台能力暂不可用(503),请稍后重试" lead."""
    busy = f"{media.label}生成服务繁忙,请稍后重试"
    server.answer("/tools/v1/check", FakeResponse(200, {"ok": True}))
    server.answer(media.generate, FakeResponse(503, _vendor_unavailable(f"{media.kind}_provider_busy", busy)))

    error = _generate(media, {"prompt": "x", "model": media.model})["error"]

    assert error == f"{media.label}生成失败: {busy}"


def test_an_unexplained_503_promises_nothing(desktop_env, server, media):
    server.answer("/tools/v1/check", FakeResponse(200, {"ok": True}))
    server.answer(media.generate, FakeResponse(503, {}))

    error = _generate(media, {"prompt": "x", "model": media.model})["error"]

    assert error == f"{media.label}生成失败: {media.label}生成服务出了问题，没有说明原因。"


def test_a_rate_limit_is_still_backed_off_and_retried(desktop_env, server, video):
    """Only the daily limits skip the backoff; a per-minute limit can clear in seconds."""
    limited = {"detail": {"code": "video_rate_limited", "message": "视频生成请求过于频繁，请稍后再试。"}}
    server.answer("/tools/v1/check", FakeResponse(200, {"ok": True}))
    server.answer(video.generate, *[FakeResponse(429, limited) for _ in range(3)])

    error = _generate(video)["error"]

    assert server.requests.count(("POST", video.generate)) == 3
    assert "频繁" in error


@pytest.mark.parametrize(
    ("answer", "expected"),
    [
        pytest.param(
            (503, {"detail": {"code": "video_generation_unavailable", "message": "视频生成暂不可用。"}}),
            "平台现在暂时关闭了{label}生成，重新开放之前重试也不会成功。",
            id="503-switched-off",
        ),
        pytest.param((502, b""), "{label}生成服务出错了(HTTP 502),没有说明原因。", id="empty-body"),
    ],
)
def test_legacy_leg_says_the_same_as_the_gateway(legacy_env, master, media, answer, expected):
    master.answers = {media.legacy_check: {"ok": True}, media.legacy_generate: answer}

    error = _generate(media, {"prompt": "x", "model": media.model})["error"]

    assert error == f"{media.label}生成失败: " + expected.format(label=media.label)
    assert not any(marker in error for marker in RETRY_LATER)


# ── 2. leg health is read before generating; an unavailable leg is said at once ─


def test_switched_off_video_is_said_before_any_render(desktop_env, server, video):
    off = _leg(configured=False)
    server.answer("/tools/v1/check", FakeResponse(200, _check_body("video", flat=off, legs={f"chinaapi:{MINI}": off})))

    result = _generate(video)

    assert result["error"] == "平台现在暂时关闭了视频生成，重新开放之前重试也不会成功。"
    assert server.requests == [("GET", "/tools/v1/check")]


def test_a_failing_default_leg_says_when_to_try_again(desktop_env, server, video):
    failing = _leg(healthy=False, retry_after=600)
    server.answer("/tools/v1/check", FakeResponse(200, _check_body("video", flat=failing)))

    result = _generate(video)

    assert result["error"] == "视频生成最近连续几次都没成功，平台先暂停了它，大约 10 分钟后可以再试。"
    assert server.requests == [("GET", "/tools/v1/check")]


def test_the_picked_models_leg_decides(_hermes_home, desktop_env, server, media):
    """The Desktop sends the picker's model, so its own leg is read, not the flat default."""
    _pick(_hermes_home, media, media.model)
    other = "MiniMax-H3" if media.kind == "video" else "qwen-image-3.0-pro"
    failing = _leg(healthy=False, retry_after=61)
    legs = {f"chinaapi:{media.model}": failing, f"chinaapi:{other}": _leg()}
    server.answer("/tools/v1/check", FakeResponse(200, _check_body(media.kind, flat=_leg(), legs=legs)))

    result = _generate(media)

    assert result["error"] == (
        f"你选的{media.label}模型最近连续几次都没生成成功，平台先暂停了它，大约 2 分钟后可以再试；"
        f"现在也可以在输入框的「+」菜单里换一个{media.label}模型。"
    )
    assert server.requests == [("GET", "/tools/v1/check")]

    # The other way round: a failing default does not block a serving picked model.
    _pick(_hermes_home, media, other)
    server.requests.clear()
    server.answer("/tools/v1/check", FakeResponse(200, _check_body(media.kind, flat=failing, legs=legs)))
    server.answer(media.generate, FakeResponse(200, {"data": {"ok": True}}))

    assert _generate(media)["ok"] is True
    assert server.requests == [("GET", "/tools/v1/check"), ("POST", media.generate)]


@pytest.mark.parametrize(
    "check_answer",
    [
        pytest.param(lambda _kind: FakeResponse(500, {}), id="check-unreadable"),
        pytest.param(lambda kind: FakeResponse(200, {"ok": True, kind: {"configured": False}}),
                     id="server-before-hc945"),
        pytest.param(lambda kind: FakeResponse(200, _check_body(kind, flat=_leg(configured=False), legs={})),
                     id="model-not-listed"),
    ],
)
def test_no_clear_verdict_goes_ahead(_hermes_home, desktop_env, server, media, check_answer):
    _pick(_hermes_home, media, media.model)
    server.answer("/tools/v1/check", check_answer(media.kind))
    server.answer(media.generate, FakeResponse(200, {"data": {"ok": True}}))

    assert _generate(media)["ok"] is True
    assert server.requests == [("GET", "/tools/v1/check"), ("POST", media.generate)]


def test_an_image_without_a_model_skips_the_check(desktop_env, server, image):
    """The server picks a model-less image engine by purpose; no single leg describes it."""
    server.answer(image.generate, FakeResponse(200, {"data": {"ok": True}}))

    assert _generate(image)["ok"] is True
    assert server.requests == [("POST", image.generate)]


def test_legacy_leg_reads_the_master_check_too(_hermes_home, legacy_env, master, media):
    _pick(_hermes_home, media, media.model)
    off = _leg(configured=False)
    master.answers = {
        media.legacy_check: {"ok": False, "configured": False, "health": off, "legs": {f"chinaapi:{media.model}": off}},
    }

    result = _generate(media)

    assert result["error"] == f"平台现在暂时关闭了{media.label}生成，重新开放之前重试也不会成功。"
    assert master.paths == [media.legacy_check]


# ── 3. the tool stays offered (Kael 2026-10-19) ───────────────────────────────


def test_gateway_check_fn_keeps_the_tool_without_any_request(desktop_env, server, media):
    assert media.module._check() is True
    assert server.requests == []


def test_legacy_check_fn_keeps_the_tool_while_switched_off_or_failing(legacy_env, master, media):
    master.answers = {
        media.legacy_check: {"ok": False, "configured": False, "api_key_configured": True, "model": media.model},
    }
    assert media.module._check() is True

    master.answers = {media.legacy_check: {"ok": False, "api_key_configured": False, "model": media.model}}
    assert media.module._check() is False  # no platform key at all: nothing to offer
