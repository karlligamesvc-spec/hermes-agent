"""Seam-test + behavior test for apex_overlay.im_passthrough (hc-539).

Pins the upstream symbol the seam monkey-patches so an upstream rename turns a
silently-disarmed feature into a loud CI failure:

* ``gateway.run.GatewayRunner._handle_message`` — the passthrough controller
  wraps it to intercept ``/cc`` / ``/codex`` sessions before the Hermes agent.

Behavior proven (deterministic, table-driven where the logic is pure; scripted
in-memory harness — no real ``claude``/``codex`` process — for the state
machine):

* command classification (/cc /codex /stop /cancel /plain) in and out of
  passthrough, including the verbatim-forward contract;
* the enter → forward → cancel → stop lifecycle over a fake harness;
* long-output chunking (pure ``chunk_text`` + the ``_deliver`` split-send);
* the deny-all permission red line — structurally (enter never installs an
  approving callback; the real harness default IS deny) and behaviorally
  (a permission_request folds to a deny notice, never an approval);
* the ``HERMES_IM_PASSTHROUGH`` kill switch and the opt-in / auth gates.

Run via ``scripts/run_tests_parallel.py`` (per-file fresh interpreter).
"""

from __future__ import annotations

import asyncio
import inspect

import pytest

from agent.coding_agents.events import AgentEvent, AvailabilityInfo
from apex_overlay import im_passthrough
from apex_overlay.im_passthrough import (
    PtAction,
    chunk_text,
    classify_input,
    render_result,
)


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


# ---------------------------------------------------------------------------
# Seam assertions — pin the patched symbol
# ---------------------------------------------------------------------------


def test_seam_target_handle_message_exists_and_is_async():
    from gateway.run import GatewayRunner

    method = getattr(GatewayRunner, im_passthrough._TARGET_METHOD, None)
    assert method is not None, (
        "GatewayRunner._handle_message is gone — IM passthrough can no longer "
        "intercept inbound messages. Update im_passthrough._TARGET_METHOD."
    )
    assert inspect.iscoroutinefunction(method), (
        "_handle_message must be async — the passthrough wrapper awaits it."
    )
    params = list(inspect.signature(method).parameters)
    assert params[:2] == ["self", "event"], (
        f"_handle_message param order changed to {params!r}; the wrapper forwards "
        f"(self, event, ...)."
    )


def test_apply_installs_wrapper_and_is_idempotent():
    from gateway.run import GatewayRunner

    im_passthrough._APPLIED = False
    assert im_passthrough.apply() is True
    assert getattr(GatewayRunner._handle_message, im_passthrough._MARK, False)

    ref = GatewayRunner._handle_message
    assert im_passthrough.apply() is True
    assert GatewayRunner._handle_message is ref, "apply() must not double-wrap"


def test_plugin_register_applies_seam():
    from tests.apex_overlay.conftest import run_plugin_register_with_stubbed_seams

    called = run_plugin_register_with_stubbed_seams("_im_passthrough_plugin_under_test")
    assert "im_passthrough" in called, (
        "plugin.register() must call im_passthrough.apply()"
    )


# ---------------------------------------------------------------------------
# Pure core — classify_input (table-driven)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "command,args,raw,in_pt,expect_action,expect_family",
    [
        # Not in passthrough: only an explicit entry command engages (opt-in).
        ("cc", "", "/cc", False, PtAction.ENTER, "claude"),
        ("claude", "", "/claude", False, PtAction.ENTER, "claude"),
        ("codex", "", "/codex", False, PtAction.ENTER, "codex"),
        (None, "", "hello there", False, PtAction.IGNORE, None),
        ("help", "", "/help", False, PtAction.IGNORE, None),   # unrelated slash → normal flow
        ("stop", "", "/stop", False, PtAction.IGNORE, None),   # /stop only matters IN passthrough
        ("cancel", "", "/cancel", False, PtAction.IGNORE, None),
        # In passthrough: control words intercepted, everything else forwarded verbatim.
        ("stop", "", "/stop", True, PtAction.STOP, None),
        ("cancel", "", "/cancel", True, PtAction.CANCEL, None),
        ("cc", "", "/cc", True, PtAction.SWITCH, "claude"),
        ("codex", "", "/codex", True, PtAction.SWITCH, "codex"),
        (None, "", "fix the bug in main.py", True, PtAction.FORWARD, None),
        ("help", "", "/help", True, PtAction.FORWARD, None),   # verbatim: agent decides
    ],
)
def test_classify_input(command, args, raw, in_pt, expect_action, expect_family):
    decision = classify_input(command, args, raw, in_passthrough=in_pt)
    assert decision.action is expect_action
    assert decision.family == expect_family


