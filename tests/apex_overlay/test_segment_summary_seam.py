"""hc-1218: the summary carried into a new segment of Desktop's one thread records results, not recipes.

Every test runs the real ``ContextCompressor.compress`` (the code ``session.compress`` reaches on both of its
routes); only the summary model (``call_llm``) is a stand-in, and it records the exact prompt it is sent. The
seam is installed through its own ``apply()`` for each test and every patched attribute goes back afterwards,
so the "upstream" runs below are the unpatched class.

What is pinned:

1. A boundary summary opens with the plain-Chinese header (also when the summary model failed and the
   deterministic fallback is carried instead).
2. The summarizer is asked for results and what is still pending, not the approach, keeping preferences the
   user stated; upstream's focus block (and its auto focus on the latest user turns, "in full detail") is gone.
3. A compression that is not a segment boundary (the context window filling mid-task, ``/compress`` typed by
   hand) and a marked one with the switch off (a cloud container) are byte-identical to upstream.
4. The header never feeds back: the next boundary has one header, a mid-task compression none.
5. The marker is the Desktop's, and the Desktop's focus survives both ``session.compress`` routes' parser.
"""

from __future__ import annotations

import copy
import inspect
import os
import re
import subprocess
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from agent import context_compressor as cc
from agent.context_compressor import COMPRESSED_SUMMARY_METADATA_KEY, SUMMARY_PREFIX, ContextCompressor
from agent.conversation_compression_manual import parse_compress_args
from apex_overlay import segment_summary
from apex_overlay.segment_summary import BOUNDARY_RULES, HEADER, MARKER

REPO = Path(__file__).resolve().parents[2]
MIDDLEWARE = REPO / "apps/desktop/src/app/single-thread/composer-middleware.ts"
_PATCHED = ("compress", "_build_summary_prompt", "_assemble_compressed", "_strip_summary_prefix")

# The approach of the 2026-11-08 video (the assistant's own zero-cost choices) and a preference the user stated.
APPROACH = "用 5 张图做了静态图推拉，切成 5 个镜头，没加配音，没出 film.html"
USER_PREFERENCE = "以后做视频都用女声配音"
SUMMARY_BODY = "## Goal\n做了一条 15 秒的产品视频，成片在 demo-15s。\n\n## Constraints & Preferences\n- 用户说：以后都用女声配音"


def _desktop_focus() -> dict[str, str]:
    """The focus the Desktop sends for each kind of new segment, read from the composer middleware itself."""
    source = MIDDLEWARE.read_text(encoding="utf-8")
    marker = re.search(r"export const SEGMENT_SUMMARY_MARKER = '([^']+)'", source)
    assert marker, "SEGMENT_SUMMARY_MARKER is gone from the composer middleware"
    focus = dict(re.findall(r"^\s+(day|idle|restart): `\$\{SEGMENT_SUMMARY_MARKER\}([^`]+)`,?$", source, re.MULTILINE))
    assert set(focus) == {"day", "idle", "restart"}, focus
    return {reason: marker.group(1) + text for reason, text in focus.items()}


DESKTOP_FOCUS = _desktop_focus()


def _upstream(name: str):
    """The class attribute as upstream defined it, even if a plugin load in this process installed the seam."""
    attr = ContextCompressor.__dict__[name]
    if isinstance(attr, staticmethod):
        return staticmethod(segment_summary.unpatched(attr.__func__))
    return segment_summary.unpatched(attr)


_UPSTREAM = {name: _upstream(name) for name in _PATCHED}


@pytest.fixture
def seam(monkeypatch):
    """The seam on the real class for one test; the patched attributes and the mark are undone afterwards."""
    for name in _PATCHED:
        monkeypatch.setattr(ContextCompressor, name, _UPSTREAM[name])
    monkeypatch.setattr(cc, segment_summary._MARK, False, raising=False)
    assert segment_summary.apply() is True
    assert getattr(cc, segment_summary._MARK) is True, "seam not installed"
    assert all(ContextCompressor.__dict__[name] is not _UPSTREAM[name] for name in _PATCHED), "seam patched nothing"
    assert getattr(ContextCompressor.__dict__["_strip_summary_prefix"].__func__, segment_summary._MARK, False)
    return segment_summary


@pytest.fixture
def product_mode(monkeypatch):
    monkeypatch.setenv("APEX_SINGLE_THREAD_ACTIVE", "1")


