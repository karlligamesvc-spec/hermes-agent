"""hc-1195: what one code-running tool call changed under skills/ and memories/, and how to take it back.

Mechanics only. The evidence rules stay in ``__init__.py`` (hc-1036); this file never judges content.
The plugin takes a ``Snapshot`` before ``terminal`` / ``execute_code`` / ``process_manage`` /
``browser_exec`` run, lists the ``changes`` afterwards, and ``revert`` puts back the files it names.

Which files: every regular file under ``<HERMES_HOME>/skills`` and ``<HERMES_HOME>/memories``, except
names starting with ``.`` (locks, manifests, the skills hub cache), symlinks, and the skill trees the
platform owns: APEX Desktop syncs its platform skills into ``skills/apexnodes/``, a cloud agent's
platform skills are the names in ``skills/.apexnodes_platform_manifest``. A platform sync can land in
the middle of a tool call, and several platform skills spell out the very phrases the rules refuse
(「直连抖音」 in honesty-verification), so their writes must never be read as the assistant's.

Cost (measured 2026-11-08 on a real APEX Desktop home, Apple-silicon Mac: 1,027 files under skills/,
523 of them in ``apexnodes/``, so 504 watched):

* Every call: one ``os.scandir`` walk of each tree before the call (``take``, 3.4 ms) and one after
  (``changes``, 3.4 ms), stat only.
* Old bytes: to undo an edit the old bytes must exist before the call. A process-wide cache keeps each
  file's bytes, zlib-compressed, keyed by its stat (mtime, ctime, size); a file is read only when its
  stat differs from the cached one, so after the first call per home only files changed since the
  last call are read. The first call per process and home reads the trees once (110 ms) and the cache
  then holds 2.4 MB.
* Caps: files over ``MAX_FILE_BYTES`` are listed but not cached or checked; the cache stops growing at
  ``MAX_CACHE_BYTES`` compressed; a walk stops at ``MAX_FILES`` files.
"""

from __future__ import annotations

import logging
import os
import threading
import time
import zlib
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

MAX_FILE_BYTES = 256 * 1024
MAX_CACHE_BYTES = 32 * 1024 * 1024
MAX_FILES = 20_000
PLATFORM_CATEGORY = "apexnodes"  # APEX Desktop: <skills>/apexnodes/<name>/
PLATFORM_MANIFEST = ".apexnodes_platform_manifest"  # cloud agents: one "name:hash" line per platform skill

CREATED, MODIFIED, REMOVED = "created", "modified", "removed"

_lock = threading.Lock()
_caches: dict[str, dict[str, tuple[tuple[int, int, int], bytes | None]]] = {}


class Snapshot:
    """The two trees as they were when one call started: ``files`` maps path → (stat, zlib bytes or None)."""

    __slots__ = ("dirs", "files", "home", "memories", "skills", "started")

    def __init__(self, home: str, files: dict[str, tuple[tuple[int, int, int], bytes | None]], dirs: set[str]):
        self.home = home
        self.skills = os.path.join(home, "skills")
        self.memories = os.path.join(home, "memories")
        self.files = files
        self.dirs = dirs
        self.started = time.monotonic()

    def old_bytes(self, path: str) -> bytes | None:
        entry = self.files.get(path)
        return zlib.decompress(entry[1]) if entry and entry[1] is not None else None

    def rel(self, path: str) -> str:
        return os.path.relpath(path, self.home).replace(os.sep, "/")


class Change:
    __slots__ = ("kind", "new_text", "old", "path")

    def __init__(self, path: str, kind: str, old: bytes | None, new_text: str | None):
        self.path = path
        self.kind = kind
        self.old = old  # bytes before the call (None: the file is new, or it was not cached)
        self.new_text = new_text  # UTF-8 text after the call (None: removed, binary, too big, unreadable)