def test_classify_forward_is_verbatim():
    """FORWARD carries the raw text unchanged — the no-loss contract."""
    raw = "  please KEEP  my\n  whitespace and /slashes  "
    d = classify_input(None, "", raw, in_passthrough=True)
    assert d.action is PtAction.FORWARD
    assert d.forward_text == raw, "forwarded text must be byte-identical (lossless)"


# ---------------------------------------------------------------------------
# Pure core — chunk_text (table-driven)
# ---------------------------------------------------------------------------


def test_chunk_text_short_is_single():
    assert chunk_text("hi", 100) == ["hi"]


def test_chunk_text_empty_is_none():
    assert chunk_text("", 100) == []
    assert chunk_text("   ", 100) == []


def test_chunk_text_respects_limit_and_reassembles():
    body = "\n".join(f"line-{i:03d} " + "x" * 40 for i in range(200))
    chunks = chunk_text(body, 500)
    assert len(chunks) > 1
    assert all(len(c) <= 500 for c in chunks), "no chunk may exceed the limit"
    # Content is preserved (modulo boundary whitespace we strip on split).
    assert "line-000" in chunks[0]
    assert "line-199" in chunks[-1]


def test_chunk_text_hard_split_when_no_boundary():
    body = "x" * 1200  # no spaces/newlines at all
    chunks = chunk_text(body, 500)
    assert [len(c) for c in chunks] == [500, 500, 200]


# ---------------------------------------------------------------------------
# Red line — deny-all permission handling
# ---------------------------------------------------------------------------


def test_real_harness_default_is_deny():
    """The harness the seam builds defaults to denying every permission request."""
    from agent.coding_agents import harness_for
    from agent.coding_agents.harness import default_deny_permission

    h = harness_for("claude")
    assert h._permission_callback is default_deny_permission, (
        "a passthrough harness must keep the deny-all default permission callback"
    )


def test_render_result_permission_required_denies_and_notifies():
    result = {
        "status": "failed",
        "output": "",
        "permission_required": True,
        "permission_summary": "rm -rf /tmp/x",
        "error": "",
    }
    text = render_result(result)
    assert "拒绝" in text and "不会自动批准" in text, "must state the op was denied, no auto-approve"
    assert "rm -rf /tmp/x" in text, "must surface what was denied so the owner can act"
    # There is no approval vocabulary anywhere in the reply.
    for banned in ("已批准", "allow_once", "allow_always", "approved"):
        assert banned not in text


def test_render_result_output_then_permission():
    result = {
        "output": "here is the plan",
        "permission_required": True,
        "permission_summary": "write /etc/hosts",
        "error": "",
    }
    text = render_result(result)
    assert text.startswith("here is the plan")
    assert "write /etc/hosts" in text


# ---------------------------------------------------------------------------
# State machine — scripted fake harness (no real process)
# ---------------------------------------------------------------------------


