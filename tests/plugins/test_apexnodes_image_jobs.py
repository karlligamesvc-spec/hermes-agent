"""Desktop ``generate_image`` submits a job and polls it (hc-1190, the image twin of hc-1000).

``generate_image`` held one request to api.apex-nodes.com open while the platform drew the
image (the vendor alone may take 180 s), with nothing on the wire. On 2026-10-22 that
shape lost answers on the Shanghai home broadband → Tencent HK/SG path (hc-978): the
server answered, the answer never arrived. An image lost that way was already billed.

The first tests run a real local HTTP gateway through the real ``request_json`` and the
real tool, so a lost answer is a request the server accepts and never answers. The rest
drive ``generate_image`` through hc-1000's scripted ``request_json`` and fake clock.
"""

from __future__ import annotations

import importlib
import json
import sys

import httpx
import pytest

from tests.plugins.test_apexnodes_asr_jobs import HANG, LocalGateway, _run_bounded
from tests.plugins.test_apexnodes_gateway_tools import GATEWAY_KEY, _gateway_module, _load_plugin
from tests.plugins.test_apexnodes_video_jobs import FakeClock

JOBS = "/tools/v1/image/jobs"
GENERATE = "/tools/v1/image/generate"
CHECK = "/tools/v1/check"
RUNNING = {"ok": True, "job_id": "job-i", "status": "running", "poll_after_seconds": 0}
DATA = {
    "image_url": "https://cdn.example/i1.png",
    "image_ref": "media:" + "e" * 32 + "/image_1.png",
    "images": [{"image_url": "https://cdn.example/i1.png"}],
    "model": "gpt-image-2.5-flare",
}
DONE = {"ok": True, "job_id": "job-i", "status": "done", "elapsed_seconds": 41, "data": DATA, "cost_cents": 0}
SERVING = {"ok": True, "image": {"configured": True, "serving": True, "legs": {}}}
ARGS = {"prompt": "收纳架主图，白底，3:4", "aspect_ratio": "3:4"}


def _short_waits(module, monkeypatch):
    """Seconds instead of minutes; the logic under test is unchanged."""
    monkeypatch.setattr(module, "_IMAGE_JOB_SUBMIT_TIMEOUT_SECONDS", 0.3)
    monkeypatch.setattr(module, "_IMAGE_JOB_POLL_TIMEOUT_SECONDS", 0.3)
    monkeypatch.setattr(module, "_IMAGE_JOB_POLL_GAP_SECONDS", (0.01, 0.01, 0.05))
    monkeypatch.setattr(module, "_IMAGE_JOB_UNREACHABLE_SECONDS", 1.0)


def _desktop_tool(module, monkeypatch, landed):
    monkeypatch.setattr(module, "download_media", lambda url, **_kw: landed)
    image = _load_plugin("apexnodes-image-tools")
    monkeypatch.setattr(image, "_desktop_image_model", lambda: None)
    return image


@pytest.fixture
def desktop(monkeypatch, tmp_path):
    """The real gateway module and image tool against a local gateway."""
    module = _gateway_module()
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("TOOLS_GATEWAY_KEY", GATEWAY_KEY)
    monkeypatch.delenv("TOOLS_GATEWAY_DISABLED", raising=False)
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        monkeypatch.delenv(name, raising=False)
    # An env with only NO_PROXY keeps urllib off the Mac's system proxy settings.
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")
    _short_waits(module, monkeypatch)
    landed = tmp_path / "image.png"
    landed.write_bytes(b"fake-image")
    image = _desktop_tool(module, monkeypatch, landed)
    yield module, image, landed
    sys.modules.pop(image.__name__, None)


def _keys_seen(gw: LocalGateway) -> list[str]:
    keys: list[str] = []

    def record(handler):
        if handler.command == "POST" and handler.path == JOBS:
            keys.append(handler.headers.get("Idempotency-Key"))

    gw.on_request = record
    return keys


def _call(image, args=ARGS, seconds=10):
    return _run_bounded(lambda: json.loads(image._handle_generate_image(dict(args))), seconds)


