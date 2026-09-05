"""Guard: the installers must pin core.autocrlf=false ON THE CLONE.

WHAT BROKE. hc-678, mainland-China Windows, fresh first install of 0.17.8. The
repository stage exits 1::

    Cloning into 'C:\\Users\\Admin\\hc667-fresh\\hermes-agent'...
    Updating files: 100% (8444/8444), done.
    From https://github.com/NousResearch/hermes-agent
     * branch  6f5f74c8eb...  -> FETCH_HEAD
    error: Your local changes to the following files would be overwritten by checkout:
            ui-tui/src/components/appChrome.tsx
            ... 1199 files ...
    Aborting

Nobody touched those files. Git for Windows ships ``core.autocrlf=true`` at
SYSTEM scope (``C:\\Program Files\\Git\\etc\\gitconfig``; verified on the
DESKTOP-7TPW2SX test machine, git 2.54.0.windows.1), so the clone wrote the
repo's LF text files to the working tree as CRLF. install.ps1 then turned
normalization off -- AFTER the tree was already on disk. ``git config`` does not
rewrite a working tree; it only stops git converting on the way back in, so
every CRLF file became unequal to its LF blob and the whole checkout read as
modified. A sampled file diffed 726 insertions / 726 deletions, all line ends.

THE BOUNDARY IS THE CLONE, NOT THE CHECKOUT. install.ps1 already carried a
comment saying "Pin autocrlf=false BEFORE the checkout below" -- true, and one
step too late. ``git clone`` checks the tree out as part of the clone, so
anything that runs after the clone command has already lost. ``git clone
--config core.autocrlf=false`` is applied after init but before any file is
written, and it persists into .git/config for later updates.

WHY THIS IS NOT JUST A RED STAGE. When the pin does not abort, it is worse: the
engine keeps running whatever the clone landed on (branch tip) instead of the
commit the install stamped, so the build stamp and the code on disk disagree.

WHY .gitattributes DOES NOT SAVE US. It pins eol=lf for ``*.sh``, ``Dockerfile``
and ``*.dockerfile`` only. Every ``.ts`` / ``.tsx`` / ``.py`` / ``.mjs`` file
falls through to core.autocrlf -- which is exactly the shape of the 1199-file
list above, all source, no shell scripts.

HOW THIS FILE TESTS IT. Not by grepping for the flag. It extracts the clone
command lines the installers actually execute (comments stripped, because the
comments explaining this fix necessarily quote the very flag under test), then
REPLAYS them against a local fixture repo with core.autocrlf=true forced on, and
runs the same post-clone pin sequence the script runs. Delete the flag from
either installer and the replayed checkout aborts exactly like the machine did.

WHY THE POST-CLONE ``git config core.autocrlf false`` IS REPLAYED TOO. Without
it the bug is INVISIBLE: a CRLF tree under autocrlf=true compares clean, and the
pin succeeds. The failure needs both halves -- CRLF on disk *and* normalization
subsequently off. A test that replayed only the clone would be structurally
incapable of seeing the bug it is named after (AGENTS.md #14).

WHY THE FIXTURE REMOTE IS A ``file://`` URL. Measured on DESKTOP-7TPW2SX while
verifying this fix: a clone from a plain local PATH does NOT reproduce the
failure. ``--depth 1`` is ignored for local clones, and the resulting index
caches the CRLF stat, so ``git status`` reads clean and the pin checkout
succeeds -- the unfixed installer passed twice that way. Switching the same
fixture to ``file://`` (a real shallow clone over the pack transport, which is
what production does) failed on the first try: stage exit 1, 544 dirty files,
HEAD left on the branch tip. Any variant of this test that clones from a bare
path is a guard that cannot fail.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
INSTALL_PS1 = REPO_ROOT / "scripts" / "install.ps1"
INSTALL_SH = REPO_ROOT / "scripts" / "install.sh"



def _strip_comments(body: str, marker: str) -> str:
    return "\n".join(
        "" if line.lstrip().startswith(marker) else line for line in body.splitlines()
    )


def _install_repository_ps1() -> str:
    """install.ps1's Install-Repository body, comments stripped."""
    text = INSTALL_PS1.read_text(encoding="utf-8")
    start = text.index("function Install-Repository")
    rest = text[start + 1 :]
    return _strip_comments(rest[: rest.index("\nfunction ")], "#")