def _stat_key(st: os.stat_result) -> tuple[int, int, int]:
    return (st.st_mtime_ns, st.st_ctime_ns, st.st_size)


def platform_skill_names(skills: str) -> set[str]:
    names = {PLATFORM_CATEGORY}
    try:
        with open(os.path.join(skills, PLATFORM_MANIFEST), encoding="utf-8-sig") as fh:
            names.update(line.split(":", 1)[0].strip() for line in fh if ":" in line)
    except OSError:
        pass
    return {name for name in names if name}


def _walk(root: str, skip: set[str]) -> tuple[dict[str, tuple[int, int, int]], set[str]]:
    files: dict[str, tuple[int, int, int]] = {}
    dirs: set[str] = set()
    stack = [root]
    while stack and len(files) < MAX_FILES:
        current = stack.pop()
        try:
            entries = os.scandir(current)
        except OSError:
            continue
        dirs.add(current)
        with entries:
            for entry in entries:
                if entry.name.startswith(".") or (current == root and entry.name in skip):
                    continue
                try:
                    if entry.is_dir(follow_symlinks=False):
                        stack.append(entry.path)
                    elif entry.is_file(follow_symlinks=False):
                        files[entry.path] = _stat_key(entry.stat(follow_symlinks=False))
                except OSError:
                    continue
    return files, dirs


def _walk_home(home: str) -> tuple[dict[str, tuple[int, int, int]], set[str]]:
    skills = os.path.join(home, "skills")
    files, dirs = _walk(skills, platform_skill_names(skills))
    memory_files, memory_dirs = _walk(os.path.join(home, "memories"), set())
    files.update(memory_files)
    return files, dirs | memory_dirs


def _read(path: str) -> bytes | None:
    try:
        with open(path, "rb") as fh:
            data = fh.read(MAX_FILE_BYTES + 1)
    except OSError:
        return None
    return data if len(data) <= MAX_FILE_BYTES else None


def take(home: str | os.PathLike) -> Snapshot:
    """Stat both trees; reuse cached bytes for files whose stat did not change, read the rest."""
    home = str(home)
    with _lock:
        walked, dirs = _walk_home(home)
        cached = _caches.get(home, {})
        fresh: dict[str, tuple[tuple[int, int, int], bytes | None]] = {}
        budget = MAX_CACHE_BYTES
        for path, key in walked.items():
            entry = cached.get(path)
            if entry is None or entry[0] != key:
                data = _read(path) if key[2] <= MAX_FILE_BYTES and budget > 0 else None
                entry = (key, zlib.compress(data, 1) if data is not None else None)
            if entry[1] is not None:
                budget -= len(entry[1])
            fresh[path] = entry
        _caches[home] = fresh
    return Snapshot(home, dict(fresh), dirs)


def _text(path: str) -> str | None:
    data = _read(path)
    if data is None:
        return None
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return None


def changes(snapshot: Snapshot) -> tuple[list[Change], set[str]]:
    """Files created, modified or removed since ``snapshot``, and the directories created since."""
    current, dirs = _walk_home(snapshot.home)
    found = []
    for path, key in current.items():
        before = snapshot.files.get(path)
        if before is not None and before[0] == key:
            continue
        kind = CREATED if before is None else MODIFIED
        found.append(Change(path, kind, snapshot.old_bytes(path), _text(path) if key[2] <= MAX_FILE_BYTES else None))
    for path in snapshot.files.keys() - current.keys():
        found.append(Change(path, REMOVED, snapshot.old_bytes(path), None))
    return found, dirs - snapshot.dirs


def _lines(data: bytes | None) -> set[str]:
    if data is None:
        return set()
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return set()
    return {line.strip() for line in text.splitlines() if line.strip()}


