"""hc-1223: a delete inside the session's own task folder runs without an approval card.

The record (APEX Desktop 0.17.76, 2026-11-11): a 30-second video took 87 minutes and 24 cards.
Four of them were the agent clearing its own frame folder inside the task folder before a
re-render; one deleted a folder it had made inside the user's inputs folder, which must still ask.
The folders below are laid out like that run (session folder ``~/apex-zx-test/home/cwd``, the
task's work in ``EP07-A2/_work``, the user's material in ``~/apex-zx-test/inputs``), and the
commands are the recorded ones plus the ways around the rule that must keep their card.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from agent.runtime_cwd import reset_session_cwd, set_session_cwd
from tools import approval as A
from tools import approval_context, approval_hold, approval_turn_grant
from tests.tools import _child_env_fixtures

child_env = _child_env_fixtures.child_env

SESSION = "task-folder-session"


class _Gateway:
    """The session's card surface: records each card and denies it."""

    def __init__(self):
        self.cards: list[dict] = []

    def __call__(self, data: dict) -> None:
        self.cards.append(data)
        with A._lock:
            entry = A._gateway_queues[SESSION][-1]
            entry.result = "deny"
            entry.event.set()


def _layout(home):
    task = home / "apex-zx-test" / "home" / "cwd"
    work = task / "EP07-A2" / "_work"
    (work / "panel_frames").mkdir(parents=True)
    (task / "EP07-A2" / ".git").mkdir()
    inputs = home / "apex-zx-test" / "inputs" / "参考-EP06-pacing"
    inputs.mkdir(parents=True)
    (home / "Documents").mkdir()
    (task / "EP07-A2" / "out-link").symlink_to(home / "Documents", target_is_directory=True)
    return SimpleNamespace(home=home, task=task, work=work, inputs=inputs)


