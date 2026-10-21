"""hc-954: an installed APEX Desktop engine never builds a frontend, and `hermes --tui` runs the TUI
it ships on its own Node.

Every way into a frontend build reaches one of two guards: ``source_build_env`` (before PM acquires
npm: no network) and ``run_source_script`` (before node-deps / tui.mjs / web.mjs run against a tree:
no writes). Each entry point is driven here against a fake installed engine with PM's ``ensure``
replaced by a tripwire, and the engine tree must come out byte-identical.
"""

from __future__ import annotations

import ast
import json
import os
from pathlib import Path
import sys

import pytest

import pm
from apex_overlay import packaged_engine

REPO = Path(__file__).resolve().parents[2]
WINDOWS = os.name == "nt"
REFUSED = "installed by APEX Desktop"


def _manifest(**overrides) -> dict:
    manifest = {"schema": 1, "kind": "apexnodes-runtime-bundle", "key": "4321d42c674c",
                "os": "win" if WINDOWS else "mac", "components": {"node": {"path": ".runtime/node"}}}
    manifest.update(overrides)
    return manifest


def _engine_node(root: Path) -> Path:
    return root / ".runtime/node" / ("node.exe" if WINDOWS else "bin/node")


def _snapshot(root: Path) -> dict[str, bytes]:
    return {str(path.relative_to(root)): path.read_bytes() for path in sorted(root.rglob("*")) if path.is_file()}


@pytest.fixture
def engine(tmp_path: Path) -> Path:
    """The installed-engine shape the guards read: manifest, bundled Node, shipped TUI, workspace manifests."""
    root = tmp_path / "versions" / "4321d42c674c"
    root.mkdir(parents=True)
    (root / ".bundle-manifest.json").write_text(json.dumps(_manifest()), encoding="utf-8")
    node = _engine_node(root)
    node.parent.mkdir(parents=True)
    node.write_text("#!/bin/sh\n", encoding="utf-8")
    node.chmod(0o755)
    for workspace in ("ui-tui", "web"):
        (root / workspace).mkdir()
        (root / workspace / "package.json").write_text(json.dumps({"name": workspace}) + "\n", encoding="utf-8")
    (root / "hermes_cli/tui_dist").mkdir(parents=True)
    (root / "hermes_cli/tui_dist/entry.js").write_text("console.log('tui')\n", encoding="utf-8")
    (root / "hermes_cli/tui_dist/package.json").write_text('{"type":"module"}\n', encoding="utf-8")
    return root


@pytest.fixture
def pm_tripwire(monkeypatch):
    """PM must not be asked for anything (CPython, uv, Node, npm) on these paths."""
    calls: list[str] = []

    def ensure(name, **_kwargs):
        calls.append(name)
        raise AssertionError(f"PM was asked for {name!r} inside an installed engine")

    monkeypatch.setattr(pm, "ensure", ensure)
    return calls


@pytest.fixture
def engine_running(engine, monkeypatch, pm_tripwire):
    """This process runs from ``engine`` (pm's repo root and main_tui_launch's own location)."""
    from hermes_cli import main_tui_launch
    from pm import paths

    monkeypatch.setattr(paths, "repo_root", lambda: engine)
    monkeypatch.setattr(main_tui_launch, "__file__", str(engine / "hermes_cli/main_tui_launch.py"))
    monkeypatch.delenv("HERMES_NODE", raising=False)
    monkeypatch.delenv("HERMES_TUI_DIR", raising=False)
    return engine


@pytest.mark.parametrize(("content", "recognized"), [
    (json.dumps(_manifest()), True),
    (json.dumps(_manifest(kind="hermes-agent-payload")), False),
    (json.dumps(["apexnodes-runtime-bundle"]), False),
    ("{not json", False),
    (None, False),
])
def test_only_the_apex_engine_manifest_marks_an_installed_engine(tmp_path, content, recognized):
    if content is not None:
        (tmp_path / ".bundle-manifest.json").write_text(content, encoding="utf-8")
    assert (packaged_engine.bundle_manifest(tmp_path) is not None) is recognized
    refusal = packaged_engine.build_refusal(tmp_path)
    assert (refusal is not None and REFUSED in refusal and str(tmp_path) in refusal) is recognized


@pytest.mark.parametrize(("manifest_os", "tail"), [("mac", ("bin", "node")), ("win", ("node.exe",))])
def test_bundled_node_is_resolved_like_desktops_bundled_node_exe(tmp_path, manifest_os, tail):
    (tmp_path / ".bundle-manifest.json").write_text(json.dumps(_manifest(os=manifest_os)), encoding="utf-8")
    executable = tmp_path.joinpath(".runtime", "node", *tail)
    assert packaged_engine.bundled_node(tmp_path) is None
    executable.parent.mkdir(parents=True)
    executable.write_text("", encoding="utf-8")
    executable.chmod(0o755)
    assert packaged_engine.bundled_node(tmp_path) == str(executable)


