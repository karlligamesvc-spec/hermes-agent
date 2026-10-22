"""hc-1013: a finished cut is one 15 s generation with its shots hard-cut, not one call
per shot (Kael, 2026-10-22).

The Desktop runs this bundled plugin, not the hosted copy in apex-nodes, so what the
model reads about ``seconds`` is pinned here with the same literal the apex-nodes test
pins for the hosted copy (``tests/test_hc1013_one_take_finished_cut.py``). The
platform clamps the length per model (at most 15 s); the plugin forwards it as asked,
on the gateway and the legacy leg alike. The image tool no longer describes reference
images as "one keyframe per shot".
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

PLUGINS = Path(__file__).resolve().parents[2] / "plugins"
SECONDS_DESCRIPTION = (
    "Optional clip length in whole seconds. Leave empty for the platform default (a 5 s "
    "sample). A finished cut of up to 15 s is ONE call: write all its shots into the prompt "
    "with time spans and hard cuts, not one call per shot; only a longer cut is split. The "
    "platform clamps this to the selected engine's range (at most 15 s), so report the "
    "returned seconds."
)


def _load(name: str):
    spec = importlib.util.spec_from_file_location(f"hc1013_{name.replace('-', '_')}", PLUGINS / name / "__init__.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def video_plugin():
    return _load("apexnodes-video-tools")


def test_seconds_tells_the_model_a_finished_cut_is_one_call(video_plugin):
    seconds = video_plugin.GENERATE_VIDEO_SCHEMA["parameters"]["properties"]["seconds"]
    assert seconds == {"type": "integer", "description": SECONDS_DESCRIPTION}


@pytest.mark.parametrize("gateway", [True, False], ids=["gateway", "legacy"])
@pytest.mark.parametrize("seconds", [15, None])
def test_the_take_length_is_forwarded_as_asked(video_plugin, monkeypatch, tmp_path, gateway, seconds):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    captured: list[dict] = []

    def legacy(_method, path, payload=None, timeout=None):
        if path.endswith("/check"):
            return {}
        captured.append(payload)
        return {"ok": True, "seconds": payload["seconds"]}

    def via_gateway(_method, path, payload=None, *, timeout=None):
        if path == "/tools/v1/check":
            return {}
        captured.append(payload)
        return {"data": {"ok": True, "seconds": payload["seconds"]}}

    monkeypatch.setattr(video_plugin, "_use_gateway", lambda: gateway)
    monkeypatch.setattr(video_plugin, "_request", legacy)
    monkeypatch.setattr(video_plugin._gateway, "request_json", via_gateway)
    args = {"prompt": "一条 15 秒的竖屏短视频，分三个镜头，镜头之间硬切"}
    if seconds is not None:
        args["seconds"] = seconds

    result = json.loads(video_plugin._handle_generate_video(args))

    assert [payload["seconds"] for payload in captured] == [seconds]
    assert result["seconds"] == seconds


def test_the_image_tool_no_longer_asks_for_a_keyframe_per_shot():
    images = _load("apexnodes-image-tools").GENERATE_IMAGE_SCHEMA["parameters"]["properties"]["images"]
    assert "每镜关键帧" not in images["description"] and "定妆图" in images["description"]
