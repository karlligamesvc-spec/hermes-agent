"""Hold equivalent operations after a denied or unanswered approval (hc-1034).

Every BLOCKED result tells the model not to retry, rephrase, or reach the same outcome another
way, and models still do it. On an APEX Desktop a timed-out ``python3 -c`` probe came back seconds
later as an execute_code script (which waited five more minutes), and the next blocked step as a
shell command without ``-c``. This module turns that instruction into gate behaviour for the rest
of the turn, in the three gates of :mod:`tools.approval` and in model_tools' pre-dispatch guards.

What is held: anything the gates would ask about anyway, plus the ways to run code that today
need no approval: execute_code, a terminal command that starts an interpreter, shell, runner or
script file (``python3 x.py``, ``bash x.sh``, ``./run``, ``npx``, ``uv run`` ...; see
:func:`runs_code`), browser_exec, and input written to a running process. Read-only probes
(:mod:`tools.approval_probe`) and ordinary commands (``ls``, ``command -v ffmpeg``) are not held.
:func:`runs_code` is a heuristic over command words, a second line behind the BLOCKED text: a
spelling it does not know (``awk 'BEGIN{system(...)}'``) is not held.

How it is held:
- unanswered (timed out, not delivered, withdrawn): held operations stop at once with a BLOCKED
  result and no new prompt; another prompt would wait the whole window again for someone who is
  not there.
- denied: held operations ask again, also ones that normally run without asking and ones whose
  pattern was approved for the session, and the smart-approval guardian is skipped so a human
  answers.

How long: until a human grants an approval in the session, the session is cleared, or the
conversation's next turn starts. A hold is stamped with the turn id model_tools binds for each
dispatch; a delegated child shares its parent's approval session key, sees the parent's hold
whatever its own turn id, and stamps the holds it records for the parent's turn to adopt. Calls
with no turn id (direct library use, tests) neither record nor see holds.
"""

from __future__ import annotations

import os
import threading
from dataclasses import dataclass

from tools import approval_context

PATTERN_KEY = "approval_hold:code"
DESCRIPTION = "runs code or a script after a declined approval in this turn, so asking again"
_UNANSWERED_OUTCOMES = frozenset({"timeout", "notify_failed", "cancelled"})
_MAX_SESSIONS = 256
_TARGET_CHARS = 160

# Commands that run code from a file, stdin or the network rather than doing one fixed job.
_RUNNER_NAMES = frozenset({
    "uv", "uvx", "pipx", "npx", "pnpx", "bunx", "npm", "pnpm", "yarn", "make", "just", "osascript", "swift",
    "go", "cargo", "java", "rscript", "lua", "luajit", "tclsh", "expect", "xargs", "fish", "csh", "tcsh",
})
_SYSTEM_BIN_DIRS = ("/bin/", "/sbin/", "/usr/bin/", "/usr/sbin/", "/usr/local/bin/", "/opt/homebrew/bin/")
_INFO_ONLY_ARGS = frozenset({"--version", "-version", "-V", "-VV", "-v", "--help", "-h", "version"})
# Tool calls that run code without passing a gate: name -> how to show the call on a prompt.
_CODE_TOOLS = {
    "browser_exec": lambda args: f"browser_exec <<'PY'\n{args.get('code', '')}\nPY",
    "process_manage": lambda args: (f"process_manage {args.get('action')} {args.get('session_id', '')}: "
                                    f"{args.get('data', '')}" if args.get("action") in ("write", "submit") else None),
}


@dataclass
class _Hold:
    outcome: str        # "denied" | "unanswered"
    turn: str | None    # None: recorded by a delegated child, adopted by the parent's next check
    noun: str           # command | code | action
    target: str         # redacted one-line label of what was refused

    @property
    def unanswered(self) -> bool:
        return self.outcome == "unanswered"


_lock = threading.Lock()
_holds: dict[str, _Hold] = {}


def _in_child() -> bool:
    from agent.delegation_context import is_delegated_child_context
    return is_delegated_child_context()


def active(session_key: str) -> _Hold | None:
    """The hold that applies to the current call in *session_key*, if any."""
    turn = approval_context._approval_turn_id.get()
    child = _in_child()
    with _lock:
        hold = _holds.get(session_key)
        if hold is None or child:
            return hold
        if not turn:
            return None
        if hold.turn is None:
            hold.turn = turn
        elif hold.turn != turn:
            _holds.pop(session_key, None)
            return None
        return hold


def clear(session_key: str) -> None:
    with _lock:
        _holds.pop(session_key, None)


def _label(target: str) -> str:
    from agent.redact import redact_sensitive_text
    line = " ".join(redact_sensitive_text(str(target)).split())
    return line if len(line) <= _TARGET_CHARS else line[:_TARGET_CHARS - 1] + "…"


def observe(session_key: str, result: dict, *, noun: str, target: str) -> None:
    """Record or clear a hold from one human-gate result (the shape ``_denied`` / grants return)."""
    if result.get("approved"):
        if not result.get("smart_approved"):
            clear(session_key)  # a human granted something: they are present and deciding again
        return
    outcome = str(result.get("outcome") or "")
    if result.get("user_consent") is not False or not outcome:
        return  # pending, smart-guardian or unattended results are not a human's answer
    kind = "denied" if outcome == "denied" else "unanswered"
    if kind == "unanswered" and outcome not in _UNANSWERED_OUTCOMES and not outcome.startswith("transport_"):
        return
    turn = None if _in_child() else approval_context._approval_turn_id.get()
    if turn == "":
        return
    with _lock:
        _holds.pop(session_key, None)
        _holds[session_key] = _Hold(kind, turn, noun, _label(target))
        while len(_holds) > _MAX_SESSIONS:
            _holds.pop(next(iter(_holds)))


def held_message(hold: _Hold) -> str:
    """Model-facing text for an operation stopped by an unanswered hold."""
    return (
        f"BLOCKED: not run. An approval request earlier in this turn ({hold.target}) got no answer, so "
        "until the user replies nothing else that needs approval or runs code will run in this turn. "
        "Do NOT retry, rephrase, or reach the same result through another tool, script or command. "
        "Do only the steps that need neither; then tell the user in plain words which step is waiting "
        "for their approval and why, and that you will continue once they reply."
    )


def code_tool_target(tool_name: str, args: dict) -> str | None:
    """Prompt label when this tool call runs code outside the command/code gates, else None."""
    render = _CODE_TOOLS.get(tool_name)
    return render(args if isinstance(args, dict) else {}) if render else None


def runs_code(command: str) -> bool:
    """True when *command* starts an interpreter, shell, runner or script file anywhere in it."""
    from tools import approval_detection as det
    from tools.approval_probe import is_readonly_probe

    if is_readonly_probe(command):
        return False
    normalized = det._normalize_command_for_detection(command)
    for start, _, word in det._iter_shell_command_word_spans(normalized):
        executable = det._deobfuscate_shell_word_for_detection(word)
        name = os.path.basename(executable).lower()
        is_runner = (det._interpreter_family(executable) is not None or name in det._SHELL_NAMES
                     or name in det._SHELL_CARRIER_NAMES or name in _RUNNER_NAMES
                     or ("/" in executable and not executable.startswith(_SYSTEM_BIN_DIRS)))
        if not is_runner:
            continue
        tokens = det._shell_segment_tokens(det._shell_command_segment(normalized, start), 0)
        args = tokens[1:] if tokens else None
        if not args or not set(args) <= _INFO_ONLY_ARGS:
            return True
    return False