class _SummaryModel:
    """The summary model: records every prompt; answers with ``body`` or raises when ``fail`` is set."""

    def __init__(self, body: str = SUMMARY_BODY, fail: bool = False):
        self.prompts: list[str] = []
        self._body, self._fail = body, fail

    def __call__(self, **kwargs):
        self.prompts.append("\n".join(str(m.get("content")) for m in kwargs["messages"]))
        if self._fail:
            raise RuntimeError("summary model unreachable")
        response = MagicMock()
        response.choices = [MagicMock()]
        response.choices[0].message.content = self._body
        response.choices[0].finish_reason = "stop"
        return response


def _compressor() -> ContextCompressor:
    with patch("agent.context_compressor.get_model_context_length", return_value=100_000):
        return ContextCompressor(model="test/model", threshold_percent=0.85, protect_first_n=1, protect_last_n=1,
                                 quiet_mode=True)


def _segment(carried: str | None = None) -> list[dict]:
    """One finished video task: the user's request and preference, the assistant's own approach."""
    head = [{"role": "system", "content": "system prompt"}]
    if carried is not None:
        head.append({"role": "user", "content": carried, COMPRESSED_SUMMARY_METADATA_KEY: True})
        head.append({"role": "assistant", "content": "接着昨天的来"})
    return head + [
        {"role": "user", "content": "用这 5 张图做个 15 秒的视频"},
        {"role": "assistant", "content": f"做好了：{APPROACH}。成片在 demo-15s/成片.mp4。"},
        {"role": "user", "content": USER_PREFERENCE},
        {"role": "assistant", "content": "记下了，以后配音默认女声。"},
        {"role": "user", "content": "封面还没定，明天再说"},
        {"role": "assistant", "content": "好，封面先放着。"},
        {"role": "user", "content": "那今天先到这"},
        {"role": "assistant", "content": "好的，明天见。"},
    ]


def _compress(messages: list[dict], model: _SummaryModel, **kwargs) -> list[dict]:
    with patch("agent.context_compressor.call_llm", model):
        return _compressor().compress(copy.deepcopy(messages), **kwargs)


def _summary_row(compressed: list[dict]) -> dict:
    rows = [m for m in compressed if ContextCompressor.classify_summary_content(m.get("content"))]
    assert len(rows) == 1, [str(m.get("content", ""))[:60] for m in compressed]
    return rows[0]


def _summary(compressed: list[dict]) -> str:
    """The carried summary: the whole row, or its part after the delimiter when upstream merged it into a
    tail row to keep roles alternating."""
    text = _summary_row(compressed)["content"]
    return text.split(cc._MERGED_SUMMARY_DELIMITER, 1)[1].lstrip() if cc._MERGED_SUMMARY_DELIMITER in text else text


def _body(summary: str) -> str:
    assert summary.startswith(SUMMARY_PREFIX + "\n"), summary[:120]
    return summary[len(SUMMARY_PREFIX) + 1:]


# --- 1. The header -------------------------------------------------------------------------------------------


@pytest.mark.parametrize("reason", ["day", "idle", "restart"])
def test_a_boundary_summary_opens_with_the_header_after_the_handoff_prefix(seam, product_mode, reason):
    model = _SummaryModel()
    summary = _summary(_compress(_segment(), model, focus_topic=DESKTOP_FOCUS[reason], force=True))

    assert len(model.prompts) == 1
    body = _body(summary)
    assert body.startswith(HEADER + "\n"), body[:200]
    assert body.count(HEADER) == 1
    assert SUMMARY_BODY.split("\n", 1)[0] in body  # the summary itself follows the header
    assert ContextCompressor.classify_summary_content(summary) == "standalone"  # still recognised as a handoff
    assert HEADER not in ContextCompressor._strip_summary_prefix(summary)  # what a later compression reads back


def test_the_fallback_carried_when_the_summary_model_fails_opens_with_it_too(seam, product_mode):
    model = _SummaryModel(fail=True)
    summary = _summary(_compress(_segment(), model, focus_topic=DESKTOP_FOCUS["day"], force=True))

    assert model.prompts, "the summary model was never asked"
    assert _body(summary).startswith(HEADER + "\n")


def test_the_header_is_one_plain_chinese_line_saying_it_is_not_this_requests_requirements():
    assert "\n" not in HEADER
    for words in ("以前那次做成了什么", "还差什么", "不是这次的要求", "照对应的技能重新确认", "不照搬以前那次的做法"):
        assert words in HEADER


# --- 2. Results, not the approach ----------------------------------------------------------------------------