def _clone_repo_sh() -> str:
    """install.sh's clone_repo body, comments stripped."""
    text = INSTALL_SH.read_text(encoding="utf-8")
    start = text.index("clone_repo() {")
    rest = text[start:]
    return _strip_comments(rest[: rest.index("\nsetup_venv()")], "#")


# Shell/PowerShell wrappers around the bare command, dropped so the remaining
# tokens are runnable argv. `throw "... tried git clone SSH ..."` is a message,
# not a command -- requiring `git` to be the FIRST surviving token is what keeps
# prose out of the replay.
_WRAPPER_TOKENS = frozenset({"Invoke-NativeWithRelaxedErrorAction", "{", "}", "if", "then"})
# Trailing shell noise on install.sh's `if git clone ... ; then` lines.
_SH_TRAILERS = re.compile(r"(\s+2>/dev/null.*|\s*;\s*then\s*$|\s+then\s*$)")


def _clone_argv(body: str, subs: dict[str, str], shell: bool) -> list[list[str]]:
    """Every `git [-c k=v]... clone ...` the body actually executes, as argv."""
    lines = body.splitlines()
    if shell:
        # install.sh wraps the larger HTTPS clone commands across physical
        # lines. Reconstruct shell continuation lines before tokenising so a
        # newly added route cannot be counted but replayed without its repo
        # and destination arguments.
        logical_lines = []
        pending = ""
        for raw in lines:
            line = raw.strip()
            if line.endswith("\\"):
                pending += line[:-1].rstrip() + " "
                continue
            logical_lines.append(pending + line)
            pending = ""
        assert not pending, "unterminated shell continuation in clone_repo()"
        lines = logical_lines

    argvs = []
    for line in lines:
        stripped = _SH_TRAILERS.sub("", line.strip()) if shell else line.strip()
        if shell:
            stripped = re.sub(r'^if\s+GIT_SSH_COMMAND="[^"]*"\s+', "if ", stripped)
        tokens = [t for t in stripped.split() if t not in _WRAPPER_TOKENS]
        tokens = [t for t in tokens if not re.match(r"^\w+=", t)]  # env prefixes
        if not tokens or tokens[0] != "git" or "clone" not in tokens[:4]:
            continue
        tokens = [t.strip('"') for t in tokens if t not in ("\\", ";")]
        argvs.append([subs.get(t, t) for t in tokens])

    # Belt: a clone written in a form the filter above does not recognise would
    # silently drop out of the replay. Every real route uses `--depth 1`.
    written = len(re.findall(r"clone\b[^\n]*--depth", "\n".join(lines)))
    assert written == len(argvs), (
        f"parsed {len(argvs)} clone routes but the source contains {written} -- "
        "a clone route is written in a shape this test cannot replay"
    )
    return argvs


def _ps1_clone_argv(remote: str, dest: Path) -> list[list[str]]:
    return _clone_argv(
        _install_repository_ps1(),
        {
            "$Branch": "main",
            "$RepoUrlSsh": str(remote),
            "$RepoUrlHttps": str(remote),
            "$InstallDir": str(dest),
        },
        shell=False,
    )


def _sh_clone_argv(remote: str, dest: Path) -> list[list[str]]:
    return _clone_argv(
        _clone_repo_sh(),
        {
            "$BRANCH": "main",
            "$REPO_URL_SSH": str(remote),
            "$REPO_URL_HTTPS": str(remote),
            "$INSTALL_DIR": str(dest),
        },
        shell=True,
    )


def _git(cwd: Path, *args: str, env: dict | None = None, check: bool = True):
    return subprocess.run(
        ["git", *args], cwd=cwd, env=env, check=check, capture_output=True, text=True
    )