@pytest.fixture
def desk(tmp_path, monkeypatch):
    """A Desktop-like gateway session whose working directory is the task folder."""
    folders = _layout(tmp_path / "home")
    monkeypatch.setenv("HOME", str(folders.home))
    monkeypatch.setenv("HERMES_GATEWAY_SESSION", "1")
    for var in ("HERMES_INTERACTIVE", "HERMES_CRON_SESSION", "HERMES_EXEC_ASK"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(approval_context, "_get_approval_mode", lambda: "manual")
    monkeypatch.setattr(A, "_YOLO_MODE_FROZEN", False)
    folders.gateway = _Gateway()
    key_token = approval_context.set_current_session_key(SESSION)
    cwd_token = set_session_cwd(str(folders.task))
    with A._lock:
        A._session_approved.pop(SESSION, None)
        A._gateway_notify_cbs[SESSION] = folders.gateway
    approval_hold.clear(SESSION)
    approval_turn_grant.revoke(SESSION)
    try:
        yield folders
    finally:
        reset_session_cwd(cwd_token)
        approval_context.reset_current_session_key(key_token)
        approval_hold.clear(SESSION)
        with A._lock:
            A._gateway_notify_cbs.pop(SESSION, None)
            A._gateway_queues.pop(SESSION, None)
            A._session_approved.pop(SESSION, None)


def _gate(desk, command: str, start: str | None, env_type: str = "local") -> dict:
    folder = None if start is None else str(getattr(desk, start))
    return A.check_all_command_guards(command.format(**vars(desk)), env_type, cwd=folder)


RUNS_WITHOUT_A_CARD = [
    # (case, command, the folder it starts in)
    ("record: rebuild the frames before each render (3 cards)",
     'cd {work} && rm -rf panel_frames && "$APEX_PYTHON" render_panel.py 2>&1 | tail -3', "task"),
    ("record: clear the frames after checking the cut",
     "cd {task}/EP07-A2 && ffmpeg -v error -ss 6 -i EP07-成片.mp4 -frames:v 1 _work/预览牌.png -y && "
     "du -sh _work/panel_frames && rm -rf _work/panel_frames && du -sh . && ls", "task"),
    ("relative to where the command starts", "rm -rf panel_frames", "work"),
    ("quoted, after --, with a null redirect", 'rm -rf -- "EP07-A2/_work/panel_frames" 2>/dev/null', "task"),
    ("absolute path from elsewhere", "rm -r {work}/panel_frames", "home"),
    ("cd into the folder first", "cd {work} && rm -rf panel_frames", "home"),
]


@pytest.mark.parametrize(("case", "command", "start"), RUNS_WITHOUT_A_CARD, ids=[row[0] for row in RUNS_WITHOUT_A_CARD])
def test_delete_inside_the_task_folder_runs_without_a_card(desk, case, command, start):
    result = _gate(desk, command, start)
    assert result["approved"] is True and desk.gateway.cards == [], case
    assert [entry["scope"] for entry in result["pre_approved"]] == ["task_folder"]  # the run says why


STILL_ASKS = [
    ("record: a folder it made in the user's inputs folder",
     'cd {task}/EP07-A2 && mv EP07-成片-pacing _work/ 2>/dev/null; rm -rf {inputs}; ls -la; echo "---"; '
     "head -12 字幕.srt", "task"),
    ("home folder", "rm -rf ~/x", "task"),
    ("parent folder", "rm -rf ../x", "task"),
    ("a symlink that points outside", "rm -rf EP07-A2/out-link", "task"),
    ("through that symlink", "rm -rf EP07-A2/out-link/", "task"),
    ("cd somewhere else first", "cd /tmp && rm -rf x", "task"),
    ("the task folder itself", "rm -rf {task}", "task"),
    ("version control data", "rm -rf EP07-A2/.git", "task"),
    ("a link made earlier in the same command", "ln -s ~ l && rm -rf l/Documents", "task"),
    ("a glob", "rm -rf EP07-A2/*", "task"),
    ("a variable", "rm -rf $TARGET", "task"),
    ("a cd that may not have run (;)", "cd {work}; rm -rf panel_frames", "home"),
    ("a subshell", "(cd {work} && rm -rf panel_frames)", "home"),
    ("command substitution", "rm -rf $(echo panel_frames)", "work"),
    ("sudo", "sudo rm -rf panel_frames", "work"),
    ("an unknown option", "rm -rf --no-preserve-root panel_frames", "work"),
    ("an in-folder delete next to another finding", "rm -rf panel_frames && chmod -R 777 /tmp/x", "work"),
    ("no start folder known", "rm -rf panel_frames", None),
]


@pytest.mark.parametrize(("case", "command", "start"), STILL_ASKS, ids=[row[0] for row in STILL_ASKS])
def test_any_other_delete_still_asks(desk, case, command, start):
    result = _gate(desk, command, start)
    assert result["approved"] is False and len(desk.gateway.cards) == 1, case


def test_next_finding_is_the_one_the_card_names(desk):
    """With the in-folder delete set aside, the card asks about what is left."""
    _gate(desk, "rm -rf panel_frames && chmod -R 777 /tmp/x", "work")
    assert "permission" in desk.gateway.cards[0]["description"]


def test_a_catastrophic_delete_is_still_blocked(desk):
    result = _gate(desk, "rm -rf /", "task")
    assert result["approved"] is False and desk.gateway.cards == []


def test_only_the_local_backend(desk):
    result = _gate(desk, "rm -rf panel_frames", "work", env_type="ssh")
    assert result["approved"] is False and len(desk.gateway.cards) == 1


@pytest.mark.parametrize("where", ["the home folder", "a top-level folder in home", "an assistant's profile home"])
def test_no_task_folder_when_the_session_works_somewhere_broad(desk, monkeypatch, where):
    """The Desktop default works in the home folder and an assistant in its profile home: neither is
    a task folder, so a delete there asks as before."""
    profile_home = desk.home / ".apexnodes" / "profiles" / "apex-bot-2"
    profile_home.mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(profile_home))
    session_folder = {"the home folder": desk.home, "a top-level folder in home": desk.home / "Documents",
                      "an assistant's profile home": profile_home}[where]
    (session_folder / "old").mkdir()
    token = set_session_cwd(str(session_folder))
    try:
        result = A.check_all_command_guards("rm -rf old", "local", cwd=str(session_folder))
    finally:
        reset_session_cwd(token)
    assert result["approved"] is False and len(desk.gateway.cards) == 1


@pytest.mark.platforms("posix")
def test_terminal_tool_passes_its_start_folder(child_env, monkeypatch):
    """The real terminal tool: the in-folder delete runs and removes the folder; the inputs-folder
    delete asks, is refused, and nothing outside is touched."""
    from tools import terminal_tool as tt
    from tools.terminal_tool_lifecycle import cleanup_vm

    folders = _layout(child_env)
    gateway = _Gateway()
    monkeypatch.setenv("HERMES_GATEWAY_SESSION", "1")
    monkeypatch.setenv("TERMINAL_CWD", str(folders.task))
    monkeypatch.setattr(approval_context, "_get_approval_mode", lambda: "manual")
    key_token = approval_context.set_current_session_key(SESSION)
    with A._lock:
        A._gateway_notify_cbs[SESSION] = gateway
    try:
        ran = json.loads(tt.terminal_tool(
            command=f"cd {folders.work} && rm -rf panel_frames && echo rebuilt", task_id="hc1223-e2e"))
        refused = json.loads(tt.terminal_tool(command=f"rm -rf {folders.inputs}", task_id="hc1223-e2e"))
    finally:
        cleanup_vm("hc1223-e2e")
        approval_context.reset_current_session_key(key_token)
        with A._lock:
            A._gateway_notify_cbs.pop(SESSION, None)
            A._gateway_queues.pop(SESSION, None)
    assert ran["exit_code"] == 0 and "rebuilt" in ran["output"], ran
    assert not (folders.work / "panel_frames").exists()
    assert refused["status"] == "blocked" and folders.inputs.is_dir()
    assert [card["command"] for card in gateway.cards] == [f"rm -rf {folders.inputs}"]
