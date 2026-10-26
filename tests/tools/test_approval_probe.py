"""hc-1034: whole-command read-only probes skip the approval prompt; nothing else does.

On an APEX Desktop with manual approvals, ``python3 -c "import PIL"`` waited five minutes for a
click and came back BLOCKED, three times in one user's records. ``tools.approval_probe`` lets
exactly that probe shape through (and an execute_code script made of the same statements); these
tables pin both sides of the allowlist: what passes, and that every shell or Python construct
outside it still reaches the gate.
"""

from __future__ import annotations

import pytest

from tools import approval as A
from tools import approval_context
from tools.approval_detection import detect_dangerous_command
from tools.approval_probe import is_probe_script, is_readonly_probe, probe_code_from_command

PROBES = [
    'python3 -c "import PIL"',
    # The probe from the 2026-10-22 record, on its own line.
    'python3 -c "import PIL, sys; print(\'PIL\', PIL.__version__)"',
    "python3 -c 'import numpy; print(numpy.__version__)'",
    'python -c "import cv2"',
    "python3.12 -c 'import moviepy'",
    '/usr/bin/python3 -I -s -c "import PIL"',
    "python3 -c 'from PIL import Image; print(Image.__file__)'",
    "python3 -c 'import importlib.util; print(importlib.util.find_spec(\"cv2\"))'",
    "python3 -c 'import importlib.metadata; print(importlib.metadata.version(\"pillow\"))'",
    "python3 -c 'import shutil; print(shutil.which(\"ffmpeg\"))'",
    "python3 -c 'import sys; print(sys.version, sys.executable)'",
    "python3 -c 'import platform; print(platform.python_version(), platform.machine())'",
    "python3 -c 'import PIL; print(f\"PIL {PIL.__version__}\")'",
    "python3 -c 'import PIL; print(getattr(PIL, \"__version__\", \"?\"))'",
    "python3 -c 'import PIL; print(PIL.__version__, sep=\"\", end=\"\\n\")'",
]


@pytest.mark.parametrize("command", PROBES)
def test_whole_command_probe_is_not_flagged(command):
    assert is_readonly_probe(command)
    assert detect_dangerous_command(command) == (False, None, None)


# (command, what keeps it on the normal path)
NOT_PROBES = [
    ('python3 -c "import PIL" 2>&1', "redirect stderr to stdout"),
    ('python3 -c "import PIL" 2>/dev/null', "redirect to /dev/null"),
    ('python3 -c "import PIL" > ~/.zshrc', "redirect writes a file"),
    ('python3 -c "import PIL" | tail -1', "pipe"),
    ('python3 -c "print(1)" | sh', "pipe into a shell"),
    ('python3 -c "import PIL"; rm -rf build', "; separator"),
    ('python3 -c "import PIL" && rm -rf build', "&& separator"),
    ('python3 -c "import PIL" || rm -rf build', "|| separator"),
    ('python3 -c "import PIL" &', "background"),
    ('(python3 -c "import PIL")', "subshell"),
    ('python3 -c "$(cat payload)"', "command substitution"),
    ('python3 -c "`cat payload`"', "backtick substitution"),
    ('python3 -c "import $MOD"', "parameter expansion"),
    # Valid probe code once shlex has split it, but the shell would still run something:
    ('python3 -c "import PIL; print(\'$(rm -rf build)\')"', "command substitution inside valid code"),
    ('python3 -c "import PIL; print(\'`rm -rf build`\')"', "backticks inside valid code"),
    ('python3 -c "import PIL";print(PIL)', "; glued to the quoted code"),
    ('python3 -c "import PIL" # note', "comment"),
    ('PYTHONPATH=/tmp/x python3 -c "import PIL"', "env assignment"),
    ('env python3 -c "import PIL"', "wrapper"),
    ('./python3 -c "import PIL"', "relative interpreter path"),
    ('python3 -c "import PIL" extra-arg', "argument after the code"),
    ('python3 -W ignore -c "import PIL"', "flag outside the allowlist"),
    ('python3 -m pip show pillow', "-m instead of -c"),
    ("python3 -c 'import PIL''; import os'", "spliced quotes"),
    ('python3 -c "import PIL"\nrm -rf build', "newline separator"),
    ('node -e "require(\'sharp\')"', "not python"),
    # Code outside the probe grammar:
    ('python3 -c "print(1)"', "no import: nothing to probe"),
    ('python3 -c "import os; os.system(\'rm -rf build\')"', "arbitrary call: os.system"),
    ('python3 -c "import subprocess; subprocess.run([\'ls\'])"', "arbitrary call: subprocess.run"),
    ('python3 -c "print(open(\'/etc/passwd\').read())"', "builtin call"),
    ('python3 -c "import shutil; shutil.rmtree(\'build\')"', "write call on an allowed module"),
    ('python3 -c "import shutil; print(shutil.which(name))"', "non-constant argument"),
    ('python3 -c "import PIL; x = 1"', "assignment"),
    ('python3 -c "import PIL as p"', "import alias"),
    ('python3 -c "from os import system as print; print(\'x\')"', "alias shadowing print"),
    ('python3 -c "from evil import print; print(\'x\')"', "from-import shadowing print"),
    # Rebinding a call root after a real import: only the reserved-name check stops this one.
    ('python3 -c "import shutil; from evil import shutil; print(shutil.which(\'x\'))"', "from-import shadowing a call root"),
    ('python3 -c "from os import *"', "star import"),
    ('python3 -c "from . import x"', "relative import"),
    ('python3 -c "import antigravity"', "import opens a browser"),
    ('python3 -c "import idlelib.idle"', "import opens a window"),
    ('python3 -c "import tkinter.__main__"', "__main__ module"),
    ('python3 -c "import sys; print(sys.modules.__class__)"', "dunder attribute"),
    ('python3 -c "import sys; print(sys._getframe)"', "private attribute"),
    ('python3 -c "import sys; print(sys.argv[0])"', "subscript"),
    ('python3 -c "import sys; print(sys.version + \'x\')"', "operator"),
    ('python3 -c "import PIL; print(*PIL.__all__)"', "star argument"),
    ('python3 -c "import PIL; print(PIL, file=open(\'x\', \'w\'))"', "print keyword"),
    ('python3 -c "try:\n    import PIL\nfinally:\n    pass"', "try/finally"),
    ('python3 -c "import PIL; (lambda: 0)()"', "lambda"),
    ('python3 -c "import PIL\ndef f(): pass"', "function definition"),
    ('python3 -c ""', "empty code"),
    ('python3 -c "import PIL("', "syntax error"),
]


