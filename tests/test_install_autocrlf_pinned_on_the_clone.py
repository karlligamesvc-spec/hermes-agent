"""Guard: install.ps1 must pin core.autocrlf=false ON THE CLONE (hc-678).

WHAT BROKE. hc-678, mainland-China Windows, fresh first install of 0.17.8: the
repository stage exited 1 with "Your local changes to the following files would
be overwritten by checkout" over 1199 files nobody touched. Git for Windows ships
``core.autocrlf=true`` at SYSTEM scope, so the clone wrote LF files as CRLF; once
normalization was later turned off, every CRLF file became unequal to its LF blob
and the whole checkout read as modified.

WHAT v0.22 CHANGED (hc-911). Upstream's ``.gitattributes`` now pins ``eol=lf`` for
every source type, a pinned install clones ``--no-checkout`` and materializes the
pin with ``checkout --force``, and ``hermes update`` migrates a checkout off
``autocrlf=true`` itself. What is left uncovered is every tracked file whose type
``.gitattributes`` does not name (extensionless files, ``.txt``, ``.cfg``, ...):
under the system autocrlf=true they still land as CRLF, and read as modified the
moment anything sets autocrlf=false. The seam pins it on the clone, before any file
is written, so no file ever lands as CRLF.

HOW THIS FILE TESTS IT. It extracts the clone command install.ps1 actually runs
(the ``$longPaths`` config list and the clone line, comments stripped), REPLAYS it
against a ``file://`` fixture remote with core.autocrlf=true forced on, pins the
commit the way install.ps1 does, then flips autocrlf off as a later update would.
Remove the seam's ``core.autocrlf=false`` and the uncovered file lands CRLF and the
checkout reads dirty. ``file://`` and not a bare path: a local-path clone ignores
the pack transport and caches the CRLF stat, which hid the original failure.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
INSTALL_PS1 = REPO_ROOT / "scripts" / "install.ps1"


def _stage_repository_ps1() -> str:
    """install.ps1's Stage-Repository body, comment lines stripped."""
    text = INSTALL_PS1.read_text(encoding="utf-8")
    start = text.index("function Stage-Repository")
    body = text[start : text.index("\nfunction ", start + 1)]
    return "\n".join("" if line.lstrip().startswith("#") else line for line in body.splitlines())


def _clone_config_args(body: str) -> list[str]:
    """Every ``--config k=v`` pair the installer puts into ``$longPaths``."""
    args: list[str] = []
    for line in body.splitlines():
        if re.match(r"\s*\$longPaths\s*\+?=", line):
            args += re.findall(r"'([^']+)'", line)
    assert args and len(args) % 2 == 0, f"cannot parse $longPaths in Stage-Repository: {args}"
    return args


def _pinned_clone_argv(body: str, remote: str, tree: Path) -> list[str]:
    """The fresh-clone line, as argv, for a pinned (``-Commit``) install."""
    lines = [l for l in body.splitlines() if "git clone @progress @longPaths" in l and "@checkout" in l]
    assert len(lines) == 1, f"expected one primary clone line, found {len(lines)}"
    command = re.search(r"\{\s*(git clone [^}]*)\}", lines[0]).group(1).split()
    subs = {
        "@progress": [],
        "@longPaths": _clone_config_args(body),
        "@checkout": ["--no-checkout"],  # $Commit set: install.ps1 clones without a checkout
        "$Branch": ["main"],
        "$RepoUrl": [remote],
        "$tree": [str(tree)],
    }
    argv: list[str] = []
    for token in command:
        argv += subs.get(token, [token])
    return argv


def _git(cwd: Path, *args: str, env: dict, check: bool = True):
    return subprocess.run(["git", *args], cwd=cwd, env=env, check=check, capture_output=True, text=True)


def _autocrlf_true_env(tmp_path: Path) -> dict:
    """Force core.autocrlf=true and PROVE it took (AGENTS.md #14)."""
    home = tmp_path / "githome"
    home.mkdir()
    global_cfg = home / ".gitconfig"
    global_cfg.write_text("[core]\n\tautocrlf = true\n", encoding="utf-8")
    system_cfg = tmp_path / "system.gitconfig"
    system_cfg.write_text("", encoding="utf-8")
    env = os.environ | {"HOME": str(home), "GIT_CONFIG_GLOBAL": str(global_cfg), "GIT_CONFIG_SYSTEM": str(system_cfg)}
    effective = _git(tmp_path, "config", "core.autocrlf", env=env, check=False).stdout.strip()
    assert effective == "true", f"harness failed to force core.autocrlf=true (git says {effective!r})"
    return env


def _fixture_remote(tmp_path: Path, env: dict) -> tuple[str, str]:
    """A bare remote with this repo's real .gitattributes, and a pin behind the tip."""
    seed = tmp_path / "seed"
    seed.mkdir()
    _git(seed, "init", "-q", env=env)
    _git(seed, "config", "user.email", "t@t", env=env)
    _git(seed, "config", "user.name", "t", env=env)
    shutil.copyfile(REPO_ROOT / ".gitattributes", seed / ".gitattributes")
    (seed / "app.ts").write_text("const a = 1\n", encoding="utf-8", newline="")
    # Not named by .gitattributes: falls through to core.autocrlf.
    (seed / "NOTES.txt").write_text("one\ntwo\n", encoding="utf-8", newline="")
    _git(seed, "add", "-A", env=env)
    _git(seed, "commit", "-qm", "base", env=env)
    _git(seed, "branch", "-M", "main", env=env)
    remote = tmp_path / "origin.git"
    _git(tmp_path, "init", "-q", "--bare", str(remote), env=env)
    _git(seed, "remote", "add", "origin", str(remote), env=env)
    _git(seed, "push", "-q", "-u", "origin", "main", env=env)
    pin = _git(seed, "rev-parse", "HEAD", env=env).stdout.strip()
    (seed / "NOTES.txt").write_text("one\ntwo\nthree\n", encoding="utf-8", newline="")
    _git(seed, "commit", "-qam", "tip", env=env)
    _git(seed, "push", "-q", "origin", "main", env=env)
    return remote.as_uri(), pin


def test_stage_repository_pins_autocrlf_in_the_clone_config():
    pairs = _clone_config_args(_stage_repository_ps1())
    assert set(pairs[::2]) == {"--config"}
    assert "core.autocrlf=false" in pairs[1::2]


@pytest.mark.live_system_guard_bypass
@pytest.mark.skipif(shutil.which("git") is None, reason="needs git")
def test_pinned_clone_stays_clean_after_autocrlf_is_turned_off(tmp_path: Path):
    env = _autocrlf_true_env(tmp_path)
    remote, pin = _fixture_remote(tmp_path, env)
    tree = tmp_path / "work" / "tree"
    tree.parent.mkdir()

    clone = subprocess.run(_pinned_clone_argv(_stage_repository_ps1(), remote, tree),
                           cwd=tree.parent, env=env, capture_output=True, text=True, check=False)
    assert clone.returncode == 0, clone.stderr
    # install.ps1's pin step for a fresh pinned clone.
    _git(tree, "checkout", "--force", "--detach", pin, env=env)
    assert _git(tree, "rev-parse", "HEAD", env=env).stdout.strip() == pin

    # What a later update does to an autocrlf=true checkout.
    _git(tree, "config", "core.autocrlf", "false", env=env)
    assert _git(tree, "status", "--porcelain", env=env).stdout.strip() == ""
    assert b"\r\n" not in (tree / "NOTES.txt").read_bytes()
    assert b"\r\n" not in (tree / "app.ts").read_bytes()
