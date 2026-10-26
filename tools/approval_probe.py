"""Read-only probes that need no approval prompt (hc-1034).

Presence checks (``command -v``, ``which``, ``type``) and version queries already pass the
dangerous-pattern layer. The everyday probe it does flag is an inline interpreter check such as
``python3 -c "import PIL; print(PIL.__version__)"``, because ``-c`` can carry any code. On a
Desktop with manual approvals that probe waited five minutes for a click nobody gave, then came
back BLOCKED. This module recognises that probe, and an execute_code script made of the same
statements, so neither waits on a human. Everything here is an allowlist: anything it does not
recognise keeps the normal approval flow.

Command shape: the WHOLE command is one python interpreter, optional flags from
``_PYTHON_FLAGS``, ``-c`` and the probe code, nothing after it. Outside single quotes only ASCII
letters, digits, blanks and ``_ . / - + , : @ %`` may appear; inside double quotes ``$``, a
backtick, ``\\`` and ``!`` may not; two quoted strings may not touch. So pipes, redirects,
``;`` / ``&&`` / ``||`` / ``&``, subshells, ``$(...)``, backticks, globs, ``~``, env assignments,
comments and quote splicing all leave the command on the normal path.

Probe code (checked with :mod:`ast`):
- at least one import: code that imports nothing (``print(1)``) is not a probe;
- statements: ``import a.b`` and ``from a import b`` (no ``as``, no ``*``, no relative import),
  ``pass``, an allowed call as a statement, and ``try`` whose handlers catch ImportError,
  ModuleNotFoundError or Exception (optionally ``as e``) with no ``finally``;
- calls: ``print(...)`` (keywords ``sep`` / ``end`` with string constants only),
  ``getattr(<value>, "<attribute>"[, <constant>])``, ``shutil.which("x")``,
  ``importlib.util.find_spec("x")``, ``importlib.metadata.version("x")`` and the zero-argument
  ``platform.python_version()`` / ``platform.platform()`` / ``platform.machine()``; a dotted
  call must start from a name bound by a plain ``import`` of that module;
- values: constants, names bound by the imports or an ``except ... as``, attribute chains on
  them, f-strings of those, and the calls above. No attribute part may start with ``_`` except
  ``__version__`` and ``__file__``. No subscripts, operators, lambdas, comprehensions or
  assignments;
- modules: no ``__main__`` part, and none of the standard-library modules whose import opens a
  window or a browser (``_SIDE_EFFECT_MODULES``);
- a name bound by ``from ... import`` or ``except ... as`` may not shadow ``print``, ``getattr``,
  the handler exception names or a module a call starts from;
- at most ``_MAX_CODE_CHARS`` characters and ``_MAX_STATEMENTS`` statements.

What a probe still executes: the interpreter's start-up (site, ``.pth`` files) and the imported
packages' own initialisation code, plus whatever module the current directory supplies under that
name. ``python3 some_file.py`` already runs any file without a prompt, so none of that adds a
capability; what the allowlist removes is arbitrary inline code, which is what ``-c`` was flagged
for.
"""

from __future__ import annotations

import ast
import os
import re
import shlex

_MAX_COMMAND_CHARS = 1_200
_MAX_CODE_CHARS = 1_000
_MAX_STATEMENTS = 40

_PYTHON_NAME_RE = re.compile(r"py(?:\.exe)?|python[23]?(?:\.\d+)*(?:\.exe)?")
_PYTHON_FLAGS = frozenset({"-I", "-s", "-S", "-E", "-B", "-u", "-q"})
_UNQUOTED_SAFE = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_./-+,:@% \t")
_DOUBLE_QUOTE_SPECIAL = frozenset("$`\\!")

_SIDE_EFFECT_MODULES = frozenset({"antigravity", "this", "idlelib", "turtledemo", "__hello__", "__phello__"})
_HANDLER_NAMES = frozenset({"ImportError", "ModuleNotFoundError", "Exception"})
_BUILTIN_CALLS = frozenset({"print", "getattr"})
# Dotted call -> how many arguments it takes (each a string constant).
_MODULE_CALLS = {
    ("shutil", "which"): 1,
    ("importlib", "util", "find_spec"): 1,
    ("importlib", "metadata", "version"): 1,
    ("platform", "python_version"): 0,
    ("platform", "platform"): 0,
    ("platform", "machine"): 0,
}
_CALL_ROOTS = frozenset(path[0] for path in _MODULE_CALLS)
_ALLOWED_DUNDERS = frozenset({"__version__", "__file__"})


def _single_simple_command(command: str) -> list[str] | None:
    """argv of *command* when it is one simple command with no shell syntax beyond quoting."""
    if not command or len(command) > _MAX_COMMAND_CHARS:
        return None
    quote = None
    just_closed = False
    for ch in command:
        if quote == "'":
            quote = None if ch == "'" else quote
            just_closed = quote is None
            continue
        if quote == '"':
            if ch in _DOUBLE_QUOTE_SPECIAL:
                return None
            quote = None if ch == '"' else quote
            just_closed = quote is None
            continue
        if ch in "'\"":
            if just_closed:
                return None  # 'a''b' splices differently in zsh with RC_QUOTES
            quote = ch
            continue
        just_closed = False
        if ch not in _UNQUOTED_SAFE:
            return None
    if quote is not None:
        return None
    try:
        return shlex.split(command, posix=True)
    except ValueError:
        return None


