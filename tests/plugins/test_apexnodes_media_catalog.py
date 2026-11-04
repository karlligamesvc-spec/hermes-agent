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


# ── generate_video: the same rules (contract v16) ─────────────────────────────

VIDEO_PLUGIN = ROOT / "plugins/apexnodes-video-tools/__init__.py"
MINI = "doubao-seedance-2-0-mini-260615"
H3 = "MiniMax-H3"
GROK = "grok-imagine-video"


@pytest.fixture
def video_plugin(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    spec = importlib.util.spec_from_file_location("apexnodes_media_catalog_video_test", VIDEO_PLUGIN)
    assert spec and spec.loader
    plugin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(plugin)
    return plugin


def _serve_video(monkeypatch, plugin, *, gateway: bool, section: dict | None = None) -> list[dict]:
    section = section if section is not None else {"catalog": copy.deepcopy(SERVED["video"]), "legs": {}}
    sent: list[dict] = []

    def legacy(_method, path, payload=None, timeout=None):
        if path.endswith("/check"):
            return section
        sent.append(payload)
        return {"ok": True, "model": payload.get("model")}

    def gateway_request(method, path, payload=None, **_kwargs):
        # The gateway's video job wire (hc-1000): the submit answers running, the poll done.
        if path == "/tools/v1/check":
            return {"video": section}
        if method == "POST":
            sent.append(payload)
            return {"ok": True, "job_id": "j1", "status": "running", "poll_after_seconds": 5}
        return {"ok": True, "job_id": "j1", "status": "done", "data": {"model": sent[-1].get("model")}}

    monkeypatch.setattr(plugin, "_use_gateway", lambda: gateway)
    monkeypatch.setattr(plugin, "_request", legacy)
    monkeypatch.setattr(plugin._gateway, "request_json", gateway_request)
    monkeypatch.setattr(plugin._gateway.time, "sleep", lambda _s: None)
    return sent


def test_the_video_model_parameter_lists_no_ids(video_plugin):
    model = video_plugin.GENERATE_VIDEO_SCHEMA["parameters"]["properties"]["model"]
    assert "enum" not in model and "video-generation" in model["description"]


@pytest.mark.parametrize("gateway", [True, False])
@pytest.mark.parametrize(
    ("config_text", "asked", "sent_model"),
    [
        # The bug the ticket is about: the hidden picker's saved Mini replaced the assistant's model.
        (f"apex:\n  generation_video_model: {MINI}\n  generation_model_choice: assistant\n", H3, H3),
        (f"apex:\n  generation_video_model: {MINI}\n  generation_model_choice: assistant\n", None, None),
        (f"apex:\n  generation_video_model: {MINI}\n  generation_model_choice: user\n", H3, MINI),
        (f"apex:\n  generation_video_model: {MINI}\n", H3, MINI),
    ],
)
def test_who_picks_the_video_model(video_plugin, monkeypatch, tmp_path, gateway, config_text, asked, sent_model):
    (tmp_path / "config.yaml").write_text(config_text, encoding="utf-8")
    sent = _serve_video(monkeypatch, video_plugin, gateway=gateway)
    args = {"prompt": "一只猫在弹钢琴", **({"model": asked} if asked else {})}
    result = json.loads(video_plugin._handle_generate_video(args))
    assert "error" not in result, result
    assert sent[0]["model"] == sent_model


@pytest.mark.parametrize("gateway", [True, False])
def test_a_hypit_video_models_health_is_read_on_its_own_leg(video_plugin, monkeypatch, gateway):
    paused = {"configured": True, "serving": False, "healthy": False, "retry_after_seconds": 300}
    section = {"catalog": copy.deepcopy(SERVED["video"]), "legs": {"hypit:grok-imagine-video": paused}}
    sent = _serve_video(monkeypatch, video_plugin, gateway=gateway, section=section)
    result = json.loads(video_plugin._handle_generate_video({"prompt": "x", "model": GROK}))
    assert sent == [] and "5 分钟" in result["error"] and "「+」" not in result["error"]


@pytest.mark.parametrize("gateway", [True, False])
def test_a_leg_switched_off_as_a_whole_says_so(video_plugin, monkeypatch, gateway):
    """chinaapi switched off: its rows read configured=false with no reason of their own;
    the leg check says the platform switched video off, not an empty "unavailable"."""
    section = {"catalog": copy.deepcopy(SERVED["video"]), "legs": {f"chinaapi:{H3}": {"configured": False, "serving": False}}}
    for row in section["catalog"]["models"]:
        if row["provider"] == "chinaapi":
            row["configured"] = False
    sent = _serve_video(monkeypatch, video_plugin, gateway=gateway, section=section)
    result = json.loads(video_plugin._handle_generate_video({"prompt": "x", "model": H3}))
    assert sent == [] and "暂时关闭" in result["error"] and "换成" not in result["error"]
