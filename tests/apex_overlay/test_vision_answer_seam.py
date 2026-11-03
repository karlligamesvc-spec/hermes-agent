"""hc-1065: ``vision_analyze`` on APEX answers the question asked, and never returns reasoning.

2026-10-26, APEX Desktop, model ``apex-flash``: 17 ``vision_analyze`` calls all went to the
auxiliary model with a "fully describe and explain everything" prompt. Five hit the 4,096-token
output limit (relay.log ``completion=4096``): four returned the model's private reasoning as the
answer, one stopped mid-sentence and was passed on as complete. These tests pin the overlay:

  1. Upstream shape the seam relies on (patchable extractor, handler source).
  2. Routing stays upstream's: the relay's models keep the auxiliary path (sending Flash images
     natively waits for a paid check), and a route upstream already sends natively still does.
  3. The auxiliary prompt asks a direct question in the configured language.
  4. Only the visible answer comes back; a cut-off answer says so; a cut-off with no answer fails.
  5. Wiring: register() applies the seam, and apply() armed before the imports patches them.
"""
from __future__ import annotations

import asyncio
import base64
import inspect
import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from agent import image_routing
from apex_overlay import vision_answer as seam
from tools import vision_tools
from tools.registry import registry

REPO = Path(__file__).resolve().parents[2]
RELAY = "https://apex-nodes.com/relay/v1"
_TINY_PNG = base64.b64decode(
    b"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
)
IMAGE = "data:image/png;base64," + base64.b64encode(_TINY_PNG).decode("ascii")
LEAKED_REASONING = "We need answer Chinese. Need fully describe and explain everything about"


def _cfg(model: str = "apex-flash", base_url: str = RELAY, **extra) -> dict:
    return {"model": {"provider": "custom", "default": model, "base_url": base_url}, **extra}


def _response(content, finish_reason="stop", reasoning=None):
    message = SimpleNamespace(content=content, reasoning_content=reasoning, reasoning=None, reasoning_details=None)
    return SimpleNamespace(choices=[SimpleNamespace(message=message, finish_reason=finish_reason)])


@pytest.fixture(autouse=True)
def _no_catalog_network(monkeypatch):
    """The models.dev probe would fetch the catalog; this suite needs it to have no opinion."""
    import agent.models_dev

    monkeypatch.setattr(agent.models_dev, "get_model_capabilities", lambda *a, **k: None)


@pytest.fixture
def installed(monkeypatch):
    """Both patches for one test; monkeypatch puts the extractor and the handler back."""
    entry = registry.get_entry("vision_analyze")
    monkeypatch.setattr(vision_tools, "extract_content_or_reasoning", vision_tools.extract_content_or_reasoning)
    monkeypatch.setattr(entry, "handler", entry.handler)
    assert seam._install_vision(vision_tools) is True
    return entry


def _main_route(monkeypatch, cfg: dict) -> None:
    """The active main model as the engine reads it during a turn."""
    import agent.auxiliary_client as aux
    import hermes_cli.config

    monkeypatch.setattr(hermes_cli.config, "load_config", lambda *a, **k: cfg)
    monkeypatch.setattr(aux, "_read_main_provider", lambda: cfg["model"]["provider"])
    monkeypatch.setattr(aux, "_read_main_model", lambda: cfg["model"]["default"])


# ---------------------------------------------------------------------------
# 1. Upstream shape
# ---------------------------------------------------------------------------

def test_upstream_targets_keep_their_shape():
    assert list(inspect.signature(vision_tools.vision_analyze_tool).parameters) == [
        "image_url", "user_prompt", "model", "task_id", "region"]
    assert list(inspect.signature(vision_tools._configured_aux_model).parameters) == ["sections", "env_vars"]
    # The wrapper copies upstream's auxiliary branch; a change here means re-checking that copy.
    source = inspect.getsource(vision_tools._handle_vision_analyze)
    assert "if _should_use_native_vision_fast_path():" in source
    assert 'model = _configured_aux_model(("vision",), ("AUXILIARY_VISION_MODEL",))' in source
    assert "vision_analyze_tool(image_url, full_prompt, model, task_id=task_id, region=region)" in source
    # _call_vision_llm reads the extractor from the module at call time (the patch point).
    assert "extract_content_or_reasoning(" in inspect.getsource(vision_tools._call_vision_llm)
    entry = registry.get_entry("vision_analyze")
    assert entry is not None and entry.is_async
    assert inspect.unwrap(entry.handler) is vision_tools._handle_vision_analyze


