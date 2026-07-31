"""Guard: the repository stage must survive a checkout that has no .git.

WHAT BROKE. 2026-07-31, mainland-China Windows, first launch of 0.17.4:

    [OK] Runtime source ready from COS mirror (8ca1d63be9b9...)
    -> Configuring git for Windows compatibility...
    stage 'repository' failed: fatal: not in a git directory

Install-RuntimeFromCos unpacks a SOURCE TARBALL. It is a plain directory tree,
already built from the pinned commit (the tarball URL is keyed on $Commit), and
it has no .git. Everything the repository stage ran after the clone block was
repo-scoped git -- `git config <key> <value>` and the $Commit/$Tag pin -- and in
a directory without .git that is `fatal: not in a git directory`. Under this
script's EAP=Stop the stderr line terminates the stage, so the old
"harmless if it fails" comment was wrong on exactly the path every mainland
install takes.

WHY IT SURFACED ONLY NOW. The system-packages stage used to hang ahead of it
(the original hc-632 report: 18+ minutes on unmirrored winget). Fixing that
stall is what first let an install reach this line.

WHY THE .SH TWIN WAS FINE. install.sh already gates its pin on
`[ -d "$INSTALL_DIR/.git" ]` and says why in a comment. One behavior, two
implementations, only one of them fixed -- AGENTS.md #12. So this file checks
BOTH installers, not just the one that broke.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
INSTALL_PS1 = REPO_ROOT / "scripts" / "install.ps1"
INSTALL_SH = REPO_ROOT / "scripts" / "install.sh"


def _clone_repo_ps1() -> str:
    """Source of install.ps1's repository stage, comments stripped.

    Comments are dropped because the assertions below are about which git calls
    actually execute, and the comments explaining this fix necessarily quote the
    very commands being restricted.
    """
    text = INSTALL_PS1.read_text(encoding="utf-8")
    start = text.index("function Install-Repository")
    rest = text[start + 1 :]
    body = rest[: rest.index("\nfunction ")]
    return "\n".join("" if line.lstrip().startswith("#") else line for line in body.splitlines())


def _post_clone_section() -> str:
    """The part that runs AFTER a checkout exists, by any route.

    This is the section the COS tarball reaches with no .git; the clone/ZIP
    routes above it create their own repo (`git init`) and are not at issue.
    """
    body = _clone_repo_ps1()
    return body[body.index("$hasGitDir = Test-Path") :]


def test_the_git_dir_probe_exists_and_is_the_real_path():
    body = _clone_repo_ps1()
    assert 'Test-Path (Join-Path $InstallDir ".git")' in body, (
        "the repository stage must ask whether the checkout is a git repo before "
        "running repo-scoped git against it"
    )


def test_every_repo_scoped_git_call_after_the_clone_is_gated():
    """No bare repo-scoped git may run unguarded on a COS checkout."""
    section = _post_clone_section()

    # Repo-scoped git verbs. `config --global` is deliberately absent: it writes
    # ~/.gitconfig and works fine outside a repo, which is why the call above
    # the clone block is not part of this bug.
    repo_scoped = re.findall(r"git\s+(?:-c\s+\S+\s+)?(config|fetch|checkout|rev-parse|remote)\b", section)
    assert repo_scoped, "sanity: the section should still contain repo-scoped git calls"

    for line in section.splitlines():
        if not re.search(r"git\s+(?:-c\s+\S+\s+)?(config|fetch|checkout|rev-parse|remote)\b", line):
            continue
        # Indentation is the structure here: every such call must sit inside one
        # of the $hasGitDir blocks, which are indented past the function body.
        assert line.startswith(" " * 12), (
            f"repo-scoped git call is not nested inside a $hasGitDir guard:\n    {line.strip()}"
        )


def test_both_guarded_blocks_are_keyed_on_the_probe():
    section = _post_clone_section()
    assert "if ($hasGitDir) {" in section, "the per-repo config block must be gated"
    assert "if (-not $didUpdate -and $hasGitDir) {" in section, (
        "the $Commit/$Tag pin must be gated too -- it is the next thing to hit "
        "`fatal: not in a git directory` once the config calls are fixed"
    )


def test_the_pushed_location_is_popped():
    """The old code pushed $InstallDir and never popped it."""
    section = _post_clone_section()
    assert section.count("Push-Location") == 1
    assert "Pop-Location" in section
    assert "} finally {" in section, "Pop-Location must run even when the pin throws"


def test_sh_twin_still_gates_its_pin():
    """The .sh side got this right first; keep it that way.

    Pinned so a future edit cannot quietly regress the implementation that was
    already correct while everyone's attention is on the one that broke.
    """
    text = INSTALL_SH.read_text(encoding="utf-8")
    assert '[ -n "$INSTALL_COMMIT" ] && [ -d "$INSTALL_DIR/.git" ]' in text, (
        "install.sh must keep gating its commit pin on .git existing -- a COS "
        "source tarball has none"
    )
