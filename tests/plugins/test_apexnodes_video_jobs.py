"""Desktop ``generate_video`` submits a job and polls it (hc-1000, hc-978's video follow-up).

``generate_video`` held one request to api.apex-nodes.com open for up to 660 s while the
platform queued, rendered and downloaded the clip, with nothing on the wire. On
2026-10-22 the same shape lost transcription answers on the Shanghai home broadband →
Tencent HK/SG path (hc-978): the server answered, the answer never arrived. For video a
lost answer is a clip that was already billed and never reached the user.

The first tests run a real local HTTP gateway through the real ``request_json`` and the
real tool, so a lost answer is a request the server accepts and never answers. The rest
drive ``generate_video`` through a scripted ``request_json`` and a fake clock.
"""

from __future__ import annotations

import json
import sys

import httpx
import pytest

from tests.plugins.test_apexnodes_asr_jobs import HANG, LocalGateway, _run_bounded
from tests.plugins.test_apexnodes_gateway_tools import GATEWAY_KEY, _gateway_module, _load_plugin

JOBS = "/tools/v1/video/jobs"
GENERATE = "/tools/v1/video/generate"
RUNNING = {"ok": True, "job_id": "job-v", "status": "running", "poll_after_seconds": 0}
DATA = {"video_url": "https://cdn.example/o.mp4", "seconds": 5, "last_frame_ref": "media:" + "e" * 32 + "/last.jpg"}
DONE = {"ok": True, "job_id": "job-v", "status": "done", "elapsed_seconds": 98, "data": DATA, "cost_cents": 270}
SERVING = {"ok": True, "video": {"configured": True, "serving": True, "legs": {}}}
ARGS = {"prompt": "收纳架开箱，三个镜头", "aspect_ratio": "portrait"}


def _short_waits(module, monkeypatch):
    """Seconds instead of minutes; the logic under test is unchanged."""
    monkeypatch.setattr(module, "_VIDEO_JOB_SUBMIT_TIMEOUT_SECONDS", 0.3)
    monkeypatch.setattr(module, "_VIDEO_JOB_POLL_TIMEOUT_SECONDS", 0.3)
    monkeypatch.setattr(module, "_VIDEO_JOB_POLL_GAP_SECONDS", (0.01, 0.01, 0.05))
    monkeypatch.setattr(module, "_VIDEO_JOB_UNREACHABLE_SECONDS", 1.0)


@pytest.fixture
def desktop(monkeypatch, tmp_path):
    """The real gateway module and video tool against a local gateway."""
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
    landed = tmp_path / "clip.mp4"
    landed.write_bytes(b"fake-video")
    monkeypatch.setattr(module, "download_media", lambda url, **_kw: landed)
    video = _load_plugin("apexnodes-video-tools")
    monkeypatch.setattr(video, "_desktop_video_model", lambda: None)
    yield module, video
    sys.modules.pop(video.__name__, None)


def _keys_seen(gw: LocalGateway) -> list[str]:
    keys: list[str] = []

    def record(handler):
        if handler.command == "POST" and handler.path == JOBS:
            keys.append(handler.headers.get("Idempotency-Key"))

    gw.on_request = record
    return keys


def test_lost_answers_on_a_silent_path_cost_one_poll_not_the_video(desktop, monkeypatch):
    """The incident's shape: the synchronous call's answer never arrives. The job flow
    still delivers the clip although two of its polls are lost the same way."""
    _module, video = desktop
    with LocalGateway() as gw:
        monkeypatch.setenv("TOOLS_GATEWAY_BASE", gw.base)
        gw.plan[("GET", "/tools/v1/check")] = [(200, SERVING)]
        gw.plan[("POST", GENERATE)] = [HANG]
        gw.plan[("POST", JOBS)] = [(202, RUNNING)]
        gw.plan[("GET", f"{JOBS}/job-v")] = [HANG, HANG, (200, DONE)]
        finished, box = _run_bounded(lambda: json.loads(video._handle_generate_video(dict(ARGS))), 10)
    assert finished, "the tool hung on a lost answer"
    result = box["result"]
    assert result["video_url"] == DATA["video_url"] and result["cost_cents"] == 270
    assert result["last_frame_ref"] == DATA["last_frame_ref"]
    assert "note" not in result
    assert ("POST", GENERATE) not in gw.seen
    assert gw.seen.count(("POST", JOBS)) == 1
    assert gw.seen.count(("GET", f"{JOBS}/job-v")) == 3


