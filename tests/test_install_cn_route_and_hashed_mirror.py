"""Guards for hc-636 — a mainland install must be both FAST and hash-verified.

TWO DEFECTS, ONE SYMPTOM (26+ minutes on the `dependencies` stage, 2026-07-31).

A. The region probe asked "is github.com reachable?" and read NO as "in China".
   That is a proxy for geography, and mainland access to github is intermittent:
   the same physical machine answered cn on one run and global 90 minutes later.
   The two errors cost wildly different amounts -- mirrors from abroad are merely
   slower, upstream from the mainland is tens of minutes -- so a coin-flip signal
   is the wrong shape. Now both PyPI routes are timed and the faster one wins.

B. Even with mirrors ON, the dependency install ignored them. `uv sync --locked`
   downloads the literal files.pythonhosted.org URLs recorded in uv.lock, and
   the helper that runs it strips the index env on purpose (a mismatched index
   makes `--locked` refuse). So tier 0 was hash-verified and glacial, while every
   faster tier below re-resolved with NO hash verification: speed or integrity,
   never both. The new tier exports the lock to a requirements file -- uv writes
   every recorded sha256 into it -- and installs THAT from the mirror under
   --require-hashes.

WHY THESE TESTS EXIST IN THIS SHAPE. Both defects are SILENT. Nothing errors;
one path is merely slow and the other merely unverified. Two of the invariants
below were broken during development and produced no failure signal at all:

  * `uv export --locked` refuses on an index/lock mismatch exactly like
    `uv sync --locked` does. With the mirror env still set it exits 2 and writes
    a 0-byte file -- and because the tier is deliberately non-fatal, the install
    silently degraded back to the slow upstream sync. "Fixed" and "did nothing"
    look identical in the log.
  * The new tier must run BEFORE tier 0, not as its fallback: on a mainland
    machine tier 0 does not FAIL, it just takes half an hour, so a fallback
    would never be reached.

Both installers are checked -- .sh behaviorally in a real bash process, .ps1
pinned at the source level (no pwsh on dev Macs / CI images). They are twin
implementations of one behavior, and fixing only the one that broke is the most
expensive recurring bug in this repo (AGENTS.md #12).
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
LIB_SH = REPO_ROOT / "scripts" / "lib" / "apexnodes-region-detect.sh"
LIB_PS1 = REPO_ROOT / "scripts" / "lib" / "apexnodes-region-detect.ps1"
INSTALL_SH = REPO_ROOT / "scripts" / "install.sh"
INSTALL_PS1 = REPO_ROOT / "scripts" / "install.ps1"

INDEX_ENV_VARS = (
    "UV_DEFAULT_INDEX",
    "UV_INDEX_URL",
    "UV_EXTRA_INDEX_URL",
    "UV_INDEX",
    "PIP_INDEX_URL",
    "PIP_EXTRA_INDEX_URL",
)


def _bash(script: str) -> subprocess.CompletedProcess:
    import os

    env = {k: v for k, v in os.environ.items() if k not in (
        "HERMES_CN_MIRRORS", "APEXNODES_REGION", "HERMES_RUNTIME_COS_BASE", "HERMES_HOME",
        *INDEX_ENV_VARS,
    )}
    return subprocess.run(["bash", "-c", script], capture_output=True, text=True, env=env)


def _strip_ps_comments(source: str) -> str:
    """Blank whole-line PowerShell comments, preserving line count.

    The assertions here are about executable behavior, and the comments
    explaining this fix necessarily quote the commands being constrained --
    matching those would make a guard pass on its own documentation.
    """
    return "\n".join("" if l.lstrip().startswith("#") else l for l in source.splitlines())


def _ps_function(path: Path, name: str) -> str:
    text = _strip_ps_comments(path.read_text(encoding="utf-8"))
    start = text.index(f"function {name}")
    rest = text[start + 1 :]
    end = rest.index("\nfunction ") if "\nfunction " in rest else len(rest)
    return rest[:end]


def _sh_function(path: Path, name: str) -> str:
    text = path.read_text(encoding="utf-8")
    start = text.index(f"{name}() {{")
    rest = text[start:]
    return rest[: rest.index("\n}\n") + 2]


# ===========================================================================
# A. The region probe measures the route, and every ambiguity favours the mirror
# ===========================================================================

_DECIDE = """
_an_log() {{ :; }}
source {lib}
# Replace the network probe with a table. The decision logic is what is under
# test; curl is not.
_an_probe_ms() {{
    case "$1" in
        *pythonhosted*) {up} ;;
        *tuna*)         {mirror} ;;
    esac
}}
if _an_pypi_route_is_domestic; then echo cn; else echo global; fi
"""


def _decide(up: str, mirror: str) -> str:
    return _bash(_DECIDE.format(lib=LIB_SH, up=up, mirror=mirror)).stdout.strip()


def test_mirror_wins_on_exact_parity():
    """Two comparable routes both work, so the safe side of the asymmetry wins."""
    assert _decide("echo 100", "echo 100") == "cn"


def test_mirror_wins_when_merely_slower_but_within_the_margin():
    # 200 <= 100*3 -> still cn. A bare `<` here made near-parity a coin flip,
    # which is the same defect being fixed, one threshold down.
    assert _decide("echo 100", "echo 200") == "cn"


def test_global_requires_upstream_to_be_decisively_faster():
    # 400 > 100*3 -> upstream is decisively better, take it.
    assert _decide("echo 100", "echo 400") == "global"


def test_silent_upstream_means_mirror():
    """The mainland case: upstream times out, mirror answers."""
    assert _decide("return 1", "echo 50") == "cn"


def test_silent_mirror_means_upstream():
    assert _decide("echo 50", "return 1") == "global"


def test_a_box_with_no_network_at_all_still_favours_the_mirror():
    """Nothing to measure -> land on the side whose error is cheap.

    The old probe defaulted to 'global' on doubt, which is backwards: being
    wrong toward upstream costs a mainland user tens of minutes, being wrong
    toward the mirror costs a foreign user some download speed.
    """
    assert _decide("return 1", "return 1") == "cn"


def test_mirror_gets_a_second_sample_and_upstream_does_not():
    """Re-sample exactly the side whose spike causes the expensive error.

    A mirror spike makes us abandon the mirror (mainland pays tens of minutes);
    an upstream spike makes us keep it (nobody is hurt). Paying a second
    upstream probe would also mean waiting out a second timeout on precisely
    the machines this exists for.
    """
    # The counter lives in a file: each probe runs inside a command
    # substitution, i.e. a subshell, so a shell variable would never make it
    # back to the parent (this test asserted mirror_probes=0 until it did).
    script = f"""
    _an_log() {{ :; }}
    source {LIB_SH}
    tally=$(mktemp)
    _an_probe_ms() {{
        case "$1" in
            *pythonhosted*) echo 100 ;;
            *tuna*)
                printf x >> "$tally"
                if [ "$(wc -c < "$tally")" -eq 1 ]; then echo 9999; else echo 50; fi ;;
        esac
    }}
    if _an_pypi_route_is_domestic; then echo cn; else echo global; fi
    echo "mirror_probes=$(wc -c < "$tally" | tr -d ' ')"
    """
    out = _bash(script).stdout
    assert "cn" in out, "a single mirror spike must not flip the answer to global"
    assert "mirror_probes=2" in out, "the mirror is sampled twice, best-of"


def test_the_probe_targets_pypi_hosts_not_github():
    sh = LIB_SH.read_text(encoding="utf-8")
    ps = LIB_PS1.read_text(encoding="utf-8")
    for text, label in ((sh, "sh"), (ps, "ps1")):
        assert "files.pythonhosted.org" in text and "pypi.tuna.tsinghua.edu.cn" in text, label
    # The old proxy signal must be gone from BOTH, not just the one that broke.
    for text, label in ((_strip_ps_comments(ps), "ps1"), (sh, "sh")):
        body = text[text.index("region detection") :] if "region detection" in text else text
        assert "github.com/" not in body, (
            f"{label}: github reachability must no longer decide the region -- "
            "it is a proxy for geography and it flapped on a real machine"
        )


def test_twin_probe_implementations_agree_on_the_rules():
    sh = _sh_function(LIB_SH, "_an_pypi_route_is_domestic")
    ps = _ps_function(LIB_PS1, "Test-PypiRouteIsDomestic")
    # Same three-way structure on both sides: upstream-silent, mirror-silent,
    # then a margin comparison.
    assert "_AN_UPSTREAM_MARGIN" in sh and "UpstreamMargin" in ps
    assert sh.index("-z \"$up\"") < sh.index("-z \"$mirror\""), "sh: upstream-silent must be checked first"
    assert ps.index("$null -eq $upstream") < ps.index("$null -eq $mirror"), "ps1: same order"
    # The constant is declared outside the function; assert the body USES it and
    # that both declarations carry the same value.
    assert re.search(r"^_AN_UPSTREAM_MARGIN=(\d+)$", LIB_SH.read_text(encoding="utf-8"), re.M).group(1) == "3"
    assert re.search(r"\$script:UpstreamMargin\s*=\s*(\d+)", LIB_PS1.read_text(encoding="utf-8")).group(1) == "3"


# ===========================================================================
# B. The mirror-served hash-verified tier
# ===========================================================================


def test_export_runs_with_the_index_env_stripped():
    """The silent trap: `uv export --locked` refuses on an index/lock mismatch.

    Verified against uv 0.12 with UV_DEFAULT_INDEX=TUNA set: exit 2, 0-byte
    output, message "The lockfile at `uv.lock` needs to be updated". Because the
    tier is deliberately non-fatal, that degrades silently back to the slow
    upstream sync -- "fixed" and "did nothing" produce identical logs.
    """
    body = _sh_function(INSTALL_SH, "_uv_mirror_hashed")
    export_line = next(l for l in body.splitlines() if "uv_cmd export" in l.lower() or "$UV_CMD export" in l)
    # The `env -u ...` prefix sits on the line above the wrapped command.
    export_block = body[: body.index(export_line) + len(export_line)]
    for var in INDEX_ENV_VARS:
        assert f"-u {var}" in export_block, f"sh: export must run with {var} cleared"

    ps = _ps_function(INSTALL_PS1, "Invoke-UvMirrorHashedInstall")
    export_at = ps.index("export --format requirements-txt")
    assert "Invoke-WithoutIndexEnv" in ps[:export_at], (
        "ps1: the export must be wrapped in Invoke-WithoutIndexEnv"
    )


def test_the_install_step_keeps_the_mirror():
    """Stripping the index for the INSTALL step would defeat the whole tier."""
    sh = _sh_function(INSTALL_SH, "_uv_mirror_hashed")
    install_line = next(l for l in sh.splitlines() if "pip install --require-hashes" in l)
    assert "env -u" not in install_line, "sh: the install step must see the mirror index"

    ps = _ps_function(INSTALL_PS1, "Invoke-UvMirrorHashedInstall")
    install_at = ps.index("pip install --require-hashes")
    tail = ps[ps.index("export --format requirements-txt") : install_at]
    assert tail.count("Invoke-WithoutIndexEnv") == 0, "ps1: the install step must see the mirror index"


def test_hashes_are_actually_required():
    """Without --require-hashes this is just the unverified tier with extra steps."""
    for body, label in (
        (_sh_function(INSTALL_SH, "_uv_mirror_hashed"), "sh"),
        (_ps_function(INSTALL_PS1, "Invoke-UvMirrorHashedInstall"), "ps1"),
    ):
        assert "--require-hashes" in body, label
        assert "--no-emit-project" in body, f"{label}: the local package is on no index"


def test_the_new_tier_runs_before_the_upstream_locked_sync():
    """Ordering is the fix. A fallback would never be reached.

    On a mainland machine tier 0 does not fail -- it succeeds after half an
    hour -- so putting the mirror tier after it would leave the stall exactly
    where it was.
    """
    sh = INSTALL_SH.read_text(encoding="utf-8")
    assert sh.index('if [ "$force_locked_reinstall" = false ] && _uv_mirror_hashed; then') < sh.index(
        'log_info "Trying tier: hash-verified (uv.lock)'
    ), (
        "sh: the mirror tier must be attempted before the upstream locked sync"
    )

    ps = _strip_ps_comments(INSTALL_PS1.read_text(encoding="utf-8"))
    assert ps.index("if ((-not $forceLockedReinstall) -and (Invoke-UvMirrorHashedInstall))") < ps.index(
        'Write-Info "Trying tier: hash-verified (uv.lock)'
    ), (
        "ps1: same ordering"
    )


def test_the_tier_is_cn_gated_and_non_fatal():
    sh = _sh_function(INSTALL_SH, "_uv_mirror_hashed")
    assert '[ "${HERMES_CN_MIRRORS:-}" = "1" ] || return 1' in sh, (
        "a non-CN install must drop through untouched, keeping upstream parity"
    )
    assert "return 1" in sh, "every failure path reports non-zero so the caller falls through"

    ps = _ps_function(INSTALL_PS1, "Invoke-UvMirrorHashedInstall")
    assert "Test-CnEnabled" in ps
    assert "return $false" in ps


def test_index_env_sanitation_has_one_implementation_not_two():
    """Two copies of this list is one copy too many.

    A second caller appeared with hc-636; a hand-mirrored env list is exactly
    the shape that gets updated in one place and not the other.
    """
    ps = INSTALL_PS1.read_text(encoding="utf-8")
    assert "function Invoke-WithoutIndexEnv" in ps
    helper = _ps_function(INSTALL_PS1, "Invoke-WithoutIndexEnv")
    for var in INDEX_ENV_VARS:
        assert var in helper, f"{var} missing from the shared sanitation list"
    sync = _ps_function(INSTALL_PS1, "Invoke-UvSyncLocked")
    assert "Invoke-WithoutIndexEnv" in sync
    assert "UV_DEFAULT_INDEX" not in sync, "Invoke-UvSyncLocked must not keep its own copy of the list"
