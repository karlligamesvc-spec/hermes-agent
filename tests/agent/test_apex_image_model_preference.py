"""The bundled Desktop image plugin must honor the current picker selection."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest


PLUGIN = Path(__file__).resolve().parents[2] / "plugins/apexnodes-image-tools/__init__.py"


@pytest.fixture
def image_plugin():
    spec = importlib.util.spec_from_file_location("apex_image_model_preference_test", PLUGIN)
    assert spec and spec.loader
    plugin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(plugin)
    return plugin


@pytest.mark.parametrize(
    ("selected", "explicit", "expected"),
    [
        ("gpt-image-2.5-flare", None, "gpt-image-2.5-flare"),
        ("qwen-image-3.0-pro", None, "qwen-image-3.0-pro"),
        ("gpt-image-2.5-flare", "gemini-2.5-flash-image", "gpt-image-2.5-flare"),
    ],
)
def test_bundled_image_plugin_uses_picker_on_gateway_and_legacy(
    image_plugin, monkeypatch, tmp_path, selected, explicit, expected
):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    (tmp_path / "config.yaml").write_text(
        f"apex:\n  generation_image_model: {selected}\n", encoding="utf-8"
    )
    args = {"prompt": "西高地犬"}
    if explicit:
        args["model"] = explicit
    captured = []

    monkeypatch.setattr(image_plugin, "_use_gateway", lambda: False)
    monkeypatch.setattr(
        image_plugin,
        "_request",
        lambda _method, _path, payload: captured.append(payload) or {"ok": True, "model": expected},
    )
    assert json.loads(image_plugin._handle_generate_image(args))["model"] == expected

    monkeypatch.setattr(image_plugin, "_use_gateway", lambda: True)
    monkeypatch.setattr(
        image_plugin._gateway,
        "request_json",
        lambda _method, _path, payload, timeout: captured.append(payload)
        or {"data": {"ok": True, "model": expected}},
    )
    assert json.loads(image_plugin._handle_generate_image(args))["model"] == expected
    assert [payload["model"] for payload in captured] == [expected, expected]


@pytest.mark.parametrize(
    "invalid_yaml",
    ["apex: [unterminated\n", "apex: []\n", "apex:\n  generation_image_model: unknown\n"],
)
def test_invalid_picker_never_falls_back_to_agnes(
    image_plugin, monkeypatch, tmp_path, invalid_yaml
):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    (tmp_path / "config.yaml").write_text(invalid_yaml, encoding="utf-8")
    monkeypatch.setattr(image_plugin, "_use_gateway", lambda: False)
    monkeypatch.setattr(
        image_plugin, "_request", lambda *_args: pytest.fail("must not send image request")
    )

    result = json.loads(image_plugin._handle_generate_image({"prompt": "西高地犬"}))

    assert "当前图片模型设置" in result["error"]


def test_bundled_tool_description_prevents_duplicate_delivery(image_plugin):
    description = image_plugin.GENERATE_IMAGE_SCHEMA["description"]
    assert "Never output both for the same image" in description
    assert "report the returned model" in description
