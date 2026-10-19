"""The ``clarify`` server request carries the recommended label exactly as the tool decided it.

Desktop's card, the TUI prompt and the Bot room card all render this request's choices and label
only a choice that carries the wire marker, never one by its position. So a question with no better
answer (``recommended: false``) must reach them unmarked, and every other question with the first
choice marked. Real ``clarify_tool`` → real ``_clarify_block``; the client is the captured request.
"""

import json

from tools.clarify_tool import clarify_tool
from tui_gateway import server, server_requests


def _ask(monkeypatch, questions):
    sent = {}

    def send(method, sid, params, timeout=None, qids=None):
        sent.update(method=method, questions=params["questions"])
        # The client answers each question with its first choice, as the card showed it.
        return {"answers": {q["qid"]: q["choices"][0] for q in params["questions"]}, "outcome": "submitted"}

    monkeypatch.setattr(server_requests, "send", send)
    result = json.loads(clarify_tool(questions, callback=lambda normalized: server._clarify_block("s1", normalized)))
    assert sent["method"] == "clarify"
    return [q["choices"] for q in sent["questions"]], [r["user_response"] for r in result["responses"]]


def test_each_question_reaches_the_client_labelled_only_when_it_has_a_better_answer(monkeypatch):
    choices, answers = _ask(monkeypatch, [
        {"question": "What do you film?", "choices": ["Vlogs", "Skits"], "recommended": False},
        {"question": "How often should you post?", "choices": ["Daily", "Weekly"]},
    ])
    assert choices == [["Vlogs", "Skits"], ["Daily (Recommended)", "Weekly"]]
    assert answers == ["Vlogs", "Daily"]
