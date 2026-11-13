"""Read-only execute_code scripts need no approval card (hc-1223).

On an APEX Desktop every execute_code script waited for a card, including ones that only read the
task's files: printing a transcript JSON, measuring frames with PIL and numpy, printing part of its
own script. :func:`is_readonly_script` recognises such a script and
:func:`tools.approval.check_execute_code_guard` lets it run like a hc-1034 probe. It is an allowlist
checked with :mod:`ast`; anything it does not recognise keeps the normal approval flow. Writing a
file is never read-only: an edit of the agent's own script goes through the file tools.

A read-only script:

- reads at least one file's contents: ``open`` in a read mode, ``read_text`` / ``read_bytes``,
  ``PIL.Image.open``, ``wave.open`` or ``numpy.fromfile``. A script that reads nothing is not
  exempt, so ``print('x')`` and ``os.listdir('.')`` still stand for "some script" in gate tests;
- imports only modules in ``_MODULES`` and uses only the names listed for each, every one either a
  plain function, class or constant or a module with its own entry. Lists, not "any public name":
  modules re-export what they import (``PIL.Image.os``). So no subprocess, socket, urllib, pickle,
  sys, importlib, tempfile, ``shutil.rmtree`` or the ``hermes_tools`` bridge;
- opens files only to read: every mode an ``open`` carries is a constant without ``w``, ``a``,
  ``x`` or ``+``, a ``.open()`` on a value takes nothing but such constants, no ``opener=``, and
  ``open`` is only ever called, never passed around;
- reaches no attribute in ``_DENIED_ATTRS`` (write, save, unlink, rename, mkdir, chmod, replace,
  show, ...) on any object and no attribute starting with ``_`` but ``__name__``, ``__version__``,
  ``__file__`` and ``__doc__``; ``.copy()`` takes no arguments (``Path.copy`` takes a target);
- uses names it binds itself, its imports and the builtins in ``_BUILTINS``; a module only through
  an attribute (``os.path.join``), never as a value; ``print`` without ``file=``, ``type`` with one
  argument; no ``exec``, ``eval``, ``compile``, ``getattr``, ``globals``, ``__import__`` or ``input``;
- has no class, decorator, ``global``/``nonlocal``, ``async``, ``match`` or t-string, assigns to no
  attribute of a module, and stays under ``_MAX_CODE_CHARS`` / ``_MAX_NODES``.
"""

from __future__ import annotations

import ast
import re

_MAX_CODE_CHARS = 20_000
_MAX_NODES = 6_000