class _FakeHarness:
    """In-memory stand-in for an AgentHarness: scripted turns, no subprocess."""

    def __init__(self, *, family="claude", installed=True, scripted=None):
        self.family = family
        self._installed = installed
        self._scripted = list(scripted or [])
        self.opened = False
        self.closed = False
        self.cancelled = 0
        self.prompts: list[str] = []

    def availability(self):
        return AvailabilityInfo(
            family=self.family, installed=self._installed, detail="fake detail"
        )

    def open(self):
        self.opened = True
        return ""

    def close(self):
        self.closed = True

    def cancel(self):
        self.cancelled += 1

    def prompt(self, text):
        self.prompts.append(text)
        if self._scripted:
            events = self._scripted.pop(0)
        else:
            events = [
                AgentEvent.session_started("sess-1"),
                AgentEvent.message(f"echo:{text}"),
                AgentEvent.turn_completed("end_turn"),
            ]
        return iter(events)


class _FakeAdapter:
    def __init__(self):
        self.sent: list[tuple[str, str]] = []

    async def send(self, chat_id, text):
        self.sent.append((chat_id, text))


class _FakeSource:
    def __init__(self, user_id="u1", chat_id="c1"):
        self.user_id = user_id
        self.chat_id = chat_id
        self.internal = False


class _FakeEvent:
    """Minimal MessageEvent shim: real get_command/get_command_args semantics."""

    def __init__(self, text, source=None, internal=False):
        self.text = text
        self.source = source or _FakeSource()
        self.internal = internal

    def get_command(self):
        if not self.text or not self.text.startswith("/"):
            return None
        first = self.text.split(maxsplit=1)[0][1:].lower()
        return first or None

    def get_command_args(self):
        parts = self.text.split(maxsplit=1)
        return parts[1] if len(parts) > 1 else ""


class _FakeRunner:
    def __init__(self, adapter=None, authorized=True):
        self._adapter = adapter or _FakeAdapter()
        self._authorized = authorized

    def _session_key_for_source(self, source):
        return f"{source.user_id}:{source.chat_id}"

    def _is_user_authorized(self, source):
        return self._authorized

    def _adapter_for_source(self, source):
        return self._adapter


def _install_fake_harness(monkeypatch, harness, capture=None):
    def _factory(family, cwd=None, **kwargs):
        if capture is not None:
            capture["family"] = family
            capture["cwd"] = cwd
            capture["kwargs"] = kwargs
        harness.family = family
        return harness
    monkeypatch.setattr(im_passthrough, "harness_for", _factory)


def test_enter_never_installs_permission_callback(monkeypatch):
    """Red line, structural: the enter path builds the harness WITHOUT a
    permission_callback, so it keeps the deny-all default."""
    capture: dict = {}
    harness = _FakeHarness()
    _install_fake_harness(monkeypatch, harness, capture)
    runner = _FakeRunner()

    handled, reply = _run(
        im_passthrough.maybe_handle_passthrough(runner, _FakeEvent("/cc"))
    )
    assert handled is True
    assert "直通模式" in reply
    assert "permission_callback" not in capture["kwargs"], (
        "passthrough must never pass an approving permission_callback"
    )
    assert harness.opened is True


def test_full_lifecycle_enter_forward_cancel_stop(monkeypatch):
    harness = _FakeHarness()
    _install_fake_harness(monkeypatch, harness)
    runner = _FakeRunner()
    src = _FakeSource()

    async def _go():
        # /cc → enter
        h1, r1 = await im_passthrough.maybe_handle_passthrough(runner, _FakeEvent("/cc", src))
        assert h1 and "直通模式" in r1
        # plain text → forwarded verbatim, echoed back
        h2, r2 = await im_passthrough.maybe_handle_passthrough(
            runner, _FakeEvent("do the thing", src)
        )
        assert h2 and r2 == "echo:do the thing"
        assert harness.prompts == ["do the thing"]
        # /cancel → interrupt
        h3, r3 = await im_passthrough.maybe_handle_passthrough(runner, _FakeEvent("/cancel", src))
        assert h3 and harness.cancelled == 1
        # /stop → exit, session gone, harness closed
        h4, r4 = await im_passthrough.maybe_handle_passthrough(runner, _FakeEvent("/stop", src))
        assert h4 and harness.closed is True
        # after stop, plain text is no longer intercepted
        h5, r5 = await im_passthrough.maybe_handle_passthrough(
            runner, _FakeEvent("now normal again", src)
        )
        assert h5 is False and r5 is None

    _run(_go())