def test_a_lost_submit_answer_is_sent_again_under_the_same_key(desktop, monkeypatch):
    """Did the submit arrive? The client cannot know, so it asks again with the same
    Idempotency-Key, which the server answers with the one job it started."""
    _module, video = desktop
    with LocalGateway() as gw:
        monkeypatch.setenv("TOOLS_GATEWAY_BASE", gw.base)
        keys = _keys_seen(gw)
        gw.plan[("GET", "/tools/v1/check")] = [(200, SERVING)]
        gw.plan[("POST", JOBS)] = [HANG, (502, {}), (202, {**RUNNING, "reused": True})]
        gw.plan[("GET", f"{JOBS}/job-v")] = [(200, DONE)]
        finished, box = _run_bounded(lambda: json.loads(video._handle_generate_video(dict(ARGS))), 10)
    assert finished and box["result"]["video_url"] == DATA["video_url"]
    assert len(keys) == 3 and len(set(keys)) == 1 and len(keys[0]) == 32
    assert "note" not in box["result"], "a retry inside one call is not an earlier call's clip"


def test_a_dead_path_ends_in_minutes_and_the_same_call_later_gets_the_clip_back(desktop, monkeypatch):
    """Offline mid-render: the tool says so instead of waiting out its budget, and the
    clip the platform billed meanwhile comes back to the identical call afterwards,
    without a second render."""
    _module, video = desktop
    with LocalGateway() as gw:
        monkeypatch.setenv("TOOLS_GATEWAY_BASE", gw.base)
        keys = _keys_seen(gw)
        gw.plan[("GET", "/tools/v1/check")] = [(200, SERVING)]
        gw.plan[("POST", JOBS)] = [(202, RUNNING), (200, {**DONE, "reused": True})]
        gw.plan[("GET", f"{JOBS}/job-v")] = [HANG]
        finished, box = _run_bounded(lambda: json.loads(video._handle_generate_video(dict(ARGS))), 10)
        assert finished, "a dead path must end the wait, not the tool's 660 s budget"
        error = box["result"]["error"]
        assert error.startswith("视频生成失败: 视频任务已经交给平台")
        assert "连续" in error and "完全相同的参数" in error and "generate_video" in error

        # The network is back; the agent makes the same call again.
        finished, box = _run_bounded(lambda: json.loads(video._handle_generate_video(dict(ARGS))), 10)
    assert finished
    result = box["result"]
    assert result["video_url"] == DATA["video_url"]
    assert "没有重新生成" in result["note"]
    assert len(keys) == 2 and keys[0] == keys[1], "the same call carries the same key"


def test_a_different_call_after_a_lost_one_is_its_own_generation(desktop, monkeypatch):
    _module, video = desktop
    with LocalGateway() as gw:
        monkeypatch.setenv("TOOLS_GATEWAY_BASE", gw.base)
        keys = _keys_seen(gw)
        gw.plan[("GET", "/tools/v1/check")] = [(200, SERVING)]
        gw.plan[("POST", JOBS)] = [(202, RUNNING), (202, {**RUNNING, "job_id": "job-w"})]
        gw.plan[("GET", f"{JOBS}/job-v")] = [HANG]
        gw.plan[("GET", f"{JOBS}/job-w")] = [(200, {**DONE, "job_id": "job-w"})]
        _run_bounded(lambda: video._handle_generate_video(dict(ARGS)), 10)
        finished, box = _run_bounded(
            lambda: json.loads(video._handle_generate_video({**ARGS, "prompt": "换一个开头"})), 10
        )
    assert finished and "note" not in box["result"]
    assert len(keys) == 2 and keys[0] != keys[1]


def test_old_gateway_without_jobs_gets_the_synchronous_call(desktop, monkeypatch):
    _module, video = desktop
    with LocalGateway() as gw:
        monkeypatch.setenv("TOOLS_GATEWAY_BASE", gw.base)
        gw.plan[("GET", "/tools/v1/check")] = [(200, SERVING)]
        gw.plan[("POST", GENERATE)] = [(200, {"ok": True, "data": DATA, "cost_cents": 270})]
        finished, box = _run_bounded(lambda: json.loads(video._handle_generate_video(dict(ARGS))), 10)
    assert finished and box["result"]["video_url"] == DATA["video_url"]
    assert gw.seen == [("GET", "/tools/v1/check"), ("POST", JOBS), ("POST", GENERATE)]


def test_a_refused_submit_reads_like_the_synchronous_endpoints_refusal(desktop, monkeypatch):
    """The submit takes the same body and refuses the same way; its sentence is the
    one the video tool always said for /video/generate, not a bare gateway status."""
    _module, video = desktop
    crash = {"detail": {"code": "video_generate_internal", "message": "视频生成时平台内部出错了。"}}
    with LocalGateway() as gw:
        monkeypatch.setenv("TOOLS_GATEWAY_BASE", gw.base)
        gw.plan[("GET", "/tools/v1/check")] = [(200, SERVING)]
        gw.plan[("POST", JOBS)] = [(500, crash)]
        finished, box = _run_bounded(lambda: json.loads(video._handle_generate_video(dict(ARGS))), 10)
    assert finished
    assert box["result"]["error"] == "视频生成失败: 视频生成时平台内部出错了。"
    assert gw.seen.count(("POST", JOBS)) == 1