def probe_code_from_command(command: str) -> str | None:
    """The ``-c`` code when *command* is exactly ``python [flags] -c CODE``, else None."""
    argv = _single_simple_command((command or "").strip())
    if not argv or len(argv) < 3:
        return None
    executable = argv[0]
    if "/" in executable and not executable.startswith("/"):
        return None
    if not _PYTHON_NAME_RE.fullmatch(os.path.basename(executable).lower()):
        return None
    index = 1
    while index < len(argv) and argv[index] in _PYTHON_FLAGS:
        index += 1
    if index != len(argv) - 2 or argv[index] != "-c":
        return None
    return argv[index + 1]


def is_readonly_probe(command: str) -> bool:
    """True when *command* is a read-only inline-Python probe (see the module docstring)."""
    code = probe_code_from_command(command)
    return code is not None and is_probe_script(code)


class _Checker:
    """One pass over a parsed probe; ``ok()`` is False at the first construct outside the grammar."""

    def __init__(self) -> None:
        self.module_roots: set[str] = set()
        self.names: set[str] = set()
        self.imports = 0
        self.statements = 0

    def ok(self, tree: ast.Module) -> bool:
        # A probe checks something: code with no import (``print(1)``) keeps the normal path.
        return self._bind_all(tree.body) and self.imports > 0 and self._body(tree.body)

    # Bindings are collected first: a probe may name a module before the line that imports it,
    # and a shadowing binding anywhere must reject the whole probe.
    def _bind_all(self, body: list[ast.stmt]) -> bool:
        from_bound: set[str] = set()
        for node in ast.walk(ast.Module(body=body, type_ignores=[])):
            self.imports += isinstance(node, (ast.Import, ast.ImportFrom))
            if isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.asname or not _module_ok(alias.name):
                        return False
                    root = alias.name.split(".")[0]
                    self.module_roots.add(root)
                    self.names.add(root)
            elif isinstance(node, ast.ImportFrom):
                if node.level or not node.module or not _module_ok(node.module):
                    return False
                for alias in node.names:
                    if alias.asname or alias.name == "*" or not _module_ok(alias.name):
                        return False
                    from_bound.add(alias.name)
            elif isinstance(node, ast.ExceptHandler) and node.name:
                from_bound.add(node.name)
        reserved = _BUILTIN_CALLS | _HANDLER_NAMES | _CALL_ROOTS | self.module_roots
        if from_bound & reserved:
            return False
        self.names |= from_bound
        return True

    def _body(self, body: list[ast.stmt]) -> bool:
        return all(self._statement(node) for node in body)

    def _statement(self, node: ast.stmt) -> bool:
        self.statements += 1
        if self.statements > _MAX_STATEMENTS:
            return False
        if isinstance(node, (ast.Import, ast.ImportFrom, ast.Pass)):
            return True
        if isinstance(node, ast.Expr):
            return isinstance(node.value, ast.Call) and self._call(node.value)
        if isinstance(node, ast.Try) and not node.finalbody:
            return (self._body(node.body) and self._body(node.orelse)
                    and all(self._handler(handler) for handler in node.handlers))
        return False

    def _handler(self, handler: ast.ExceptHandler) -> bool:
        kinds = handler.type.elts if isinstance(handler.type, ast.Tuple) else [handler.type]
        return all(isinstance(kind, ast.Name) and kind.id in _HANDLER_NAMES for kind in kinds) \
            and self._body(handler.body)

    def _call(self, node: ast.Call) -> bool:
        func = node.func
        if isinstance(func, ast.Name) and func.id == "print":
            return all(self._value(arg) for arg in node.args) and all(
                kw.arg in ("sep", "end") and _is_str(kw.value) for kw in node.keywords)
        if isinstance(func, ast.Name) and func.id == "getattr":
            args = node.args
            return (not node.keywords and len(args) in (2, 3) and self._value(args[0])
                    and _is_str(args[1]) and _attribute_ok(args[1].value)
                    and (len(args) == 2 or isinstance(args[2], ast.Constant)))
        path = _dotted(func)
        if path is None or path[0] not in self.module_roots or path not in _MODULE_CALLS:
            return False
        return not node.keywords and len(node.args) == _MODULE_CALLS[path] and all(map(_is_str, node.args))

    def _value(self, node: ast.expr) -> bool:
        if isinstance(node, ast.Constant):
            return isinstance(node.value, (str, int, float, bool)) or node.value is None
        if isinstance(node, ast.Name):
            return node.id in self.names
        if isinstance(node, ast.Attribute):
            return _attribute_ok(node.attr) and self._value(node.value)
        if isinstance(node, ast.Call):
            return self._call(node)
        if isinstance(node, ast.JoinedStr):
            return all(self._value(part) for part in node.values)
        if isinstance(node, ast.FormattedValue):
            return self._value(node.value) and (node.format_spec is None or self._value(node.format_spec))
        return False


def _module_ok(name: str) -> bool:
    parts = name.split(".")
    return all(part.isidentifier() for part in parts) and "__main__" not in parts \
        and parts[0] not in _SIDE_EFFECT_MODULES


def _attribute_ok(name: object) -> bool:
    return isinstance(name, str) and name.isidentifier() and (not name.startswith("_") or name in _ALLOWED_DUNDERS)


def _is_str(node: ast.expr) -> bool:
    return isinstance(node, ast.Constant) and isinstance(node.value, str)


def _dotted(node: ast.expr) -> tuple[str, ...] | None:
    parts: list[str] = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if not isinstance(node, ast.Name) or not parts:
        return None
    return (node.id, *reversed(parts))


def is_probe_script(code: str) -> bool:
    """True when *code* uses only the read-only probe grammar in the module docstring."""
    if not isinstance(code, str) or not code.strip() or len(code) > _MAX_CODE_CHARS:
        return False
    try:
        tree = ast.parse(code, mode="exec")
    except (SyntaxError, ValueError):
        return False
    return _Checker().ok(tree)