def test_lost_answers_on_a_silent_path_cost_one_poll_not_the_image(desktop, monkeypatch):
    """The incident's shape: the synchronous call's answer never arrives. The job flow
    still delivers the image although two of its polls are lost the same way."""
    _module, image, landed = desktop
    with LocalGateway() as gw:
        monkeypatch.setenv("TOOLS_GATEWAY_BASE", gw.base)
        gw.plan[("GET", CHECK)] = [(200, SERVING)]
        gw.plan[("POST", GENERATE)] = [HANG]
        gw.plan[("POST", JOBS)] = [(202, RUNNING)]
        gw.plan[("GET", f"{JOBS}/job-i")] = [HANG, HANG, (200, DONE)]
        finished, box = _call(image)
    assert finished, "the tool hung on a lost answer"
    result = box["result"]
    assert result["image_url"] == DATA["image_url"] and result["image_path"] == str(landed)
    assert result["image_ref"] == DATA["image_ref"] and result["cost_cents"] == 0
    assert "note" not in result
    assert ("POST", GENERATE) not in gw.seen
    assert gw.seen.count(("POST", JOBS)) == 1
    assert gw.seen.count(("GET", f"{JOBS}/job-i")) == 3


def test_a_lost_submit_answer_is_sent_again_under_the_same_key(desktop, monkeypatch):
    """Did the submit arrive? The client cannot know, so it asks again with the same
    Idempotency-Key, which the server answers with the one job it started (one image,
    billed once)."""
    _module, image, _landed = desktop
    with LocalGateway() as gw:
        monkeypatch.setenv("TOOLS_GATEWAY_BASE", gw.base)
        keys = _keys_seen(gw)
        gw.plan[("GET", CHECK)] = [(200, SERVING)]
        gw.plan[("POST", JOBS)] = [HANG, (502, {}), (202, {**RUNNING, "reused": True})]
        gw.plan[("GET", f"{JOBS}/job-i")] = [(200, DONE)]
        finished, box = _call(image)
    assert finished and box["result"]["image_url"] == DATA["image_url"]
    assert len(keys) == 3 and len(set(keys)) == 1 and len(keys[0]) == 32
    assert "note" not in box["result"], "a retry inside one call is not an earlier call's image"


def test_a_dead_path_ends_in_minutes_and_the_same_call_later_gets_the_image_back(desktop, monkeypatch):
    """Offline mid-render: the tool says so instead of waiting out its budget, and the
    image the platform billed meanwhile comes back to the identical call afterwards,
    without drawing it again."""
    _module, image, _landed = desktop
    with LocalGateway() as gw:
        monkeypatch.setenv("TOOLS_GATEWAY_BASE", gw.base)
        keys = _keys_seen(gw)
        gw.plan[("GET", CHECK)] = [(200, SERVING)]
        gw.plan[("POST", JOBS)] = [(202, RUNNING), (200, {**DONE, "reused": True})]
        gw.plan[("GET", f"{JOBS}/job-i")] = [HANG]
        finished, box = _call(image)
        assert finished, "a dead path must end the wait, not the tool's budget"
        error = box["result"]["error"]
        assert error.startswith("图片生成失败: 图片任务已经交给平台")
        assert "连续" in error and "完全相同的参数" in error and "generate_image" in error

        # The network is back; the agent makes the same call again.
        finished, box = _call(image)
    assert finished
    result = box["result"]
    assert result["image_url"] == DATA["image_url"]
    assert "没有重新出图" in result["note"] and "没有再计费" in result["note"]
    assert len(keys) == 2 and keys[0] == keys[1], "the same call carries the same key"