def test_a_download_failure_keeps_the_recovered_note(desktop, monkeypatch):
    module, video = desktop

    def failing(url, **_kw):
        raise module.GatewayError("direct link fetch failed")

    monkeypatch.setattr(module, "download_media", failing)
    result = json.loads(video._localize_gateway_video({**DATA, "note": module.say("video_job_recovered")}, "p"))
    assert "没有重新生成" in result["note"] and "有效期" in result["note"]


# ── scripted request_json + fake clock ───────────────────────────────────────


class FakeClock:
    def __init__(self):
        self.now = 1000.0
        self.wall = 1_800_000_000.0

    def monotonic(self):
        return self.now

    def time(self):
        return self.wall

    def sleep(self, seconds):
        self.now += seconds
        self.wall += seconds


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


def _generate(module, args=ARGS, *, timeout=660):
    return module.generate_video(dict(args), call_args=dict(args), timeout=timeout)


def _error(module, status, code=None):
    return module.GatewayError(f"HTTP {status}", status=status, code=code)


def _posts(state):
    return [c for c in state["calls"] if c[0] == "POST"]


def _sync_error(module, status, detail):
    """What /video/generate's answer reads as on the Desktop (the real mapping)."""
    response = httpx.Response(status, json={"detail": detail})
    return module._error_from_response(response, module.credential_source(), path=module.VIDEO_GENERATE_PATH)


@pytest.mark.parametrize(
    ("status", "detail", "sentence"),
    [
        (503, {"code": "vendor_unavailable", "message": "视频生成暂不可用。", "vendor_code": "video_generation_unavailable"},
         "平台现在暂时关闭了视频生成"),
        (429, {"code": "video_daily_limit_reached", "message": "今日视频生成额度已用完。"}, "明天恢复"),
        (400, {"code": "reference_image_rejected", "message": "参考图没有通过上游的内容审核。"}, "参考图没有通过"),
        (500, {"code": "video_generate_internal", "message": "视频生成时平台内部出错了。"}, "平台内部出错"),
    ],
    ids=["switched-off", "daily-limit", "input-image", "platform-crash"],
)
def test_a_failed_job_reads_exactly_like_the_synchronous_error(scripted, status, detail, sentence):
    module, state, _clock = scripted
    state["answers"][("POST", module.VIDEO_JOBS_PATH)] = [RUNNING]
    state["answers"][("GET", f"{module.VIDEO_JOBS_PATH}/job-v")] = [
        {"ok": False, "job_id": "job-v", "status": "failed", "error": {"status_code": status, "detail": detail}}
    ]
    with pytest.raises(module.GatewayError) as caught:
        _generate(module)
    expected = _sync_error(module, status, detail)
    assert (str(caught.value), caught.value.status, caught.value.code) == (str(expected), expected.status, expected.code)
    assert sentence in str(caught.value)
    assert len(_posts(state)) == 1, "a failed job is an answer, not a reason to render again"
    assert module._read_video_pending(module.time.time()) == {}, "a known end leaves no pending record"


def test_a_job_the_restarted_server_lost_is_not_rendered_again_on_its_own(scripted):
    """A job that finished just before the restart was billed; only the agent decides
    to spend another render."""
    module, state, _clock = scripted
    state["answers"][("POST", module.VIDEO_JOBS_PATH)] = [RUNNING]
    state["answers"][("GET", f"{module.VIDEO_JOBS_PATH}/job-v")] = [_error(module, 404, "video_job_not_found")]
    with pytest.raises(module.GatewayError) as caught:
        _generate(module)
    assert caught.value.code == "video_job_not_found"
    assert "平台重启过" in str(caught.value) and "generate_video" in str(caught.value)
    assert len(_posts(state)) == 1


def test_a_render_still_running_at_the_budget_stops_and_keeps_its_key(scripted):
    module, state, clock = scripted
    state["answers"][("POST", module.VIDEO_JOBS_PATH)] = [{**RUNNING, "poll_after_seconds": 5}]
    state["answers"][("GET", f"{module.VIDEO_JOBS_PATH}/job-v")] = [{**RUNNING, "poll_after_seconds": 5}]
    started = clock.now
    with pytest.raises(module.GatewayError) as caught:
        _generate(module, timeout=660)
    waited = clock.now - started
    assert caught.value.code == "video_job_overdue"
    assert "停止等待" in str(caught.value) and "完全相同的参数" in str(caught.value)
    # Stops with room left for the download inside the tool's 660 s.
    assert 600 <= waited <= 660 - 30
    (entry,) = module._read_video_pending(clock.wall).values()
    assert entry["key"] == state["calls"][0][3]["Idempotency-Key"]


