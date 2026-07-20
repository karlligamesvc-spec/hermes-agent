"""hc-569: desktop engine fast-update channel in install.sh.

A dependency-unchanged engine update still paid for the full bootstrap:
~9s of prerequisites probes on every run, a ~5s read-only ``uv sync --locked
--check`` in python-deps, and an unconditional ``npx playwright install``
no-op re-run dominating the 20-40s node-deps stage. hc-569 short-circuits
exactly those *dependency-install* segments — never the tree-integrity
verification (bootstrap-runner ``evaluateTreeIntegrity``, untouched) and
never the gateway restart:

* ``python_deps_fingerprint`` / ``python_deps_up_to_date`` /
  ``python_deps_mark_installed``: repo-local ``.python-deps-installed``
  marker holding the cksum of ``uv.lock``, written ONLY after a
  lock-verified install; a matching fingerprint plus an importable venv
  skips the whole python-deps segment without invoking uv.
* ``install_node_deps`` whole-stage fast path: both npm fingerprints
  unchanged AND a browser already provisioned skips the stage including the
  ``npx playwright install`` re-run.
* ``prereq_fast_pass`` / ``prereq_record_success``: a <7-day cache of the
  last fully-successful prerequisites chain keyed by a cheap
  machine+toolchain fingerprint fast-passes the stage.
* ``invalidate_fast_path_caches``: ANY stage failure drops every fast-path
  cache (self-heal first — the next attempt runs the full path).

Everything is fail-open by construction: missing marker, hash mismatch,
missing venv/browser, unparseable cache, or a non ``--stage`` invocation all
fall through to the previous full behavior.
"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
INSTALL_SH = REPO_ROOT / "scripts" / "install.sh"

pytestmark = pytest.mark.skipif(
    subprocess.run(["bash", "--version"], capture_output=True).returncode != 0,
    reason="needs bash",
)


def _extract_function(name: str) -> str:
    text = INSTALL_SH.read_text()
    match = re.search(rf"^{re.escape(name)}\(\) \{{.*?\n\}}", text, re.DOTALL | re.MULTILINE)
    assert match is not None, f"{name}() not found in install.sh"
    return match.group(0)


STUB_LOGGERS = "\n".join(
    [
        'log_info() { echo "INFO: $*"; }',
        'log_success() { echo "SUCCESS: $*"; }',
        'log_warn() { echo "WARN: $*"; }',
        'log_error() { echo "ERROR: $*"; }',
    ]
)


# ---------------------------------------------------------------------------
# Static guards: red line + wiring
# ---------------------------------------------------------------------------


def test_red_line_tree_integrity_untouched() -> None:
    """hc-569 red line: the fast-update channel must not touch the hc-543
    update-integrity machinery. The stamp writer keeps its name and the
    bootstrap runner keeps evaluateTreeIntegrity byte-recognizable."""
    lib = (REPO_ROOT / "scripts" / "lib" / "apexnodes-region-detect.sh").read_text()
    assert '.hermes-source-commit' in lib
    runner = (REPO_ROOT / "apps" / "desktop" / "electron" / "bootstrap-runner.cjs").read_text()
    assert "function evaluateTreeIntegrity" in runner
    assert "commit_mismatch" in runner


def test_install_deps_consults_fingerprint_before_uv_check() -> None:
    fn = _extract_function("install_deps")
    idx_fp = fn.find('python_deps_up_to_date "$INSTALL_DIR"')
    idx_uv_check = fn.find("_uv_sync_locked --check")
    idx_locked_sync = fn.find("if _uv_sync_locked; then")
    assert idx_fp != -1, "install_deps must consult the python-deps fingerprint fast path"
    assert idx_uv_check != -1 and idx_locked_sync != -1
    assert idx_fp < idx_uv_check, "the fingerprint fast path must run BEFORE the ~5s uv --check probe"
    # The fast path is desktop --stage only: the monolithic path is unchanged.
    gate = fn.find('[ -n "$STAGE_NAME" ]')
    assert gate != -1 and gate < idx_fp, "the fingerprint fast path must be gated to --stage mode"


def test_install_deps_marks_fingerprint_only_on_lock_verified_paths() -> None:
    fn = _extract_function("install_deps")
    marks = [m.start() for m in re.finditer(re.escape('python_deps_mark_installed "$INSTALL_DIR"'), fn)]
    assert len(marks) == 2, (
        "expected exactly two fingerprint writes: after the uv --check pass and "
        f"after the locked sync success (found {len(marks)})"
    )
    idx_tiers = fn.find("Multi-tier fallback")
    assert idx_tiers != -1
    assert all(m < idx_tiers for m in marks), (
        "the fingerprint must never be recorded on an unlocked tier install — "
        "a degraded env must keep re-verifying on every update"
    )
    # Entering the unlocked tiers must drop any stale marker so a
    # tier-degraded env can never be fast-skipped later.
    idx_drop = fn.find('rm -f "$(python_deps_marker_path "$INSTALL_DIR")"')
    assert idx_drop != -1 and idx_drop < idx_tiers


def test_setup_venv_drops_python_marker_before_recreating_venv() -> None:
    fn = _extract_function("setup_venv")
    idx_drop = fn.find('rm -f "$(python_deps_marker_path "$INSTALL_DIR")"')
    idx_create = fn.find("venv venv --python")
    assert idx_drop != -1, "setup_venv must invalidate the python-deps fingerprint when recreating the venv"
    assert idx_create != -1
    assert idx_drop < idx_create, "the marker must be dropped BEFORE the empty venv exists"


def test_install_node_deps_whole_stage_fast_path_wiring() -> None:
    fn = _extract_function("install_node_deps")
    idx_fast = fn.find("node_browser_provisioned")
    idx_npm = fn.find('run_with_timeout "$NODE_DEPS_TIMEOUT" npm install --silent')
    idx_playwright = fn.find("run_playwright_install")
    assert idx_fast != -1, "install_node_deps must gate the whole-stage fast path on node_browser_provisioned"
    assert idx_npm != -1 and idx_playwright != -1
    assert idx_fast < idx_npm and idx_fast < idx_playwright, (
        "the whole-stage fast path must run before npm install AND before the playwright re-run"
    )
    gate = fn.find('[ -n "$STAGE_NAME" ]')
    assert gate != -1 and gate < idx_npm, "the node fast path must be gated to --stage mode"
    # Both npm projects' fingerprints must participate.
    assert 'node_deps_up_to_date "$INSTALL_DIR"' in fn
    assert 'node_deps_up_to_date "$INSTALL_DIR/ui-tui"' in fn


def test_prerequisites_stage_wires_fast_pass_and_records_success() -> None:
    fn = _extract_function("run_stage_body")
    prereq_case = fn[fn.find("prerequisites)") : fn.find("repository)")]
    assert "prereq_fast_pass" in prereq_case
    idx_pass = prereq_case.find("prereq_fast_pass")
    idx_chain = prereq_case.find("install_uv")
    idx_record = prereq_case.find("prereq_record_success")
    assert idx_chain != -1 and idx_record != -1
    assert idx_pass < idx_chain, "the fast pass must be consulted before the full chain"
    assert idx_record > idx_chain, "the cache may only be recorded after the full chain succeeded"


def test_run_stage_protocol_invalidates_caches_on_failure() -> None:
    fn = _extract_function("run_stage_protocol")
    idx_invalidate = fn.find("invalidate_fast_path_caches")
    assert idx_invalidate != -1, "a failed stage must drop every fast-path cache (self-heal)"
    assert fn.find('[ "$code" -ne 0 ]') != -1
    assert fn.find('[ "$code" -ne 0 ]') < idx_invalidate


# ---------------------------------------------------------------------------
# Behavioral: python-deps fingerprint trio
# ---------------------------------------------------------------------------


def _py_trio_harness() -> str:
    return "\n".join(
        _extract_function(name)
        for name in (
            "python_deps_marker_path",
            "python_deps_fingerprint",
            "python_deps_up_to_date",
            "python_deps_mark_installed",
        )
    )


def _run_py_trio(script: str, cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", "-c", f"set -e\n{_py_trio_harness()}\n{script}"],
        cwd=cwd,
        capture_output=True,
        text=True,
    )


def _seed_python_tree(root: Path, importable: bool = True) -> None:
    (root / "uv.lock").write_text("version = 1\n[[package]]\nname='x'\n")
    venv_bin = root / "venv" / "bin"
    venv_bin.mkdir(parents=True)
    python = venv_bin / "python"
    python.write_text("#!/bin/bash\nexit 0\n" if importable else "#!/bin/bash\nexit 1\n")
    python.chmod(0o755)


def test_python_fresh_tree_without_marker_needs_install(tmp_path: Path) -> None:
    _seed_python_tree(tmp_path)
    res = _run_py_trio('python_deps_up_to_date "$PWD" && echo UP_TO_DATE || echo NEEDS_INSTALL', tmp_path)
    assert res.returncode == 0, res.stderr
    assert "NEEDS_INSTALL" in res.stdout


def test_python_marked_and_unchanged_is_up_to_date(tmp_path: Path) -> None:
    _seed_python_tree(tmp_path)
    res = _run_py_trio(
        'python_deps_mark_installed "$PWD"\n'
        'python_deps_up_to_date "$PWD" && echo UP_TO_DATE || echo NEEDS_INSTALL',
        tmp_path,
    )
    assert res.returncode == 0, res.stderr
    assert "UP_TO_DATE" in res.stdout


def test_python_uv_lock_change_invalidates(tmp_path: Path) -> None:
    _seed_python_tree(tmp_path)
    res = _run_py_trio(
        'python_deps_mark_installed "$PWD"\n'
        "echo 'version = 2' >> uv.lock\n"
        'python_deps_up_to_date "$PWD" && echo UP_TO_DATE || echo NEEDS_INSTALL',
        tmp_path,
    )
    assert res.returncode == 0, res.stderr
    assert "NEEDS_INSTALL" in res.stdout, "an updated uv.lock must force the full install path"


def test_python_missing_venv_interpreter_forces_install(tmp_path: Path) -> None:
    _seed_python_tree(tmp_path)
    res = _run_py_trio(
        'python_deps_mark_installed "$PWD"\n'
        "rm -rf venv\n"
        'python_deps_up_to_date "$PWD" && echo UP_TO_DATE || echo NEEDS_INSTALL',
        tmp_path,
    )
    assert res.returncode == 0, res.stderr
    assert "NEEDS_INSTALL" in res.stdout, "a fresh marker must never vouch for a deleted venv"


def test_python_failed_import_probe_forces_install(tmp_path: Path) -> None:
    """A marker that outlived its venv contents (recreated venv, gutted
    site-packages) must not be trusted: the import probe is the decisive
    guard and must fail toward the full install."""
    _seed_python_tree(tmp_path, importable=False)
    res = _run_py_trio(
        'python_deps_mark_installed "$PWD"\n'
        'python_deps_up_to_date "$PWD" && echo UP_TO_DATE || echo NEEDS_INSTALL',
        tmp_path,
    )
    assert res.returncode == 0, res.stderr
    assert "NEEDS_INSTALL" in res.stdout


def test_python_marker_write_failure_does_not_abort(tmp_path: Path) -> None:
    _seed_python_tree(tmp_path)
    res = _run_py_trio(
        'chmod 555 "$PWD"\n'
        'python_deps_mark_installed "$PWD"\n'
        "echo MARK_DID_NOT_ABORT\n"
        'chmod 755 "$PWD"',
        tmp_path,
    )
    assert res.returncode == 0, res.stderr
    assert "MARK_DID_NOT_ABORT" in res.stdout


# ---------------------------------------------------------------------------
# Behavioral: node_browser_provisioned
# ---------------------------------------------------------------------------


def _run_browser_probe(script: str, cwd: Path, extra: str = "") -> subprocess.CompletedProcess:
    harness = "\n".join(
        [
            STUB_LOGGERS,
            "SKIP_BROWSER=false",
            "OS=linux",
            extra,
            _extract_function("find_system_browser"),
            _extract_function("node_browser_provisioned"),
        ]
    )
    return subprocess.run(["bash", "-c", f"{harness}\n{script}"], cwd=cwd, capture_output=True, text=True)


def test_browser_provisioned_when_playwright_cache_has_chromium(tmp_path: Path) -> None:
    cache = tmp_path / "pw-cache"
    (cache / "chromium-1187").mkdir(parents=True)
    res = _run_browser_probe(
        f'export PLAYWRIGHT_BROWSERS_PATH="{cache}"\n'
        "node_browser_provisioned && echo PROVISIONED || echo MISSING",
        tmp_path,
    )
    assert "PROVISIONED" in res.stdout, res.stdout + res.stderr


def test_browser_missing_cache_blocks_fast_path(tmp_path: Path) -> None:
    cache = tmp_path / "pw-cache-empty"
    cache.mkdir()
    res = _run_browser_probe(
        f'export PLAYWRIGHT_BROWSERS_PATH="{cache}"\n'
        "node_browser_provisioned && echo PROVISIONED || echo MISSING",
        tmp_path,
    )
    assert "MISSING" in res.stdout, (
        "no chromium build in the Playwright cache must fall through to the full "
        "stage so `playwright install` keeps self-healing on every update"
    )


def test_browser_skip_browser_flag_counts_as_provisioned(tmp_path: Path) -> None:
    res = _run_browser_probe(
        "SKIP_BROWSER=true\nnode_browser_provisioned && echo PROVISIONED || echo MISSING", tmp_path
    )
    assert "PROVISIONED" in res.stdout


def test_browser_explicit_override_counts_as_provisioned(tmp_path: Path) -> None:
    fake_browser = tmp_path / "mybrowser"
    fake_browser.write_text("#!/bin/bash\n")
    fake_browser.chmod(0o755)
    res = _run_browser_probe(
        f'export AGENT_BROWSER_EXECUTABLE_PATH="{fake_browser}"\n'
        "node_browser_provisioned && echo PROVISIONED || echo MISSING",
        tmp_path,
    )
    assert "PROVISIONED" in res.stdout


# ---------------------------------------------------------------------------
# Behavioral: prerequisites cache
# ---------------------------------------------------------------------------


def _prereq_harness(ttl_seconds: int = 604800, stage_name: str = "prerequisites") -> str:
    return "\n".join(
        [
            STUB_LOGGERS,
            'mark_stage_skipped() { echo "MARKED_SKIPPED code=${1:-} reason=${2:-}"; }',
            f'STAGE_NAME="{stage_name}"',
            "OS=macos",
            "DISTRO=macos",
            "DISTRO_VERSION=",
            "PYTHON_PATH=/bin/sh",
            f"PREREQ_CACHE_TTL_SECONDS={ttl_seconds}",
            _extract_function("prereq_cache_path"),
            _extract_function("prereq_fingerprint"),
            _extract_function("prereq_fast_pass"),
            _extract_function("prereq_record_success"),
        ]
    )


def _run_prereq(script: str, cwd: Path, hermes_home: Path, **kwargs) -> subprocess.CompletedProcess:
    full = f'set -e\nexport HERMES_HOME="{hermes_home}"\n{_prereq_harness(**kwargs)}\n{script}'
    return subprocess.run(["bash", "-c", full], cwd=cwd, capture_output=True, text=True)


def test_prereq_first_run_records_then_fast_passes(tmp_path: Path) -> None:
    home = tmp_path / "home"
    home.mkdir()
    res = _run_prereq(
        "prereq_fast_pass && echo FAST1 || echo FULL1\n"
        "prereq_record_success\n"
        "prereq_fast_pass && echo FAST2 || echo FULL2",
        tmp_path,
        home,
    )
    assert res.returncode == 0, res.stderr
    assert "FULL1" in res.stdout, "no cache yet: the first run must take the full chain"
    assert "FAST2" in res.stdout, "a fresh matching cache must fast-pass"
    assert "MARKED_SKIPPED code=prereq_cached" in res.stdout, "the fast pass must surface an honest skip reason"
    marker = home / "bootstrap-cache" / "prereq-check.marker"
    assert marker.exists()
    lines = marker.read_text().splitlines()
    assert len(lines) == 3, f"marker must hold fingerprint + epoch + python path, got: {lines}"
    assert lines[1].isdigit()


def test_prereq_fingerprint_mismatch_forces_full_chain(tmp_path: Path) -> None:
    import time

    home = tmp_path / "home"
    marker_dir = home / "bootstrap-cache"
    marker_dir.mkdir(parents=True)
    # Fresh epoch (in the TTL window) so the FINGERPRINT comparison is what
    # rejects the cache, exercising the old/new evidence log line.
    (marker_dir / "prereq-check.marker").write_text(
        f"v1|other|machine|fingerprint\n{int(time.time())}\n/bin/sh\n"
    )
    res = _run_prereq("prereq_fast_pass && echo FAST || echo FULL", tmp_path, home)
    assert res.returncode == 0, res.stderr
    assert "FULL" in res.stdout
    assert "fingerprint changed" in res.stdout, "a mismatch must log the old/new fingerprint evidence"


def test_prereq_expired_ttl_forces_full_chain(tmp_path: Path) -> None:
    home = tmp_path / "home"
    home.mkdir()
    res = _run_prereq(
        "prereq_record_success\nprereq_fast_pass && echo FAST || echo FULL",
        tmp_path,
        home,
        ttl_seconds=0,
    )
    assert res.returncode == 0, res.stderr
    assert "FULL" in res.stdout, "TTL=0 must never fast-pass"


def test_prereq_recorded_python_gone_forces_full_chain(tmp_path: Path) -> None:
    home = tmp_path / "home"
    home.mkdir()
    res = _run_prereq(
        "PYTHON_PATH=/nonexistent/python3.11\n"
        "prereq_record_success\n"
        "prereq_fast_pass && echo FAST || echo FULL",
        tmp_path,
        home,
    )
    assert res.returncode == 0, res.stderr
    assert "FULL" in res.stdout, "a vanished python interpreter must invalidate the fast pass"


def test_prereq_malformed_cache_fails_open(tmp_path: Path) -> None:
    home = tmp_path / "home"
    marker_dir = home / "bootstrap-cache"
    marker_dir.mkdir(parents=True)
    (marker_dir / "prereq-check.marker").write_text("garbage\nnot-a-number\n")
    res = _run_prereq("prereq_fast_pass && echo FAST || echo FULL", tmp_path, home)
    assert res.returncode == 0, res.stderr
    assert "FULL" in res.stdout


def test_prereq_never_engages_outside_stage_mode(tmp_path: Path) -> None:
    home = tmp_path / "home"
    home.mkdir()
    res = _run_prereq(
        "prereq_record_success\nprereq_fast_pass && echo FAST || echo FULL",
        tmp_path,
        home,
        stage_name="",
    )
    assert res.returncode == 0, res.stderr
    assert "FULL" in res.stdout, "the monolithic (non --stage) path must never fast-pass"
    marker = home / "bootstrap-cache" / "prereq-check.marker"
    assert not marker.exists(), "the monolithic path must not write the cache either"


# ---------------------------------------------------------------------------
# Behavioral: stage protocol — skip reason threading + failure invalidation
# ---------------------------------------------------------------------------


def _protocol_harness(body: str) -> str:
    """run_stage_protocol with a scripted run_stage_body."""
    return "\n".join(
        [
            STUB_LOGGERS,
            _extract_function("json_escape"),
            _extract_function("emit_stage_json"),
            _extract_function("mark_stage_skipped"),
            _extract_function("stage_needs_user_input"),
            _extract_function("prereq_cache_path"),
            _extract_function("python_deps_marker_path"),
            _extract_function("node_deps_marker_path"),
            _extract_function("invalidate_fast_path_caches"),
            "NON_INTERACTIVE=true",
            "JSON_OUTPUT=true",
            f"run_stage_body() {{ {body}; }}",
            _extract_function("run_stage_protocol"),
        ]
    )


def _last_json_frame(stdout: str) -> dict:
    for line in reversed([ln for ln in stdout.splitlines() if ln.strip()]):
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict) and "stage" in parsed:
            return parsed
    raise AssertionError(f"no JSON result frame in output:\n{stdout}")


def test_skip_frame_carries_code_and_reason(tmp_path: Path) -> None:
    harness = _protocol_harness('mark_stage_skipped deps_unchanged "uv.lock unchanged (fingerprint 123-456)"')
    res = subprocess.run(
        ["bash", "-c", f'set -e\nexport HERMES_HOME="{tmp_path}"\nINSTALL_DIR=\n{harness}\nrun_stage_protocol python-deps'],
        capture_output=True,
        text=True,
    )
    assert res.returncode == 0, res.stderr
    frame = _last_json_frame(res.stdout)
    assert frame == {
        "ok": True,
        "stage": "python-deps",
        "skipped": True,
        "reason": "uv.lock unchanged (fingerprint 123-456)",
        "skip_code": "deps_unchanged",
    }


def test_legacy_no_arg_skip_frame_shape_unchanged(tmp_path: Path) -> None:
    """Existing callers (setup_venv, network cache) skip with no arguments —
    their frame must stay byte-compatible: no reason, no skip_code."""
    harness = _protocol_harness("mark_stage_skipped")
    res = subprocess.run(
        ["bash", "-c", f'set -e\nexport HERMES_HOME="{tmp_path}"\nINSTALL_DIR=\n{harness}\nrun_stage_protocol venv'],
        capture_output=True,
        text=True,
    )
    assert res.returncode == 0, res.stderr
    frame = _last_json_frame(res.stdout)
    assert frame == {"ok": True, "stage": "venv", "skipped": True}


def test_stage_failure_invalidates_every_fast_path_cache(tmp_path: Path) -> None:
    home = tmp_path / "home"
    tree = tmp_path / "tree"
    (home / "bootstrap-cache").mkdir(parents=True)
    (tree / "ui-tui").mkdir(parents=True)
    prereq = home / "bootstrap-cache" / "prereq-check.marker"
    network = home / "bootstrap-cache" / "network-check.marker"
    py_marker = tree / ".python-deps-installed"
    node_marker = tree / ".node-deps-installed"
    tui_marker = tree / "ui-tui" / ".node-deps-installed"
    for f in (prereq, network, py_marker, node_marker, tui_marker):
        f.write_text("stale\n")

    # node-deps (NOT a needs_user_input stage, which would short-circuit to a
    # skip before the scripted failing body ever ran).
    harness = _protocol_harness("return 1")
    res = subprocess.run(
        [
            "bash",
            "-c",
            f'set -e\nexport HERMES_HOME="{home}"\nINSTALL_DIR="{tree}"\n{harness}\n'
            "run_stage_protocol node-deps || true",
        ],
        capture_output=True,
        text=True,
    )
    assert res.returncode == 0, res.stderr
    frame = _last_json_frame(res.stdout)
    assert frame["ok"] is False
    for f in (prereq, network, py_marker, node_marker, tui_marker):
        assert not f.exists(), f"{f.name} must be dropped after a stage failure (self-heal)"


def test_stage_success_keeps_fast_path_caches(tmp_path: Path) -> None:
    home = tmp_path / "home"
    tree = tmp_path / "tree"
    (home / "bootstrap-cache").mkdir(parents=True)
    tree.mkdir()
    prereq = home / "bootstrap-cache" / "prereq-check.marker"
    py_marker = tree / ".python-deps-installed"
    prereq.write_text("fresh\n")
    py_marker.write_text("fresh\n")

    harness = _protocol_harness("return 0")
    res = subprocess.run(
        [
            "bash",
            "-c",
            f'set -e\nexport HERMES_HOME="{home}"\nINSTALL_DIR="{tree}"\n{harness}\nrun_stage_protocol config',
        ],
        capture_output=True,
        text=True,
    )
    assert res.returncode == 0, res.stderr
    assert prereq.exists() and py_marker.exists(), "a successful stage must not drop the caches"