@pytest.mark.platforms("posix")
def test_a_non_executable_bundled_node_is_not_used(engine):
    _engine_node(engine).chmod(0o644)
    assert packaged_engine.bundled_node(engine) is None


def test_source_build_env_refuses_an_installed_engine_before_pm(engine_running, pm_tripwire):
    from hermes_cli.source_build import source_build_env

    before = _snapshot(engine_running)
    with pytest.raises(RuntimeError, match=REFUSED):
        source_build_env()
    with pytest.raises(RuntimeError, match=REFUSED):
        source_build_env(explicit=True, verify=False)  # the update tail's call
    assert pm_tripwire == []
    assert _snapshot(engine_running) == before


def test_source_build_env_still_acquires_npm_for_a_checkout(tmp_path, monkeypatch):
    from hermes_cli.source_build import source_build_env
    from pm import paths
    from pm.package import Runner

    acquired = []
    monkeypatch.setattr(paths, "repo_root", lambda: tmp_path)
    monkeypatch.setattr(pm, "ensure", lambda name, **kwargs: acquired.append(name) or Runner(name, kwargs["base_env"]))
    assert source_build_env()["CI"] == "1"
    assert acquired == ["npm"]


def test_no_source_script_runs_against_an_installed_engine(engine, tmp_path, monkeypatch):
    from hermes_cli import source_build

    ran = []
    monkeypatch.setattr(source_build, "run_in_custody", lambda root, command, label, **kwargs: ran.append(root))
    before = _snapshot(engine)
    for script in ("scripts/build/node-deps.mjs", "scripts/build/tui.mjs", "scripts/build/web.mjs"):
        with pytest.raises(RuntimeError, match=REFUSED):
            source_build.run_source_script(engine, script, env={"PATH": os.environ.get("PATH", "")}, label=script)
    assert ran == [] and _snapshot(engine) == before
    source_build.run_source_script(tmp_path, "scripts/build/tui.mjs", env={"PATH": os.environ.get("PATH", "")}, label="tui")
    assert ran == [tmp_path]


def test_a_tree_without_the_overlay_keeps_upstream_behavior(engine, monkeypatch):
    """Upstream's own layouts (and partial test checkouts) carry no apex_overlay: nothing to protect."""
    from hermes_cli import main_tui_launch, source_build
    from pm.package import Runner

    monkeypatch.setitem(sys.modules, "apex_overlay.packaged_engine", None)  # import raises ImportError
    monkeypatch.setattr(main_tui_launch, "__file__", str(engine / "hermes_cli/main_tui_launch.py"))
    monkeypatch.delenv("HERMES_NODE", raising=False)
    pm_node = engine.parent / "pm-node"
    pm_node.write_text("", encoding="utf-8")
    pm_node.chmod(0o755)
    monkeypatch.setattr(pm, "ensure", lambda name, **kwargs: Runner(name, {"PATH": str(engine.parent)}))
    monkeypatch.setattr(main_tui_launch.shutil, "which", lambda name, path=None: str(pm_node))
    assert source_build.packaged_engine_refusal(engine) is None
    assert main_tui_launch._tui_node_bin("node") == str(pm_node)


def test_tui_runs_the_shipped_build_on_the_engines_node(engine_running, pm_tripwire, monkeypatch):
    from hermes_cli import main_tui_launch, source_build

    monkeypatch.setattr(source_build, "source_build_env", lambda *a, **k: pytest.fail("a source build started"))
    before = _snapshot(engine_running)
    argv, cwd = main_tui_launch._make_tui_argv(engine_running / "ui-tui", tui_dev=False)
    entry = engine_running / "hermes_cli/tui_dist/entry.js"
    assert argv == [str(_engine_node(engine_running)), "--expose-gc", str(entry)]
    assert cwd == entry.parent
    assert pm_tripwire == [] and _snapshot(engine_running) == before


def test_an_explicit_hermes_node_still_wins(engine_running, tmp_path, monkeypatch):
    from hermes_cli import main_tui_launch

    explicit = tmp_path / "explicit-node"
    explicit.write_text("", encoding="utf-8")
    explicit.chmod(0o755)
    monkeypatch.setenv("HERMES_NODE", str(explicit))
    assert main_tui_launch._tui_node_bin("node") == str(explicit)


@pytest.mark.parametrize("tui_dev", [True, False])
def test_tui_source_builds_are_refused_with_a_message(engine_running, pm_tripwire, monkeypatch, capsys, tui_dev):
    """``--dev``, or a shipped TUI gone missing: refused before PM or npm, with the reason on stderr."""
    from hermes_cli import main_tui_launch

    if not tui_dev:
        for path in (engine_running / "hermes_cli/tui_dist").iterdir():
            path.unlink()
        (engine_running / "hermes_cli/tui_dist").rmdir()
        monkeypatch.setattr(main_tui_launch, "_tui_need_rebuild", lambda tui_dir: True)
    before = _snapshot(engine_running)
    with pytest.raises(SystemExit) as exit_info:
        main_tui_launch._make_tui_argv(engine_running / "ui-tui", tui_dev=tui_dev)
    assert exit_info.value.code == 1
    assert REFUSED in capsys.readouterr().err
    assert pm_tripwire == [] and _snapshot(engine_running) == before


