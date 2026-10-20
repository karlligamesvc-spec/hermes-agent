"""hc-984: the tail of honest generation errors, Desktop side (twin of apex-nodes hc-984).

* A crash in the platform's own code answers ``/tools/v1/{image,video}/generate`` with a
  JSON 500 whose sentence says so; a 422 rejection carries the server's sentence too.
  Both used to come out as "平台工具网关返回错误(HTTP n)(详情: …)", a bare 500 as
  "(详情: Internal Server Error)". On a generation path every status other than the
  Desktop's own guidance (401 sign in again, 402 top up, 413 too large, 429 back off)
  is now the server's sentence, or says it gave none; a raw HTML/text body is never
  relayed as the reason.
* An answer nobody could read no longer promises "请稍后重试".
* An image without a model reads the leg it will land on (``purpose_legs``, by purpose
  and whether a cover has a title) before generating, like every other call.
* The sentences this client writes itself come in Chinese and English and follow the
  user's language: ``HERMES_LANGUAGE``, then the user's own ``display.language``;
  Chinese unless that is English (the APEX default; the runtime's merged default is
  ``en``, which must not leak in).
* "... expects a JSON object argument" is Chinese in the media tools.
"""

from __future__ import annotations

import importlib.util
import io
import json
import string
import sys
import types
import urllib.error
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
GATEWAY_BASE = "https://gw.test"
LEGACY_BASE = "http://master.test/api/v1"
INTERNAL = {
    "image": "图片生成时平台内部出了错（和你的描述无关），平台已记下这个错误。要等平台修好，现在重试多半还是失败。",
    "video": "视频生成时平台内部出了错（和你的描述无关），平台已记下这个错误。要等平台修好，现在重试多半还是失败。",
}
RETRY_LATER = ("稍后", "繁忙")
LABELS = {"image": "图片", "video": "视频"}

_ENV = (
    "HERMES_PLATFORM_API_BASE",
    "HERMES_MASTER_API_BASE",
    "HERMES_SCHEDULER_API_BASE",
    "API_SERVER_KEY",
    "MODEL_API_KEY",
    "TOOLS_GATEWAY_BASE",
    "TOOLS_GATEWAY_KEY",
    "TOOLS_GATEWAY_DISABLED",
    "HERMES_LANGUAGE",
)


@pytest.fixture(autouse=True)
def home(tmp_path, monkeypatch):
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


def _gateway():
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


@pytest.fixture(params=sorted(LABELS))
def media(request):
    module = _load_plugin(f"apexnodes-{request.param}-tools")
    yield types.SimpleNamespace(
        kind=request.param,
        label=LABELS[request.param],
        module=module,
        handler=f"_handle_generate_{request.param}",
        generate=f"/tools/v1/{request.param}/generate",
        legacy_generate=f"/media/{request.param}-generate",
        legacy_check=f"/media/{request.param}/check",
    )
    sys.modules.pop(module.__name__, None)


@pytest.fixture
def image():
    module = _load_plugin("apexnodes-image-tools")
    yield module
    sys.modules.pop(module.__name__, None)


def _language(home: Path, value: str | None) -> None:
    display = "" if value is None else f"display:\n  language: {value}\n"
    (home / "config.yaml").write_text(display + "model:\n  default: x\n", encoding="utf-8")


class Answer:
    """An httpx-like response; ``raw`` (bytes) makes ``json()`` raise like a non-JSON body."""

    def __init__(self, status_code=200, body=None, *, raw: bytes | None = None):
        self.status_code = status_code
        self._body = body if body is not None else {}
        self._raw = raw
        self.headers = {}
        self.text = raw.decode("utf-8", errors="replace") if raw is not None else json.dumps(self._body, ensure_ascii=False)

    def json(self):
        if self._raw is not None:
            return json.loads(self._raw)
        return self._body