def test_switch_family_closes_old_opens_new(monkeypatch):
    claude = _FakeHarness(family="claude")
    codex = _FakeHarness(family="codex")
    handles = iter([claude, codex])

    def _factory(family, cwd=None, **kwargs):
        h = next(handles)
        h.family = family
        return h
    monkeypatch.setattr(im_passthrough, "harness_for", _factory)
    runner = _FakeRunner()
    src = _FakeSource()

    async def _go():
        await im_passthrough.maybe_handle_passthrough(runner, _FakeEvent("/cc", src))
        # switch to codex
        handled, reply = await im_passthrough.maybe_handle_passthrough(
            runner, _FakeEvent("/codex", src)
        )
        assert handled and "Codex" in reply
        assert claude.closed is True, "switching must close the previous harness"
        sessions = getattr(runner, im_passthrough._STATE_ATTR)
        assert sessions[runner._session_key_for_source(src)].family == "codex"

    _run(_go())


def test_enter_unavailable_family_returns_error_no_session(monkeypatch):
    """Rule 5: an un-installed family gives a clear 'not wired' error, no session."""
    harness = _FakeHarness(installed=False)
    _install_fake_harness(monkeypatch, harness)
    runner = _FakeRunner()

    handled, reply = _run(
        im_passthrough.maybe_handle_passthrough(runner, _FakeEvent("/codex"))
    )
    assert handled is True
    assert "未接入" in reply
    assert harness.opened is False
    sessions = getattr(runner, im_passthrough._STATE_ATTR, {})
    assert sessions == {}, "no session may be created for an unavailable family"


def test_inline_first_prompt_after_enter(monkeypatch):
    harness = _FakeHarness()
    _install_fake_harness(monkeypatch, harness)
    runner = _FakeRunner()

    handled, reply = _run(
        im_passthrough.maybe_handle_passthrough(runner, _FakeEvent("/cc fix the flaky test"))
    )
    assert handled is True
    assert "直通模式" in reply
    assert "echo:fix the flaky test" in reply
    assert harness.prompts == ["fix the flaky test"]


def test_permission_request_end_to_end_denies(monkeypatch):
    """A turn whose stream contains a permission_request folds to a deny notice."""
    scripted = [[
        AgentEvent.session_started("s1"),
        AgentEvent.permission_request({"title": "delete production db"}),
        AgentEvent.turn_completed("end_turn"),
    ]]
    harness = _FakeHarness(scripted=scripted)
    _install_fake_harness(monkeypatch, harness)
    runner = _FakeRunner()
    src = _FakeSource()

    async def _go():
        await im_passthrough.maybe_handle_passthrough(runner, _FakeEvent("/cc", src))
        handled, reply = await im_passthrough.maybe_handle_passthrough(
            runner, _FakeEvent("wipe everything", src)
        )
        assert handled
        assert "拒绝" in reply and "delete production db" in reply

    _run(_go())


def test_long_output_is_chunked_over_adapter(monkeypatch):
    big = "Z" * 9000
    scripted = [[
        AgentEvent.session_started("s1"),
        AgentEvent.message(big),
        AgentEvent.turn_completed("end_turn"),
    ]]
    harness = _FakeHarness(scripted=scripted)
    _install_fake_harness(monkeypatch, harness)
    adapter = _FakeAdapter()
    runner = _FakeRunner(adapter=adapter)
    src = _FakeSource()

    async def _go():
        await im_passthrough.maybe_handle_passthrough(runner, _FakeEvent("/cc", src))
        handled, reply = await im_passthrough.maybe_handle_passthrough(
            runner, _FakeEvent("emit a wall of text", src)
        )
        assert handled
        # Earlier chunks went out over the adapter; the last is returned.
        assert len(adapter.sent) >= 1
        total = "".join(t for _, t in adapter.sent) + reply
        assert total.count("Z") == 9000, "no content lost across chunks"

    _run(_go())


