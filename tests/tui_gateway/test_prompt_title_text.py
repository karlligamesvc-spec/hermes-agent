"""A Desktop turn is titled after what the user typed, not the model input built around it.

prompt.submit prepends notes the user never typed to the model input (attached-image hints, reactions,
voice/HUD surface). An image turn's session was titled "[The user attached an image…" in the APEX sidebar
(2026-10-22) because the titler read that input; the gateway already hands it the typed text."""

import threading
import types

import pytest

from tui_gateway import server


def _session(agent):
    return {
        "agent": agent, "session_key": "session-key", "history": [], "history_lock": threading.Lock(),
        "history_version": 0, "running": False, "attached_images": [], "image_counter": 0, "cols": 80,
        "slash_worker": None, "show_reasoning": False, "tool_progress_mode": "all",
    }


class _ImmediateThread:
    def __init__(self, target=None, daemon=None, **_thread_options):
        self._target = target

    def start(self):
        self._target()


@pytest.mark.parametrize("typed", ["这是一个奶茶店，老板拍了几张图，生成一个本地宣传视频", ""])
def test_image_turn_titles_from_the_typed_caption(monkeypatch, tmp_path, typed):
    captured = {}

    class _Agent:
        provider, model, api_mode = "custom", "apex-flash", "chat_completions"

        def run_conversation(self, prompt, conversation_history=None, stream_callback=None,
                             title_user_message=None, **_kwargs):
            captured.update(run_message=prompt, title_user_message=title_user_message)
            return {"final_response": "ok", "messages": [{"role": "assistant", "content": "ok"}]}

    image = tmp_path / "Application Support" / "IMG_6352.jpg"
    image.parent.mkdir(parents=True)
    image.write_bytes(b"jpg")
    session = _session(_Agent())
    session["attached_images"] = [str(image)]
    server._sessions["sid"] = session
    try:
        monkeypatch.setattr(server.threading, "Thread", _ImmediateThread)
        monkeypatch.setattr(server, "_get_usage", lambda _a: {})
        monkeypatch.setattr(server, "render_message", lambda _t, _c: "")
        monkeypatch.setattr(server, "_emit", lambda *a: None)
        resp = server.handle_request(
            {"id": "1", "method": "prompt.submit", "params": {"session_id": "sid", "text": typed}})
        assert resp.get("result")
    finally:
        server._sessions.pop("sid", None)

    # The model input really leads with the image note (text mode for a non-vision route).
    assert isinstance(captured["run_message"], str)
    assert captured["run_message"].startswith("[The user attached an image: IMG_6352.jpg]")
    # The titler gets the caption, or nothing to title from for an image-only opener.
    assert captured["title_user_message"] == typed