def test_a_call_cut_off_by_quitting_is_picked_up_by_the_identical_call_after_a_restart(desktop, monkeypatch, tmp_path):
    """The key is on disk before the submit leaves, so an app that quits (or a Desktop
    that restarts) mid-wait loses nothing: after the restart nothing is sent on its own,
    and the agent's identical call gets the billed image back under the same key."""
    module, image, landed = desktop
    pending = module._pending_file("image")
    written_before_submit: list[bool] = []
    keys: list[str] = []

    def record(handler):
        if handler.command == "POST" and handler.path == JOBS:
            key = handler.headers.get("Idempotency-Key")
            keys.append(key)
            written_before_submit.append(pending.exists() and key in pending.read_text(encoding="utf-8"))

    with LocalGateway() as gw:
        monkeypatch.setenv("TOOLS_GATEWAY_BASE", gw.base)
        gw.on_request = record
        gw.plan[("GET", CHECK)] = [(200, SERVING)]
        gw.plan[("POST", JOBS)] = [HANG]
        finished, box = _call(image)
        assert finished and box["result"]["error"].startswith("图片生成失败: 图片任务已经交给平台")
        assert written_before_submit and all(written_before_submit)

        # The Desktop restarts: the engine's memory is gone, the record on disk stays.
        importlib.reload(module)
        _short_waits(module, monkeypatch)
        sys.modules.pop(image.__name__, None)
        image = _desktop_tool(module, monkeypatch, landed)
        seen_before = list(gw.seen)
        assert module._image_calls_in_flight == set()
        gw.plan[("POST", JOBS)] = [(200, {**DONE, "reused": True})]
        finished, box = _call(image)
    assert finished
    assert "没有重新出图" in box["result"]["note"]
    assert len(set(keys)) == 1 and len(keys) >= 2
    assert gw.seen[len(seen_before):] == [("GET", CHECK), ("POST", JOBS)]
    assert module._read_pending(module._image_generation(), module.time.time()) == {}


def test_old_gateway_without_jobs_gets_the_synchronous_call(desktop, monkeypatch):
    _module, image, _landed = desktop
    with LocalGateway() as gw:
        monkeypatch.setenv("TOOLS_GATEWAY_BASE", gw.base)
        gw.plan[("GET", CHECK)] = [(200, SERVING)]
        gw.plan[("POST", GENERATE)] = [(200, {"ok": True, "data": DATA, "cost_cents": 0})]
        finished, box = _call(image)
    assert finished and box["result"]["image_url"] == DATA["image_url"]
    assert gw.seen == [("GET", CHECK), ("POST", JOBS), ("POST", GENERATE)]


def test_a_refused_submit_reads_like_the_synchronous_endpoints_refusal(desktop, monkeypatch):
    """The submit takes the same body and refuses the same way; its sentence is the
    one the image tool always said for /image/generate, not a bare gateway status."""
    _module, image, _landed = desktop
    crash = {"detail": {"code": "image_generate_internal", "message": "图片生成时平台内部出错了。"}}
    with LocalGateway() as gw:
        monkeypatch.setenv("TOOLS_GATEWAY_BASE", gw.base)
        gw.plan[("GET", CHECK)] = [(200, SERVING)]
        gw.plan[("POST", JOBS)] = [(500, crash)]
        finished, box = _call(image)
    assert finished
    assert box["result"]["error"] == "图片生成失败: 图片生成时平台内部出错了。"
    assert gw.seen.count(("POST", JOBS)) == 1


def test_the_tool_polls_for_the_budget_the_executor_gives_it(desktop, monkeypatch):
    """The budget the polls stop at is the one the tool registers with the executor."""
    module, image, _landed = desktop
    seen = {}

    def spy(payload, *, call_args, timeout):
        seen.update(timeout=timeout, call_args=call_args, payload=payload)
        return {"data": DATA, "cost_cents": 0}

    monkeypatch.setenv("TOOLS_GATEWAY_BASE", "https://gw.test")
    monkeypatch.setattr(module, "generate_image", spy)
    takes_images = {"ok": True, "image": {**SERVING["image"], "input_images": {"supported": True}}}
    monkeypatch.setattr(module, "tools_check", lambda **_kw: takes_images)
    registered = {}
    image.register(type("Ctx", (), {"register_tool": lambda self, **kw: registered.update(kw)})())
    result = json.loads(image._handle_generate_image({**ARGS, "images": ["media:" + "a" * 32 + "/ref.png"]}))
    assert result.get("image_url") == DATA["image_url"], result
    assert seen["timeout"] == registered["execution_timeout"] == image._IMAGE_TOOL_BUDGET
    # The fingerprint is the call as the agent made it, before any upload.
    assert seen["call_args"]["images"] == ["media:" + "a" * 32 + "/ref.png"]


