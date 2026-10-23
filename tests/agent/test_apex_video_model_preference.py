"""hc-948: the bundled Desktop video plugin must honor the current picker selection.

The Desktop saves ``apex.generation_video_model`` (seeded to Seedance 2.0 Mini),
but the bundled plugin never read it, so every Desktop video call went out without
``model`` and landed on the Agnes leg (2026-10-18 short-video review: three Agnes
HTTP 503s). Mirrors ``test_apex_image_model_preference.py``.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest


PLUGIN = Path(__file__).resolve().parents[2] / "plugins/apexnodes-video-tools/__init__.py"
MINI = "doubao-seedance-2-0-mini-260615"


@pytest.fixture
def video_plugin():
    spec = importlib.util.spec_from_file_location("apex_video_model_preference_test", PLUGIN)
    assert spec and spec.loader
    plugin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(plugin)
    return plugin


def _fake_transports(captured, answer):
    """Fake legacy ``_request`` and gateway ``request_json``. hc-969's leg-health read
    gets an empty body (no verdict, the call goes ahead); the generation call records
    its payload and answers ``answer(payload)``."""

    def legacy(_method, path, payload=None, timeout=None):
        if path.endswith("/check"):
            return {}
        captured.append(payload)
        return answer(payload)

    def gateway(_method, path, payload=None, *, timeout=None, headers=None):
        if path == "/tools/v1/check":
            return {}
        captured.append(payload)
        # The video job submit (hc-1000, hc-978's follow-up), answered as already done: these
        # tests read the payload, the polling has its own tests.
        return {"job_id": "j1", "status": "done", "data": answer(payload)}

    return legacy, gateway


def _capture_both_paths(video_plugin, monkeypatch, args, answer):
    """Run the handler once on the legacy path and once on the gateway path."""
    captured = []
    fake_legacy, fake_gateway = _fake_transports(captured, lambda _payload: {"ok": True, "model": answer})
    monkeypatch.setattr(video_plugin, "_use_gateway", lambda: False)
    monkeypatch.setattr(video_plugin, "_request", fake_legacy)
    legacy = json.loads(video_plugin._handle_generate_video(dict(args)))

    monkeypatch.setattr(video_plugin, "_use_gateway", lambda: True)
    monkeypatch.setattr(video_plugin._gateway, "request_json", fake_gateway)
    gateway = json.loads(video_plugin._handle_generate_video(dict(args)))
    return captured, legacy, gateway


@pytest.mark.parametrize(
    ("selected", "explicit", "expected"),
    [
        (MINI, None, MINI),
        ("MiniMax-H3", None, "MiniMax-H3"),
        (MINI, "doubao-seedance-2-5-260628", MINI),
    ],
)
def test_bundled_video_plugin_uses_picker_on_gateway_and_legacy(
    video_plugin, monkeypatch, tmp_path, selected, explicit, expected
):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    (tmp_path / "config.yaml").write_text(
        f"apex:\n  generation_video_model: {selected}\n", encoding="utf-8"
    )
    args = {"prompt": "收纳架开箱"}
    if explicit:
        args["model"] = explicit

    captured, legacy, gateway = _capture_both_paths(video_plugin, monkeypatch, args, expected)

    assert legacy["model"] == expected and gateway["model"] == expected
    assert [payload["model"] for payload in captured] == [expected, expected]


@pytest.mark.parametrize(
    ("config_text", "explicit", "expected"),
    [
        (None, None, None),
        (None, "MiniMax-H3", "MiniMax-H3"),
        ("model:\n  default: x\n", None, None),
        ("apex:\n  generation_image_model: gpt-image-2.5-flare\n", None, None),
    ],
    ids=["no-config", "no-config-explicit", "no-apex-section", "image-only"],
)
def test_without_a_picker_the_call_keeps_the_platform_default(
    video_plugin, monkeypatch, tmp_path, config_text, explicit, expected
):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    if config_text is not None:
        (tmp_path / "config.yaml").write_text(config_text, encoding="utf-8")
    args = {"prompt": "收纳架开箱"}
    if explicit:
        args["model"] = explicit

    captured, _legacy, _gateway_result = _capture_both_paths(video_plugin, monkeypatch, args, expected)

    assert [payload["model"] for payload in captured] == [expected, expected]


@pytest.mark.parametrize(
    "invalid_yaml",
    [
        "apex: [unterminated\n",
        "apex: []\n",
        "apex:\n  generation_video_model: unknown-model\n",
        "apex:\n  generation_video_model: 7\n",
    ],
)
def test_invalid_picker_never_falls_back_to_the_platform_default(
    video_plugin, monkeypatch, tmp_path, invalid_yaml
):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    (tmp_path / "config.yaml").write_text(invalid_yaml, encoding="utf-8")
    monkeypatch.setattr(video_plugin, "_use_gateway", lambda: True)
    monkeypatch.setattr(
        video_plugin._gateway, "request_json", lambda *_args, **_kwargs: pytest.fail("must not send video request")
    )

    result = json.loads(video_plugin._handle_generate_video({"prompt": "收纳架开箱"}))

    assert "当前视频模型设置" in result["error"]


def test_the_picker_is_reread_on_every_call(video_plugin, monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    config = tmp_path / "config.yaml"
    captured = []
    _fake_legacy, fake_gateway = _fake_transports(captured, lambda _payload: {"ok": True})
    monkeypatch.setattr(video_plugin, "_use_gateway", lambda: True)
    monkeypatch.setattr(video_plugin._gateway, "request_json", fake_gateway)
    for model in (MINI, "MiniMax-H3"):
        config.write_text(f"apex:\n  generation_video_model: {model}\n", encoding="utf-8")
        video_plugin._handle_generate_video({"prompt": "收纳架开箱"})

    assert [payload["model"] for payload in captured] == [MINI, "MiniMax-H3"]