_MODULES: dict[str, frozenset[str]] = {name: frozenset(names.split()) for name, names in {
    "json": "load loads dumps JSONDecodeError",
    "re": "compile match fullmatch search findall finditer sub subn split escape error Pattern Match "
          "IGNORECASE I MULTILINE M DOTALL S VERBOSE X ASCII A",
    "math": "sqrt floor ceil trunc log log10 log2 exp pow fabs isclose isnan isinf isfinite inf nan pi e tau "
            "hypot atan2 sin cos tan radians degrees fsum prod gcd dist copysign",
    "statistics": "mean fmean median median_low median_high mode multimode pstdev stdev pvariance variance "
                  "quantiles geometric_mean harmonic_mean",
    "collections": "Counter defaultdict OrderedDict deque",
    "itertools": "chain groupby islice zip_longest product combinations permutations accumulate pairwise count "
                 "repeat takewhile dropwhile starmap batched",
    "functools": "reduce cmp_to_key",
    "datetime": "datetime date time timedelta timezone",
    "time": "time time_ns monotonic perf_counter sleep strftime strptime localtime gmtime mktime",
    "string": "ascii_letters ascii_lowercase ascii_uppercase digits hexdigits punctuation whitespace printable",
    "textwrap": "wrap fill shorten dedent indent",
    "unicodedata": "name category normalize east_asian_width lookup numeric decimal digit",
    "difflib": "SequenceMatcher unified_diff context_diff ndiff get_close_matches",
    "hashlib": "md5 sha1 sha256 sha512 blake2b new file_digest",
    "base64": "b64encode b64decode urlsafe_b64encode urlsafe_b64decode",
    "struct": "pack unpack unpack_from iter_unpack calcsize Struct",
    "io": "BytesIO StringIO",
    "csv": "reader DictReader Sniffer Error",
    "glob": "glob iglob escape",
    "fnmatch": "fnmatch fnmatchcase filter",
    "pathlib": "Path PurePath PurePosixPath PureWindowsPath",
    "os": "path listdir scandir walk stat lstat getcwd fspath sep linesep curdir pardir extsep",
    "os.path": "join exists lexists isfile isdir islink getsize getmtime getctime getatime basename dirname "
               "split splitext abspath realpath relpath normpath expanduser commonpath commonprefix samefile sep",
    "pprint": "pprint pformat pp",
    "shutil": "which disk_usage",
    "wave": "open Error",
    "mimetypes": "guess_type guess_extension",
    "PIL": "Image ImageStat ImageOps ImageChops ImageFilter ImageDraw ImageFont ImageColor ImageEnhance ExifTags "
           "__version__",
    "PIL.Image": "open new fromarray frombytes merge blend composite alpha_composite eval Image Resampling Transpose "
                 "LANCZOS BICUBIC BILINEAR NEAREST UnidentifiedImageError DecompressionBombError",
    "PIL.ImageStat": "Stat",
    "PIL.ImageOps": "grayscale autocontrast equalize fit pad contain cover exif_transpose invert mirror flip expand "
                    "crop scale colorize posterize solarize",
    "PIL.ImageChops": "difference add subtract multiply screen lighter darker invert blend composite offset "
                      "constant duplicate add_modulo subtract_modulo logical_and logical_or logical_xor overlay "
                      "soft_light hard_light",
    "PIL.ImageFilter": "GaussianBlur BoxBlur MedianFilter MinFilter MaxFilter ModeFilter UnsharpMask BLUR SHARPEN "
                       "SMOOTH SMOOTH_MORE DETAIL CONTOUR EDGE_ENHANCE EDGE_ENHANCE_MORE EMBOSS FIND_EDGES",
    "PIL.ImageDraw": "Draw",
    "PIL.ImageFont": "truetype load_default",
    "PIL.ImageColor": "getrgb getcolor",
    "PIL.ImageEnhance": "Brightness Contrast Color Sharpness",
    "PIL.ExifTags": "TAGS GPSTAGS Base",
    "numpy": "array asarray zeros ones full empty zeros_like ones_like full_like arange linspace where nonzero "
             "argwhere count_nonzero mean median average std var min max amin amax ptp sum prod cumsum cumprod "
             "diff abs absolute sign sqrt square power exp log log10 log2 floor ceil round rint clip percentile "
             "quantile histogram bincount argmax argmin argsort sort unique concatenate stack hstack vstack "
             "column_stack split array_split reshape transpose flip roll pad tile repeat any all isclose allclose "
             "array_equal isnan isinf isfinite nan inf pi newaxis logical_and logical_or logical_not maximum "
             "minimum dot matmul outer interp convolve corrcoef cov searchsorted digitize meshgrid indices "
             "ndarray dtype uint8 uint16 int8 int16 int32 int64 float16 float32 float64 bool_ nanmean nanmedian "
             "nanstd nanmin nanmax nansum nanargmax nanargmin fromfile frombuffer set_printoptions linalg fft "
             "__version__",
    "numpy.linalg": "norm det inv pinv eig eigh svd lstsq solve matrix_rank",
    "numpy.fft": "fft ifft rfft irfft fft2 ifft2 fftfreq rfftfreq fftshift ifftshift",
}.items()}

