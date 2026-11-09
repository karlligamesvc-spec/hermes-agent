"""hc-1195: the hc-1036 evidence guard for files a code-running tool writes under skills/ and memories/.

``terminal``, ``execute_code``, ``process_manage`` (``write`` / ``submit`` feed a running process, ``wait``
lets it run) and ``browser_exec`` (full Python) can write any file, and their arguments do not say which
(apex-nodes #1098 exit table, row 20). So around each such call:

1. ``pre_tool_call``: snapshot both trees (``durable_files.take``: stat only, cached bytes).
2. After the call, in whichever hook runs first: ``transform_tool_result`` (it can still change the
   result) or ``post_tool_call`` (the only one left when the tool raised or the executor gave up on it).
   List what changed, run the hc-1036 check (``evidence_problems`` from ``__init__.py``, unchanged) on
   the lines this call added, and undo every change in each skill directory (or memory file) that fails.
3. The result then starts with the words a refused ``skill_manage`` gets, which files were undone, and
   the lines (file and line number). A message that cannot ride on its own result (the tool raised, the
   call timed out) rides on the session's next tool result, or else on the next turn's context.

Lines already in a file before the call are never judged: old skills stay as they are. Two calls open at
once (two chats, sub-agents, a script's own terminal call inside execute_code) share one lock for taking,
checking and undoing; an undo is told to every call still open and rebased into their snapshots, so
none of them can mistake it for its own edit and put the refused lines back.
"""

from __future__ import annotations

import importlib.util
import json
import logging
import threading
from pathlib import Path
from typing import Any, Callable

logger = logging.getLogger(__name__)

TOOLS = {  # "process" is the legacy name of process_manage
    "terminal": "终端命令", "execute_code": "代码", "process_manage": "后台进程", "process": "后台进程", "browser_exec": "浏览器脚本",
}
LATE_STATUSES = frozenset({"timeout", "cancelled"})  # the executor gave up; the worker may still be writing
UNDONE = {"created": "新建的，已删掉", "modified": "已恢复成运行前的样子", "removed": "这次删掉的，已恢复"}
EARLIER = "补一句先前的事："
MAX_WINDOWS = 64
MAX_SESSIONS = 512
MAX_LINES = 6