@pytest.fixture
def server(monkeypatch):
    gateway_module = _gateway()
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
    def __init__(self, raw: bytes):
        self._raw = raw

    def read(self):
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture
def master(monkeypatch):
    state = types.SimpleNamespace(paths=[], answers={})

    def fake_urlopen(request, timeout=None):
        path = request.full_url[len(LEGACY_BASE):]
        state.paths.append(path)
        status, body = state.answers[path]
        raw = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode("utf-8")
        if status >= 400:
            raise urllib.error.HTTPError(request.full_url, status, "error", {}, io.BytesIO(raw))
        return _UrlopenResponse(raw)

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    return state


def _healthy_check() -> Answer:
    return Answer(200, {"ok": True, "image": {"legs": {}}, "video": {"configured": True, "serving": True, "health": {}, "legs": {}}})


def _run(media, args=None) -> dict:
    return json.loads(getattr(media.module, media.handler)(args or {"prompt": "收纳架开箱"}))


# ── the language rule ─────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("env", "configured", "expected"),
    [
        (None, None, "zh"),
        (None, "zh", "zh"),
        (None, "zh-hant", "zh"),
        (None, "ja", "zh"),
        (None, "en", "en"),
        (None, "en-US", "en"),
        ("en", None, "en"),
        ("zh", "en", "zh"),
    ],
    ids=["unset", "zh", "zh-hant", "ja", "en", "en-US", "env-en", "env-wins"],
)
def test_the_users_language_decides_chinese_by_default(home, monkeypatch, env, configured, expected):
    if env is not None:
        monkeypatch.setenv("HERMES_LANGUAGE", env)
    _language(home, configured)
    assert _gateway().ui_language() == expected


def test_an_unset_language_is_chinese_although_the_runtime_default_is_english(home):
    """The merged runtime config fills in display.language = en; the user's file is what counts."""
    (home / "config.yaml").write_text("model:\n  default: x\n", encoding="utf-8")
    assert _gateway().ui_language() == "zh"
    (home / "config.yaml").write_text("display: [unclosed\n", encoding="utf-8")
    assert _gateway().ui_language() == "zh"


def _fields(template: str) -> set[str]:
    return {name.lower() for _, name, _, _ in string.Formatter().parse(template) if name}


def test_every_sentence_has_a_chinese_and_an_english_version():
    for key, (zh, en) in _gateway()._COPY.items():
        assert any("一" <= ch <= "鿿" for ch in zh), key
        assert not any("一" <= ch <= "鿿" or ch in "「」，。；：" for ch in en), key
        assert _fields(zh) == _fields(en), key


# ── generation answers: the server's sentence, or that it gave none ───────────


@pytest.mark.parametrize(
    ("answer", "expected"),
    [
        pytest.param(
            lambda m: Answer(500, {"detail": {"code": f"{m.kind}_generate_internal", "message": INTERNAL[m.kind]}}),
            lambda m: INTERNAL[m.kind],
            id="500-platform-crash",
        ),
        pytest.param(
            lambda m: Answer(500, raw=b"Internal Server Error"),
            lambda m: f"{m.label}生成服务出错了(HTTP 500),没有说明原因。",
            id="500-bare-text",
        ),
        pytest.param(
            lambda m: Answer(502, raw=b"<html><body>502 Bad Gateway</body></html>"),
            lambda m: f"{m.label}生成服务出错了(HTTP 502),没有说明原因。",
            id="502-html",
        ),
        pytest.param(
            lambda m: Answer(422, {"detail": {"code": f"{m.kind}_provider_rejected", "message": f"{m.label}模型拒绝了这次请求，原样重试不会成功。"}}),
            lambda m: f"{m.label}模型拒绝了这次请求，原样重试不会成功。",
            id="422-rejected",
        ),
        pytest.param(
            lambda m: Answer(400, {"detail": {"code": "missing_prompt"}}),
            lambda m: f"{m.label}生成服务出错了(HTTP 400, missing_prompt),没有说明原因。",
            id="400-code-only",
        ),
    ],
)
def test_a_generation_failure_reads_as_the_servers_sentence(desktop_env, server, media, answer, expected):
    server.answer("/tools/v1/check", _healthy_check())
    server.answer(media.generate, answer(media))

    error = _run(media)["error"]

    assert error == f"{media.label}生成失败: {expected(media)}"
    assert "平台工具网关返回错误" not in error and "<html>" not in error


