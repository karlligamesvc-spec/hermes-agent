"""Windows behavior smoke for install.ps1 runtime integrity and locked repair."""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
SMOKE = REPO_ROOT / "scripts" / "tests" / "test-install-ps1-runtime-integrity.ps1"


@pytest.mark.skipif(sys.platform != "win32", reason="PowerShell installer behavior is Windows-only")
def test_install_ps1_runtime_integrity_and_locked_repair() -> None:
    powershell = shutil.which("pwsh") or shutil.which("powershell")
    assert powershell, "Windows test host must provide PowerShell"
    result = subprocess.run(
        [powershell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(SMOKE)],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "runtime integrity behavior: PASS" in result.stdout
