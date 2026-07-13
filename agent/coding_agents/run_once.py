"""One-shot AcpHarness runner — drive one coding-agent family for a single prompt.

This is the thin, side-effect-isolated entrypoint the APEX Desktop daemon leg
(hc-533) shells out to. The daemon (Electron main process, ``apex-daemon.cjs``)
owns the cloud reverse-connect (register / heartbeat / poll / result); when it
claims a ``local_agent_run`` task it invokes::

    <venv-python> -m agent.coding_agents.run_once   # job JSON on stdin

with the job on stdin and reads one result JSON line from stdout. Keeping the
AcpHarness (hc-524) drive in Python — where the harness lives — means the daemon
never re-implements a wire protocol in Node; it just moves a JSON job across the
process boundary and gets a normalized result back.

Iron rules inherited from hc-524 hold here unchanged: the harness white-lists
launch by the registry, scrubs the child env (the user's own Claude/Codex/Cursor
credentials stay local and are never forwarded to Hermes, nor up to the cloud),
and converges on the session. This module adds no capability — it only *reduces*
the harness's normalized :class:`AgentEvent` stream into one flat result dict.

Contract with the daemon (stdout JSON, one object):
    {
      "status": "done" | "failed",
      "output": "<concatenated assistant text>",
      "session_id": "<family session id, when one was reported>",
      "permission_required": bool,   # a dangerous op hit the permission gate
      "permission_summary": "<one line describing it>",
      "error": "<driver/agent error, when any>",
      "stop_reason": "<turn stop reason>",
      "family": "<agent family>"
    }

The daemon shapes this into the cloud result body (``buildResultSubmitBody`` in
apex-daemon.cjs) — the cloud contract lives on the Node side, mirroring how
apex-im-entry.cjs owns the cloud endpoint contract.

Permission handling: the harness's default permission callback DENIES every
request (``default_deny_permission``), so a dangerous op never runs unattended
on the user's machine. We still observe the ``permission_request`` event so the
result can carry ``permission_required`` — the cloud turns that into a Feishu
notice telling the owner to approve it on Desktop. v1 never auto-approves; there
is no code path here that allows one.
"""

from __future__ import annotations

import json
import sys
from typing import Any, Iterable

from agent.coding_agents import EventKind, harness_for
from agent.coding_agents.registry import AGENT_REGISTRY

# The families the daemon leg drives in v1 — the first-wave launchable set
# (claude / codex / cursor). ``codebuddy`` is defined-but-parked in the registry
# (launch=False) and is deliberately NOT drivable here: an unsupported family
# gets a clear "not wired" failure, never a fabricated success (hc-533 scope).
SUPPORTED_FAMILIES: tuple[str, ...] = tuple(
    sorted(spec.id for spec in AGENT_REGISTRY.values() if spec.launch)
)


def _summarize_permission(request: Any) -> str:
    """Best-effort one-line summary of a permission request, across families.

    ACP, Codex and Claude describe a permission request differently; we probe a
    small set of common human-readable keys and fall back to a truncated repr.
    Never raises — a permission notice must always be able to render.
    """
    if isinstance(request, dict):
        for key in ("title", "description", "tool_name", "tool", "name", "command", "summary"):
            value = request.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()[:200]
    text = str(request or "").strip()
    return text[:200] if text else "an operation requiring your approval"