@pytest.mark.parametrize(
    ("status", "marker"),
    [(401, "被服务端拒绝(401)"), (402, "额度不足"), (413, "大小上限")],
)
def test_the_desktop_guidance_statuses_keep_their_guidance(desktop_env, server, media, status, marker):
    server.answer("/tools/v1/check", _healthy_check())
    server.answer(media.generate, Answer(status, {"detail": {"code": "x", "message": "server text"}}))
    assert marker in _run(media)["error"]


@pytest.mark.parametrize("raw", [b"", b"<html>oops</html>", b"[1, 2]"], ids=["empty", "html", "list"])
def test_an_unreadable_answer_promises_nothing(desktop_env, server, media, raw):
    server.answer("/tools/v1/check", _healthy_check())
    server.answer(media.generate, Answer(200, raw=raw) if raw != b"[1, 2]" else Answer(200, [1, 2]))

    error = _run(media)["error"]

    assert error == f"{media.label}生成失败: {media.label}生成服务的回答读不出来，这次没有结果。"
    assert not any(marker in error for marker in RETRY_LATER)


def test_an_unreadable_answer_on_any_other_tool_promises_nothing_either(desktop_env, server):
    server.answer("/tools/v1/check", Answer(200, raw=b"<html>oops</html>"))
    with pytest.raises(_gateway().GatewayError) as raised:
        _gateway().request_json("GET", "/tools/v1/check")
    assert str(raised.value) == "平台工具网关的回答读不出来,这次没有结果。"


@pytest.mark.parametrize(
    ("answer", "expected"),
    [
        pytest.param((200, b""), "{label}生成服务的回答读不出来，这次没有结果。", id="2xx-empty"),
        pytest.param((500, {"detail": {"code": "video_generate_internal"}}), "{label}生成服务出错了(HTTP 500, video_generate_internal),没有说明原因。", id="code-only"),
        pytest.param((502, b"<html>bad gateway</html>"), "{label}生成服务出错了(HTTP 502),没有说明原因。", id="html"),
    ],
)
def test_the_legacy_leg_answers_the_same_way(legacy_env, master, media, answer, expected):
    master.answers = {media.legacy_check: (200, {"ok": True}), media.legacy_generate: answer}
    assert _run(media)["error"] == f"{media.label}生成失败: " + expected.format(label=media.label)


# ── an image without a model reads the leg it will land on ────────────────────

ROUTES = {"illustration": "agnes", "cover": "agnes-overlay", "cover_without_title": "nanobanana-flash"}
PAUSED = "图片生成最近连续几次都没成功，平台先暂停了它，大约 15 分钟后可以再试。"


def _leg(*, configured=True, healthy=True) -> dict:
    return {
        "configured": configured,
        "serving": configured and healthy,
        "healthy": healthy,
        "state": "ok" if healthy else "failing",
        "retry_after_seconds": None if healthy else 900,
    }


def _image_check(down: str | None = None, *, switched_off: str | None = None, routes=ROUTES) -> dict:
    legs = {name: _leg() for name in ("agnes", "agnes-overlay", "nanobanana-flash", "seedream")}
    if down:
        legs[down] = _leg(healthy=False)
    if switched_off:
        legs[switched_off] = _leg(configured=False)
    section = {"configured": True, "serving": True, "health": {"healthy": True}, "legs": legs}
    if routes is not None:
        section["purpose_legs"] = routes
    return section