# Functions reached through an import that read a file (``open`` ones are counted by the open rule).
_READ_FUNCTIONS = frozenset({"numpy.fromfile"})
_READ_METHODS = frozenset({"read_text", "read_bytes"})
# Attributes refused on any object: they write, delete, rename, change permissions, open a window or
# connect. ``replace`` is here because ``Path.replace`` renames and cannot be told from ``str.replace``.
_DENIED_ATTRS = frozenset({
    "write", "writelines", "write_text", "write_bytes", "save", "savefig", "tofile", "dump", "truncate",
    "touch", "mkdir", "makedirs", "rmdir", "unlink", "rename", "replace", "symlink_to", "hardlink_to",
    "link_to", "chmod", "lchmod", "chown", "copy_into", "move", "move_into", "rmtree", "show", "system",
    "popen", "spawn", "kill", "send", "sendall", "connect", "urlopen", "startfile",
})
# Attributes allowed only as the callee of a call whose arguments the checker reads.
_CALL_ONLY_ATTRS = frozenset({"open", "copy"})
_ALLOWED_DUNDERS = frozenset({"__name__", "__version__", "__file__", "__doc__"})
_BUILTINS = frozenset("""
    print len range enumerate zip map filter sorted reversed sum min max abs round divmod pow int float
    complex str bytes bytearray bool list tuple dict set frozenset repr ascii format hex oct bin ord chr
    isinstance issubclass iter next all any hash slice callable type id True False None NotImplemented
    Ellipsis __name__ Exception BaseException ValueError KeyError IndexError TypeError RuntimeError OSError
    IOError FileNotFoundError IsADirectoryError NotADirectoryError PermissionError StopIteration
    ZeroDivisionError ArithmeticError LookupError AttributeError AssertionError NotImplementedError
    UnicodeError UnicodeDecodeError EOFError OverflowError ImportError ModuleNotFoundError
""".split())
_READ_MODE = re.compile(r"[rbtU]{1,3}")
# Node types checked only through their children; every other type outside the handlers is refused.
_STRUCTURAL = (
    ast.Expr, ast.Assign, ast.AugAssign, ast.AnnAssign, ast.For, ast.While, ast.If, ast.With, ast.withitem,
    ast.Try, ast.TryStar, ast.ExceptHandler, ast.Raise, ast.Assert, ast.Pass, ast.Break, ast.Continue,
    ast.Return, ast.Import, ast.ImportFrom, ast.alias, ast.BinOp, ast.UnaryOp, ast.BoolOp, ast.Compare,
    ast.IfExp, ast.Subscript, ast.Slice, ast.Starred, ast.Tuple, ast.List, ast.Set, ast.Dict, ast.JoinedStr,
    ast.FormattedValue, ast.NamedExpr, ast.Lambda, ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp,
    ast.comprehension, ast.arguments, ast.arg, ast.Yield, ast.YieldFrom, ast.Constant, ast.operator,
    ast.unaryop, ast.boolop, ast.cmpop, ast.expr_context,
)


def is_readonly_script(code: str) -> bool:
    """True when *code* only reads files and computes (see the module docstring)."""
    if not isinstance(code, str) or not code.strip() or len(code) > _MAX_CODE_CHARS:
        return False
    try:
        tree = ast.parse(code, mode="exec")
        if sum(1 for _ in ast.walk(tree)) > _MAX_NODES:
            return False
        return _Checker().ok(tree)
    except (SyntaxError, ValueError, RecursionError):
        return False


def _module_path_ok(parts: list[str], *, callee: bool = False) -> bool:
    """``parts`` (a dotted path from an import) names an allowed function, class or constant."""
    k = next((k for k in range(len(parts), 0, -1) if ".".join(parts[:k]) in _MODULES), 0)
    if k == 0 or k == len(parts) or parts[k] not in _MODULES[".".join(parts[:k])]:
        return False  # not an allowed module, a module used as a value, or a name not on its list
    tail = parts[k + 1:]
    if not tail:
        return callee or parts[k] not in _CALL_ONLY_ATTRS
    return all(_attr_ok(name) for name in tail[:-1]) and _attr_ok(tail[-1], callee=callee)


def _attr_ok(name: str, *, callee: bool = False) -> bool:
    if (name.startswith("_") and name not in _ALLOWED_DUNDERS) or name in _DENIED_ATTRS:
        return False
    return callee or name not in _CALL_ONLY_ATTRS


def _read_mode(node: ast.expr) -> bool:
    return isinstance(node, ast.Constant) and isinstance(node.value, str) and bool(_READ_MODE.fullmatch(node.value))


