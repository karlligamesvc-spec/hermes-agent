"""Deletes inside the session's own task folder need no approval card (hc-1223).

An APEX Desktop run rebuilt its own frame folder before every render (``cd <task>/_work && rm -rf
panel_frames && "$APEX_PYTHON" render_panel.py``) and stopped for a card each time; an unanswered
card then blocks the rest of the turn. :func:`residual_command` returns the command with every
such delete replaced by ``true``, and the gate runs its normal detection on what is left, so any
other finding in the same command still asks. Everything here is an allowlist: a command it cannot
read exactly keeps the normal approval flow.

The task folder is the session's working directory (``agent.runtime_cwd.resolve_agent_cwd``, the
folder the system prompt names), symlinks resolved, and only when it is a folder of its own: at
least two levels inside the home folder, and neither inside nor around the home folder, Hermes'
data folders or the running install. A session that works in the home folder itself (the Desktop
default) or in an assistant's profile home has no task folder, so its deletes ask as before.

A delete is exempt when, on the local backend:

- the whole command splits into segments joined by ``&&``, ``;`` or newlines, with no command
  substitution, backticks, subshells, braces, heredocs, comments or backslashes outside quotes;
- the segment is ``rm`` with only ``-r -R -f -v -d`` (or their long forms) before its operands,
  optionally followed by ``2>/dev/null``-style redirects, and no ``$``, ``~``, glob or backslash
  in any operand;
- every segment before it is ``cd <absolute existing folder>``, another exempt delete, or one of
  the ``_TRANSPARENT`` commands without a pipe or a background ``&``. Anything else before it
  (``ln -s``, ``mv``, ``cp``, a script) could change what the path points at by the time it runs;
- every operand, resolved from each folder the shell can be in at that point (where the command
  starts, or the target of a ``cd`` before it), names an entry strictly inside the task folder,
  both as written and with a final symlink followed, and no ``.git``, ``.hg`` or ``.svn`` in it.
"""

from __future__ import annotations

import os
import unicodedata
from dataclasses import dataclass
from pathlib import Path

_MAX_COMMAND_CHARS = 4_000
_RM_SHORT_FLAGS = frozenset("rRfvd")
_RM_LONG_FLAGS = frozenset({"--recursive", "--force", "--verbose", "--dir"})
_NULL_REDIRECTS = frozenset({"2>/dev/null", ">/dev/null", "1>/dev/null", "&>/dev/null", ">>/dev/null", "2>&1"})
# Commands that cannot change the shell's folder or create, move or replace a link or a folder.
_TRANSPARENT = frozenset({"ls", "du", "df", "pwd", "echo", "printf", "cat", "head", "tail", "wc", "stat",
                          "file", "date", "sleep", "true", "ffprobe", "ffmpeg"})
_PLAIN_PUNCTUATION = frozenset("_./-+,:@%=")
_DOUBLE_QUOTE_EXPANDS = frozenset("$`\\!")
_VCS_DIRS = frozenset({".git", ".hg", ".svn"})


@dataclass(frozen=True)
class _Segment:
    start: int
    end: int
    new_list: bool  # the command start or a ``;``/newline precedes it, so any earlier ``cd`` may not have run


@dataclass(frozen=True)
class _Word:
    text: str       # after quote removal
    raw: str        # as written
    plain: bool     # nothing in it is expanded: plain path characters outside quotes, no ``$`` in double quotes
    unquoted: str   # its characters outside quotes


def task_folder() -> Path | None:
    """The session's working directory when it is a folder of its own (module docstring), else None."""
    from agent.runtime_cwd import resolve_agent_cwd

    try:
        folder = Path(os.path.realpath(resolve_agent_cwd()))
        home = Path(os.path.realpath(Path.home()))
    except (OSError, RuntimeError):
        return None
    return None if _too_broad(folder, home) else folder


def _too_broad(folder: Path, home: Path) -> bool:
    from agent.file_safety import _hermes_dirs
    from agent.runtime_cwd import _PACKAGE_ROOT

    try:
        depth = len(folder.relative_to(home).parts)
    except ValueError:
        return True
    if depth < 2 or not folder.is_dir():
        return True
    return any(_related(folder, guarded) for guarded in (*_hermes_dirs(), _PACKAGE_ROOT.resolve()))


def _related(a: Path, b: Path) -> bool:
    return a == b or a in b.parents or b in a.parents


def residual_command(command: str, *, start_dir: str | None, env_type: str) -> str | None:
    """*command* with each delete inside the task folder replaced by ``true``; None when none qualifies."""
    if env_type != "local" or not command or len(command) > _MAX_COMMAND_CHARS:
        return None
    from tools.approval_detection import detect_content_rule_keys

    segments = _segments(command)
    folder = task_folder() if segments else None
    if folder is None or detect_content_rule_keys(command):
        return None
    exempt = _exempt_deletes(command, segments, start_dir, folder)
    if not exempt:
        return None
    pieces, last = [], 0
    for segment in exempt:
        pieces += [command[last:segment.start], " true "]
        last = segment.end
    return "".join(pieces) + command[last:]