def test_the_boundary_prompt_asks_for_results_and_pending_not_the_approach(seam, product_mode):
    model = _SummaryModel()
    _compress(_segment(), model, focus_topic=DESKTOP_FOCUS["day"], force=True)

    prompt = model.prompts[0]
    assert prompt.endswith(BOUNDARY_RULES)
    assert "FOCUS TOPIC" not in prompt  # upstream's "include full detail" block for the focus
    assert MARKER not in prompt
    assert "Recent user focus" not in prompt  # upstream's auto focus would keep the old task in full detail
    for asked in ("Record RESULTS", "still pending", "Do NOT record HOW", "没加配音", "静态图推拉", "shot counts",
                  "KEEP preferences and requirements the user stated", "not a user preference",
                  "the session log included"):
        assert asked in BOUNDARY_RULES


def test_a_previous_summary_with_an_approach_is_rewritten_under_the_same_rules(seam, product_mode):
    """An earlier mid-task checkpoint in the segment carries the approach; the boundary update still drops it."""
    carried = f"{SUMMARY_PREFIX}\n## Completed Actions\n1. {APPROACH} [tool: generate_video]"
    model = _SummaryModel()
    _compress(_segment(carried), model, focus_topic=DESKTOP_FOCUS["day"], force=True)

    prompt = model.prompts[0]
    assert "PREVIOUS SUMMARY" in prompt and APPROACH in prompt
    assert prompt.endswith(BOUNDARY_RULES)


# --- 3. Everything else is upstream's ------------------------------------------------------------------------


def _upstream_and_seam(monkeypatch, run):
    """``run()`` with the seam installed, then on the unpatched class: (prompts, compressed) for each."""
    with_seam = run()
    for name in _PATCHED:
        monkeypatch.setattr(ContextCompressor, name, _UPSTREAM[name])
    return with_seam, run()


@pytest.mark.parametrize("focus", [
    pytest.param(None, id="window-full-mid-task"),
    pytest.param("视频的配音部分", id="typed-compress-focus"),
])
def test_a_compression_that_is_not_a_boundary_is_upstreams(seam, product_mode, monkeypatch, focus):
    def run():
        model = _SummaryModel()
        compressed = _compress(_segment(), model, **({"focus_topic": focus} if focus else {}))
        return model.prompts, compressed

    (seam_prompts, seam_out), (upstream_prompts, upstream_out) = _upstream_and_seam(monkeypatch, run)
    assert seam_prompts and seam_prompts == upstream_prompts
    assert seam_out == upstream_out
    assert HEADER not in _summary(seam_out) and BOUNDARY_RULES not in seam_prompts[0]


def test_a_marked_compression_with_the_switch_off_is_upstreams(seam, monkeypatch):
    """A cloud container never sets the switch: the Desktop's focus would be an ordinary focus topic there."""
    monkeypatch.delenv("APEX_SINGLE_THREAD_ACTIVE", raising=False)

    def run():
        model = _SummaryModel()
        return model.prompts, _compress(_segment(), model, focus_topic=DESKTOP_FOCUS["day"], force=True)

    (seam_prompts, seam_out), (upstream_prompts, upstream_out) = _upstream_and_seam(monkeypatch, run)
    assert seam_prompts == upstream_prompts and seam_out == upstream_out
    assert "FOCUS TOPIC" in seam_prompts[0]


# --- 4. The header never feeds back --------------------------------------------------------------------------


def test_the_body_read_back_from_a_carried_summary_has_no_header(seam):
    carried = f"{SUMMARY_PREFIX}\n{HEADER}\n{SUMMARY_BODY}"
    assert ContextCompressor._strip_summary_prefix(carried) == SUMMARY_BODY
    assert ContextCompressor._strip_summary_prefix(SUMMARY_BODY) == SUMMARY_BODY


def test_the_next_boundary_after_an_engine_restart_has_exactly_one_header(seam, product_mode):
    """A new engine rehydrates the previous summary from the transcript, where yesterday's header sits."""
    carried = f"{SUMMARY_PREFIX}\n{HEADER}\n{SUMMARY_BODY}"
    model = _SummaryModel(body=f"{HEADER}\n{SUMMARY_BODY}")  # a summarizer that copies the line anyway
    summary = _summary(_compress(_segment(carried), model, focus_topic=DESKTOP_FOCUS["day"], force=True))

    assert "PREVIOUS SUMMARY" in model.prompts[0]
    assert model.prompts[0].count(HEADER) == 0
    assert _body(summary).startswith(HEADER + "\n") and summary.count(HEADER) == 1


def test_a_mid_task_compression_after_a_boundary_does_not_inherit_the_header(seam, product_mode):
    carried = f"{SUMMARY_PREFIX}\n{HEADER}\n{SUMMARY_BODY}"
    model = _SummaryModel()
    summary = _summary(_compress(_segment(carried), model))

    assert model.prompts[0].count(HEADER) == 0
    assert HEADER not in summary


