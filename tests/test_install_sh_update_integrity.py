"""hc-543: engine-update integrity for the .git-less COS install path.

Root cause (verified on a real desktop, 2026-07-16): an opt-in engine update
re-runs the desktop bootstrap with a NEW ``INSTALL_COMMIT`` against the OLD
on-disk tree. Desktop trees are COS-extracted flat checkouts with NO ``.git``,
so ``clone_repo()`` took its "COS-mirror checkout found, reusing" branch and
left the stale files in place — yet every stage returned ok and the
bootstrap-complete marker got stamped with the new version. Result: the UI
reported "engine is vNext" while the files were still vPrev (``/cc`` unknown
command; ``apex_overlay/im_passthrough.py`` never on disk).

Two shell-side halves of the fix are pinned here (the Electron half — refusing
the marker when the tree stamp disagrees with the target — lives in
apps/desktop/electron/bootstrap-runner.test.cjs):

1. The COS extract writes a ``.hermes-source-commit`` provenance stamp (the only
   on-disk signal tying a .git-less tree to a commit).
2. ``clone_repo()`` reuses an existing COS tree ONLY when its stamp already
   matches the target commit; on a mismatch (or an absent/legacy stamp) it
   re-extracts the target tarball instead of silently reusing the stale tree.

The bash is exercised for real: the overlay lib / clone_repo function are
sourced in a throwaway bash process with curl or the COS downloader stubbed.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import tarfile
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
INSTALL_SH = REPO_ROOT / "scripts" / "install.sh"
LIB_SH = REPO_ROOT / "scripts" / "lib" / "apexnodes-region-detect.sh"
STAMP_NAME = ".hermes-source-commit"

pytestmark = pytest.mark.skipif(
    shutil.which("bash") is None, reason="needs bash"
)


def _bash(script: str, **env) -> subprocess.CompletedProcess:
    import os

    clean = {
        k: v
        for k, v in os.environ.items()
        if k
        not in ("HERMES_CN_MIRRORS", "APEXNODES_REGION", "HERMES_RUNTIME_COS_BASE", "HERMES_HOME")
    }
    clean.update({k: str(v) for k, v in env.items()})
    return subprocess.run(["bash", "-c", script], capture_output=True, text=True, env=clean)


def _make_tarball(tmp_path: Path, marker_text: str) -> Path:
    """Build a hermes-agent/ source tarball whose pyproject carries a marker so
    a test can prove a specific tarball's contents landed on disk."""
    src = tmp_path / "src" / "hermes-agent"
    src.mkdir(parents=True)
    (src / "pyproject.toml").write_text(f"[project]\nname='hermes-agent'\n# {marker_text}\n")
    tarball = tmp_path / f"{marker_text}.tar.gz"
    with tarfile.open(tarball, "w:gz") as tf:
        tf.add(src, arcname="hermes-agent")
    return tarball


# ---------------------------------------------------------------------------
# 1. The COS extract stamps the tree, and the reader round-trips it.
# ---------------------------------------------------------------------------

def test_extract_writes_source_commit_stamp(tmp_path: Path) -> None:
    tarball = _make_tarball(tmp_path, "v_target")
    install_dir = tmp_path / "install"
    script = f"""
set -u
source "{LIB_SH}"
curl() {{ local out=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done; cp "{tarball}" "$out"; }}
INSTALL_DIR="{install_dir}"
INSTALL_COMMIT="deadbeefcafe1234"
BRANCH=""
apexnodes_download_runtime_tarball && echo RC=0 || echo RC=$?
echo "STAMP=$(apexnodes_installed_source_commit "$INSTALL_DIR")"
"""
    r = _bash(
        script,
        HERMES_RUNTIME_COS_BASE="https://cos.example/runtime",
        HERMES_HOME=str(tmp_path / "home"),
    )
    assert "RC=0" in r.stdout, r.stdout + r.stderr
    stamp = install_dir / STAMP_NAME
    assert stamp.is_file(), "extract must write the provenance stamp"
    assert stamp.read_text().strip() == "deadbeefcafe1234"
    # The reader helper round-trips the stamped commit (whitespace-stripped).
    assert "STAMP=deadbeefcafe1234" in r.stdout, r.stdout


def test_installed_source_commit_absent_is_empty_not_error(tmp_path: Path) -> None:
    install_dir = tmp_path / "install"
    install_dir.mkdir()
    script = f"""
set -u
source "{LIB_SH}"
out="$(apexnodes_installed_source_commit "{install_dir}")"; rc=$?
echo "RC=$rc OUT=[$out]"
"""
    r = _bash(script, HERMES_HOME=str(tmp_path / "home"))
    assert "RC=0 OUT=[]" in r.stdout, r.stdout + r.stderr


# ---------------------------------------------------------------------------
# 2. clone_repo() reuse guard: reuse iff stamp==target, else re-extract.
# ---------------------------------------------------------------------------

def _extract_clone_repo() -> str:
    text = INSTALL_SH.read_text()
    m = re.search(r"^clone_repo\(\) \{\n.*?^\}$", text, re.DOTALL | re.MULTILINE)
    assert m is not None, "clone_repo() not found in install.sh"
    return m.group(0)


