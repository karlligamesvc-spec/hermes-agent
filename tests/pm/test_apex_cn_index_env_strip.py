"""hc-472 / hc-911: pm's isolated runtime builder strips the CN mirror index env.

``apexnodes_apply_cn_mirror_env`` exports a CN default package index (``UV_DEFAULT_INDEX``,
``UV_INDEX_URL``; Tsinghua TUNA). ``uv.lock`` records the registry each package resolved
against, so that env must never reach pm's ``uv sync --locked`` or uv re-resolves against the
mirror and refuses. Drives pm's real ``PythonEnvironment._run`` with the env the real CN lib
exports and a fake ``uv`` that records what it received. Lives under tests/pm because only
these tests may reach pm's private environment engine (ruff.toml TID251).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from pm.environment import PythonEnvironment

REPO_ROOT = Path(__file__).resolve().parents[2]
LIB_SH = REPO_ROOT / "scripts" / "lib" / "apexnodes-region-detect.sh"
_INDEX_ENV_VARS = ("UV_DEFAULT_INDEX", "UV_INDEX_URL", "UV_EXTRA_INDEX_URL", "UV_INDEX")


def _cn_lib_env(tmp_path: Path) -> dict[str, str]:
    """The environment after the real CN lib has applied its mirror defaults."""
    script = f'set -u\nsource "{LIB_SH}"\napexnodes_apply_cn_mirror_env\nenv -0'
    clean = {k: v for k, v in os.environ.items() if not k.startswith(("UV_", "PIP_"))}
    clean |= {"HERMES_CN_MIRRORS": "1", "HERMES_HOME": str(tmp_path / "home")}
    out = subprocess.run(["bash", "-c", script], env=clean, capture_output=True, check=True).stdout
    env = dict(item.split("=", 1) for item in out.decode().split("\0") if "=" in item)
    exported = [name for name in (*_INDEX_ENV_VARS, "PIP_INDEX_URL") if env.get(name)]
    # Prove the fault is present before testing that pm removes it (AGENTS.md #14).
    assert {"UV_DEFAULT_INDEX", "UV_INDEX_URL"} <= set(exported), exported
    return env


def _fake_uv(tmp_path: Path) -> tuple[Path, Path]:
    record = tmp_path / "uv-received.json"
    uv = tmp_path / "uv"
    uv.write_text(
        f"#!{sys.executable}\nimport json, os, sys\n"
        f"json.dump({{'argv': sys.argv[1:], 'env': dict(os.environ)}}, open({str(record)!r}, 'w'))\n",
        encoding="utf-8",
    )
    uv.chmod(0o755)
    return uv, record


def _received(tmp_path: Path, *, no_config: bool) -> dict:
    uv, record = _fake_uv(tmp_path)
    environment = PythonEnvironment(
        uv=uv, python=Path(sys.executable), destination=tmp_path / "venv",
        cache=tmp_path / "cache", env=_cn_lib_env(tmp_path), no_config=no_config,
    )
    result = environment._run(["sync", "--locked"], cwd=tmp_path, timeout=30)
    assert result.returncode == 0, result.stderr
    return json.loads(record.read_text(encoding="utf-8"))


@pytest.mark.skipif(shutil.which("bash") is None or sys.platform == "win32", reason="needs bash + a #! uv stub")
def test_pm_runtime_builder_strips_the_cn_index_env_from_the_locked_sync(tmp_path: Path):
    seen = _received(tmp_path, no_config=True)
    leaked = {name: seen["env"][name] for name in _INDEX_ENV_VARS if name in seen["env"]}
    assert not leaked, f"CN index env reached `uv sync --locked`: {leaked}"
    assert "--no-config" in seen["argv"]
    # Only index redirects go; the CN transport/tool mirrors stay for the processes that read them.
    assert seen["env"].get("npm_config_registry") == "https://registry.npmmirror.com"


@pytest.mark.skipif(shutil.which("bash") is None or sys.platform == "win32", reason="needs bash + a #! uv stub")
def test_without_isolation_the_cn_index_env_does_reach_uv(tmp_path: Path):
    """The harness can see the fault: a non-isolated run keeps the mirror index."""
    seen = _received(tmp_path, no_config=False)
    assert seen["env"].get("UV_DEFAULT_INDEX") == "https://pypi.tuna.tsinghua.edu.cn/simple"
