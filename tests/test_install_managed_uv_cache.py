"""Regression guards for the Hermes-managed uv cache on macOS and Windows."""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parent.parent
INSTALL_SH = REPO_ROOT / "scripts" / "install.sh"
INSTALL_PS1 = REPO_ROOT / "scripts" / "install.ps1"


def _extract_sh_function(name: str) -> str:
    text = INSTALL_SH.read_text(encoding="utf-8")
    match = re.search(
        rf"^{re.escape(name)}\(\) \{{.*?^\}}",
        text,
        re.DOTALL | re.MULTILINE,
    )
    assert match is not None, f"{name}() not found in install.sh"
    return match.group(0)


@pytest.mark.skipif(shutil.which("bash") is None, reason="needs bash")
@pytest.mark.parametrize(
    ("explicit_cache", "expected_suffix"),
    [
        (None, "/managed-home/cache/uv"),
        ("/operator/cache", "/operator/cache"),
    ],
)
def test_install_sh_managed_uv_cache_is_hermes_scoped_and_overrideable(
    tmp_path: Path,
    explicit_cache: str | None,
    expected_suffix: str,
) -> None:
    function = _extract_sh_function("configure_managed_uv_cache")
    managed_home = tmp_path / "managed-home"
    env_line = (
        "unset UV_CACHE_DIR\n"
        if explicit_cache is None
        else f'export UV_CACHE_DIR="{explicit_cache}"\n'
    )
    script = (
        "set -e\n"
        f'HERMES_HOME="{managed_home}"\n'
        f"{env_line}"
        f"{function}\n"
        "configure_managed_uv_cache\n"
        'printf "%s" "$UV_CACHE_DIR"\n'
    )

    result = subprocess.run(
        ["bash", "-c", script],
        text=True,
        capture_output=True,
        check=True,
    )

    assert result.stdout.endswith(expected_suffix)


def test_install_sh_configures_cache_before_using_managed_uv() -> None:
    body = _extract_sh_function("install_uv")
    configure_idx = body.index("configure_managed_uv_cache")
    managed_uv_idx = body.index('local _managed_uv="$HERMES_HOME/bin/uv"')
    assert configure_idx < managed_uv_idx


def test_install_ps1_uses_same_hermes_scoped_cache_contract() -> None:
    source = INSTALL_PS1.read_text(encoding="utf-8")
    function = re.search(
        r"function Set-ManagedUvCache \{(?P<body>[\s\S]*?)^\}",
        source,
        re.MULTILINE,
    )
    assert function is not None
    body = function.group("body")
    assert "if (-not $env:UV_CACHE_DIR)" in body
    assert '$env:UV_CACHE_DIR = Join-Path $HermesHome "cache\\uv"' in body
    assert source.index("Set-ManagedUvCache\n") < source.index("function Install-Uv")