def _run_clone_repo(install_dir: Path, install_commit: str, downloader_stub: str) -> subprocess.CompletedProcess:
    """Drive the real clone_repo() against an existing .git-less tree, with the
    overlay COS helpers replaced by a recording stub so no network is touched.

    downloader_stub defines apexnodes_download_runtime_tarball; it must return 0
    on a simulated successful re-extract and record the call into $CALLED_FILE.

    The harness is written to a temp .sh and run as ``bash <file>`` (not
    ``bash -c <src>``) so the extracted clone_repo source — which mentions
    "hermes update" in its git-branch comments — never lands in argv and trips
    tests/conftest.py's live-system guard. clone_repo never enters that git
    branch here (the seeded tree has no .git), so nothing real is fetched.
    """
    body = _extract_clone_repo()
    called = install_dir.parent / "download_called"
    script = f"""
set -u
log_info() {{ echo "INFO: $*"; }}
log_warn() {{ echo "WARN: $*"; }}
log_error() {{ echo "ERROR: $*" >&2; }}
log_success() {{ echo "OK: $*"; }}
apexnodes_cos_configured() {{ return 0; }}
apexnodes_installed_source_commit() {{
    local d="${{1:-$INSTALL_DIR}}"
    [ -f "$d/{STAMP_NAME}" ] || return 0
    tr -d '[:space:]' < "$d/{STAMP_NAME}"
}}
CALLED_FILE="{called}"
{downloader_stub}
INSTALL_DIR="{install_dir}"
INSTALL_COMMIT="{install_commit}"
BRANCH="main"
{body}
clone_repo
echo "DOWNLOAD_CALLED=$([ -f "$CALLED_FILE" ] && echo yes || echo no)"
"""
    harness = install_dir.parent / "clone_repo_harness.sh"
    harness.write_text(script)
    return subprocess.run(
        ["bash", str(harness)],
        capture_output=True,
        text=True,
        env={"HERMES_RUNTIME_COS_BASE": "https://cos.example/runtime", "PATH": _minimal_path()},
    )


def _minimal_path() -> str:
    import os

    return os.environ.get("PATH", "/usr/bin:/bin")


# A downloader stub that "succeeds": records the call and rewrites the tree +
# stamp to the target commit (what a real re-extract would do).
_STUB_SUCCESS = """
apexnodes_download_runtime_tarball() {
    : > "$CALLED_FILE"
    mkdir -p "$INSTALL_DIR"
    printf 'name=target\\n' > "$INSTALL_DIR/pyproject.toml"
    printf '%s\\n' "$INSTALL_COMMIT" > "$INSTALL_DIR/.hermes-source-commit"
    return 0
}
"""

# A downloader stub that "fails" (network down): records the call, returns 1.
_STUB_FAIL = """
apexnodes_download_runtime_tarball() { : > "$CALLED_FILE"; return 1; }
"""


def _seed_cos_tree(install_dir: Path, stamp: str | None) -> None:
    install_dir.mkdir(parents=True)
    (install_dir / "pyproject.toml").write_text("name=old\n")
    if stamp is not None:
        (install_dir / STAMP_NAME).write_text(stamp + "\n")


def test_reuse_when_stamp_matches_target(tmp_path: Path) -> None:
    install_dir = tmp_path / "hermes-agent"
    _seed_cos_tree(install_dir, stamp="feedface0001")
    r = _run_clone_repo(install_dir, "feedface0001", _STUB_SUCCESS)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "DOWNLOAD_CALLED=no" in r.stdout, r.stdout
    assert "reusing" in r.stdout.lower(), r.stdout
    # The old tree is left untouched (no re-extract).
    assert (install_dir / "pyproject.toml").read_text() == "name=old\n"


def test_reextract_when_stamp_is_a_different_commit(tmp_path: Path) -> None:
    """The hc-543 bug scenario: stale tree, update to a new commit."""
    install_dir = tmp_path / "hermes-agent"
    _seed_cos_tree(install_dir, stamp="0000oldcommit0000")
    r = _run_clone_repo(install_dir, "1111newcommit1111", _STUB_SUCCESS)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "DOWNLOAD_CALLED=yes" in r.stdout, "must re-extract the target tarball, not reuse the stale tree\n" + r.stdout
    # The re-extract landed the target commit's tree + stamp.
    assert (install_dir / STAMP_NAME).read_text().strip() == "1111newcommit1111"


def test_reextract_when_no_stamp_legacy_tree(tmp_path: Path) -> None:
    """A pre-hc-543 tree has no stamp — treated as a mismatch, so it self-heals
    on the next update rather than reusing an unverifiable tree."""
    install_dir = tmp_path / "hermes-agent"
    _seed_cos_tree(install_dir, stamp=None)
    r = _run_clone_repo(install_dir, "1111newcommit1111", _STUB_SUCCESS)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "DOWNLOAD_CALLED=yes" in r.stdout, r.stdout


def test_stale_tree_with_failed_redownload_errors_out(tmp_path: Path) -> None:
    """When the tree is stale AND the re-download fails, clone_repo must FAIL
    (non-zero) rather than fall through to reusing the stale tree — the whole
    point is to never stamp a marker over files that didn't update."""
    install_dir = tmp_path / "hermes-agent"
    _seed_cos_tree(install_dir, stamp="0000oldcommit0000")
    r = _run_clone_repo(install_dir, "1111newcommit1111", _STUB_FAIL)
    assert r.returncode != 0, "stale tree + failed re-download must not silently succeed\n" + r.stdout + r.stderr
    # `exit 1` terminates the harness before the DOWNLOAD_CALLED echo, so assert
    # on the recorder file directly: the re-download WAS attempted (not reused).
    assert (install_dir.parent / "download_called").exists(), "re-download must be attempted before erroring out"
    assert "is stale" in r.stderr, r.stderr