def reduce_events(events: Iterable[Any], *, family: str) -> dict[str, Any]:
    """Fold a normalized AgentEvent stream into one flat result dict.

    Pure and deterministic — no I/O, no subprocess — so it is unit-tested
    directly against synthetic event lists. Assistant text is concatenated in
    arrival order; a permission request wins over a plain completion (the owner
    must act); the last error text is retained for the ``failed`` surface.
    """
    output_parts: list[str] = []
    session_id: str | None = None
    permission_required = False
    permission_summary = ""
    error_text = ""
    stop_reason = ""

    for event in events:
        kind = event.kind
        if kind == EventKind.SESSION_STARTED:
            session_id = event.session_id or session_id
        elif kind == EventKind.AGENT_MESSAGE:
            if event.text:
                output_parts.append(event.text)
        elif kind == EventKind.PERMISSION_REQUEST:
            permission_required = True
            summary = _summarize_permission((event.data or {}).get("request"))
            if summary:
                permission_summary = summary
        elif kind == EventKind.ERROR:
            if event.text:
                error_text = event.text  # last error wins
        elif kind == EventKind.TURN_COMPLETED:
            stop_reason = str((event.data or {}).get("stop_reason") or "")

    output = "\n".join(part for part in output_parts if part)

    if permission_required:
        status = "failed"
    elif error_text and not output:
        status = "failed"
    else:
        status = "done"

    result: dict[str, Any] = {
        "status": status,
        "output": output,
        "session_id": session_id or "",
        "permission_required": permission_required,
        "permission_summary": permission_summary,
        "error": error_text,
        "stop_reason": stop_reason,
        "family": family,
    }
    return result


def _failure(family: str, error: str, *, detail: str = "") -> dict[str, Any]:
    return {
        "status": "failed",
        "output": "",
        "session_id": "",
        "permission_required": False,
        "permission_summary": "",
        "error": error,
        "detail": detail,
        "stop_reason": "",
        "family": family,
    }


def parse_job(raw: Any) -> tuple[str, str, str | None]:
    """Validate a job payload into ``(family, prompt, cwd)``.

    Raises :class:`ValueError` with a stable, non-sensitive message on any
    malformed / unsupported input so the caller emits a clean ``failed`` result
    instead of a stack trace. The prompt is never echoed in error text.
    """
    if not isinstance(raw, dict):
        raise ValueError("job must be a JSON object")
    family = str(raw.get("family") or raw.get("agent_family") or "").strip()
    if not family:
        raise ValueError("missing agent family")
    if family not in SUPPORTED_FAMILIES:
        raise ValueError(f"unsupported agent family {family!r}")
    prompt = raw.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("missing prompt")
    cwd_raw = raw.get("cwd")
    cwd = cwd_raw.strip() if isinstance(cwd_raw, str) and cwd_raw.strip() else None
    return family, prompt, cwd


def run_job(raw: Any) -> dict[str, Any]:
    """Drive one family for one prompt and reduce its stream to a result.

    A missing binary / unlaunchable family degrades to a ``failed`` result with
    ``error="agent_not_available"`` (the harness raises ``RuntimeError`` with an
    install hint) — never a fabricated success. Any other unexpected exception
    is caught and surfaced as ``error="run_failed"`` so the daemon always gets a
    parseable line back.
    """
    try:
        family, prompt, cwd = parse_job(raw)
    except ValueError as exc:
        return _failure("", "invalid_job", detail=str(exc))

    harness = harness_for(family, cwd)
    try:
        harness.open()
        events = list(harness.prompt(prompt))
    except RuntimeError as exc:
        # Binary not on PATH / could not launch — the "该 agent 未接入" case.
        return _failure(family, "agent_not_available", detail=str(exc))
    except Exception as exc:  # never let the runner crash without a result line
        return _failure(family, "run_failed", detail=f"{type(exc).__name__}: {exc}")
    finally:
        try:
            harness.close()
        except Exception:
            pass

    return reduce_events(events, family=family)


def main(argv: list[str] | None = None) -> int:
    raw_input = sys.stdin.read()
    try:
        job = json.loads(raw_input) if raw_input.strip() else {}
    except json.JSONDecodeError as exc:
        result = _failure("", "invalid_job", detail=f"stdin is not JSON: {exc}")
    else:
        result = run_job(job)
    sys.stdout.write(json.dumps(result))
    sys.stdout.flush()
    # Exit 0 even on a "failed" result: the failure is IN the JSON body the
    # daemon parses; a non-zero exit would make the daemon treat a well-formed
    # failure the same as a crashed runner.
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
