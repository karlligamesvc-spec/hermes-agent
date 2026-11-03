"""hc-1046: the Desktop media tools pick models from the catalog the ApexNodes server serves.

* the ``model`` parameter lists no ids; a model is checked against ``catalog`` in the
  check block (``/tools/v1/check`` ``image``/``video``, ``/media/{image,video}/check`` on
  the legacy leg), so a model the platform adds needs no Desktop release;
* while the Desktop hides its model picker (``apex.generation_model_choice: assistant``,
  tier mode and single-thread product mode) the saved value is the hidden default and
  the assistant's model stands; with the picker shown the saved choice still wins;
* an id the catalog lacks, or a model switched off, is refused before anything is
  spent, with the ids that work; a Hypit model's health is read on its own leg.

The catalog is a snapshot of the server's real view (``fixtures/apex_media_catalog_hc1046.json``).
The ApexNodes copy (``app/runtime_plugins/apexnodes-image-tools``) has the same cases in
``tests/test_hc1046_plugin_model_choice.py``.
"""

from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
IMAGE_PLUGIN = ROOT / "plugins/apexnodes-image-tools/__init__.py"
SERVED = json.loads((Path(__file__).resolve().parent / "fixtures/apex_media_catalog_hc1046.json").read_text(encoding="utf-8"))
FLARE = "gpt-image-2.5-flare"
PRO = "nano-banana-pro"
HIDDEN = "apex:\n  generation_image_model: gpt-image-2.5-flare\n  generation_model_choice: assistant\n"
SHOWN = "apex:\n  generation_image_model: gpt-image-2.5-flare\n  generation_model_choice: user\n"


@pytest.fixture
def image_plugin(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    spec = importlib.util.spec_from_file_location("apexnodes_media_catalog_image_test", IMAGE_PLUGIN)
    assert spec and spec.loader
    plugin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(plugin)
    return plugin


def _section(**legs) -> dict:
    return {"catalog": copy.deepcopy(SERVED["image"]), "legs": legs}


def _serve(monkeypatch, plugin, *, gateway: bool, section: dict | None = None) -> list[dict]:
    """The server on one leg: the check answers ``section``, a generation is recorded."""
    section = section if section is not None else _section()
    sent: list[dict] = []

    def legacy(_method, path, payload=None, timeout=None):
        if path.endswith("/check"):
            return section
        sent.append(payload)
        return {"ok": True, "model": payload.get("model")}

    def gateway_request(_method, path, payload=None, *, timeout=None):
        if path == "/tools/v1/check":
            return {"image": section}
        sent.append(payload)
        return {"data": {"ok": True, "model": payload.get("model")}}

    monkeypatch.setattr(plugin, "_use_gateway", lambda: gateway)
    monkeypatch.setattr(plugin, "_request", legacy)
    monkeypatch.setattr(plugin._gateway, "request_json", gateway_request)
    return sent


def _call(plugin, **args) -> dict:
    return json.loads(plugin._handle_generate_image({"prompt": "西高地犬", **args}))


def test_the_model_parameter_lists_no_ids(image_plugin):
    model = image_plugin.GENERATE_IMAGE_SCHEMA["parameters"]["properties"]["model"]
    assert "enum" not in model and "image-generation" in model["description"]


@pytest.mark.parametrize("gateway", [True, False])
@pytest.mark.parametrize(
    ("config_text", "asked", "sent_model"),
    [
        (HIDDEN, PRO, PRO),
        (HIDDEN, None, None),
        (SHOWN, PRO, FLARE),
        ("apex:\n  generation_image_model: gpt-image-2.5-flare\n", PRO, FLARE),
    ],
)
def test_who_picks_the_model(image_plugin, monkeypatch, tmp_path, gateway, config_text, asked, sent_model):
    (tmp_path / "config.yaml").write_text(config_text, encoding="utf-8")
    sent = _serve(monkeypatch, image_plugin, gateway=gateway)
    result = _call(image_plugin, **({"model": asked} if asked else {}))
    assert result.get("ok") is True, result
    assert sent[0]["model"] == sent_model


@pytest.mark.parametrize("gateway", [True, False])
def test_an_id_the_catalog_lacks_is_refused_with_the_ids_that_work(image_plugin, monkeypatch, gateway):
    sent = _serve(monkeypatch, image_plugin, gateway=gateway)
    result = _call(image_plugin, model="midjourney-v9")
    assert sent == [] and "midjourney-v9" in result["error"]
    assert FLARE in result["error"] and PRO in result["error"]


def test_a_model_switched_off_says_the_servers_reason(image_plugin, monkeypatch):
    section = _section()
    for row in section["catalog"]["models"]:
        if row["provider"] == "hypit":
            row.update(configured=False, unavailable_reason=f"{row['label']} 暂不可用(平台没有开放这条线路)。")
    sent = _serve(monkeypatch, image_plugin, gateway=True, section=section)
    result = _call(image_plugin, model=PRO)
    assert sent == [] and "Nano Banana Pro 暂不可用" in result["error"] and "没有用掉额度" in result["error"]
    assert FLARE in result["error"] and "nano-banana-2-lite" not in result["error"]


def test_a_stale_saved_choice_reads_as_the_setting(image_plugin, monkeypatch, tmp_path):
    (tmp_path / "config.yaml").write_text("apex:\n  generation_image_model: retired-model-x\n", encoding="utf-8")
    sent = _serve(monkeypatch, image_plugin, gateway=True)
    result = _call(image_plugin)
    assert sent == [] and "当前图片模型设置" in result["error"]


@pytest.mark.parametrize("gateway", [True, False])
def test_a_hypit_models_health_is_read_on_its_own_leg(image_plugin, monkeypatch, gateway):
    paused = {"configured": True, "serving": False, "healthy": False, "retry_after_seconds": 300}
    sent = _serve(monkeypatch, image_plugin, gateway=gateway, section=_section(**{"hypit:nano-banana-pro": paused}))
    result = _call(image_plugin, model=PRO)
    assert sent == [] and "5 分钟" in result["error"]
    # The pause copy no longer sends the user to a picker the product shell hides.
    assert "「+」" not in result["error"]


def test_a_server_without_a_catalog_validates_the_name_itself(image_plugin, monkeypatch):
    sent = _serve(monkeypatch, image_plugin, gateway=True, section={"legs": {}})
    assert _call(image_plugin, model="anything-new")["ok"] is True
    assert sent[0]["model"] == "anything-new"
