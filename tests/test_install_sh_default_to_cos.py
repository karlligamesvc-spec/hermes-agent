"""Behavioral tests for hc-474 (default-to-COS single source).

Contract under test — the F2 root-cause fix:

1. The COS artifact helpers are REGION-INDEPENDENT: they attempt the COS
   download whenever HERMES_RUNTIME_COS_BASE is configured, even with
   HERMES_CN_MIRRORS explicitly 0 (the old code returned early there, which is
   exactly how a misdetected region stranded a mainland install on github).
2. Upstream parity: without a COS base the helpers are immediate no-ops that
   never touch the network.
3. The persisted region cache ($HERMES_HOME/.apexnodes-region) has NO effect
   on any install-time decision — resolve probes fresh every time and only
   WRITES the file (telemetry + runtime region signal).
4. The explicit overrides (HERMES_CN_MIRRORS rule 1, APEXNODES_REGION rule 2)
   stay authoritative and skip probing entirely.

The bash side is exercised for real: each test sources the actual lib in a
throwaway bash process, stubs curl / the probe fns, and observes behavior.
The .ps1 twin is pinned at the source level (no pwsh on dev Macs / CI images),
mirroring tests/test_install_ps1_node_deps_incremental.py's approach.
"""

from __future__ import annotations

import subprocess
import tarfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
LIB_SH = REPO_ROOT / "scripts" / "lib" / "apexnodes-region-detect.sh"
LIB_PS1 = REPO_ROOT / "scripts" / "lib" / "apexnodes-region-detect.ps1"


def _bash(script: str, **extra_env) -> subprocess.CompletedProcess:
    import os

    env = {k: v for k, v in os.environ.items() if k not in (
        "HERMES_CN_MIRRORS", "APEXNODES_REGION", "HERMES_RUNTIME_COS_BASE", "HERMES_HOME",
    )}
    env.update({k: str(v) for k, v in extra_env.items()})
    return subprocess.run(["bash", "-c", script], capture_output=True, text=True, env=env)


# ---------------------------------------------------------------------------
# 1. COS helpers are region-independent (the hc-474 crux)
# ---------------------------------------------------------------------------

def test_runtime_tarball_attempts_cos_even_with_cn_mirrors_zero(tmp_path):
    """HERMES_CN_MIRRORS=0 (explicit global) must NOT skip the COS download."""
    calls = tmp_path / "curl_calls"
    script = f"""
set -u
source "{LIB_SH}"
curl() {{ echo "$@" >> "{calls}"; return 22; }}  # record + fail -> fallback rc
INSTALL_DIR="{tmp_path}/install"
INSTALL_COMMIT="deadbeef"
BRANCH=""
apexnodes_download_runtime_tarball && echo "RC=0" || echo "RC=$?"
"""
    r = _bash(
        script,
        HERMES_CN_MIRRORS="0",
        HERMES_RUNTIME_COS_BASE="https://cos.example/runtime",
        HERMES_HOME=str(tmp_path / "home"),
    )
    assert "RC=1" in r.stdout, r.stdout + r.stderr
    recorded = calls.read_text() if calls.exists() else ""
    assert "https://cos.example/runtime/hermes-agent-deadbeef.tar.gz" in recorded, (
        "COS download must be attempted regardless of region "
        f"(curl calls: {recorded!r})"
    )


def test_runtime_tarball_succeeds_from_cos_with_cn_mirrors_zero(tmp_path):
    """Full success path: a valid COS tarball populates INSTALL_DIR on a
    machine explicitly marked non-CN."""
    src = tmp_path / "tree" / "hermes-agent"
    src.mkdir(parents=True)
    (src / "pyproject.toml").write_text("[project]\nname='x'\n")
    tarball = tmp_path / "runtime.tar.gz"
    with tarfile.open(tarball, "w:gz") as tf:
        tf.add(src, arcname="hermes-agent")

    install_dir = tmp_path / "install"
    script = f"""
set -u
source "{LIB_SH}"
curl() {{
    # emulate `curl -fsSL --max-time N <url> -o <out>`: last arg is the output path
    local out=""
    while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done
    cp "{tarball}" "$out"
}}
INSTALL_DIR="{install_dir}"
INSTALL_COMMIT="deadbeef"
BRANCH=""
apexnodes_download_runtime_tarball && echo "RC=0" || echo "RC=$?"
"""
    r = _bash(
        script,
        HERMES_CN_MIRRORS="0",
        HERMES_RUNTIME_COS_BASE="https://cos.example/runtime",
        HERMES_HOME=str(tmp_path / "home"),
    )
    assert "RC=0" in r.stdout, r.stdout + r.stderr
    assert (install_dir / "pyproject.toml").is_file(), "COS tarball must populate INSTALL_DIR"


def test_helpers_are_noops_without_cos_base(tmp_path):
    """Upstream parity: no COS base -> immediate no-op, zero network calls."""
    calls = tmp_path / "curl_calls"
    script = f"""
set -u
source "{LIB_SH}"
curl() {{ echo "$@" >> "{calls}"; return 22; }}
INSTALL_DIR="{tmp_path}/install"
INSTALL_COMMIT="deadbeef"
BRANCH=""
OS="linux"
apexnodes_download_runtime_tarball; echo "TARBALL_RC=$?"
apexnodes_install_uv_from_cos;      echo "UV_RC=$?"
"""
    r = _bash(script, HERMES_HOME=str(tmp_path / "home"))
    assert "TARBALL_RC=1" in r.stdout and "UV_RC=1" in r.stdout, r.stdout + r.stderr
    assert not calls.exists(), f"no COS base must mean no network: {calls.read_text() if calls.exists() else ''}"


