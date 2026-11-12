"""Vendored third-party code stays as recorded (apex_overlay/vendor/README.md): every file is either byte-for-byte
upstream, with its sha256 in ``<package>.SOURCE.json``, or listed there as changed or added with the reason."""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest

VENDOR = Path(__file__).resolve().parents[2] / "apex_overlay" / "vendor"
PACKAGES = sorted(p.name.removesuffix(".SOURCE.json") for p in VENDOR.glob("*.SOURCE.json"))


def _files(package: Path) -> set[str]:
    return {p.relative_to(package).as_posix() for p in package.rglob("*")
            if p.is_file() and "__pycache__" not in p.parts}


@pytest.mark.parametrize("name", PACKAGES)
def test_every_vendored_file_is_upstream_or_a_recorded_change(name):
    record = json.loads((VENDOR / f"{name}.SOURCE.json").read_text(encoding="utf-8"))
    package = VENDOR / name
    present = _files(package)
    unchanged = record["unchanged_sha256"]
    assert present == set(unchanged) | set(record["changed"]) | set(record["added"])
    for rel, digest in unchanged.items():
        assert hashlib.sha256((package / rel).read_bytes()).hexdigest() == digest, f"{rel} differs from upstream"
    assert not present & set(record["removed"])


def test_pyjianyingdraft_needs_none_of_the_dependencies_it_was_vendored_to_avoid():
    blocked = ("pymediainfo", "imageio", "uiautomation", "numpy")
    code = (
        "import sys\n"
        f"for name in {blocked!r}: sys.modules[name] = None\n"
        "import apex_overlay.vendor.pyJianYingDraft as d\n"
        "assert d.TransitionType.from_name('叠化').value.is_vip is False\n"
        "assert not hasattr(d, 'JianyingController')\n"
    )
    done = subprocess.run([sys.executable, "-c", code], cwd=VENDOR.parents[1], capture_output=True, text=True,
                          stdin=subprocess.DEVNULL, timeout=60, check=False)
    assert done.returncode == 0, done.stderr


def test_pyjianyingdraft_carries_the_two_pr198_changes():
    from apex_overlay.vendor.pyJianYingDraft.draft_folder import DRAFT_FILE_NAME
    from apex_overlay.vendor.pyJianYingDraft.script_file import MATERIALS_DIR_NAME, ScriptFile

    assert (DRAFT_FILE_NAME, MATERIALS_DIR_NAME) == ("draft_info.json", "materials")
    assert "inline_materials" in ScriptFile.save.__code__.co_varnames