# ---------------------------------------------------------------------------
# Gates — kill switch, opt-in, auth
# ---------------------------------------------------------------------------


def test_kill_switch_disables_feature(monkeypatch):
    monkeypatch.setenv("HERMES_IM_PASSTHROUGH", "0")
    harness = _FakeHarness()
    _install_fake_harness(monkeypatch, harness)
    runner = _FakeRunner()

    handled, reply = _run(
        im_passthrough.maybe_handle_passthrough(runner, _FakeEvent("/cc"))
    )
    assert handled is False and reply is None
    assert harness.opened is False


def test_default_enabled(monkeypatch):
    monkeypatch.delenv("HERMES_IM_PASSTHROUGH", raising=False)
    assert im_passthrough._enabled() is True


def test_plain_text_ignored_when_not_in_passthrough(monkeypatch):
    harness = _FakeHarness()
    _install_fake_harness(monkeypatch, harness)
    runner = _FakeRunner()
    handled, reply = _run(
        im_passthrough.maybe_handle_passthrough(runner, _FakeEvent("just chatting"))
    )
    assert handled is False and reply is None


def test_unauthorized_user_does_not_engage(monkeypatch):
    harness = _FakeHarness()
    _install_fake_harness(monkeypatch, harness)
    runner = _FakeRunner(authorized=False)
    handled, reply = _run(
        im_passthrough.maybe_handle_passthrough(runner, _FakeEvent("/cc"))
    )
    assert handled is False and reply is None
    assert harness.opened is False


def test_internal_event_bypasses_passthrough(monkeypatch):
    harness = _FakeHarness()
    _install_fake_harness(monkeypatch, harness)
    runner = _FakeRunner()
    ev = _FakeEvent("/cc")
    ev.internal = True
    handled, reply = _run(im_passthrough.maybe_handle_passthrough(runner, ev))
    assert handled is False and reply is None


# ---------------------------------------------------------------------------
# The method wrapper delegates vs short-circuits
# ---------------------------------------------------------------------------


def test_wrapper_short_circuits_when_handled(monkeypatch):
    calls = {"orig": 0}

    async def _orig(self, event):
        calls["orig"] += 1
        return "ORIG"

    async def _fake_ctrl(runner, event):
        return True, "PASSTHRU"

    monkeypatch.setattr(im_passthrough, "maybe_handle_passthrough", _fake_ctrl)
    wrapped = im_passthrough._wrap_handle_message(_orig)
    result = _run(wrapped("self", _FakeEvent("/cc")))
    assert result == "PASSTHRU"
    assert calls["orig"] == 0, "handled message must NOT reach the original"


def test_wrapper_delegates_when_not_handled(monkeypatch):
    calls = {"orig": 0}

    async def _orig(self, event):
        calls["orig"] += 1
        return "ORIG"

    async def _fake_ctrl(runner, event):
        return False, None

    monkeypatch.setattr(im_passthrough, "maybe_handle_passthrough", _fake_ctrl)
    wrapped = im_passthrough._wrap_handle_message(_orig)
    result = _run(wrapped("self", _FakeEvent("hi")))
    assert result == "ORIG"
    assert calls["orig"] == 1


def test_wrapper_never_lets_controller_break_handling(monkeypatch):
    calls = {"orig": 0}

    async def _orig(self, event):
        calls["orig"] += 1
        return "ORIG"

    async def _boom(runner, event):
        raise RuntimeError("controller exploded")

    monkeypatch.setattr(im_passthrough, "maybe_handle_passthrough", _boom)
    wrapped = im_passthrough._wrap_handle_message(_orig)
    result = _run(wrapped("self", _FakeEvent("hi")))
    assert result == "ORIG", "a controller crash must fall through to normal handling"
    assert calls["orig"] == 1
