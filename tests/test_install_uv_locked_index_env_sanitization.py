"""hc-472 followup: the CN mirror index env must never reach the locked runtime sync.

``apexnodes_apply_cn_mirror_env`` (scripts/lib/apexnodes-region-detect.sh) /
``Set-ApexCnMirrorEnv`` (.ps1) export a CN default package index (``UV_DEFAULT_INDEX``,
``UV_INDEX_URL``, ``PIP_INDEX_URL``; Tsinghua TUNA) when ``HERMES_CN_MIRRORS=1``.
``uv.lock`` records the registry each package was resolved against, so with that env
active ``uv sync --locked`` re-resolves against the mirror and refuses ("The lockfile
needs to be updated"). Before hc-472 every CN install then fell through to an
unverified ``uv pip install`` tier.

hc-911 (v0.22): the installers no longer run uv themselves; they hand the install to
``pm``, whose isolated runtime builder (``pm.runtime_stage``, ``no_config=True``) drops
every index-redirect setting before its ``uv sync --locked``. These tests drive pm's real
``PythonEnvironment._run`` with the env our CN lib actually exports and a fake ``uv`` that
records what it received (tests/pm/test_apex_cn_index_env_strip.py — the only place tests may
reach pm's private engine). The release gate (scripts/verify-environment.py) pins the same
wiring statically, and this file guards that gate.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BUILD_BUNDLE = REPO_ROOT / "scripts" / "build-runtime-bundle.mjs"
VERIFY_ENVIRONMENT = REPO_ROOT / "scripts" / "verify-environment.py"

_INDEX_ENV_VARS = ("UV_DEFAULT_INDEX", "UV_INDEX_URL", "UV_EXTRA_INDEX_URL", "UV_INDEX")


def test_runtime_stage_requests_isolation():
    source = (REPO_ROOT / "pm" / "runtime_stage.py").read_text(encoding="utf-8")
    assert "no_config=True" in source


def test_release_environment_guard_passes_on_this_tree():
    spec = importlib.util.spec_from_file_location("verify_environment", VERIFY_ENVIRONMENT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    checks = {name: ok for name, ok, _ in module.static_source_checks(REPO_ROOT / "apexnodes-environment.yaml")}
    assert checks == {
        "pm artifact mirror honors the CN COS copy": True,
        "pm runtime builder strips mirror index env from the locked sync": True,
    }


def test_build_runtime_bundle_strips_the_same_index_env():
    """The bundle build runs its own `uv sync --locked` outside pm."""
    bundle_src = BUILD_BUNDLE.read_text(encoding="utf-8")
    for var in (*_INDEX_ENV_VARS, "PIP_INDEX_URL", "PIP_EXTRA_INDEX_URL", "UV_NO_CONFIG"):
        assert f"'{var}'" in bundle_src, f"build-runtime-bundle.mjs no longer strips {var}"