def test_the_submit_and_each_poll_have_short_read_timeouts(scripted):
    module, state, _clock = scripted
    state["answers"][("POST", module.VIDEO_JOBS_PATH)] = [{**RUNNING, "poll_after_seconds": 5}]
    state["answers"][("GET", f"{module.VIDEO_JOBS_PATH}/job-v")] = [{**RUNNING, "poll_after_seconds": 5}] * 3 + [DONE]
    assert _generate(module)["data"] == DATA
    submit, *polls = state["calls"]
    assert submit[:3] == ("POST", module.VIDEO_JOBS_PATH, module._VIDEO_JOB_SUBMIT_TIMEOUT_SECONDS)
    assert [p[:3] for p in polls] == [("GET", f"{module.VIDEO_JOBS_PATH}/job-v", module._VIDEO_JOB_POLL_TIMEOUT_SECONDS)] * 4
    assert module._VIDEO_JOB_SUBMIT_TIMEOUT_SECONDS <= 60 and module._VIDEO_JOB_POLL_TIMEOUT_SECONDS <= 30


def test_the_same_call_after_a_finished_one_is_a_new_generation(scripted):
    """Asking for the same clip again on purpose renders again: only a call whose end
    was never heard leaves its key behind."""
    module, state, _clock = scripted
    state["answers"][("POST", module.VIDEO_JOBS_PATH)] = [RUNNING]
    state["answers"][("GET", f"{module.VIDEO_JOBS_PATH}/job-v")] = [DONE]
    first = _generate(module)
    second = _generate(module)
    keys = [c[3]["Idempotency-Key"] for c in _posts(state)]
    assert len(keys) == 2 and keys[0] != keys[1]
    assert "recovered" not in first and "recovered" not in second
    assert module._read_video_pending(module.time.time()) == {}


@pytest.mark.parametrize(
    "refusal",
    [401, 402, 422, 500, "unreadable_answer", "gateway_unconfigured", "credential_missing"],
)
def test_a_refused_submit_is_final_and_leaves_no_record(scripted, refusal):
    """A refusal, an unreadable answer or a missing setup is an answer: sending it
    again changes nothing."""
    module, state, _clock = scripted
    if isinstance(refusal, int):
        error = _error(module, refusal)
    else:
        error = module.GatewayError(refusal, code=refusal)
    state["answers"][("POST", module.VIDEO_JOBS_PATH)] = [error]
    with pytest.raises(module.GatewayError) as caught:
        _generate(module)
    assert caught.value is error
    assert len(_posts(state)) == 1
    assert module._read_video_pending(module.time.time()) == {}


def test_a_submit_with_no_answer_for_two_minutes_says_so_and_keeps_its_key(scripted):
    module, state, _clock = scripted
    state["answers"][("POST", module.VIDEO_JOBS_PATH)] = [module.GatewayError("network", code="network_unreachable")]
    with pytest.raises(module.GatewayError) as caught:
        _generate(module)
    assert caught.value.code == "video_job_unreachable"
    keys = {c[3]["Idempotency-Key"] for c in _posts(state)}
    assert len(_posts(state)) > 1 and len(keys) == 1
    (entry,) = module._read_video_pending(module.time.time()).values()
    assert entry["key"] in keys


def test_a_twin_running_now_gets_its_own_key_and_the_record_stays_with_the_first(scripted):
    module, _state, _clock = scripted
    fingerprint = "f" * 64
    first, earlier = module._video_call_key(fingerprint)
    assert first and earlier is False
    assert module._video_call_key(fingerprint) == (None, False)
    module._end_video_call(fingerprint, keep=True)
    assert module._video_call_key(fingerprint) == (first, True)
    module._end_video_call(fingerprint, keep=False)
    again, earlier = module._video_call_key(fingerprint)
    module._end_video_call(fingerprint, keep=False)
    assert again != first and earlier is False


def test_a_pending_key_expires_with_the_servers_copy_of_the_job(scripted):
    module, _state, clock = scripted
    fingerprint = "a" * 64
    key, _ = module._video_call_key(fingerprint)
    module._end_video_call(fingerprint, keep=True)
    clock.wall += module._VIDEO_PENDING_TTL_SECONDS + 1
    fresh, earlier = module._video_call_key(fingerprint)
    module._end_video_call(fingerprint, keep=False)
    assert fresh != key and earlier is False


def test_an_unreadable_pending_record_never_stops_a_generation(scripted):
    module, state, _clock = scripted
    module._video_pending_file().write_text("{not json", encoding="utf-8")
    state["answers"][("POST", module.VIDEO_JOBS_PATH)] = [DONE]
    assert _generate(module)["data"] == DATA