# --- 5. The Desktop's marker, both routes, the seam's targets ------------------------------------------------


def test_the_marker_is_the_desktops_and_every_desktop_focus_is_recognised():
    assert MARKER == "【新的一段】"
    for reason, focus in DESKTOP_FOCUS.items():
        assert segment_summary.is_segment_focus(focus), reason
    assert not segment_summary.is_segment_focus("视频的配音部分")
    assert not segment_summary.is_segment_focus(None)


@pytest.mark.parametrize("reason", ["day", "idle", "restart"])
def test_the_desktop_focus_survives_both_session_compress_routes(reason):
    """In process the focus is parsed as is; to a compute host it travels as ``/compress <focus>``."""
    focus = DESKTOP_FOCUS[reason]
    host_side = ("/compress" + f" {focus}").removeprefix("/compress").strip()  # tui_gateway/compute_host.py
    for raw in (focus, host_side):
        request = parse_compress_args(raw)
        assert (request.focus_topic, request.partial, request.preview, request.aggressive) == (focus, False, False, False)


def test_upstream_still_has_what_the_seam_patches():
    assert segment_summary._targets_present(ContextCompressor)
    assert isinstance(cc.SUMMARY_PREFIX, str) and cc.SUMMARY_PREFIX.startswith("[CONTEXT COMPACTION")
    params = inspect.signature(ContextCompressor.compress).parameters
    assert params["focus_topic"].default is None


def test_apply_is_idempotent_and_keeps_compress_introspectable(seam):
    patched = {name: ContextCompressor.__dict__[name] for name in _PATCHED}
    assert segment_summary.apply() is True
    assert {name: ContextCompressor.__dict__[name] for name in _PATCHED} == patched
    # The agent binds only the kwargs compress() accepts, read from its signature.
    from agent.conversation_compression import _supported_compression_kwargs
    kwargs = _supported_compression_kwargs(_compressor().compress, current_tokens=None, focus_topic="x", force=True,
                                          memory_context="ledger")
    assert {"focus_topic", "force", "memory_context"} <= set(kwargs)


_PLUGIN_CHILD = """
import importlib.util, os, sys, types
from unittest.mock import MagicMock, patch
spec = importlib.util.spec_from_file_location("_hc1218_apex_overlay_plugin", "plugins/apex-overlay/__init__.py")
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)
plugin.register(types.SimpleNamespace(register_tts_provider=lambda provider: None))
assert "agent.context_compressor" not in sys.modules, "register() imported the compressor"

from agent.context_compressor import SUMMARY_PREFIX, ContextCompressor
from apex_overlay.segment_summary import HEADER

def call_llm(**kwargs):
    response = MagicMock()
    response.choices = [MagicMock()]
    response.choices[0].message.content = "## Goal\\ndone"
    response.choices[0].finish_reason = "stop"
    return response

turns = [{"role": "system", "content": "s"}] + [
    {"role": "user" if i % 2 == 0 else "assistant", "content": f"turn {i}"} for i in range(8)]
with patch("agent.context_compressor.get_model_context_length", return_value=100_000):
    compressor = ContextCompressor(model="test/model", protect_first_n=1, protect_last_n=1, quiet_mode=True)
with patch("agent.context_compressor.call_llm", call_llm):
    out = compressor.compress(turns, focus_topic=sys.argv[1], force=True)
text = "\\n".join(str(m.get("content")) for m in out)
print("HEADER" if SUMMARY_PREFIX + "\\n" + HEADER + "\\n" in text else "NO-HEADER")
"""


@pytest.mark.parametrize("switch, expected", [("1", "HEADER"), ("", "NO-HEADER")])
def test_the_overlay_plugin_installs_the_seam_in_a_fresh_engine(tmp_path, switch, expected):
    """The real plugin's register() in a fresh interpreter, then the compressor's own import: a Desktop
    segment compression gets the header with the switch on, and none with it off."""
    home = tmp_path / "home"
    home.mkdir()
    env = {**os.environ, "HERMES_HOME": str(home), "APEX_SINGLE_THREAD_ACTIVE": switch}
    result = subprocess.run([sys.executable, "-c", _PLUGIN_CHILD, DESKTOP_FOCUS["day"]], cwd=REPO, env=env,
                            capture_output=True, text=True, timeout=120, check=False)
    assert result.returncode == 0, result.stderr[-3000:]
    assert result.stdout.strip().splitlines()[-1] == expected, result.stdout[-2000:]
