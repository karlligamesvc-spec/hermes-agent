"""hc-1069: a live-voice turn reaches the model with exactly the text turn's tools, skills and MCP.

The Desktop's realtime voice only reads replies aloud; every utterance is submitted to the open chat as
a normal ``prompt.submit`` with ``surface: "voice-live"`` and the recent spoken exchange. Users reported
that "in voice it cannot use skills or MCP". The surface is meant to change ONE thing — a per-turn note
on the model input — so this pins the rest end to end, through the real Desktop backend (``hermes
serve`` over ``/api/ws``) on the parity fixture home (a skill + a stdio MCP server): the same words
submitted as a typed turn and as a voice-live turn (fresh chat, and later in the typed chat) must send
byte-identical tool schemas and system prompt, with the MCP tool offered and the skill indexed, and
differ only by the voice note in front of the user's words.
"""

from __future__ import annotations

import json

from tests.e2e.core.parity import _drive_rpc
from tests.e2e.core.parity._helpers import (
    MCP_TOOL_NAME, TURN_TIMEOUT, _text, build_parity_home, offered_tool_names, terminate)
from tests.fakes.fake_llm_provider import FakeLLMServer, Text
from tools.voice_live import VOICE_LIVE_TURN_NOTE

WORDS = "帮我查一下抖音上最近三天美妆类目的热门视频"
VOICE_CONTEXT = f"User: {WORDS}"


def _first_request(srv: FakeLLMServer, before: int) -> dict:
    body = srv.main_requests()[before]
    msgs = body.get("messages") or []
    return {
        "tools": json.dumps(body.get("tools") or [], sort_keys=True, ensure_ascii=False),
        "offered": offered_tool_names(body),
        "system": "\n".join(_text(m.get("content")) for m in msgs if m.get("role") == "system"),
        "user": _text(next(m for m in reversed(msgs) if m.get("role") == "user").get("content")),
        "effort": body.get("reasoning_effort"),
    }


def _turn(rpc: _drive_rpc.RpcClient, srv: FakeLLMServer, sid: str, **params) -> dict:
    def completes() -> int:
        return sum(1 for e in rpc.events if e.get("type") == "message.complete" and e.get("session_id") == sid)

    before, seen = len(srv.main_requests()), completes()
    rpc.call("prompt.submit", {"session_id": sid, "text": WORDS, **params}, timeout=TURN_TIMEOUT)
    rpc.wait_event("message.complete", lambda e: e.get("session_id") == sid and completes() > seen)
    return _first_request(srv, before)


def test_voice_live_turn_has_the_typed_turns_tools_skills_and_mcp(tmp_path):
    with FakeLLMServer(lambda _record: Text("好的。")) as srv:
        ph = build_parity_home(tmp_path, srv.base_url, grandchild=False)
        sp = _drive_rpc.spawn_serve(ph)
        try:
            rpc, close = _drive_rpc.ws_rpc(_drive_rpc.desktop_port(sp), sp.token)
            try:
                rpc.wait_event("gateway.ready", timeout=_drive_rpc.READY_TIMEOUT)

                def chat() -> str:
                    return rpc.call("session.create", {"cwd": str(ph.project)}, timeout=TURN_TIMEOUT)["session_id"]

                typed_chat = chat()
                typed = _turn(rpc, srv, typed_chat)
                voice_fresh = _turn(rpc, srv, chat(), surface="voice-live", voice_context=VOICE_CONTEXT)
                voice_later = _turn(rpc, srv, typed_chat, surface="voice-live", voice_context=VOICE_CONTEXT)
            finally:
                close()
        finally:
            terminate(sp.proc, timeout=60)

    assert MCP_TOOL_NAME in typed["offered"]
    assert ph.canaries["skill"] in typed["system"]
    assert VOICE_LIVE_TURN_NOTE not in typed["user"]
    for voice in (voice_fresh, voice_later):
        assert voice["tools"] == typed["tools"]
        assert voice["system"] == typed["system"]
        assert voice["effort"] == typed["effort"]
        assert voice["user"].startswith(VOICE_LIVE_TURN_NOTE)
        assert f"]\n\n{WORDS}" in voice["user"]  # the words follow the note (hook context may trail)
