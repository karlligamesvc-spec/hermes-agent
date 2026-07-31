"""Regression: every shipped .ps1 must stay pure ASCII.

Issues #66994 / #67000 reported the Windows GUI installer (Hermes-Setup.exe)
crashing before it did anything, with a cascade of PowerShell parser errors at
lines 1619 / 1770 ("Missing argument in parameter list", "A 'using' statement
must appear before any other statements in a script").

Root cause: ``scripts/install.ps1`` has no UTF-8 BOM, and a commit added two
non-ASCII characters *inside double-quoted string literals* (a bullet and an
em-dash). Windows PowerShell 5.1 -- which the bootstrap runs the cached script
under -- reads a BOM-less ``.ps1`` in the system ANSI code page (e.g. CP1252),
not UTF-8. The em-dash's UTF-8 tail byte (0x94) decodes to a "smart" close-quote
(U+201D), which the PowerShell tokenizer treats as a string delimiter. That
prematurely closes the string and desyncs the parser for the rest of the file,
surfacing as unrelated syntax errors far downstream.

Non-ASCII bytes inside ``#`` comments are harmless (the tokenizer skips a
comment to end-of-line regardless of what it contains), which is why the file
carried em-dashes in comments for months without breaking -- only a non-ASCII
byte in *code* (a string literal) triggers the desync.

This test is source-level because Linux CI cannot execute the PowerShell
installer. Keeping the whole file ASCII-only is the transport-independent
invariant: pure ASCII cannot be misdecoded under any code page, BOM or not, so
the bug class cannot recur -- in a comment or a string.

hc-632 widened this from install.ps1 to EVERY .ps1 in the repo. The original
guard pinned the one file that had been caught, but install.ps1 dot-sources
scripts/lib/apexnodes-region-detect.ps1, which is BOM-less all the same and was
carrying four em-dashes with nothing watching it -- a desync there lands in the
same parser, during the same install. Discovering it took enumerating the .ps1
files rather than re-reading the one that broke (AGENTS.md #12).
"""

from __future__ import annotations

from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parent.parent
SKIP_DIRS = {".venv", "node_modules", ".git"}


def _shipped_ps1_files() -> list[Path]:
    return sorted(
        p for p in REPO_ROOT.rglob("*.ps1") if not SKIP_DIRS.intersection(p.relative_to(REPO_ROOT).parts)
    )


def test_the_guard_actually_sees_the_installer_and_its_lib() -> None:
    """A discovery-based guard that discovers nothing passes vacuously."""
    found = {p.relative_to(REPO_ROOT).as_posix() for p in _shipped_ps1_files()}
    assert {"scripts/install.ps1", "scripts/lib/apexnodes-region-detect.ps1"} <= found, found


@pytest.mark.parametrize("path", _shipped_ps1_files(), ids=lambda p: p.name)
def test_ps1_is_pure_ascii(path: Path) -> None:
    raw = path.read_bytes()

    offenders = []
    line_no = 1
    for byte in raw:
        if byte == 0x0A:
            line_no += 1
        elif byte >= 0x80:
            offenders.append(line_no)

    rel = path.relative_to(REPO_ROOT).as_posix()
    assert not offenders, (
        f"{rel} must be pure ASCII so Windows PowerShell 5.1 "
        "(which reads a BOM-less .ps1 in the system ANSI code page, not UTF-8) "
        "cannot misdecode a byte into a stray quote and desync the parser "
        "(issues #66994 / #67000). Non-ASCII bytes found on line(s): "
        f"{sorted(set(offenders))}. Use ASCII equivalents (em-dash -> '--', "
        "bullet -> '-')."
    )