class _Checker:
    """One pass over a parsed script; ``ok()`` is False at the first construct outside the allowlist."""

    def __init__(self) -> None:
        self.modules: dict[str, str] = {}  # local name -> module path (``import numpy as np``)
        self.objects: dict[str, str] = {}  # local name -> dotted path (``from pathlib import Path``)
        self.bound: set[str] = set()       # names the script assigns, defines or takes as parameters
        self.reads = 0

    def ok(self, tree: ast.Module) -> bool:
        return self._bind(tree) and all(self._node(node) for node in tree.body) and self.reads > 0

    def _bind(self, tree: ast.Module) -> bool:
        for node in ast.walk(tree):
            if isinstance(node, ast.Import) and not all(self._bind_import(alias) for alias in node.names):
                return False
            if isinstance(node, ast.ImportFrom) and not self._bind_from(node):
                return False
            if isinstance(node, ast.Name) and not isinstance(node.ctx, ast.Load):
                self.bound.add(node.id)
            elif isinstance(node, ast.arg):
                self.bound.add(node.arg)
            elif isinstance(node, (ast.FunctionDef, ast.ExceptHandler)) and node.name:
                self.bound.add(node.name)
        return True

    def _bind_import(self, alias: ast.alias) -> bool:
        root = alias.name.split(".")[0]
        if alias.name not in _MODULES or root not in _MODULES:
            return False
        self.modules[alias.asname or root] = alias.name if alias.asname else root
        return True

    def _bind_from(self, node: ast.ImportFrom) -> bool:
        if node.level or node.module not in _MODULES:
            return False
        for alias in node.names:
            path = f"{node.module}.{alias.name}"
            if path in _MODULES:
                self.modules[alias.asname or alias.name] = path
            elif alias.name != "*" and _module_path_ok(path.split("."), callee=True):
                self.objects[alias.asname or alias.name] = path
            else:
                return False
        return True

    def _node(self, node: ast.AST) -> bool:
        handler = _HANDLERS.get(type(node))
        if handler is not None:
            return handler(self, node)
        return isinstance(node, _STRUCTURAL) and all(self._node(child) for child in ast.iter_child_nodes(node))

    def _import_path(self, node: ast.expr) -> str | None:
        """The dotted path *node* reaches through an import (``np.linalg.norm`` -> numpy.linalg.norm)."""
        chain = []
        while isinstance(node, ast.Attribute):
            chain.append(node.attr)
            node = node.value
        if not isinstance(node, ast.Name):
            return None
        root = self.modules.get(node.id) or self.objects.get(node.id)
        return ".".join([root, *reversed(chain)]) if root else None

    def _name(self, node: ast.Name) -> bool:
        if node.id.startswith("__") and node.id not in _ALLOWED_DUNDERS:
            return False
        if not isinstance(node.ctx, ast.Load):
            return True
        if node.id in self.modules:
            return False  # a module as a value
        if node.id in self.objects:
            return self.objects[node.id].rsplit(".", 1)[-1] not in _CALL_ONLY_ATTRS
        return node.id in self.bound or node.id in _BUILTINS

    def _attribute(self, node: ast.Attribute, *, callee: bool = False) -> bool:
        path = self._import_path(node)
        if path is not None:
            return isinstance(node.ctx, ast.Load) and _module_path_ok(path.split("."), callee=callee)
        return _attr_ok(node.attr, callee=callee) and self._node(node.value)

    def _call(self, node: ast.Call) -> bool:
        if not (all(self._node(arg) for arg in node.args) and all(self._node(kw.value) for kw in node.keywords)):
            return False
        func = node.func
        if isinstance(func, ast.Name):
            return self._name_call(func.id, node)
        if isinstance(func, ast.Attribute):
            return self._attribute(func, callee=True) and self._attribute_call(func, node)
        return self._node(func)

    def _name_call(self, name: str, node: ast.Call) -> bool:
        if name in self.modules or (name.startswith("__") and name not in _ALLOWED_DUNDERS):
            return False
        if name in self.objects:
            return self._path_call(self.objects[name], node)
        if name == "open":
            return self._open_call(node, skip_file=True)
        if name in self.bound:
            return True
        if name == "print":
            return all(kw.arg in ("sep", "end", "flush") for kw in node.keywords)
        if name == "type":
            return len(node.args) == 1 and not node.keywords
        return name in _BUILTINS

    def _attribute_call(self, func: ast.Attribute, node: ast.Call) -> bool:
        path = self._import_path(func)
        if path is not None:
            return self._path_call(path, node)
        if func.attr == "open":
            return self._open_call(node, skip_file=False)
        if func.attr == "copy":
            return not node.args and not node.keywords
        self.reads += func.attr in _READ_METHODS
        return True

    def _path_call(self, path: str, node: ast.Call) -> bool:
        if path.rsplit(".", 1)[-1] == "open":
            return self._open_call(node, skip_file=True)
        self.reads += path in _READ_FUNCTIONS
        return True

    def _open_call(self, node: ast.Call, *, skip_file: bool) -> bool:
        """An ``open`` that can only read: every mode it passes is a constant read mode."""
        if any(isinstance(arg, ast.Starred) for arg in node.args) or any(
                kw.arg in (None, "opener") for kw in node.keywords):
            return False
        modes = [*(node.args[1:] if skip_file else node.args), *(kw.value for kw in node.keywords if kw.arg == "mode")]
        if not all(_read_mode(mode) for mode in modes):
            return False
        self.reads += 1
        return True

    def _function(self, node: ast.FunctionDef) -> bool:
        if node.decorator_list or getattr(node, "type_params", None):
            return False
        return all(self._node(child) for child in ast.iter_child_nodes(node))

    def _delete(self, node: ast.Delete) -> bool:
        return all(isinstance(target, (ast.Name, ast.Subscript)) and self._node(target) for target in node.targets)


_HANDLERS = {
    ast.Name: _Checker._name,
    ast.Attribute: _Checker._attribute,
    ast.Call: _Checker._call,
    ast.FunctionDef: _Checker._function,
    ast.Delete: _Checker._delete,
}