def test_a_download_failure_keeps_the_recovered_note(desktop, monkeypatch):
    module, image, _landed = desktop

    def failing(url, **_kw):
        raise module.GatewayError("direct link fetch failed")

    monkeypatch.setattr(module, "download_media", failing)
    result = json.loads(image._localize_gateway_image({**DATA, "note": module.say("image_job_recovered")}, "p"))
    assert "没有重新出图" in result["note"] and "有效期" in result["note"]


# ── scripted request_json + fake clock (hc-1000's harness) ────────────────────


@pytest.fixture
def scripted(monkeypatch, tmp_path):
    """``answers`` maps (method, path) to a list of answers (dicts, or exceptions to
    raise; the last one repeats); ``calls`` records (method, path, timeout, headers)."""
    module = _gateway_module()
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / ".hermes"))
    clock = FakeClock()
    monkeypatch.setattr(module, "time", clock)
    state = {"answers": {}, "calls": []}

    def request_json(method, path, payload=None, *, timeout=90, files=None, form_data=None, headers=None):
        state["calls"].append((method, path, timeout, dict(headers or {})))
        queue = state["answers"][(method, path)]
        answer = queue.pop(0) if len(queue) > 1 else queue[0]
        clock.now += 1  # every request takes a second
        if isinstance(answer, BaseException):
            raise answer
        return dict(answer)

    monkeypatch.setattr(module, "request_json", request_json)
    return module, state, clock


def _generate(module, args=ARGS, *, timeout=420):
    return module.generate_image(dict(args), call_args=dict(args), timeout=timeout)


def _posts(state):
    return [c for c in state["calls"] if c[0] == "POST"]


def _pending(module):
    return module._read_pending(module._image_generation(), module.time.time())


def _sync_error(module, status, detail):
    """What /image/generate's answer reads as on the Desktop (the real mapping)."""
    response = httpx.Response(status, json={"detail": detail})
    return module._error_from_response(response, module.credential_source(), path=module.IMAGE_GENERATE_PATH)


@pytest.mark.parametrize(
    ("status", "detail", "sentence"),
    [
        (503, {"code": "vendor_unavailable", "message": "图片生成暂不可用。", "vendor_code": "provider_not_configured"},
         "平台还没有开通图片生成服务"),
        (503, {"code": "vendor_unavailable", "message": "图片生成超时，这次没有出图。", "vendor_code": "image_provider_timeout"},
         "图片生成超时"),
        (429, {"code": "image_daily_limit_reached", "message": "今日图片生成额度已用完。"}, "明天恢复"),
        (400, {"code": "input_images_unsupported", "message": "这个引擎不收参考图。"}, "不收参考图"),
        (500, {"code": "image_generate_internal", "message": "图片生成时平台内部出错了。"}, "平台内部出错"),
    ],
    ids=["not-configured", "vendor-timeout", "daily-limit", "input-image", "platform-crash"],
)
def test_a_failed_job_reads_exactly_like_the_synchronous_error(scripted, status, detail, sentence):
    module, state, _clock = scripted
    state["answers"][("POST", module.IMAGE_JOBS_PATH)] = [RUNNING]
    state["answers"][("GET", f"{module.IMAGE_JOBS_PATH}/job-i")] = [
        {"ok": False, "job_id": "job-i", "status": "failed", "error": {"status_code": status, "detail": detail}}
    ]
    with pytest.raises(module.GatewayError) as caught:
        _generate(module)
    expected = _sync_error(module, status, detail)
    assert (str(caught.value), caught.value.status, caught.value.code) == (str(expected), expected.status, expected.code)
    assert sentence in str(caught.value)
    assert len(_posts(state)) == 1, "a failed job is an answer, not a reason to draw again"
    assert _pending(module) == {}, "a known end leaves no pending record"


