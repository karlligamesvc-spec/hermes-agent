"""Regression: every platform adapter's ``connect()`` must accept the
``is_reconnect`` keyword argument.

The gateway reconnect watcher forwards ``is_reconnect=True`` to every
adapter on every retry (``GatewayRunner._connect_adapter_with_timeout``
in ``gateway/run.py``). An adapter whose ``connect()`` signature omits
``is_reconnect`` blows up on the first reconnect attempt with::

    TypeError: <Foo>Adapter.connect() got an unexpected
               keyword argument 'is_reconnect'

…and never recovers: the watcher retries every 300s forever, so the
platform stays silently offline until an operator restarts the gateway.

This shipped for real. ``QQAdapter`` and ``WecomCallbackAdapter`` both
carried a bare ``async def connect(self)`` up to the v0.19.0 baseline
bump, and on the engine builds that predate it QQ channels went dark
with nothing but a WARNING line to show for it.

Why this file is shaped the way it is
-------------------------------------
An earlier version of this guard globbed for files literally named
``adapter.py`` (or ``*_adapter.py``) under ``gateway/platforms/`` and
``plugins/platforms/``. That found 22 files and missed **10 live
adapters** — every adapter that lives in a flat module (``webhook.py``,
``signal.py``, ``weixin.py``, ``yuanbao.py``, ``api_server.py``,
``bluebubbles.py``, ``whatsapp_cloud.py``, ``msgraph_webhook.py``) plus
``gateway/relay/adapter.py``, which sits outside both roots. A guard
that only inspects the adapters it happens to glob is the same bug it
is meant to prevent, one level up.

So discovery is **structural, not lexical**: we resolve the class
hierarchy and take every class that transitively subclasses
``BasePlatformAdapter``, wherever in the repo it lives. A new adapter is
covered the moment it subclasses the base — no list to update, no
filename convention to obey.

Parsing is done with ``ast`` rather than by importing, so the test does
not need every platform's optional SDK (aiohttp, slack_sdk, telegram,
matrix-nio, …) installed.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]

# The base class every gateway platform adapter derives from. This is the
# single structural fact the whole guard hangs off: `run.py` keeps
# `self.adapters[platform]` populated with instances of these classes and
# calls `connect(is_reconnect=...)` on each of them.
ADAPTER_BASE = "BasePlatformAdapter"

# Directories that never hold production adapters. Everything else in the
# repo is scanned, so an adapter added under `apex_overlay/` (the ApexNodes
# seam) or any future package is picked up without touching this file.
SKIP_DIRS = {
    ".git",
    ".venv",
    "venv",
    "node_modules",
    "build",
    "dist",
    "__pycache__",
    "tests",
}


def _python_files() -> list[Path]:
    return sorted(
        p
        for p in REPO_ROOT.rglob("*.py")
        if not SKIP_DIRS.intersection(p.relative_to(REPO_ROOT).parts)
    )


def _base_name(node: ast.expr) -> str | None:
    """Last identifier of a base-class expression.

    Handles ``Foo``, ``module.Foo`` and ``pkg.module.Foo`` alike — we only
    need the class *name* to link a subclass to its base, because adapter
    class names are unique across the tree.
    """
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def _collect_classes() -> dict[str, list[tuple[Path, ast.ClassDef]]]:
    """Map class name -> every (file, ClassDef) defining that name."""
    classes: dict[str, list[tuple[Path, ast.ClassDef]]] = {}
    for path in _python_files():
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        except (SyntaxError, UnicodeDecodeError):
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef):
                classes.setdefault(node.name, []).append((path, node))
    return classes


ALL_CLASSES = _collect_classes()


def _is_adapter(name: str) -> bool:
    """True iff ``name`` transitively subclasses ``BasePlatformAdapter``.

    Memoised, with a cycle guard — the base map is built from names, so a
    pathological ``class A(B)`` / ``class B(A)`` pair must not recurse
    forever.
    """
    memo: dict[str, bool] = {}

    def walk(cls_name: str, seen: frozenset[str]) -> bool:
        if cls_name == ADAPTER_BASE:
            return True
        if cls_name in memo:
            return memo[cls_name]
        if cls_name in seen:
            return False
        result = False
        for _path, node in ALL_CLASSES.get(cls_name, []):
            bases = [b for b in (_base_name(x) for x in node.bases) if b]
            if any(walk(b, seen | {cls_name}) for b in bases):
                result = True
                break
        memo[cls_name] = result
        return result

    return walk(name, frozenset())


def _own_connect(node: ast.ClassDef) -> ast.AsyncFunctionDef | None:
    """The class's *own* ``async def connect``, if it overrides one.

    Classes that inherit ``BasePlatformAdapter.connect`` unchanged are fine
    by construction — only overrides can drop the kwarg.
    """
    for item in node.body:
        if isinstance(item, ast.AsyncFunctionDef) and item.name == "connect":
            return item
    return None


def _adapter_connect_overrides() -> list[tuple[Path, ast.ClassDef, ast.AsyncFunctionDef]]:
    """Every adapter class in the repo that defines its own ``connect``."""
    found = []
    for name, entries in ALL_CLASSES.items():
        if not _is_adapter(name):
            continue
        for path, node in entries:
            connect = _own_connect(node)
            if connect is not None:
                found.append((path, node, connect))
    return sorted(found, key=lambda t: (str(t[0]), t[1].name))


ADAPTER_CONNECTS = _adapter_connect_overrides()


def _accepts_is_reconnect(func: ast.AsyncFunctionDef) -> bool:
    """True iff ``connect`` declares a parameter *named* ``is_reconnect``.

    Two forms deliberately do NOT count:

    - ``**kwargs`` catch-all. Swallowing the kwarg turns the next instance
      of this bug from a loud TypeError into a silently-ignored flag — an
      adapter that quietly treats every reconnect as a cold boot (dropping
      the platform's server-side update queue, #46621) is worse than one
      that crashes visibly.
    - **Positional-only** ``is_reconnect`` (``def connect(self, x, /)``).
      The name is there but ``connect(is_reconnect=True)`` still raises
      TypeError — positional-only parameters cannot be passed by keyword.
      Matching on the name alone would hand out a false pass.
    """
    args = func.args
    callable_by_keyword = args.args + args.kwonlyargs
    return any(a.arg == "is_reconnect" for a in callable_by_keyword)


def _id(path: Path, cls: ast.ClassDef) -> str:
    return f"{path.relative_to(REPO_ROOT)}::{cls.name}"


# ---------------------------------------------------------------------------
# The contract
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "path,cls,connect",
    ADAPTER_CONNECTS,
    ids=[_id(p, c) for p, c, _f in ADAPTER_CONNECTS],
)
def test_adapter_connect_accepts_is_reconnect(
    path: Path, cls: ast.ClassDef, connect: ast.AsyncFunctionDef
):
    """Every ``BasePlatformAdapter`` subclass that overrides ``connect``
    must accept ``is_reconnect``.

    Fix by matching the base signature::

        async def connect(self, *, is_reconnect: bool = False) -> bool:

    If the platform has nothing to preserve across an outage, accept the
    flag and drop it explicitly (``del is_reconnect``) — do NOT add
    ``**kwargs``.
    """
    assert _accepts_is_reconnect(connect), (
        f"{_id(path, cls)} defines `async def connect()` on line "
        f"{connect.lineno} without an `is_reconnect` parameter.\n"
        f"The gateway reconnect watcher calls "
        f"`adapter.connect(is_reconnect=True)` on every retry, so this "
        f"adapter raises TypeError on its first reconnect and then stays "
        f"offline forever, retrying every 300s with only a WARNING to "
        f"show for it.\n"
        f"Add `*, is_reconnect: bool = False` to the signature."
    )


# ---------------------------------------------------------------------------
# Guards on the guard
# ---------------------------------------------------------------------------


def test_discovery_is_not_degenerate():
    """The structural walker must still be finding adapters.

    If the hierarchy resolution breaks (base class renamed, packages
    moved), ``ADAPTER_CONNECTS`` silently empties and the parametrised
    test above passes on nothing. The counts below are a floor, not a
    manifest — they only need bumping if adapters are *removed*.
    """
    assert len(ADAPTER_CONNECTS) >= 25, (
        f"Only {len(ADAPTER_CONNECTS)} adapter `connect` overrides found. "
        f"The class-hierarchy walker is probably broken — it resolved "
        f"{sum(1 for n in ALL_CLASSES if _is_adapter(n))} adapter classes "
        f"out of {len(ALL_CLASSES)} classes scanned."
    )


def test_discovery_covers_adapters_outside_the_platform_dirs():
    """Adapters that don't live in ``*/platforms/*/adapter.py`` are covered.

    This is the specific hole that let the QQ outage go unguarded: the
    previous glob-based discovery only saw files named ``adapter.py``.
    These three are each in a shape that glob missed — a flat module, a
    non-``adapter.py`` filename, and a different top-level package.
    """
    discovered = {_id(p, c) for p, c, _f in ADAPTER_CONNECTS}
    for expected in (
        "gateway/platforms/webhook.py::WebhookAdapter",
        "gateway/platforms/weixin.py::WeixinAdapter",
        "gateway/relay/adapter.py::RelayAdapter",
    ):
        assert expected in discovered, (
            f"{expected} was not discovered. Structural discovery has "
            f"regressed to something lexical; adapters outside the "
            f"`platforms/<name>/adapter.py` convention are unguarded again."
        )


def test_structural_discovery_agrees_with_an_independent_signal():
    """Cross-check the walker against a signal it does not share.

    Hierarchy resolution links a subclass to its base *by name*, so it has
    one residual blind spot: a base imported under an alias
    (``import BasePlatformAdapter as Base``) would make an adapter
    invisible, and every other test here would keep passing — the checker
    would be issuing its own clean bill of health.

    So probe with something that shares none of that logic: any class
    literally named ``*Adapter`` that defines ``async def connect``. Today
    the two sets agree exactly. If the lexical probe ever finds a class
    the structural walker missed, the walker has a hole.
    """
    structural = {_id(p, c) for p, c, _f in ADAPTER_CONNECTS}

    lexical = set()
    for path in _python_files():
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        except (SyntaxError, UnicodeDecodeError):
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef) and node.name.endswith("Adapter"):
                if _own_connect(node) is not None:
                    lexical.add(_id(path, node))

    missed = lexical - structural
    assert not missed, (
        f"These classes look like adapters with their own connect() but "
        f"were NOT resolved as BasePlatformAdapter subclasses: "
        f"{sorted(missed)}. Either the class hierarchy walker has a blind "
        f"spot (aliased base import? dynamically built base?) or these are "
        f"genuinely not gateway adapters — confirm which before excluding."
    )


def test_no_adapter_relies_on_kwargs_to_swallow_is_reconnect():
    """No adapter may satisfy the contract via a ``**kwargs`` catch-all.

    ``**kwargs`` makes the signature *accept* the call, which is exactly
    what turns a loud failure into a silent one: the adapter would treat
    every watcher reconnect as a cold boot and drop the platform's
    server-side queue without anyone noticing.
    """
    offenders = [
        f"{_id(p, c)} (line {f.lineno})"
        for p, c, f in ADAPTER_CONNECTS
        if f.args.kwarg is not None and not _accepts_is_reconnect(f)
    ]
    assert not offenders, (
        f"These adapters absorb `is_reconnect` into `**kwargs` instead of "
        f"declaring it: {offenders}. Declare the parameter explicitly."
    )


def test_run_py_still_forwards_is_reconnect():
    """Pin the call convention this whole guard exists to serve.

    If ``gateway/run.py`` ever stops forwarding ``is_reconnect=`` the
    contract above becomes cargo cult — it would keep passing while
    guarding a call that no longer happens. Fail loudly instead so the
    guard gets revisited alongside the call site.
    """
    run_py = REPO_ROOT / "gateway" / "run.py"
    tree = ast.parse(run_py.read_text(encoding="utf-8"), filename=str(run_py))

    forwarding_calls = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "connect"
        and any(kw.arg == "is_reconnect" for kw in node.keywords)
    ]
    assert forwarding_calls, (
        "gateway/run.py no longer calls `.connect(is_reconnect=...)`. "
        "Either the reconnect path moved (point this test at it) or the "
        "kwarg was dropped (then this whole contract file should go too)."
    )


def test_relay_transports_are_out_of_scope():
    """Relay *transports* are a layer below adapters — deliberately excluded.

    ``gateway/relay/transport.py::RelayTransport`` (a Protocol) and
    ``gateway/relay/ws_transport.py::WebSocketRelayTransport`` both define
    ``async def connect(self)`` with no ``is_reconnect``. That is correct
    and must stay that way: the reconnect watcher never touches them. Only
    ``RelayAdapter`` is on the watcher path, and it calls
    ``self._transport.connect()`` with no arguments — routine WS drops are
    handled by the transport's own reconnect supervisor.

    Widening the transport signature would add a parameter nothing ever
    passes. This test pins the boundary so the next person auditing
    ``connect(self)`` signatures doesn't "fix" the wrong layer.
    """
    assert not _is_adapter("RelayTransport")
    assert not _is_adapter("WebSocketRelayTransport")
    assert _is_adapter("RelayAdapter"), (
        "RelayAdapter must remain a BasePlatformAdapter subclass — it IS "
        "on the reconnect-watcher path and must keep accepting the kwarg."
    )

    relay_adapter = REPO_ROOT / "gateway" / "relay" / "adapter.py"
    tree = ast.parse(relay_adapter.read_text(encoding="utf-8"), filename=str(relay_adapter))
    transport_connects = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "connect"
        and isinstance(node.func.value, ast.Attribute)
        and node.func.value.attr == "_transport"
    ]
    assert transport_connects, "RelayAdapter no longer calls self._transport.connect()"
    for call in transport_connects:
        assert not call.args and not call.keywords, (
            "RelayAdapter now passes arguments to self._transport.connect(); "
            "the transport layer contract changed — revisit whether "
            "transports belong in this guard after all."
        )
