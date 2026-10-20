"""The bundled Desktop image plugin must honor the current picker selection."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest


PLUGIN = Path(__file__).resolve().parents[2] / "plugins/apexnodes-image-tools/__init__.py"


def _fake_transports(captured, answer):
    """Fake legacy ``_request`` and gateway ``request_json``. hc-969's leg-health read
    gets an empty body (no verdict, the call goes ahead); the generation call records
    its payload and answers ``answer(payload)``."""

    def legacy(_method, path, payload=None, timeout=None):
        if path.endswith("/check"):
            return {}
        captured.append(payload)
        return answer(payload)

    def gateway(_method, path, payload=None, *, timeout=None):
        if path == "/tools/v1/check":
            return {}
        captured.append(payload)
        return {"data": answer(payload)}

    return legacy, gateway


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
    fake_legacy, fake_gateway = _fake_transports(captured, lambda _payload: {"ok": True, "model": expected})

    monkeypatch.setattr(image_plugin, "_use_gateway", lambda: False)
    monkeypatch.setattr(image_plugin, "_request", fake_legacy)
    assert json.loads(image_plugin._handle_generate_image(args))["model"] == expected

    monkeypatch.setattr(image_plugin, "_use_gateway", lambda: True)
    monkeypatch.setattr(image_plugin._gateway, "request_json", fake_gateway)
    assert json.loads(image_plugin._handle_generate_image(args))["model"] == expected
    assert [payload["model"] for payload in captured] == [expected, expected]


def test_a_saved_agnes_image_2_5_moves_to_gpt_image_2_5_flare(image_plugin, monkeypatch, tmp_path):
    """hc-957: Agnes Image 2.5 left the picker; a config saved before that keeps working."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    (tmp_path / "config.yaml").write_text(
        "apex:\n  generation_image_model: agnes-image-2.5-flash\n", encoding="utf-8"
    )
    captured = []
    _fake_legacy, fake_gateway = _fake_transports(captured, lambda payload: {"ok": True, "model": payload["model"]})
    monkeypatch.setattr(image_plugin, "_use_gateway", lambda: True)
    monkeypatch.setattr(image_plugin._gateway, "request_json", fake_gateway)

    result = json.loads(image_plugin._handle_generate_image({"prompt": "西高地犬"}))

    assert result["model"] == "gpt-image-2.5-flare"
    assert [payload["model"] for payload in captured] == ["gpt-image-2.5-flare"]


def test_the_picker_no_longer_offers_agnes_image_2_5(image_plugin):
    model = image_plugin.GENERATE_IMAGE_SCHEMA["parameters"]["properties"]["model"]
    assert "agnes-image-2.5-flash" not in model["enum"]
    assert "Agnes" not in model["description"]
    assert set(image_plugin.RETIRED_IMAGE_MODELS.values()) <= set(model["enum"])


def test_the_desktop_plugin_offers_no_agnes_engine(image_plugin):
    """hc-990 (Kael, 2026-10-20): Agnes left every image candidate list and agnes-overlay
    became cover-overlay. The LLM-facing schema names neither; installed builds that still
    send the old names are mapped by the ApexNodes server (its CI reads this enum)."""
    schema = image_plugin.GENERATE_IMAGE_SCHEMA
    provider = schema["parameters"]["properties"]["provider"]
    assert provider["enum"] == ["cover-overlay", "cover-template", "nanobanana-flash", "nanobanana-pro"]
    assert "agnes" not in json.dumps(schema, ensure_ascii=False).lower()


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