def test_a_job_the_restarted_server_lost_is_not_drawn_again_on_its_own(scripted):
    """A job that finished just before the restart was billed; only the agent decides
    to spend another image."""
    module, state, _clock = scripted
    state["answers"][("POST", module.IMAGE_JOBS_PATH)] = [RUNNING]
    state["answers"][("GET", f"{module.IMAGE_JOBS_PATH}/job-i")] = [
        module.GatewayError("HTTP 404", status=404, code="image_job_not_found")
    ]
    with pytest.raises(module.GatewayError) as caught:
        _generate(module)
    assert caught.value.code == "image_job_not_found"
    assert "平台重启过" in str(caught.value) and "generate_image" in str(caught.value)
    assert len(_posts(state)) == 1


def test_an_image_still_drawing_at_the_budget_stops_and_keeps_its_key(scripted):
    module, state, clock = scripted
    state["answers"][("POST", module.IMAGE_JOBS_PATH)] = [{**RUNNING, "poll_after_seconds": 3}]
    state["answers"][("GET", f"{module.IMAGE_JOBS_PATH}/job-i")] = [{**RUNNING, "poll_after_seconds": 3}]
    started = clock.now
    with pytest.raises(module.GatewayError) as caught:
        _generate(module, timeout=420)
    waited = clock.now - started
    assert caught.value.code == "image_job_overdue"
    assert "停止等待" in str(caught.value) and "完全相同的参数" in str(caught.value)
    # Stops with room left for the download inside the tool's 420 s.
    assert 360 <= waited <= 420 - 30
    (entry,) = _pending(module).values()
    assert entry["key"] == state["calls"][0][3]["Idempotency-Key"]


def test_the_submit_and_each_poll_have_short_read_timeouts(scripted):
    module, state, _clock = scripted
    state["answers"][("POST", module.IMAGE_JOBS_PATH)] = [{**RUNNING, "poll_after_seconds": 3}]
    state["answers"][("GET", f"{module.IMAGE_JOBS_PATH}/job-i")] = [{**RUNNING, "poll_after_seconds": 3}] * 3 + [DONE]
    assert _generate(module)["data"] == DATA
    submit, *polls = state["calls"]
    assert submit[:3] == ("POST", module.IMAGE_JOBS_PATH, module._IMAGE_JOB_SUBMIT_TIMEOUT_SECONDS)
    assert [p[:3] for p in polls] == [("GET", f"{module.IMAGE_JOBS_PATH}/job-i", module._IMAGE_JOB_POLL_TIMEOUT_SECONDS)] * 4
    assert module._IMAGE_JOB_SUBMIT_TIMEOUT_SECONDS <= 60 and module._IMAGE_JOB_POLL_TIMEOUT_SECONDS <= 30


def test_an_old_gateway_gets_the_synchronous_call_with_its_old_cap(scripted):
    module, state, _clock = scripted
    state["answers"][("POST", module.IMAGE_JOBS_PATH)] = [module.GatewayError("HTTP 404", status=404)]
    state["answers"][("POST", module.IMAGE_GENERATE_PATH)] = [{"ok": True, "data": DATA, "cost_cents": 0}]
    assert _generate(module, timeout=420)["data"] == DATA
    fallback = [c for c in state["calls"] if c[1] == module.IMAGE_GENERATE_PATH]
    assert [c[2] for c in fallback] == [180.0], "an old gateway waits no longer than the tool did before"
    assert _pending(module) == {}


def test_the_same_call_after_a_finished_one_is_a_new_generation(scripted):
    """Asking for the same image again on purpose draws again: only a call whose end was
    never heard leaves its key behind."""
    module, state, _clock = scripted
    state["answers"][("POST", module.IMAGE_JOBS_PATH)] = [RUNNING]
    state["answers"][("GET", f"{module.IMAGE_JOBS_PATH}/job-i")] = [DONE]
    first = _generate(module)
    second = _generate(module)
    keys = [c[3]["Idempotency-Key"] for c in _posts(state)]
    assert len(keys) == 2 and keys[0] != keys[1]
    assert "recovered" not in first and "recovered" not in second
    assert _pending(module) == {}


