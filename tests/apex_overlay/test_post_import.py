"""hc-989: ``apex_overlay.post_import.when_imported`` patches a module once its import finishes.

The helper exists so a seam called from plugin discovery never waits on an import lock (see the module
docstring). These tests drive it with throwaway packages written to ``tmp_path`` so every import state
can be produced on purpose: already imported, not started (with and without its package loaded),
running on another thread while that thread waits for the registering one (the hc-989 deadlock shape),
running on the registering thread itself, past its spec lookup but not yet in ``sys.modules``, and
failing once before a retry.

Each recording patch also notes whether the module was still marked initializing when it ran: that is
what keeps other importers waiting on the module's lock until the patch is in.
"""

from __future__ import annotations

import importlib
import importlib.machinery
import itertools
import logging
import sys
import textwrap
import threading
import types

import pytest

from apex_overlay import post_import

_JOIN_SECONDS = 10
_counter = itertools.count()


@pytest.fixture
def clean_post_import():
    """Put the helper's process-wide state (queue, observers) back after each test."""
    pending = {name: list(patches) for name, patches in post_import._pending.items()}
    specs = dict(post_import._watched_specs)
    parents = dict(post_import._watched_parents)
    finder = post_import._finder
    meta_path = list(sys.meta_path)
    yield
    for name in list(post_import._watched_specs):
        if name not in specs:
            post_import._unwatch_running_import(name)
    for name in list(post_import._watched_parents):
        if name not in parents:
            post_import._unwatch_parent(name)
    post_import._pending.clear()
    post_import._pending.update(pending)
    post_import._finder = finder
    sys.meta_path[:] = meta_path


@pytest.fixture
def make_package(tmp_path, monkeypatch, clean_post_import):
    """Write a uniquely named package under tmp_path; returns (package name, gate module or None).

    ``load_package=False`` leaves the package unimported, so nothing exists yet for the parent watcher.
    """
    monkeypatch.syspath_prepend(str(tmp_path))
    created: list[str] = []

    def make(modules: dict[str, str], *, load_package: bool = True):
        name = f"_hc989_pkg_{next(_counter)}"
        root = tmp_path / name
        root.mkdir()
        (root / "__init__.py").write_text("", encoding="utf-8")
        (root / "_gate.py").write_text(
            "import threading\n"
            "entered = threading.Event()\n"
            "lock = threading.Lock()\n"
            "fail_once = False\n"
            "hook = None\n",
            encoding="utf-8",
        )
        for module, body in modules.items():
            (root / f"{module}.py").write_text(
                textwrap.dedent(body).replace("PKG", name), encoding="utf-8"
            )
        created.append(name)
        importlib.invalidate_caches()
        return name, (importlib.import_module(f"{name}._gate") if load_package else None)

    yield make
    for name in created:
        for mod in [m for m in sys.modules if m == name or m.startswith(name + ".")]:
            del sys.modules[mod]


def _recording_patch(log: list):
    def patch(module):
        log.append((
            threading.current_thread().name,
            getattr(module, "BODY_DONE", False),
            "initializing" if getattr(module.__spec__, "_initializing", False) else "initialized",
        ))
        module.PATCHED = True
        return True

    return patch


def test_an_imported_module_is_patched_at_once_on_the_calling_thread(make_package):
    pkg, _gate = make_package({"target": "BODY_DONE = True\n"})
    importlib.import_module(f"{pkg}.target")
    log: list = []

    assert post_import.when_imported(f"{pkg}.target", _recording_patch(log)) is True
    assert log == [(threading.current_thread().name, True, "initialized")]
    assert post_import.when_imported(f"{pkg}.target", lambda module: False) is False, (
        "for an imported module the patch's own result is returned"
    )
    assert f"{pkg}.target" not in post_import.pending_modules()


def test_an_import_not_started_yet_is_patched_before_it_is_marked_initialized(make_package):
    pkg, _gate = make_package({"target": "BODY_DONE = True\n"})
    log: list = []

    assert post_import.when_imported(f"{pkg}.target", _recording_patch(log)) is True
    assert f"{pkg}.target" not in sys.modules, "registering must never import the module"
    assert log == []

    seen = {}

    def importer():
        module = importlib.import_module(f"{pkg}.target")
        seen["patched_when_import_returned"] = getattr(module, "PATCHED", False)

    thread = threading.Thread(target=importer, name="importer")
    thread.start()
    thread.join(_JOIN_SECONDS)
    assert seen == {"patched_when_import_returned": True}
    assert log == [("importer", True, "initializing")], "once, on the importing thread, after the body"


