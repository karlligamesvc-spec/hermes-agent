"""APEX hc-1068: the engine now runs two ``generate_video`` calls of one reply at once.

Until then the Desktop video tool only ever ran one call at a time per reply, so its job
flow (hc-1000) is exercised side by side here for the first time: the real tool and the
real gateway module, two threads, one local gateway that answers a poll only once BOTH
clips were submitted. Each clip must keep its own Idempotency-Key (an identical key would
fetch the other clip, a lost key would bill a re-render), both must land, and the pending
record must be empty afterwards.
"""

from __future__ import annotations

import json
import sys
import threading

import pytest

from tests.plugins.test_apexnodes_asr_jobs import LocalGateway
from tests.plugins.test_apexnodes_gateway_tools import GATEWAY_KEY, _gateway_module, _load_plugin
from tests.plugins.test_apexnodes_video_jobs import JOBS, SERVING, _short_waits

CLIPS = {
    "a": {"prompt": "口播：创业者对着镜头说话，头肩景", "aspect_ratio": "portrait", "seconds": 12},
    "b": {"prompt": "空镜：剪辑软件时间线特写", "aspect_ratio": "portrait", "seconds": 15},
}


def _job(letter: str, status: str) -> dict:
    body = {"ok": True, "job_id": f"job-{letter}", "status": status, "poll_after_seconds": 0}
    if status == "done":
        body.update(data={"video_url": f"https://cdn.example/{letter}.mp4", "seconds": 5}, cost_cents=270)
    return body


@pytest.fixture
def desktop(monkeypatch, tmp_path):
    """The real gateway module and video tool against a local gateway (as hc-1000's)."""
    module = _gateway_module()
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("TOOLS_GATEWAY_KEY", GATEWAY_KEY)
    monkeypatch.delenv("TOOLS_GATEWAY_DISABLED", raising=False)
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        monkeypatch.delenv(name, raising=False)
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


def test_two_clips_of_one_reply_render_side_by_side_each_under_its_own_key(desktop, monkeypatch):
    module, video = desktop
    keys: list[str] = []
    both_submitted = threading.Event()

    def on_request(handler):
        if handler.command == "POST" and handler.path == JOBS:
            keys.append(handler.headers.get("Idempotency-Key"))
            if len(keys) == 2:
                both_submitted.set()
        elif handler.command == "GET" and handler.path.startswith(f"{JOBS}/"):
            both_submitted.wait(5)  # a clip is done only once the other one is out too

    results: dict[str, dict] = {}
    with LocalGateway() as gw:
        monkeypatch.setenv("TOOLS_GATEWAY_BASE", gw.base)
        gw.on_request = on_request
        gw.plan[("GET", "/tools/v1/check")] = [(200, SERVING)]
        gw.plan[("POST", JOBS)] = [(202, _job("a", "running")), (202, _job("b", "running"))]
        for letter in "ab":
            gw.plan[("GET", f"{JOBS}/job-{letter}")] = [(200, _job(letter, "done"))]

        def run(name: str) -> None:
            results[name] = json.loads(video._handle_generate_video(dict(CLIPS[name])))

        threads = [threading.Thread(target=run, args=(name,), daemon=True) for name in CLIPS]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(15)

    assert both_submitted.is_set(), "the second clip was submitted only after the first finished"
    assert len(keys) == 2 and len(set(keys)) == 2 and all(keys), keys
    assert sorted(result["video_url"] for result in results.values()) == [
        "https://cdn.example/a.mp4",
        "https://cdn.example/b.mp4",
    ]
    assert all("note" not in result for result in results.values()), "neither clip is a recovered one"
    assert module._read_video_pending(module.time.time()) == {}
    assert module._video_calls_in_flight == set()