def test_dashboard_web_build_is_refused(engine_running, pm_tripwire, monkeypatch, capsys):
    from hermes_cli import main_web_build

    monkeypatch.setattr(main_web_build, "_web_ui_build_needed", lambda web_dir: True)
    before = _snapshot(engine_running)
    assert main_web_build._do_build_web_ui(engine_running / "web", fatal=True) is False
    assert REFUSED in capsys.readouterr().out
    assert pm_tripwire == [] and _snapshot(engine_running) == before


def test_update_product_builds_are_refused(engine_running, pm_tripwire, monkeypatch):
    from hermes_cli import main_install_repair, source_build, update_stage
    import hermes_cli.left_core_migration as left_core
    import hermes_cli.memory_provider_migration as memory_migration

    monkeypatch.setattr(main_install_repair, "_install_configured_features_missing_deps", lambda root: None)
    monkeypatch.setattr(update_stage, "publish_stage", lambda stage: None)
    monkeypatch.setattr(memory_migration, "migrate_all_homes", lambda: None)
    monkeypatch.setattr(left_core, "migrate_all_homes", lambda: None)
    before = _snapshot(engine_running)
    with pytest.raises(source_build.ProductBuildError) as raised:
        source_build.build_update_products(engine_running, desktop=False)
    assert [name for name, _ in raised.value.failures] == ["Node dependencies"]
    assert REFUSED in str(raised.value.failures[0][1])
    assert pm_tripwire == [] and _snapshot(engine_running) == before


def _calls(function: ast.AST, names: set[str]) -> set[str]:
    """Calls in ``function``'s own body (its lambdas included); a nested def is counted on its own."""
    found, pending = set(), list(ast.iter_child_nodes(function))
    while pending:
        node = pending.pop()
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if isinstance(node, ast.Call):
            callee = node.func.attr if isinstance(node.func, ast.Attribute) else getattr(node.func, "id", None)
            if callee in names:
                found.add(callee)
        pending.extend(ast.iter_child_nodes(node))
    return found


def _callers(names: set[str]) -> dict[str, list[str]]:
    callers = {}
    for path in sorted((REPO / "hermes_cli").rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        scopes = [node for node in ast.walk(tree) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))]
        for scope in [tree, *scopes]:
            used = _calls(scope, names)
            if used:
                callers[f"{path.relative_to(REPO).as_posix()}:{getattr(scope, 'name', '<module>')}"] = sorted(used)
    return callers


def test_frontend_build_chains_are_the_counted_ones():
    """Every builder call site counted for hc-954. A new one must be checked against the two guards, then added."""
    assert _callers({"prepare_source_dependencies", "prepare_launch_dependencies", "build_source_tui",
                     "build_source_web", "run_source_script", "source_build_env"}) == {
        "hermes_cli/main_desktop.py:cmd_gui": ["prepare_source_dependencies", "source_build_env"],
        "hermes_cli/main_tui_launch.py:_make_tui_argv": ["build_source_tui", "prepare_launch_dependencies", "source_build_env"],
        "hermes_cli/main_web_build.py:_do_build_web_ui": ["build_source_web", "prepare_launch_dependencies", "source_build_env"],
        "hermes_cli/source_build.py:build_source_tui": ["run_source_script"],
        "hermes_cli/source_build.py:build_source_web": ["run_source_script"],
        "hermes_cli/source_build.py:build_update_products": ["build_source_tui", "build_source_web"],
        "hermes_cli/source_build.py:node_dependencies": ["prepare_source_dependencies", "source_build_env"],
        "hermes_cli/source_build.py:prepare_launch_dependencies": ["prepare_source_dependencies"],
        "hermes_cli/source_build.py:prepare_source_dependencies": ["run_source_script"],
    }


def test_user_facing_entry_points_are_the_counted_ones():
    """`hermes --tui` / `hermes chat --tui` (Desktop's "open in terminal"), the dashboard Chat tab's
    /api/pty, `hermes dashboard`, the `hermes update` tail, the source/ZIP completion and
    `python -m hermes_cli.source_build`; `hermes desktop` is cmd_gui (an argparse handler, counted above)."""
    assert _callers({"_make_tui_argv", "_build_web_ui", "build_update_products"}) == {
        "hermes_cli/main_dashboard.py:_resolve_dashboard_web_dist": ["_build_web_ui"],
        "hermes_cli/main_tui_launch.py:_launch_tui": ["_make_tui_argv"],
        "hermes_cli/source_build.py:<module>": ["build_update_products"],
        "hermes_cli/source_completion.py:_complete_locked": ["build_update_products"],
        "hermes_cli/update_finish.py:main": ["build_update_products"],
        "hermes_cli/web_server_chat.py:_resolve_chat_argv": ["_make_tui_argv"],
    }