def test_language_table_is_still_where_the_seam_reads_it():
    from hermes_cli import personality

    assert personality._RESPONSE_LANGUAGE_NAMES["zh"] == "Simplified Chinese"
    assert personality._RESPONSE_LANGUAGE_ALIASES["zh-cn"] == "zh"
    assert personality._get({"a": {"b": 1}}, "a", "b") == 1


# ---------------------------------------------------------------------------
# 2. Routing stays upstream's
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("model", ["apex-flash", "apex-pro", "apex-max"])
def test_relay_models_still_take_the_auxiliary_path(installed, model):
    """No route change in hc-1065: Flash goes native only after deepseek-flash is measured taking an
    image inside a tool result (Kael's merge plan, 2026-10-26)."""
    assert vision_tools._native_tool_result_images("custom", model, _cfg(model)) is False
    assert image_routing.decide_image_input_mode("custom", model, _cfg(model)) == "text"


def test_a_native_route_still_reaches_upstream(installed, monkeypatch):
    """A route upstream already sends natively (here the config override) keeps upstream's handler."""
    cfg = _cfg()
    cfg["model"]["supports_vision"] = True
    _main_route(monkeypatch, cfg)

    async def no_aux_call(**_kwargs):
        raise AssertionError("native path must not call the auxiliary model")

    monkeypatch.setattr(vision_tools, "async_call_llm", no_aux_call)
    result = asyncio.run(installed.handler({"image_url": IMAGE, "question": "画面里有字幕吗"}))
    assert isinstance(result, dict) and result["_multimodal"] is True
    assert [part["type"] for part in result["content"]] == ["text", "image_url"]


# ---------------------------------------------------------------------------
# 3. The auxiliary prompt
# ---------------------------------------------------------------------------

def _capture_aux_prompt(installed, monkeypatch, cfg, question="字幕在哪一格？只回答两点"):
    _main_route(monkeypatch, cfg)
    seen = {}

    async def fake_tool(image_url, user_prompt, model=None, task_id=None, region=None):
        seen.update(image_url=image_url, prompt=user_prompt, model=model, task_id=task_id, region=region)
        return json.dumps({"success": True, "analysis": "ok"})

    monkeypatch.setattr(vision_tools, "vision_analyze_tool", fake_tool)
    asyncio.run(installed.handler({"image_url": IMAGE, "question": question, "region": [0, 0, 1, 1]}, task_id="t1"))
    return seen


@pytest.mark.parametrize("language_cfg,expected", [
    ({"agent": {"response_language": "display"}, "display": {"language": "zh"}},
     "Write the answer in Simplified Chinese."),
    ({"agent": {"response_language": "display"}, "display": {"language": "zh-CN"}},
     "Write the answer in Simplified Chinese."),
    ({"agent": {"response_language": "ja"}}, "Write the answer in Japanese."),
    ({"agent": {"response_language": "auto"}}, "Write the answer in the language of the question."),
    ({}, "Write the answer in the language of the question."),
])
def test_auxiliary_prompt_is_a_direct_question(installed, monkeypatch, language_cfg, expected):
    seen = _capture_aux_prompt(installed, monkeypatch, _cfg(**language_cfg))
    assert "Fully describe" not in seen["prompt"] and "everything about" not in seen["prompt"]
    assert seen["prompt"].startswith("Answer the question below about this image.")
    assert expected in seen["prompt"]
    assert seen["prompt"].endswith("Question: 字幕在哪一格？只回答两点")
    assert (seen["image_url"], seen["task_id"], seen["region"]) == (IMAGE, "t1", [0, 0, 1, 1])


def test_auxiliary_prompt_keeps_the_configured_vision_model(installed, monkeypatch):
    seen = _capture_aux_prompt(installed, monkeypatch, _cfg())
    assert seen["model"] is None
    monkeypatch.setattr(vision_tools, "_cfg_auxiliary", lambda section, *keys, default=None: "vision-x")
    seen = _capture_aux_prompt(installed, monkeypatch, _cfg())
    assert seen["model"] == "vision-x"


def test_empty_question_still_asks_for_a_short_answer():
    prompt = seam.direct_question_prompt("  ", {})
    assert prompt.endswith("Question: Say briefly what this image shows.")


# ---------------------------------------------------------------------------
# 4. Only the visible answer
# ---------------------------------------------------------------------------