def test_an_import_whose_package_is_not_loaded_yet_is_patched_before_it_returns(make_package):
    """Nothing under the package is imported yet, so only the meta_path finder can see this import
    (a fresh gateway process before anything under ``gateway`` has loaded)."""
    pkg, _gate = make_package({"target": "BODY_DONE = True\n"}, load_package=False)
    log: list = []
    assert pkg not in sys.modules

    post_import.when_imported(f"{pkg}.target", _recording_patch(log))
    assert pkg not in sys.modules, "registering must not import the package either"
    module = importlib.import_module(f"{pkg}.target")

    assert getattr(module, "PATCHED", False) is True
    assert log == [(threading.current_thread().name, True, "initializing")]


def test_an_import_running_on_a_thread_that_waits_for_the_registering_thread(make_package):
    """The hc-989 interleaving, reduced: registration must return while the import it targets is stuck.

    ``discovery`` holds a lock (PluginManager._discovery_lock) and registers a patch for ``target``.
    ``importer`` (the gateway's main thread) is inside ``target``'s body, waiting for that same lock
    (gateway/run.py bridging ``auxiliary:`` through plugin discovery). If registering waited for the
    import, neither thread could ever finish.
    """
    pkg, gate = make_package({
        "target": """
            from PKG import _gate
            _gate.entered.set()
            with _gate.lock:
                pass
            BODY_DONE = True
        """,
    })
    log: list = []
    order: list[str] = []
    result = {}
    discovery_holds_lock = threading.Event()

    def discovery():
        with gate.lock:
            discovery_holds_lock.set()
            assert gate.entered.wait(_JOIN_SECONDS), "importer never entered the module body"
            result["armed"] = post_import.when_imported(f"{pkg}.target", _recording_patch(log))
            order.append("registered")

    def importer():
        discovery_holds_lock.wait(_JOIN_SECONDS)
        module = importlib.import_module(f"{pkg}.target")
        order.append(f"import returned, patched={getattr(module, 'PATCHED', False)}")

    threads = [threading.Thread(target=discovery, name="plugin-discovery", daemon=True),
               threading.Thread(target=importer, name="importer", daemon=True)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(_JOIN_SECONDS)
    assert not threads[0].is_alive(), "registration waited on an import that waits on it (hc-989 deadlock)"
    assert not threads[1].is_alive(), "the import never finished"
    assert result == {"armed": True}
    assert order == ["registered", "import returned, patched=True"]
    assert log == [("importer", True, "initializing")], (
        "once, on the importing thread, after the body and before other importers may use the module"
    )
    spec = sys.modules[f"{pkg}.target"].__spec__
    assert type(spec) is importlib.machinery.ModuleSpec, "the running import's spec class is restored"


def test_registering_from_inside_the_modules_own_import_waits_for_its_body(make_package):
    """Synchronous discovery triggered from a module's own body (no background thread) must not see
    the half-built module: the patch runs after the body, on the same thread."""
    pkg, gate = make_package({
        "target": """
            from PKG import _gate
            _gate.hook()
            BODY_DONE = True
        """,
    })
    log: list = []
    gate.hook = lambda: post_import.when_imported(f"{pkg}.target", _recording_patch(log))

    module = importlib.import_module(f"{pkg}.target")

    assert getattr(module, "PATCHED", False) is True
    assert log == [(threading.current_thread().name, True, "initializing")]


def test_an_import_already_past_its_spec_lookup_is_caught_by_the_package_fallback(make_package):
    """The import found its spec before the finder existed and is not in sys.modules yet: neither the
    finder nor the running-import watcher can see it, the parent package's binding still does."""
    pkg, _gate = make_package({"target": "BODY_DONE = True\n"})
    created = threading.Event()
    release = threading.Event()

    class SlowCreate:
        """Serve ``target`` with a loader whose create_module (after find_spec, before
        sys.modules) waits for the test."""

        def find_spec(self, fullname, path=None, target=None):
            if fullname != f"{pkg}.target":
                return None
            spec = importlib.machinery.PathFinder.find_spec(fullname, path)

            def create_module(spec_):  # no return value: the import system creates the module
                created.set()
                release.wait(_JOIN_SECONDS)

            spec.loader.create_module = create_module
            return spec

    slow = SlowCreate()
    sys.meta_path.insert(0, slow)
    log: list = []
    importer = threading.Thread(target=importlib.import_module, args=(f"{pkg}.target",), name="importer",
                                daemon=True)
    importer.start()
    try:
        assert created.wait(_JOIN_SECONDS)
        assert f"{pkg}.target" not in sys.modules
        post_import.when_imported(f"{pkg}.target", _recording_patch(log))
    finally:
        release.set()
        importer.join(_JOIN_SECONDS)
        sys.meta_path.remove(slow)

    assert log == [("importer", True, "initialized")]
    assert getattr(sys.modules[f"{pkg}.target"], "PATCHED", False) is True


def test_a_failed_import_keeps_the_patch_for_the_retry(make_package):
    pkg, gate = make_package({
        "target": """
            from PKG import _gate
            if _gate.fail_once:
                _gate.fail_once = False
                raise RuntimeError("first import fails")
            BODY_DONE = True
        """,
    })
    gate.fail_once = True
    log: list = []
    post_import.when_imported(f"{pkg}.target", _recording_patch(log))

    with pytest.raises(RuntimeError, match="first import fails"):
        importlib.import_module(f"{pkg}.target")
    assert log == []
    assert f"{pkg}.target" in post_import.pending_modules()

    importlib.import_module(f"{pkg}.target")
    assert log == [(threading.current_thread().name, True, "initializing")]


def test_a_failed_running_import_restores_its_spec_and_the_retry_is_patched(make_package):
    pkg, gate = make_package({
        "target": """
            from PKG import _gate
            _gate.hook()
            if _gate.fail_once:
                _gate.fail_once = False
                raise RuntimeError("first import fails")
            BODY_DONE = True
        """,
    })
    gate.fail_once = True
    log: list = []
    specs = []

    def register_while_running():
        specs.append(sys.modules[f"{pkg}.target"].__spec__)
        post_import.when_imported(f"{pkg}.target", _recording_patch(log))

    gate.hook = register_while_running
    with pytest.raises(RuntimeError, match="first import fails"):
        importlib.import_module(f"{pkg}.target")
    assert log == []
    assert type(specs[0]) is importlib.machinery.ModuleSpec

    gate.hook = lambda: None
    importlib.import_module(f"{pkg}.target")
    assert log == [(threading.current_thread().name, True, "initializing")]


def test_each_registered_patch_runs_once(make_package):
    pkg, _gate = make_package({"target": "BODY_DONE = True\n"})
    first: list = []
    second: list = []
    patch_a, patch_b = _recording_patch(first), _recording_patch(second)
    post_import.when_imported(f"{pkg}.target", patch_a)
    post_import.when_imported(f"{pkg}.target", patch_a)
    post_import.when_imported(f"{pkg}.target", patch_b)

    module = importlib.import_module(f"{pkg}.target")
    importlib.reload(module)

    assert len(first) == 1 and len(second) == 1


def test_patches_run_in_registration_order(make_package):
    pkg, _gate = make_package({"target": "BODY_DONE = True\n"})
    order: list[str] = []
    for label in ("bootstrap", "localize", "passthrough"):
        post_import.when_imported(f"{pkg}.target", lambda module, label=label: order.append(label) or True)

    importlib.import_module(f"{pkg}.target")

    assert order == ["bootstrap", "localize", "passthrough"], (
        "two seams wrap GatewayRunner._handle_message; their nesting must not depend on import timing"
    )


def test_a_raising_patch_is_logged_and_the_import_still_succeeds(make_package, caplog):
    pkg, _gate = make_package({"target": "BODY_DONE = True\n"})

    def broken(module):
        raise RuntimeError("seam bug")

    post_import.when_imported(f"{pkg}.target", broken)
    with caplog.at_level(logging.ERROR, logger="apex_overlay.post_import"):
        module = importlib.import_module(f"{pkg}.target")

    assert module.BODY_DONE is True
    assert any(f"patch for {pkg}.target raised" in r.getMessage() for r in caplog.records)


def test_observers_are_removed_once_nothing_is_pending(make_package):
    pkg, _gate = make_package({"target": "BODY_DONE = True\n", "other": "BODY_DONE = True\n"})
    original_class = type(sys.modules[pkg])
    post_import.when_imported(f"{pkg}.target", lambda module: True)
    post_import.when_imported(f"{pkg}.other", lambda module: True)
    assert type(sys.modules[pkg]) is not original_class, "the parent package is watched while armed"

    importlib.import_module(f"{pkg}.target")
    assert type(sys.modules[pkg]) is not original_class, "still watched: another child is pending"

    importlib.import_module(f"{pkg}.other")
    assert type(sys.modules[pkg]) is original_class
    assert not any(isinstance(f, post_import._PatchAfterImport) for f in sys.meta_path)
    assert isinstance(sys.modules[pkg], types.ModuleType)
    assert not [name for name in post_import._watched_specs if name.startswith(pkg)]


def test_top_level_module_names_are_refused(clean_post_import):
    with pytest.raises(ValueError, match="submodule"):
        post_import.when_imported("gateway", lambda module: True)
