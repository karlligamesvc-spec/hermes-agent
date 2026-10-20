"""Patch an upstream module once it has finished importing, without importing it (hc-989).

Why seams may not import their gateway target during plugin discovery
=====================================================================
Every seam's ``apply()`` runs inside plugin discovery. ``hermes gateway run`` starts discovery on the
``plugin-discovery`` daemon thread, which holds ``PluginManager._discovery_lock`` for the whole sweep,
while the main thread goes on to ``from gateway.run import start_gateway``. ``gateway/run.py`` waits for
that lock *during its own import*: its module body bridges ``config.yaml``'s ``auxiliary:`` section to
env vars through ``get_plugin_auxiliary_tasks()``, and that runs discovery. When a seam then calls
``importlib.import_module("gateway.run")`` from discovery, each thread waits on the lock the other one
holds: main for the discovery lock, discovery for ``gateway.run``'s import lock. On engines without
per-plugin load deadlines (cloud image v2026.8.31) the gateway hangs before it binds :8642 or writes
``gateway.lock``; with the 10 s deadline, apex-overlay is dropped as "load timed out" and its doubao
TTS registration is disposed.

The rule this module enforces: during discovery a seam only patches a ``gateway.*`` module that is
already fully imported. Otherwise :func:`when_imported` records the patch and runs it on the importing
thread as soon as the module body has finished, before the import system marks the module initialized.
Until then every other importer of that module waits on its import lock, so nobody can use the module
unpatched, and nothing here ever waits on an import lock itself.

How the end of an import is observed
====================================
An import is in one of these states when a seam arrives:

* **not started** — a one-shot ``sys.meta_path`` finder hands the import system the normal spec with
  that loader's ``exec_module`` wrapped for this one import (the pattern ``custom_base_url_guard``
  already uses for ``web_server_config``);
* **running, on any thread** (the deadlock case) — the finder is too late, but the module is in
  ``sys.modules`` with ``__spec__._initializing`` set. The import system clears that flag right after
  the module body returns, on the importing thread, while it still holds the module's import lock. The
  spec's class is swapped for a subclass whose ``__setattr__`` runs the patches just before the flag is
  cleared, then the original class comes back;
* **between the two** — an import that obtained its spec just before the finder was installed and had
  not reached ``sys.modules`` when we looked. As a fallback the parent package is watched too: the
  import system binds a finished submodule onto it (``setattr(gateway, "run", module)``) on the
  importing thread. That moment comes just after the flag is cleared, so this rare path alone can be
  observed a moment late by another thread. Module ``__class__`` assignment is documented Python
  ("Customizing module attribute access"); the original class is restored once nothing is pending.

Whichever observer sees the end first runs the patches; each patch runs exactly once, in registration
order, and a patch that raises is logged instead of breaking the import it rides on.
"""

from __future__ import annotations

import importlib.util
import logging
import sys
import threading
import types
from typing import Callable, Optional

logger = logging.getLogger(__name__)

Patch = Callable[[types.ModuleType], bool]

_lock = threading.RLock()
_pending: dict[str, list[Patch]] = {}
_watched_specs: dict[str, tuple[object, type]] = {}  # module -> (its running spec, the spec's class)
_watched_parents: dict[str, tuple[type, type]] = {}  # parent package -> (original class, watcher class)
_finder: Optional[_PatchAfterImport] = None


def is_imported(module_name: str) -> bool:
    """True once ``module_name`` is in ``sys.modules`` with its module body fully executed."""
    module = sys.modules.get(module_name)
    return module is not None and not _initializing(module)


def when_imported(module_name: str, patch: Patch) -> bool:
    """Run ``patch(module)`` once ``module_name`` has finished importing. Never imports it here.

    Returns ``patch``'s result when the module was already imported (the patch ran now, on this thread),
    otherwise ``True``: the patch is armed and will run on the importing thread as soon as the module
    body finishes. Registering the same ``patch`` twice before that queues it once. ``module_name`` must
    be a submodule (``package.module``), whose parent package backs up the other two observers.
    """
    if "." not in module_name:
        raise ValueError(f"when_imported needs a submodule name, got {module_name!r}")
    module = sys.modules.get(module_name)
    if module is not None and not _initializing(module):
        return _run(module_name, patch, module)
    with _lock:
        queued = _pending.setdefault(module_name, [])
        if patch not in queued:
            queued.append(patch)
        _install_finder()
        _watch_parent(module_name)
        _watch_running_import(module_name)
    # The import may have finished while the observers were being armed; nothing would see it then.
    module = sys.modules.get(module_name)
    if module is not None and not _initializing(module):
        _fire(module_name, module)
    return True


def pending_modules() -> tuple[str, ...]:
    """Module names with patches still waiting for their import (for tests and diagnostics)."""
    with _lock:
        return tuple(_pending)