# ---------------------------------------------------------------------------
# 2. Region cache has no behavioral effect on resolve (write-only telemetry)
# ---------------------------------------------------------------------------

def _resolve_with(tmp_path, cache_value, github_unreachable, domestic_reachable):
    home = tmp_path / "home"
    home.mkdir(parents=True, exist_ok=True)
    (home / ".apexnodes-region").write_text(cache_value + "\n")
    script = f"""
set -u
source "{LIB_SH}"
_an_github_unreachable() {{ return {0 if github_unreachable else 1}; }}
_an_domestic_reachable() {{ return {0 if domestic_reachable else 1}; }}
apexnodes_resolve_region
echo "CN=${{HERMES_CN_MIRRORS:-unset}}"
cat "{home}/.apexnodes-region"
"""
    return _bash(script, HERMES_HOME=str(home)), home


def test_cached_cn_is_ignored_when_probe_says_global(tmp_path):
    r, home = _resolve_with(tmp_path, "cn", github_unreachable=False, domestic_reachable=True)
    assert "CN=0" in r.stdout, (
        "a stale 'cn' cache must not pin CN mode when the fresh probe says "
        f"global (F2 class): {r.stdout} {r.stderr}"
    )
    assert (home / ".apexnodes-region").read_text().strip() == "global", "cache must be rewritten as telemetry"


def test_cached_global_is_ignored_when_probe_says_cn(tmp_path):
    r, home = _resolve_with(tmp_path, "global", github_unreachable=True, domestic_reachable=True)
    assert "CN=1" in r.stdout, (
        "a stale 'global' cache must not suppress CN mirrors when the fresh "
        f"probe says CN: {r.stdout} {r.stderr}"
    )
    assert (home / ".apexnodes-region").read_text().strip() == "cn"


def test_offline_box_stays_global(tmp_path):
    r, _ = _resolve_with(tmp_path, "cn", github_unreachable=True, domestic_reachable=False)
    assert "CN=0" in r.stdout, "github down + domestic down = offline, never CN"


# ---------------------------------------------------------------------------
# 3. Explicit overrides stay authoritative and skip probing
# ---------------------------------------------------------------------------

def test_rule1_env_skips_probes(tmp_path):
    probes = tmp_path / "probe_calls"
    script = f"""
set -u
source "{LIB_SH}"
_an_github_unreachable() {{ echo g >> "{probes}"; return 0; }}
_an_domestic_reachable() {{ echo d >> "{probes}"; return 0; }}
apexnodes_resolve_region
echo "CN=${{HERMES_CN_MIRRORS:-unset}}"
"""
    r = _bash(script, HERMES_CN_MIRRORS="1", HERMES_HOME=str(tmp_path / "home"))
    assert "CN=1" in r.stdout
    assert not probes.exists(), "rule 1 (explicit env) must not probe"


def test_rule2_region_knob_skips_probes(tmp_path):
    probes = tmp_path / "probe_calls"
    script = f"""
set -u
source "{LIB_SH}"
_an_github_unreachable() {{ echo g >> "{probes}"; return 1; }}
_an_domestic_reachable() {{ echo d >> "{probes}"; return 1; }}
apexnodes_resolve_region
echo "CN=${{HERMES_CN_MIRRORS:-unset}}"
"""
    r = _bash(script, APEXNODES_REGION="cn", HERMES_HOME=str(tmp_path / "home"))
    assert "CN=1" in r.stdout
    assert not probes.exists(), "rule 2 (APEXNODES_REGION) must not probe"


# ---------------------------------------------------------------------------
# 4. .ps1 twin pinned at source level (keep the two in step; no pwsh in CI)
# ---------------------------------------------------------------------------

def test_ps1_cos_helpers_gate_on_cos_configured_not_region():
    text = LIB_PS1.read_text()
    for fn in ("Install-UvFromCos", "Install-RuntimeFromCos", "Install-GitFromCos"):
        body = text.split(f"function {fn}", 1)[1]
        gate = body.split("\n", 3)
        head = "\n".join(gate[:3])
        assert "Test-CosConfigured" in head, f"{fn} must gate on Test-CosConfigured"
        assert "Test-CnEnabled" not in head, f"{fn} must NOT gate on the region ({fn} head: {head!r})"


def test_ps1_resolve_never_reads_the_cache():
    text = LIB_PS1.read_text()
    body = text.split("function Resolve-ApexRegion", 1)[1].split("\nfunction ", 1)[0]
    assert "Get-Content" not in body, "Resolve-ApexRegion must not READ the region cache (write-only telemetry)"
    assert "Set-Content" in body, "Resolve-ApexRegion must still WRITE the telemetry cache"


def test_ps1_heuristic_diet_matches_sh():
    """The deleted heuristics must be gone from BOTH twins."""
    sh = LIB_SH.read_text()
    ps1 = LIB_PS1.read_text()
    for gone in ("_an_timezone_suggests_cn", "_an_network_suggests_cn"):
        assert gone not in sh, f"{gone} should be deleted from the .sh lib (hc-474)"
    for gone in ("Test-TimezoneSuggestsCn", "Test-NetworkSuggestsCn"):
        assert gone not in ps1, f"{gone} should be deleted from the .ps1 lib (hc-474)"


def test_sh_resolve_never_reads_the_cache():
    sh = LIB_SH.read_text()
    body = sh.split("apexnodes_resolve_region() {", 1)[1].split("\n}\n", 1)[0]
    for read_marker in ('[ -r "$cache" ]', "cat \"$cache\""):
        assert read_marker not in body, "apexnodes_resolve_region must not READ the region cache"
    assert ".apexnodes-region" in body, "apexnodes_resolve_region must still WRITE the telemetry cache"