@pytest.mark.parametrize(
    ("args", "down"),
    [
        ({}, "agnes"),
        ({"purpose": "cover", "title": "夏日上新"}, "agnes-overlay"),
        ({"purpose": "cover"}, "nanobanana-flash"),
        ({"provider": "seedream"}, "seedream"),
    ],
    ids=["illustration", "cover-with-title", "cover-without-title", "named-provider"],
)
def test_a_model_less_image_is_stopped_when_its_leg_is_down(desktop_env, server, image, args, down):
    server.answer("/tools/v1/check", Answer(200, {"ok": True, "image": _image_check(down)}))

    result = json.loads(image._handle_generate_image({"prompt": "海报", **args}))

    assert result["error"] == PAUSED
    assert server.requests == [("GET", "/tools/v1/check")]


def test_another_purpose_on_the_same_check_still_renders(desktop_env, server, image):
    server.answer("/tools/v1/check", Answer(200, {"ok": True, "image": _image_check("agnes")}))
    server.answer("/tools/v1/image/generate", Answer(200, {"data": {"ok": True}}))

    result = json.loads(image._handle_generate_image({"prompt": "封面", "purpose": "cover", "title": "夏日上新"}))

    assert result.get("ok") is True
    assert server.requests == [("GET", "/tools/v1/check"), ("POST", "/tools/v1/image/generate")]


def test_a_switched_off_default_leg_says_retrying_will_not_help(desktop_env, server, image):
    server.answer("/tools/v1/check", Answer(200, {"ok": True, "image": _image_check(switched_off="agnes")}))
    assert json.loads(image._handle_generate_image({"prompt": "海报"}))["error"] == (
        "平台现在暂时关闭了图片生成，重新开放之前重试也不会成功。"
    )


def test_the_legacy_leg_reads_purpose_legs_too(legacy_env, master, image):
    master.answers = {"/media/image/check": (200, _image_check("agnes"))}
    assert json.loads(image._handle_generate_image({"prompt": "海报"}))["error"] == PAUSED
    assert master.paths == ["/media/image/check"]


# ── English when the user's language is English ───────────────────────────────


def test_an_english_user_hears_the_pause_and_the_crash_in_english(home, desktop_env, server, image):
    _language(home, "en")
    server.answer("/tools/v1/check", Answer(200, {"ok": True, "image": _image_check("agnes")}))
    assert json.loads(image._handle_generate_image({"prompt": "poster"}))["error"] == (
        "Image generation failed several times in a row and the platform paused it; try again in about 15 minutes."
    )

    server.answer("/tools/v1/check", _healthy_check())
    server.answer("/tools/v1/image/generate", Answer(500, raw=b""))
    assert json.loads(image._handle_generate_image({"prompt": "poster", "model": "gpt-image-2.5-flare"}))["error"] == (
        "Image generation failed: The image generation service failed (HTTP 500) without saying why."
    )


def test_an_english_user_hears_the_sign_in_hint_in_english(home, monkeypatch):
    _language(home, "en")
    monkeypatch.setenv("HERMES_DESKTOP", "1")
    message = str(_gateway().missing_credential_error())
    assert message.startswith("You are not signed in to ApexNodes")


# ── no English argument errors in the media tools ─────────────────────────────


def test_the_media_tools_refuse_a_non_object_argument_in_chinese(media):
    assert json.loads(getattr(media.module, media.handler)("not an object"))["error"] == (
        f"generate_{media.kind} 的参数必须是 JSON 对象。"
    )


@pytest.mark.parametrize("plugin", ["apexnodes-douyin-tools", "apexnodes-social-tools"])
def test_the_social_tools_refuse_a_non_object_argument_in_chinese(plugin):
    module = _load_plugin(plugin)
    handlers = {}

    class Ctx:
        def register_tool(self, *, name, handler, **_kwargs):
            handlers[name] = handler

        def __getattr__(self, _name):
            return lambda *args, **kwargs: None

    try:
        module.register(Ctx())
        assert handlers
        for name, handler in handlers.items():
            error = json.loads(handler("not an object"))["error"]
            assert "JSON 对象" in error and "expects" not in error, (name, error)
    finally:
        sys.modules.pop(module.__name__, None)