def _exempt_deletes(command: str, segments: list[_Segment], start_dir: str | None, folder: Path) -> list[_Segment]:
    start = os.path.realpath(start_dir) if start_dir and os.path.isabs(start_dir) else None
    possible: set[str | None] = {start}  # folders the shell can be in when a new list starts
    current = set(possible)              # ... and at this point of the current ``&&`` chain
    clean, exempt = True, []
    for segment in segments:
        if segment.new_list:
            current = set(possible)
        words = _words(command[segment.start:segment.end])
        target = _cd_target(words)
        if target is not None:
            current = {target}
            possible.add(target)
            continue
        operands = _rm_operands(words)
        if clean and operands and all(_inside(op, cwd, folder) for op in operands for cwd in current):
            exempt.append(segment)
            continue
        clean = clean and _transparent(words)
    return exempt


def _segments(command: str) -> list[_Segment] | None:
    """Top-level segments split at ``&&``, ``;`` and newlines; None for anything that could hide a separator."""
    segments: list[_Segment] = []
    quote, i, start, new_list = None, 0, 0, True
    while i < len(command):
        ch = command[i]
        if quote == "'":
            quote = None if ch == "'" else quote
        elif quote == '"':
            if ch == "`" or command.startswith("$(", i):
                return None
            if ch == "\\":
                i += 1
            quote = None if ch == '"' else quote
        elif ch in "'\"":
            quote = ch
        elif ch in "\\`(){}#" or command.startswith(("$(", "<<"), i):
            return None
        elif ch in ";\n" or command.startswith("&&", i):
            segments.append(_Segment(start, i, new_list))
            new_list = ch != "&"
            i += 2 if ch == "&" else 1
            start = i
            continue
        i += 1
    if quote is not None:
        return None
    segments.append(_Segment(start, len(command), new_list))
    return segments


def _words(segment: str) -> list[_Word]:
    """The segment's words with quotes removed. Quoting follows :func:`_segments`, which already
    refused unbalanced quotes and every backslash outside quotes; inside double quotes a backslash
    takes the next character with it (``\\"`` does not close the quote) and makes the word not plain."""
    words: list[_Word] = []
    i = 0
    while i < len(segment):
        if segment[i] in " \t":
            i += 1
            continue
        start, text, unquoted, plain, quote = i, [], [], True, None
        while i < len(segment) and (quote or segment[i] not in " \t"):
            ch = segment[i]
            i += 1
            if ch == quote:
                quote = None
            elif quote is None and ch in "'\"":
                quote = ch
            elif quote == '"' and ch == "\\":
                text.append(segment[i:i + 1])
                plain, i = False, i + 1
            else:
                text.append(ch)
                plain = plain and _plain_char(ch, quote)
                if quote is None:
                    unquoted.append(ch)
        words.append(_Word("".join(text), segment[start:i], plain, "".join(unquoted)))
    return words


def _plain_char(ch: str, quote: str | None) -> bool:
    if unicodedata.category(ch)[0] == "C":
        return False
    if quote == "'":
        return True
    if quote == '"':
        return ch not in _DOUBLE_QUOTE_EXPANDS
    return ch.isalnum() or ch in _PLAIN_PUNCTUATION


def _cd_target(words: list[_Word]) -> str | None:
    """The folder ``cd <absolute existing folder>`` moves to, resolved; None for any other segment."""
    if len(words) != 2 or words[0].raw != "cd" or not words[1].plain or not os.path.isabs(words[1].text):
        return None
    target = os.path.realpath(words[1].text)
    return target if os.path.isdir(target) else None


def _rm_operands(words: list[_Word]) -> list[str] | None:
    """The operands of an ``rm`` segment in the exempt shape, else None."""
    if not words or words[0].raw != "rm":
        return None
    operands: list[str] = []
    options_done = redirected = False
    for word in words[1:]:
        if word.raw in _NULL_REDIRECTS:
            redirected = True
            continue
        if redirected or not word.plain or not word.text or word.text.startswith("="):
            return None
        if not options_done and word.text == "--":
            options_done = True
        elif not options_done and word.text.startswith("-"):
            if operands or not _rm_flag(word.text):
                return None
        else:
            operands.append(word.text)
    return operands or None


def _rm_flag(text: str) -> bool:
    if text.startswith("--"):
        return text in _RM_LONG_FLAGS
    return len(text) > 1 and set(text[1:]) <= _RM_SHORT_FLAGS


def _transparent(words: list[_Word]) -> bool:
    return bool(words) and words[0].raw in _TRANSPARENT and all(
        word.raw in _NULL_REDIRECTS or not ({"|", "&"} & set(word.unquoted)) for word in words)


def _inside(operand: str, cwd: str | None, folder: Path) -> bool:
    """True when *operand*, from *cwd*, names an entry strictly inside *folder* (see the module docstring)."""
    if os.path.isabs(operand):
        path = operand
    elif cwd is None:
        return False
    else:
        path = os.path.join(cwd, operand)
    trimmed = path.rstrip("/")
    name = os.path.basename(trimmed)
    if name in ("", ".", ".."):
        return False
    entry = Path(os.path.realpath(os.path.dirname(trimmed))) / name
    return all(_strictly_inside(candidate, folder) for candidate in (entry, Path(os.path.realpath(path))))


def _strictly_inside(path: Path, folder: Path) -> bool:
    try:
        parts = path.relative_to(folder).parts
    except ValueError:
        return False
    return bool(parts) and not (_VCS_DIRS & set(parts))