@pytest.mark.parametrize(
    "refusal",
    [401, 402, 422, 500, "unreadable_answer", "gateway_unconfigured", "credential_missing"],
)
def test_a_refused_submit_is_final_and_leaves_no_record(scripted, refusal):
    """A refusal, an unreadable answer or a missing setup is an answer: sending it
    again changes nothing."""
    module, state, _clock = scripted
    error = module.GatewayError(f"HTTP {refusal}", status=refusal) if isinstance(refusal, int) else module.GatewayError(refusal, code=refusal)
    state["answers"][("POST", module.IMAGE_JOBS_PATH)] = [error]
    with pytest.raises(module.GatewayError) as caught:
        _generate(module)
    assert caught.value is error
    assert len(_posts(state)) == 1
    assert _pending(module) == {}


def test_a_submit_with_no_answer_for_two_minutes_says_so_and_keeps_its_key(scripted):
    module, state, _clock = scripted
    state["answers"][("POST", module.IMAGE_JOBS_PATH)] = [module.GatewayError("network", code="network_unreachable")]
    with pytest.raises(module.GatewayError) as caught:
        _generate(module)
    assert caught.value.code == "image_job_unreachable"
    keys = {c[3]["Idempotency-Key"] for c in _posts(state)}
    assert len(_posts(state)) > 1 and len(keys) == 1
    (entry,) = _pending(module).values()
    assert entry["key"] in keys


def test_image_and_video_calls_keep_separate_records(scripted):
    """The same arguments to generate_video and generate_image are two generations: an
    image call never picks up a video job's key, nor a video call an image's."""
    module, _state, _clock = scripted
    fingerprint = "c" * 64
    video_key, _ = module._video_call_key(fingerprint)
    module._end_video_call(fingerprint, keep=True)
    image_key, earlier = module._call_key(module._image_generation(), fingerprint)
    assert image_key != video_key and earlier is False
    assert module._pending_file("image") != module._video_pending_file()
    module._end_call(module._image_generation(), fingerprint, keep=False)
    assert module._video_call_key(fingerprint) == (video_key, True)
    module._end_video_call(fingerprint, keep=False)


def test_a_twin_running_now_gets_its_own_key_and_the_record_stays_with_the_first(scripted):
    module, _state, _clock = scripted
    gen = module._image_generation()
    fingerprint = "f" * 64
    first, earlier = module._call_key(gen, fingerprint)
    assert first and earlier is False
    assert module._call_key(gen, fingerprint) == (None, False)
    module._end_call(gen, fingerprint, keep=True)
    assert module._call_key(gen, fingerprint) == (first, True)
    module._end_call(gen, fingerprint, keep=False)


def test_a_pending_key_expires_with_the_servers_copy_of_the_job(scripted):
    module, _state, clock = scripted
    gen = module._image_generation()
    fingerprint = "a" * 64
    key, _ = module._call_key(gen, fingerprint)
    module._end_call(gen, fingerprint, keep=True)
    clock.wall += module._IMAGE_PENDING_TTL_SECONDS + 1
    fresh, earlier = module._call_key(gen, fingerprint)
    module._end_call(gen, fingerprint, keep=False)
    assert fresh != key and earlier is False


def test_an_unreadable_pending_record_never_stops_a_generation(scripted):
    module, state, _clock = scripted
    module._pending_file("image").parent.mkdir(parents=True, exist_ok=True)
    module._pending_file("image").write_text("{not json", encoding="utf-8")
    state["answers"][("POST", module.IMAGE_JOBS_PATH)] = [DONE]
    assert _generate(module)["data"] == DATA


def test_the_gateway_names_the_image_job_endpoints_the_server_serves():
    """apex-nodes docs/TOOLS-GATEWAY-API.md §4.5.1; the cross-repo route check is apex's
    tests/test_tools_gateway_contract_parity.py."""
    module = _gateway_module()
    assert (module.IMAGE_JOBS_PATH, module.IMAGE_GENERATE_PATH) == (JOBS, GENERATE)
    assert module._MEDIA_GENERATE_PATHS[JOBS] == module.MEDIA_IMAGE