def added_lines(change: Change, moved: set[str]) -> set[int]:
    """1-based numbers of the lines of ``change.new_text`` that were not in the file before the call.

    A line counts as old when the file had it anywhere, or when a file this call removed had it (a
    skill moved or renamed keeps its lines), so content that was stored before is never judged again.
    """
    old = _lines(change.old) | moved
    return {no for no, line in enumerate((change.new_text or "").splitlines(), 1) if line.strip() and line.strip() not in old}


def moved_lines(found: list[Change]) -> set[str]:
    lines: set[str] = set()
    for change in found:
        if change.kind == REMOVED:
            lines |= _lines(change.old)
    return lines


def _unit(snapshot: Snapshot, path: str, current_skill_files: set[str]) -> str:
    """What gets undone together: a skill's whole directory (the nearest one with a SKILL.md), else the file."""
    root = snapshot.skills + os.sep
    if not path.startswith(root):
        return path
    directory = os.path.dirname(path)
    while directory + os.sep != root and directory.startswith(root):
        marker = os.path.join(directory, "SKILL.md")
        if marker in snapshot.files or marker in current_skill_files:
            return directory + os.sep
        directory = os.path.dirname(directory)
    return path


def _inside(path: str, unit: str) -> bool:
    return path == unit or (unit.endswith(os.sep) and path.startswith(unit))


def revert(snapshot: Snapshot, found: list[Change], new_dirs: set[str], problem_paths: set[str]) -> list[dict[str, Any]]:
    """Undo every change inside the units of ``problem_paths``: delete what the call created, write back
    what it modified or removed, then drop the directories it created that are now empty."""
    present = {change.path for change in found if change.kind != REMOVED}
    units = {_unit(snapshot, path, present) for path in problem_paths}
    undone = []
    for change in sorted(found, key=lambda c: c.path):
        if not any(_inside(change.path, unit) for unit in units):
            continue
        outcome = {"path": change.path, "rel": snapshot.rel(change.path), "kind": change.kind, "ok": True}
        try:
            if change.kind == CREATED:
                os.unlink(change.path)
            elif change.old is None:
                outcome["ok"] = False  # too big to cache, or unreadable before the call: nothing to put back
            else:
                os.makedirs(os.path.dirname(change.path), exist_ok=True)
                with open(change.path, "wb") as fh:
                    fh.write(change.old)
                mtime = snapshot.files[change.path][0][0]
                os.utime(change.path, ns=(time.time_ns(), mtime))
        except FileNotFoundError:
            pass  # someone else already removed it
        except OSError as exc:
            outcome["ok"] = False
            logger.warning("hc-1195: could not undo %s %s: %s", change.kind, change.path, exc)
        undone.append(outcome)
    for directory in sorted(new_dirs, key=len, reverse=True):
        if any(_inside(directory + os.sep, unit) or unit.startswith(directory + os.sep) for unit in units):
            try:
                os.rmdir(directory)
            except OSError:
                pass  # not empty: something else lives there now
    return undone


def rebase(snapshot: Snapshot, paths: list[str]) -> None:
    """Make ``paths`` look unchanged to ``snapshot``: another call has just put them back, and this call
    must not read that undo as its own edit (and undo it again)."""
    for path in paths:
        try:
            key = _stat_key(os.lstat(path))
        except FileNotFoundError:
            snapshot.files.pop(path, None)
            continue
        except OSError:
            continue
        data = _read(path)
        snapshot.files[path] = (key, zlib.compress(data, 1) if data is not None else None)


def home_from_runtime() -> Path | None:
    """The active profile's HERMES_HOME (hooks run in the calling context), else $HERMES_HOME, else None."""
    try:
        from hermes_constants import get_hermes_home
    except ImportError:  # apex-nodes tests load the plugin without the runtime around it
        get_hermes_home = None
    if get_hermes_home is not None:
        try:
            return Path(get_hermes_home())
        except Exception:
            logger.debug("hc-1195: get_hermes_home failed", exc_info=True)
    env_home = os.environ.get("HERMES_HOME")
    return Path(env_home) if env_home else None
