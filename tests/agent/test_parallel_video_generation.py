"""APEX hc-1068: the clips one reply asks for render side by side.

liuxinli's editing trace (2026-10-26): one assistant message called ``text_to_speech`` and
two bridged ``generate_video`` (12 s and 15 s). The engine ran them one after another:
speech 1532→1541 s, first clip 1541→1745 s, second clip 1745→2086 s. ``generate_video``
was not parallel-safe, and as a tool whose registered deadline (660 s) exceeds the
concurrent batch's shared one (420 s) it was a barrier for every batch.

Pinned here:

1. Planner: ``generate_video`` runs beside other ``generate_video`` calls only, at most
   ``_PARALLEL_SAME_TOOL_LIMITS`` per run, bridged or direct; it never joins other
   parallel-safe work, and every other long tool stays a barrier.
2. Deadline: a same-tool run waits the tool's own registered deadline; any other batch
   keeps the shared one (an extended tool never widens other work's deadline).
3. Dispatcher: two clips that each outlast the shared deadline run at the same time and
   both finish; a clip past its own deadline is still cut.
"""

from __future__ import annotations

import json
import threading
import time
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from agent.tool_dispatch_helpers import (
    _PARALLEL_SAME_TOOL_LIMITS,
    _batch_admission,
    _parallel_batch_timeout,
    _plan_tool_batch_segments,
)
from run_agent import AIAgent
from tools.registry import registry

VIDEO = "generate_video"


def _call(name: str, args: dict | None = None, *, bridged: bool = False, call_id: str | None = None):
    arguments = dict(args or {})
    if bridged:
        name, arguments = "tool_call", {"calls": [{"name": name, "arguments": arguments}]}
    return SimpleNamespace(
        id=call_id or f"call_{uuid.uuid4().hex[:8]}",
        type="function",
        function=SimpleNamespace(name=name, arguments=json.dumps(arguments, ensure_ascii=False)),
    )


def _shape(segments) -> list[tuple[str, int]]:
    return [(kind, len(calls)) for kind, calls in segments]


@pytest.fixture
def video_tool():
    """``generate_video`` registered as the APEX plugin registers it: a 660 s budget."""
    old = registry.get_entry(VIDEO)
    registry.register(
        name=VIDEO, toolset="hc1068-probe", schema={"name": VIDEO},
        handler=lambda args, **kw: "ok", execution_timeout=660, override=True,
    )
    yield
    current = registry.get_entry(VIDEO)
    assert current is not None
    registry.restore_registration(VIDEO, current, old)


@pytest.fixture
def slow_tool():
    """Another long tool (registered budget over the shared deadline), not opted in."""
    name = "hc1068_slow_probe"
    registry.register(
        name=name, toolset="hc1068-probe", schema={"name": name},
        handler=lambda args, **kw: "ok", execution_timeout=7800,
    )
    yield name
    registry.deregister(name)


# ── ① the planner ─────────────────────────────────────────────────────────────


def test_only_generate_video_is_opted_in():
    assert _PARALLEL_SAME_TOOL_LIMITS == {VIDEO: 2}


@pytest.mark.parametrize("bridged", [False, True], ids=["direct", "bridged"])
def test_the_traces_reply_renders_its_two_clips_side_by_side(video_tool, bridged):
    calls = [
        _call("text_to_speech", {"text": "旁白"}),
        _call(VIDEO, {"prompt": "口播", "seconds": 12}, bridged=bridged),
        _call(VIDEO, {"prompt": "空镜", "seconds": 15}, bridged=bridged),
    ]
    segments = _plan_tool_batch_segments(calls)
    assert _shape(segments) == [("sequential", 1), ("parallel", 2)]
    assert [tc.id for _, run in segments for tc in run] == [tc.id for tc in calls]


@pytest.mark.parametrize(
    ("count", "shape"),
    [
        (2, [("parallel", 2)]),
        (3, [("parallel", 2), ("sequential", 1)]),
        (4, [("parallel", 2), ("parallel", 2)]),
        (5, [("parallel", 2), ("parallel", 2), ("sequential", 1)]),
    ],
)
def test_at_most_the_limit_of_clips_run_at_once(video_tool, count, shape):
    assert _shape(_plan_tool_batch_segments([_call(VIDEO, {"prompt": f"镜头 {i}"}) for i in range(count)])) == shape


@pytest.mark.parametrize(
    ("names", "shape"),
    [
        (["web_search", VIDEO, VIDEO, "web_search", "read_file"],
         [("sequential", 1), ("parallel", 2), ("parallel", 2)]),
        ([VIDEO, "web_search"], [("sequential", 2)]),
        (["web_search", "web_search", VIDEO], [("parallel", 2), ("sequential", 1)]),
        ([VIDEO, "image_generate", VIDEO], [("sequential", 3)]),
    ],
    ids=["clips-between-searches", "clip-then-search", "searches-then-clip", "image-between-clips"],
)
def test_a_clip_never_runs_beside_other_work(video_tool, names, shape):
    args = {"web_search": {"query": "q"}, "read_file": {"path": "notes.md"}}
    calls = [_call(name, args.get(name, {"prompt": "p"})) for name in names]
    assert _shape(_plan_tool_batch_segments(calls)) == shape