def _sibling(name: str):
    spec = importlib.util.spec_from_file_location(f"{__name__}_{name}", Path(__file__).with_name(f"{name}.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


durable_files = _sibling("durable_files")


def call_key(args: dict, session_id: str, task_id: str, tool_call_id: str, tool_name: str) -> tuple:
    """One call's identity across the three hooks, which run on different threads. A sandbox script's own
    calls carry no tool_call_id; their arguments name them."""
    if tool_call_id:
        return (session_id, task_id, tool_call_id)
    return (session_id, task_id, tool_name, json.dumps(args, sort_keys=True, ensure_ascii=False, default=str))


def with_notices(result: str, own: list[str], earlier: list[str]) -> str:
    """Messages in front of a JSON result (this call's as its ``error``, earlier calls' beside it), else before the text."""
    try:
        data = json.loads(result)
    except ValueError:
        data = None
    if not isinstance(data, dict):
        return "\n\n".join([*own, *earlier, result])
    front: dict[str, Any] = {}
    if own:
        front["error"] = "\n\n".join([*own, *([str(data["error"])] if data.get("error") else [])])
    if earlier:
        front["earlier_write_check"] = "\n\n".join(earlier)
    return json.dumps({**front, **{k: v for k, v in data.items() if k not in front}}, ensure_ascii=False)


class ExecWrites:
    """The calls still open (``windows``) and the messages a session is still owed (``undelivered``)."""

    def __init__(
        self,
        evidence_problems: Callable[[str, set[str]], list[tuple[str, str]]],
        evidence_block_message: Callable[[list[tuple[str, str]], set[str]], str],
        guard_sessions: dict[str, dict[str, Any]],
        guard_lock: threading.Lock,
        disabled: Callable[[], bool],
    ):
        self.evidence_problems = evidence_problems
        self.evidence_block_message = evidence_block_message
        self.guard_sessions = guard_sessions
        self.guard_lock = guard_lock
        self.disabled = disabled
        self.lock = threading.Lock()
        self.windows: dict[tuple, list[dict[str, Any]]] = {}
        self.undelivered: dict[str, list[tuple[tuple | None, str]]] = {}

    # -- windows ------------------------------------------------------------------------------------

    def open(self, key: tuple, session_id: str, *, late: bool = False) -> None:
        home = durable_files.home_from_runtime()
        if home is None:
            return
        with self.lock:
            try:
                snapshot = durable_files.take(home)
            except Exception:
                logger.warning("hc-1195: no snapshot of %s; this call's writes are not checked", home, exc_info=True)
                return
            self.windows.setdefault(key, []).append({"snapshot": snapshot, "session": session_id, "notices": [], "late": late})
            while sum(len(windows) for windows in self.windows.values()) > MAX_WINDOWS:
                oldest = next(iter(self.windows))
                self.windows[oldest].pop(0)
                if not self.windows[oldest]:
                    del self.windows[oldest]

    def _opened(self, sessions: set[str]) -> set[str]:
        with self.guard_lock:
            return set().union(*(self.guard_sessions[s]["pages"] for s in sessions if s in self.guard_sessions))

    def _problems(self, change: Any, moved: set[str], opened: set[str]) -> list[tuple[str, int, str]]:
        """(kind, line number, line) for the added lines the hc-1036 check refuses. The check reads the whole
        new text (a legend anywhere makes ✅ mean 官方); its verdict on a line depends only on that line."""
        added = durable_files.added_lines(change, moved) if change.new_text else set()
        if not added:
            return []
        kinds = {line: kind for kind, line in self.evidence_problems(change.new_text, opened)}
        numbered = enumerate(change.new_text.splitlines(), 1)
        return [(kinds[line.strip()], no, line.strip()) for no, line in numbered if no in added and line.strip() in kinds]

    def _check(self, window: dict[str, Any]) -> dict[str, Any] | None:
        """Judge what this window's call added; undo the failing units (caller holds ``self.lock``)."""
        snapshot = window["snapshot"]
        found, new_dirs = durable_files.changes(snapshot)
        if not found:
            return None
        # Whoever has a call open may have written these files, so the pages any of them opened count.
        opened = self._opened({window["session"]} | {w["session"] for ws in self.windows.values() for w in ws})
        moved = durable_files.moved_lines(found)
        problems = {change.path: hits for change in found if (hits := self._problems(change, moved, opened))}
        if not problems:
            return None
        undone = durable_files.revert(snapshot, found, new_dirs, set(problems))
        record = {
            "opened": opened,
            "undone": undone,
            "problems": [(kind, snapshot.rel(path), no, line) for path in sorted(problems) for kind, no, line in problems[path]],
        }
        for windows in self.windows.values():
            for other in windows:
                if other["snapshot"].home == snapshot.home:
                    durable_files.rebase(other["snapshot"], [item["path"] for item in undone])
                    other["notices"].append(record)
        return record

    def settle(self, key: tuple, label: str) -> tuple[str | None, bool]:
        """Close this call's oldest open window → (message for the assistant or None, whether it was abandoned)."""
        with self.lock:
            windows = self.windows.get(key)
            if not windows:
                return None, False
            window = windows.pop(0)
            if not windows:
                del self.windows[key]
            if self.disabled():
                return None, window["late"]
            try:
                record = self._check(window)
            except Exception:
                logger.warning("hc-1195: could not check what this call wrote", exc_info=True)
                record = None
            records = ([record] if record else []) + window["notices"]
        return (self.message(label, records) if records else None), window["late"]

    def message(self, label: str, records: list[dict[str, Any]]) -> str:
        problems = [problem for record in records for problem in record["problems"]]
        opened = set().union(*(record["opened"] for record in records))
        # The why and the how are exactly what a refused skill_manage says (hc-1036 evidence_block_message).
        refusal = self.evidence_block_message([(kind, line) for kind, _rel, _no, line in problems], opened)
        advice = refusal.split("\n有问题的行：")[0].split("\n")[1:]
        files = [
            f"- {item['rel']}({UNDONE[item['kind']] if item['ok'] else '没能撤回，请自己改掉下面那几行'})"
            for record in records for item in record["undone"]
        ]
        shown = [f"- {rel} 第 {no} 行：{line.lstrip('-*•# ')[:80]}" for _, rel, no, line in problems[:MAX_LINES]]
        if len(problems) > MAX_LINES:
            shown.append(f"- ……还有 {len(problems) - MAX_LINES} 行")
        head = f"没存：这次{label}运行期间写进技能或记忆文件的内容里，有资料的证据等级写高了，这些改动已撤回(其他结果照常):"
        return "\n".join([head, *files, *advice, "有问题的行：", *shown])

    # -- messages that missed their own result ----------------------------------------------------------

    def queue(self, session_id: str, key: tuple | None, message: str) -> None:
        with self.lock:
            queued = self.undelivered.pop(session_id, [])
            queued.append((key, message))
            self.undelivered[session_id] = queued[-MAX_LINES:]
            while len(self.undelivered) > MAX_SESSIONS:
                self.undelivered.pop(next(iter(self.undelivered)))

    def take(self, session_id: str, key: tuple | None) -> tuple[list[str], list[str]]:
        """→ (this call's own messages, earlier calls' messages) still owed to the session."""
        if session_id not in self.undelivered:
            return [], []
        with self.lock:
            queued = self.undelivered.pop(session_id, [])
        own = [message for queued_key, message in queued if key is not None and queued_key == key]
        earlier = [EARLIER + message for queued_key, message in queued if key is None or queued_key != key]
        return own, earlier

    # -- hooks --------------------------------------------------------------------------------------------

    def before(self, tool_name: str = "", args: Any = None, session_id: str = "", task_id: str = "", tool_call_id: str = "", **_: Any) -> None:
        if tool_name in TOOLS and isinstance(args, dict) and not self.disabled():
            self.open(call_key(args, session_id or "", task_id or "", tool_call_id or "", tool_name), session_id or "")

    def after(
        self, tool_name: str = "", args: Any = None, status: Any = None, session_id: str = "", task_id: str = "",
        tool_call_id: str = "", **_: Any,
    ) -> None:
        """Normally ``transform`` already settled the call. Not when the tool raised or the executor gave up:
        then settle here, and on a give-up keep watching, since the abandoned worker may still write."""
        if tool_name not in TOOLS or not isinstance(args, dict):
            return
        session = session_id or ""
        key = call_key(args, session, task_id or "", tool_call_id or "", tool_name)
        message, _late = self.settle(key, TOOLS[tool_name])
        late = status in LATE_STATUSES
        if late and not self.disabled():
            self.open(key, session, late=True)
        if message:
            self.queue(session, None if late else key, message)

    def transform(
        self, tool_name: str = "", args: Any = None, result: Any = None, session_id: str = "", task_id: str = "",
        tool_call_id: str = "", **_: Any,
    ) -> str | None:
        session = session_id or ""
        key = None
        if tool_name in TOOLS and isinstance(args, dict):
            key = call_key(args, session, task_id or "", tool_call_id or "", tool_name)
            message, late = self.settle(key, TOOLS[tool_name])
            if late:  # an abandoned worker finished: nobody reads this result
                if message:
                    self.queue(session, None, message)
                return None
            if message:
                self.queue(session, key, message)
        if not isinstance(result, str):
            return None
        own, earlier = self.take(session, key)
        return with_notices(result, own, earlier) if own or earlier else None

    def next_turn(self, session_id: str = "", **_: Any) -> dict | None:
        own, earlier = self.take(session_id or "", None)
        return {"context": "\n\n".join(own + earlier)} if own or earlier else None


def register(ctx: Any, evidence_problems, evidence_block_message, guard_sessions, guard_lock, disabled) -> ExecWrites:
    guard = ExecWrites(evidence_problems, evidence_block_message, guard_sessions, guard_lock, disabled)
    ctx.register_hook("pre_tool_call", guard.before)
    ctx.register_hook("post_tool_call", guard.after)
    ctx.register_hook("transform_tool_result", guard.transform)
    ctx.register_hook("pre_llm_call", guard.next_turn)
    return guard