def _initializing(module: types.ModuleType) -> bool:
    # The import system's own "module body still running" flag (see importlib._bootstrap._load_unlocked).
    return bool(getattr(getattr(module, "__spec__", None), "_initializing", False))


def _run(module_name: str, patch: Patch, module: types.ModuleType) -> bool:
    try:
        return bool(patch(module))
    except Exception:
        logger.error("apex_overlay: patch for %s raised; that seam is not active", module_name, exc_info=True)
        return False


def _fire(module_name: str, module: types.ModuleType) -> None:
    with _lock:
        patches = _pending.pop(module_name, None)
        if patches is None:
            return
        _unwatch_running_import(module_name)
        parent_name = module_name.rpartition(".")[0]
        if not any(name.rpartition(".")[0] == parent_name for name in _pending):
            _unwatch_parent(parent_name)
        if not _pending:
            _uninstall_finder()
    for patch in patches:
        _run(module_name, patch, module)


# ---------------------------------------------------------------------------
# Not started: wrap the loader of the coming import
# ---------------------------------------------------------------------------

class _PatchAfterImport:
    """``sys.meta_path`` finder that wraps one pending module's ``exec_module`` for that import only."""

    def __init__(self) -> None:
        self._finding = threading.local()

    def find_spec(self, fullname, path=None, target=None):
        if fullname not in _pending or getattr(self._finding, "name", None) == fullname:
            return None
        self._finding.name = fullname
        try:
            spec = importlib.util.find_spec(fullname)
        except Exception:
            logger.debug("apex_overlay: spec lookup for %s failed", fullname, exc_info=True)
            return None
        finally:
            self._finding.name = None
        loader = getattr(spec, "loader", None)
        inner_exec = getattr(loader, "exec_module", None)
        if inner_exec is None:
            return None

        def exec_module(module):
            try:
                inner_exec(module)
            finally:
                loader.__dict__.pop("exec_module", None)
            _fire(fullname, module)  # the module is still marked initializing here

        try:
            loader.exec_module = exec_module
        except AttributeError:
            return None  # a loader without an instance dict; the parent watcher still sees the import
        return spec


def _install_finder() -> None:
    global _finder
    if _finder is None:
        _finder = _PatchAfterImport()
        sys.meta_path.insert(0, _finder)


def _uninstall_finder() -> None:
    global _finder
    if _finder is not None:
        try:
            sys.meta_path.remove(_finder)
        except ValueError:
            pass
        _finder = None


# ---------------------------------------------------------------------------
# Running: patch just before the import system marks the module initialized
# ---------------------------------------------------------------------------

def _watch_running_import(module_name: str) -> None:
    module = sys.modules.get(module_name)
    if module is None or not _initializing(module) or module_name in _watched_specs:
        return
    spec = module.__spec__
    original = type(spec)

    def __setattr__(self, name, value):
        if name == "_initializing" and not value:
            if sys.modules.get(module_name) is module:
                _fire(module_name, module)
            else:  # the module body raised; a retried import goes through the finder
                with _lock:
                    _unwatch_running_import(module_name)
        original.__setattr__(self, name, value)

    watcher = type(f"_ApexRunningImport[{module_name}]", (original,), {"__setattr__": __setattr__})
    try:
        spec.__class__ = watcher
    except TypeError:
        logger.debug("apex_overlay: cannot watch the running import of %s; using the fallbacks", module_name)
        return
    _watched_specs[module_name] = (spec, original)


def _unwatch_running_import(module_name: str) -> None:
    spec, original = _watched_specs.pop(module_name, (None, None))
    if spec is not None and type(spec) is not original:
        spec.__class__ = original


# ---------------------------------------------------------------------------
# Fallback: an import that got its spec just before the finder existed
# ---------------------------------------------------------------------------

def _watch_parent(module_name: str) -> None:
    parent_name = module_name.rpartition(".")[0]
    parent = sys.modules.get(parent_name)
    if parent is None or parent_name in _watched_parents:
        return
    original = type(parent)

    def __setattr__(self, name, value):
        original.__setattr__(self, name, value)
        full_name = f"{parent_name}.{name}"
        if full_name in _pending and isinstance(value, types.ModuleType) and value.__name__ == full_name:
            _fire(full_name, value)

    watcher = type(f"_ApexImportWatcher[{parent_name}]", (original,), {"__slots__": (), "__setattr__": __setattr__})
    try:
        parent.__class__ = watcher
    except TypeError:
        logger.debug("apex_overlay: cannot watch package %s; relying on the other observers", parent_name)
        return
    _watched_parents[parent_name] = (original, watcher)


def _unwatch_parent(parent_name: str) -> None:
    original, watcher = _watched_parents.pop(parent_name, (None, None))
    parent = sys.modules.get(parent_name)
    if parent is not None and watcher is not None and type(parent) is watcher:
        parent.__class__ = original
