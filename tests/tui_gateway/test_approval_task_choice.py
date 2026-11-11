"""hc-1223: the Desktop's ``approval`` request lists 「本任务都允许」 (``task``) only when the engine offers it.

The Desktop renders the button from the request's ``choices``; an engine that did not offer the
choice (no turn to scope it to, a smart-DENY override, an older engine) must not get one.
"""

from __future__ import annotations

import pytest


@pytest.mark.parametrize(
    ("data", "choices"),
    [
        ({"allow_task": True}, ["once", "session", "always", "task", "deny"]),
        ({}, ["once", "session", "always", "deny"]),
        ({"allow_task": True, "allow_permanent": False}, ["once", "session", "task", "deny"]),
        ({"smart_denied": True, "allow_session": False, "allow_permanent": False}, ["once", "deny"]),
    ],
)
def test_choices_follow_the_engine_offer(data, choices):
    from tui_gateway.server import _approval_request_payload

    payload = _approval_request_payload({"command": "rm -rf build", "description": "recursive delete", **data})
    assert payload["choices"] == choices