@pytest.mark.parametrize(("command", "why"), NOT_PROBES, ids=[why for _, why in NOT_PROBES])
def test_anything_else_is_not_a_probe(command, why):
    assert not is_readonly_probe(command), why


@pytest.mark.parametrize(
    "command",
    ['python3 -c "import PIL" 2>&1 | tail -1', 'python3 -c "import os; os.remove(\'x\')"',
     'python3 -c "import PIL"; ls', 'python3 -c "import PIL" > out.txt'],
)
def test_a_non_probe_python_c_still_reaches_the_gate(command):
    dangerous, _, description = detect_dangerous_command(command)
    assert dangerous and description == "script execution via -e/-c flag"


def test_the_compound_probe_from_the_record_still_asks():
    """The 10-22 line bundled the probe with ``;``, ``||``, pipes and redirects; it stays gated,
    which is why the Desktop prompt section asks for one simple command per check."""
    line = ("for c in ffmpeg ffprobe; do printf \"%s: \" $c; command -v $c || echo MISSING; done; "
            "which python3; python3 -c \"import PIL, sys; print('PIL', PIL.__version__)\" 2>&1 | tail -1")
    assert probe_code_from_command(line) is None
    assert detect_dangerous_command(line)[0] is True


def test_code_and_command_limits():
    long_code = "import PIL\n" * 41
    assert not is_probe_script(long_code)  # more than 40 statements
    assert not is_readonly_probe("python3 -c '" + "import PIL;" * 120 + "'")  # longer than the command cap


PROBE_SCRIPTS = [
    "import shutil, sys\nprint('ffmpeg:', shutil.which('ffmpeg'))\nprint('python:', sys.executable, sys.version)",
    "try:\n    import PIL\n    print('PIL', PIL.__version__)\nexcept ImportError as e:\n    print('PIL missing', e)",
    "try:\n    import cv2\nexcept (ImportError, ModuleNotFoundError):\n    print('cv2 missing')\nelse:\n    print(cv2.__version__)",
]


@pytest.mark.parametrize("code", PROBE_SCRIPTS)
def test_probe_scripts(code):
    assert is_probe_script(code)


def test_the_execute_code_script_from_the_record_is_not_a_probe():
    """#748 looped over module names with ``__import__``: dynamic imports stay on the normal path."""
    code = ("import shutil, sys, os, glob\nprint('ffmpeg:', shutil.which('ffmpeg'))\n"
            "for m in ['PIL', 'moviepy', 'numpy', 'cv2']:\n    try:\n        mod = __import__(m)\n"
            "        print(m, 'OK', getattr(mod, '__version__', '?'))\n    except Exception as e:\n"
            "        print(m, 'MISSING', e)\n")
    assert not is_probe_script(code)


@pytest.fixture
def gateway_session(monkeypatch):
    """A gateway session in manual mode whose notifier records every approval card."""
    monkeypatch.setenv("HERMES_GATEWAY_SESSION", "1")
    for var in ("HERMES_INTERACTIVE", "HERMES_CRON_SESSION", "HERMES_EXEC_ASK"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(approval_context, "_get_approval_mode", lambda: "manual")
    monkeypatch.setattr(approval_context, "_get_approval_timeout", lambda: 0)
    monkeypatch.setattr(A, "_YOLO_MODE_FROZEN", False)
    session_key = "probe-test-session"
    token = approval_context.set_current_session_key(session_key)
    cards: list[dict] = []
    with A._lock:
        A._permanent_approved.clear()
        A._session_approved.pop(session_key, None)
        A._gateway_notify_cbs[session_key] = cards.append
    try:
        yield cards
    finally:
        approval_context.reset_current_session_key(token)
        with A._lock:
            A._gateway_notify_cbs.pop(session_key, None)
            A._gateway_queues.pop(session_key, None)


def test_terminal_probe_runs_without_a_card(gateway_session):
    result = A.check_all_command_guards('python3 -c "import PIL; print(PIL.__version__)"', "local")
    assert result["approved"] is True and gateway_session == []
    blocked = A.check_all_command_guards('python3 -c "import os; print(os.listdir())"', "local")
    assert blocked["approved"] is False and blocked["outcome"] == "timeout" and len(gateway_session) == 1


def test_execute_code_probe_runs_without_a_card(gateway_session):
    assert A.check_execute_code_guard(PROBE_SCRIPTS[0], "local")["approved"] is True
    assert gateway_session == []
    other = A.check_execute_code_guard("import os\nos.remove('x')", "local")
    assert other["approved"] is False and len(gateway_session) == 1