def _fixture_remote(tmp_path: Path, env: dict) -> tuple[str, str]:
    """A bare remote whose text files are LF, plus a commit to pin to.

    Carries this repo's real .gitattributes so the test normalizes exactly the
    way production does: *.sh is pinned to LF by attribute, .ts is not and falls
    through to core.autocrlf -- the difference the failure list shows.

    Returned as a ``file://`` URL, not a path. See the module docstring: a
    local-path clone cannot reproduce this failure.
    """
    seed = tmp_path / "seed"
    seed.mkdir()
    _git(seed, "init", "-q", env=env)
    _git(seed, "config", "user.email", "t@t", env=env)
    _git(seed, "config", "user.name", "t", env=env)
    shutil.copyfile(REPO_ROOT / ".gitattributes", seed / ".gitattributes")
    for i in range(12):
        (seed / f"app{i}.ts").write_text(
            f"const a{i} = 1\nconst b{i} = 2\n", encoding="utf-8", newline=""
        )
    (seed / "run.sh").write_text("#!/bin/sh\necho hi\n", encoding="utf-8", newline="")
    _git(seed, "add", "-A", env=env)
    _git(seed, "commit", "-qm", "base", env=env)
    _git(seed, "branch", "-M", "main", env=env)

    remote = tmp_path / "origin.git"
    _git(tmp_path, "init", "-q", "--bare", str(remote), env=env)
    # The installer fetches the pin by SHA; a bare remote refuses that unless
    # asked to allow it (GitHub allows it, which is why production gets here).
    _git(remote, "config", "uploadpack.allowAnySHA1InWant", "true", env=env)
    _git(seed, "remote", "add", "origin", str(remote), env=env)
    _git(seed, "push", "-q", "-u", "origin", "main", env=env)
    pin = _git(seed, "rev-parse", "HEAD", env=env).stdout.strip()

    # A second commit so the branch tip differs from the pin -- otherwise the
    # pin checkout would have nothing to overwrite and could not fail, and
    # "HEAD == pin" would hold even if it never ran.
    for i in range(12):
        (seed / f"app{i}.ts").write_text(
            f"const a{i} = 1\nconst b{i} = 2\nconst c{i} = 3\n", encoding="utf-8", newline=""
        )
    _git(seed, "commit", "-qam", "tip", env=env)
    _git(seed, "push", "-q", "origin", "main", env=env)
    return remote.as_uri(), pin


def _autocrlf_true_env(tmp_path: Path) -> dict:
    """Force core.autocrlf=true, and PROVE it took (AGENTS.md #14).

    Injecting a fault without asserting it landed is how a reverse-verification
    silently passes on a failure that never happened.
    """
    import os

    home = tmp_path / "githome"
    home.mkdir()
    global_cfg = home / ".gitconfig"
    global_cfg.write_text("[core]\n\tautocrlf = true\n", encoding="utf-8")
    system_cfg = tmp_path / "system.gitconfig"
    system_cfg.write_text("", encoding="utf-8")
    env = os.environ | {
        "HOME": str(home),
        "GIT_CONFIG_GLOBAL": str(global_cfg),
        "GIT_CONFIG_SYSTEM": str(system_cfg),
    }
    effective = _git(tmp_path, "config", "core.autocrlf", env=env, check=False).stdout.strip()
    assert effective == "true", (
        "the harness failed to force core.autocrlf=true "
        f"(git reports {effective!r}); this test would prove nothing"
    )
    return env


def _post_clone_pin_is_still_after_the_clone() -> None:
    """The replay below is only faithful while this remains true."""
    body = _install_repository_ps1()
    tail = body[body.index("$hasGitDir = Test-Path") :]
    assert re.search(r"git\s+(?:-c\s+\S+\s+)?config core\.autocrlf false", tail), (
        "install.ps1 no longer re-asserts core.autocrlf after the clone. That is "
        "fine on its own, but this test replays that call to reproduce the "
        "failure -- update the replay before removing it."
    )