def _analyze(monkeypatch, *responses):
    calls = []

    async def fake_llm(**kwargs):
        calls.append(kwargs)
        return responses[min(len(calls), len(responses)) - 1]

    monkeypatch.setattr(vision_tools, "async_call_llm", fake_llm)
    raw = asyncio.run(vision_tools.vision_analyze_tool(IMAGE, seam.direct_question_prompt("q", {}), None))
    return json.loads(raw), len(calls)


ANSWER_CASES = [
    # (id, responses, success, analysis check, calls)
    ("reasoning-only cut-off fails, no reasoning, no retry",
     [_response("", "length", LEAKED_REASONING)], False, None, 1),
    ("think-tag-only cut-off fails",
     [_response("<think>先看左格，再看右格", "length")], False, None, 1),
    ("partial answer is marked as cut off",
     [_response("第三格没有人物，呈现", "length")], True, "第三格没有人物，呈现\n\n" + seam.CUT_OFF_NOTE, 1),
    ("closed think block is removed",
     [_response("<think>先想想</think>左格看不到手。", "stop")], True, "左格看不到手。", 1),
    ("plain answer passes through",
     [_response("1）左格完整。2）右格切边。", "stop", "reasoning text")], True, "1）左格完整。2）右格切边。", 1),
    ("empty stop retries once and keeps the second answer",
     [_response("", "stop", "推理"), _response("答案", "stop")], True, "答案", 2),
]


@pytest.mark.parametrize("responses,success,analysis,calls", [c[1:] for c in ANSWER_CASES],
                         ids=[c[0] for c in ANSWER_CASES])
def test_only_the_visible_answer_comes_back(installed, monkeypatch, responses, success, analysis, calls):
    result, made = _analyze(monkeypatch, *responses)
    assert (result["success"], made) == (success, calls)
    dumped = json.dumps(result, ensure_ascii=False)
    assert LEAKED_REASONING not in dumped and "推理" not in dumped and "先看左格" not in dumped
    if success:
        assert result["analysis"] == analysis
    else:
        assert "output budget" in result["error"] and "region" in result["analysis"]


def test_video_shares_the_extractor(installed):
    """video_analyze goes through the same _call_vision_llm, so it gets the same answer rules."""
    with pytest.raises(seam.VisionAnswerCutOff):
        asyncio.run(vision_tools._call_vision_llm({}, "empty", _response("", "length", LEAKED_REASONING)))


@pytest.mark.parametrize("response,expected", [
    ({"choices": [{"message": {"content": "答案"}, "finish_reason": "max_tokens"}]}, "答案\n\n" + seam.CUT_OFF_NOTE),
    ({"choices": [{"message": {"content": [{"type": "text", "text": "答案"}]}, "finish_reason": "stop"}]}, "答案"),
    ("纯文本", "纯文本"),
    (None, ""),
])
def test_visible_answer_reads_dicts_part_lists_and_strings(response, expected):
    assert seam.visible_answer(response) == expected


# ---------------------------------------------------------------------------
# 5. Wiring
# ---------------------------------------------------------------------------

def test_plugin_register_applies_the_seam():
    from tests.apex_overlay.conftest import run_plugin_register_with_stubbed_seams

    assert "vision_answer" in run_plugin_register_with_stubbed_seams("_apex_overlay_plugin_hc1065")


def test_apply_before_the_imports_patches_them_when_they_load():
    """Production order: plugin discovery arms the seam, the tool modules load later (hc-989)."""
    script = (
        "import sys\n"
        "from apex_overlay import vision_answer\n"
        "assert 'tools.vision_tools' not in sys.modules\n"
        "assert vision_answer.apply() is True\n"
        "assert 'tools.vision_tools' not in sys.modules\n"
        "import tools.vision_tools as vt\n"
        "from tools.registry import registry\n"
        "assert vt.extract_content_or_reasoning is vision_answer.visible_answer\n"
        "def wrapped_once():\n"
        "    handler = registry.get_entry('vision_analyze').handler\n"
        "    return getattr(handler, '_apex_vision_answer', False) and handler.__wrapped__ is vt._handle_vision_analyze\n"
        "assert wrapped_once()\n"
        "assert vision_answer.apply() is True and wrapped_once()\n"
        "print('ok')\n"
    )
    done = subprocess.run([sys.executable, "-c", script], cwd=REPO, capture_output=True, text=True, timeout=120, check=False)
    assert done.returncode == 0 and done.stdout.strip().endswith("ok"), done.stderr[-2000:]
