"""Guard: install.ps1's repository stage must survive a checkout that has no .git.

WHAT BROKE (hc-633). 2026-07-31, mainland-China Windows, first launch of 0.17.4:

    [OK] Runtime source ready from COS mirror (8ca1d63be9b9...)
    -> Configuring git for Windows compatibility...
    stage 'repository' failed: fatal: not in a git directory

Install-RuntimeFromCos unpacks a SOURCE TARBALL: a plain tree built from the
pinned commit, with no .git. Everything the old repository stage ran after the
clone block was repo-scoped git, and under EAP=Stop the stderr line terminated
the stage on exactly the path every mainland install takes.

v0.22 SHAPE (hc-911). Upstream's Stage-Repository refuses any non-empty
directory without .git (``dir_not_checkout``) and provisions Git before anything
else. The ApexNodes COS seam therefore has to be the FIRST thing the stage does,
must not run git, and must ``return`` on every success path so none of the
upstream git code below it ever sees a COS tree. No pwsh on the CI runner, so this
file pins that structure; install.sh's twin is exercised for real in
tests/test_install_sh_update_integrity.py (git stubbed to fail).
"""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
INSTALL_PS1 = REPO_ROOT / "scripts" / "install.ps1"
GIT_CALL = re.compile(r"(?<![\w-])git(?:\.exe)?\s+(?!for\b)")


def _stage_repository() -> list[str]:
    """Stage-Repository's lines, comment lines blanked (they quote the commands)."""
    text = INSTALL_PS1.read_text(encoding="utf-8")
    start = text.index("function Stage-Repository")
    body = text[start : text.index("\nfunction ", start + 1)]
    return ["" if line.lstrip().startswith("#") else line for line in body.splitlines()]


def _cos_block(lines: list[str]) -> tuple[int, int]:
    starts = [i for i, l in enumerate(lines) if l.startswith("    if ((Get-Command Test-CosConfigured")]
    assert len(starts) == 1, f"expected exactly one COS block in Stage-Repository, found {len(starts)}"
    end = next(i for i in range(starts[0] + 1, len(lines)) if lines[i] == "    }")
    return starts[0], end


def test_cos_block_runs_before_any_git_and_before_the_occupied_dir_refusal():
    lines = _stage_repository()
    start, end = _cos_block(lines)
    first = {
        "git call": next(i for i, l in enumerate(lines) if GIT_CALL.search(l)),
        "Ensure-Git": next(i for i, l in enumerate(lines) if "Ensure-Git" in l),
        "dir_not_checkout refusal": next(i for i, l in enumerate(lines) if "dir_not_checkout" in l),
    }
    for what, index in first.items():
        assert start < index, f"the COS block must come before the first {what}"
        assert end < index, f"the {what} must not sit inside the COS block"


def test_cos_block_never_runs_git():
    lines = _stage_repository()
    start, end = _cos_block(lines)
    offenders = [l.strip() for l in lines[start : end + 1] if GIT_CALL.search(l)]
    assert not offenders, f"a COS tree has no .git; git inside the COS block: {offenders}"


def test_every_cos_success_path_returns_and_a_stale_tree_is_fatal():
    lines = _stage_repository()
    start, end = _cos_block(lines)
    block = "\n".join(lines[start : end + 1])
    assert block.count("return") == 2, "both COS success paths (reuse/re-extract, fresh) must return"
    assert "Ensure-CosRuntimeSourceCurrent -InstallDir $InstallDir -Commit $Commit -Branch $Branch" in block
    assert re.search(r'Fail "[^"]*stale[^"]*" download_failed', block), (
        "a stale COS tree that cannot be refreshed must fail the stage, never fall through"
    )
    # Fresh install: only when nothing is there yet, so a user's directory is never overwritten.
    assert "(-not (Test-Path -LiteralPath $InstallDir)) -and (Install-RuntimeFromCos)" in block