def test_every_other_long_tool_stays_a_barrier(video_tool, slow_tool):
    for bridged in (False, True):
        assert _batch_admission(_call(slow_tool, bridged=bridged), None) is None
        assert _batch_admission(_call(VIDEO, {"prompt": "p"}, bridged=bridged), None) == (VIDEO, [], False)
    assert _shape(_plan_tool_batch_segments([_call(slow_tool), _call(slow_tool)])) == [("sequential", 2)]


# ── ② the batch's deadline ────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("names", "default", "expected"),
    [
        ([VIDEO, VIDEO], 420.0, 660.0),
        ([VIDEO], 420.0, 660.0),
        ([VIDEO, VIDEO], 900.0, 900.0),  # a longer shared deadline is never shortened
        ([VIDEO, VIDEO], None, None),  # a disabled deadline stays disabled
        ([VIDEO, "web_search"], 420.0, 420.0),
        (["web_search", "read_file"], 420.0, 420.0),
        ([], 420.0, 420.0),
    ],
)
def test_a_same_tool_run_waits_its_own_deadline_and_nothing_else_is_widened(video_tool, names, default, expected):
    assert _parallel_batch_timeout(names, default) == expected


def test_a_long_tool_not_opted_in_never_widens_a_batch(slow_tool):
    assert _parallel_batch_timeout([slow_tool, slow_tool], 420.0) == 420.0


# ── ③ the dispatcher ──────────────────────────────────────────────────────────


@pytest.fixture
def agent():
    defs = [
        {"type": "function", "function": {"name": n, "description": n, "parameters": {"type": "object", "properties": {}}}}
        for n in ("text_to_speech", VIDEO)
    ]
    with (
        patch("model_tools.get_tool_definitions", return_value=defs),
        patch("model_tools.check_toolset_requirements", return_value={}),
        patch("agent.process_bootstrap.OpenAI"),
    ):
        a = AIAgent(
            api_key="test-key-1234567890",
            base_url="https://openrouter.ai/api/v1",
            quiet_mode=True,
            skip_context_files=True,
            skip_memory=True,
        )
        a.client = MagicMock()
        return a


@pytest.fixture
def short_deadlines(monkeypatch):
    """The shared deadline 0.4 s, the clip's own 3 s: seconds instead of minutes."""
    monkeypatch.setenv("HERMES_CONCURRENT_TOOL_TIMEOUT_S", "0.4")
    old = registry.get_entry(VIDEO)
    registry.register(
        name=VIDEO, toolset="hc1068-probe", schema={"name": VIDEO},
        handler=lambda args, **kw: "ok", execution_timeout=3, override=True,
    )
    yield
    current = registry.get_entry(VIDEO)
    assert current is not None
    registry.restore_registration(VIDEO, current, old)


def test_two_clips_render_at_the_same_time_past_the_shared_deadline(agent, short_deadlines):
    calls = [
        _call("text_to_speech", {"text": "旁白"}, call_id="tts"),
        _call(VIDEO, {"prompt": "口播"}, call_id="v1"),
        _call(VIDEO, {"prompt": "空镜"}, call_id="v2"),
    ]
    both_rendering = threading.Barrier(2, timeout=2)
    events: list[tuple[str, str]] = []
    lock = threading.Lock()

    def fake_handle(name, args, task_id, **kwargs):
        call_id = kwargs["tool_call_id"]
        with lock:
            events.append(("start", call_id))
        if name == VIDEO:
            both_rendering.wait()  # only passes when both clips are in flight at once
            time.sleep(0.8)  # health: allow HX013 -- each clip outlasting the shared 0.4 s deadline is the behaviour under test
        with lock:
            events.append(("end", call_id))
        return json.dumps({"ok": name, "video_url": f"https://cdn.example/{call_id}.mp4"})

    messages: list = []
    with patch("model_tools.handle_function_call", side_effect=fake_handle):
        agent._execute_tool_calls(SimpleNamespace(content="", tool_calls=calls), messages, "task-hc1068")

    assert [m["tool_call_id"] for m in messages] == ["tts", "v1", "v2"]
    for message in messages[1:]:
        assert "timed out" not in message["content"] and "video_url" in message["content"], message["content"]
    assert events.index(("end", "tts")) < events.index(("start", "v1")), "the speech still runs before the clips"


def test_a_clip_past_its_own_deadline_is_still_cut(agent, short_deadlines):
    calls = [_call(VIDEO, {"prompt": "口播"}, call_id="v1"), _call(VIDEO, {"prompt": "空镜"}, call_id="v2")]
    release = threading.Event()

    def fake_handle(name, args, task_id, **kwargs):
        release.wait(10)  # never answers within the clip's own 3 s
        return json.dumps({"ok": name})

    messages: list = []
    started = time.monotonic()
    try:
        with patch("model_tools.handle_function_call", side_effect=fake_handle):
            agent._execute_tool_calls(SimpleNamespace(content="", tool_calls=calls), messages, "task-hc1068")
    finally:
        release.set()
    waited = time.monotonic() - started
    assert [m["tool_call_id"] for m in messages] == ["v1", "v2"]
    assert all("timed out after 3.0s" in m["content"] for m in messages), [m["content"] for m in messages]
    assert 2.5 < waited < 8, waited