def _replay_and_assert(argv: list[str], dest: Path, pin: str, env: dict) -> None:
    """clone (as the installer runs it) -> post-clone pin -> fetch -> commit pin."""
    clone = subprocess.run(argv, cwd=dest.parent, env=env, capture_output=True, text=True)
    assert clone.returncode == 0, clone.stderr

    # Replayed from the installer: without it the CRLF tree compares clean and
    # the bug cannot be observed at all.
    _git(dest, "config", "core.autocrlf", "false", env=env)
    # Also the installer's: `--depth 1` leaves the pin's objects absent.
    _git(dest, "fetch", "-q", "origin", pin, env=env)

    checkout = subprocess.run(
        ["git", "checkout", "--detach", pin],
        cwd=dest,
        env=env,
        capture_output=True,
        text=True,
    )
    assert checkout.returncode == 0, (
        "the commit pin was refused -- the clone left a working tree that does "
        f"not match its own index:\n{checkout.stderr}"
    )

    # (2) the engine is on the pinned commit, not the branch tip.
    assert _git(dest, "rev-parse", "HEAD", env=env).stdout.strip() == pin

    # (3) a just-installed checkout is clean.
    assert _git(dest, "status", "--porcelain", env=env).stdout.strip() == ""

    # The bytes, not the exit code: the unattributed file must be LF on disk.
    assert b"\r\n" not in (dest / "app0.ts").read_bytes()
    # ...and the eol=lf attribute still does its own job.
    assert b"\r\n" not in (dest / "run.sh").read_bytes()


@pytest.mark.live_system_guard_bypass
@pytest.mark.skipif(shutil.which("git") is None, reason="needs git")
@pytest.mark.parametrize("installer", ["install.ps1", "install.sh"])
def test_installer_clone_survives_a_pin_under_autocrlf_true(
    tmp_path: Path, installer: str
) -> None:
    """Replay each installer's real clone commands under autocrlf=true.

    Cross-platform on purpose: core.autocrlf is honoured by git everywhere, not
    just on Windows, so this reproduces the mainland-Windows failure on the
    Linux CI runner without needing PowerShell or a Windows box.
    """
    _post_clone_pin_is_still_after_the_clone()
    env = _autocrlf_true_env(tmp_path)
    remote, pin = _fixture_remote(tmp_path, env)

    workdir = tmp_path / "work"
    workdir.mkdir()
    build = _ps1_clone_argv if installer == "install.ps1" else _sh_clone_argv

    route_count = len(build(remote, workdir / "probe"))
    expected_routes = {"install.ps1": 2, "install.sh": 3}[installer]
    assert route_count == expected_routes, (
        f"{installer} has {route_count} clone routes, not the {expected_routes} "
        "routes this guard was written against. Count them before changing "
        "them (AGENTS.md #12) and extend this test to cover the new one."
    )

    for index in range(route_count):
        dest = workdir / f"probe{index}"
        argv = build(remote, dest)[index]
        _replay_and_assert(argv, dest, pin, env)
        shutil.rmtree(dest)


@pytest.mark.live_system_guard_bypass
@pytest.mark.skipif(shutil.which("git") is None, reason="needs git")
def test_zip_fallback_pins_normalization_before_its_first_checkout() -> None:
    """The ZIP route was already correct -- keep it that way.

    It does not clone: `git init` leaves an empty tree, so its `git config`
    still lands ahead of the first `checkout -f FETCH_HEAD`. Asserted as an
    ORDER of executable statements, not as the presence of a word, because the
    comments around this code necessarily contain the word.
    """
    body = _install_repository_ps1()
    zip_block = body[body.index("git -c windows.appendAtomically=false init") :]
    zip_block = zip_block[: zip_block.index("$hasGitDir = Test-Path")]

    lines = zip_block.splitlines()
    pin_at = next(
        (i for i, line in enumerate(lines) if re.search(r"config core\.autocrlf false", line)),
        None,
    )
    # A real `git ... checkout` invocation. Matching the bare word would also
    # hit the Write-Info string two lines above it -- prose inside an executable
    # statement, which is not the thing being ordered (AGENTS.md #14).
    checkout_at = next(
        (
            i
            for i, line in enumerate(lines)
            if re.search(r"\bgit\b(?:\s+-c\s+\S+)*\s+checkout\b", line)
        ),
        None,
    )
    assert pin_at is not None, "the ZIP fallback stopped pinning core.autocrlf"
    assert checkout_at is not None, "sanity: the ZIP fallback should still check something out"
    assert pin_at < checkout_at, (
        "the ZIP fallback now sets core.autocrlf AFTER its first checkout -- the "
        "same inversion hc-678 fixed on the clone routes"
    )
