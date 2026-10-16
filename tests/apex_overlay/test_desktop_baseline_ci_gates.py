"""ApexNodes hc-911: CI lanes that build or exercise upstream's Desktop stay off the APEX baseline.

apps/desktop stays on the APEX baseline (paired Mac arm64/x64 + Windows x64 NSIS releases, built
by its own npm pipeline). Two upstream lanes assume upstream's Desktop instead, and #390's first
fork CI run failed on both:

- nix flake check built the Desktop renderer through nix/desktop.nix, whose native-deps staging
  has no Nix path in APEX's apps/desktop ("cannot cross-compile native modules").
- the Windows bundle SDK lane ran upstream's MSIX signing tests, which APEX does not carry
  ("No test files found").

Both gates lapse once upstream's Desktop files are ported. The Windows-only Python lane also
runs on the fork's standard 4-vCPU pool, where upstream's 16 workers timed 15 files out.
"""

from __future__ import annotations

import re
from pathlib import Path

import hermes_yaml as yaml

REPO = Path(__file__).resolve().parents[2]
CHECKS_NIX = REPO / "nix/checks.nix"
MSIX_TOOLING = "apps/desktop/scripts/windows-bundle-tools.mjs"


def _nix_skips() -> list[str]:
    text = CHECKS_NIX.read_text(encoding="utf-8")
    block = re.search(r"apexDesktopBaselineSkips = lib\.optionals \(!builtins\.pathExists "
                      r"\.\./apps/desktop/product-identity\.cjs\) \[(?P<names>[^\]]*)\];", text)
    assert block, "nix/checks.nix lost the product-identity-gated apexDesktopBaselineSkips list"
    return re.findall(r'"([a-z0-9-]+)"', block["names"])


def _nix_checks() -> dict[str, str]:
    """Top-level check name -> its body, from the `checks = builtins.removeAttrs { ... }` set."""
    text = CHECKS_NIX.read_text(encoding="utf-8")
    assert "checks = builtins.removeAttrs {" in text and "} apexDesktopBaselineSkips;" in text
    starts = list(re.finditer(r"(?m)^ {8}([a-z][a-z0-9-]*) =", text))
    return {m[1]: text[m.end(): nxt.start() if nxt else len(text)]
            for m, nxt in zip(starts, [*starts[1:], None])}


def test_every_nix_check_that_builds_the_desktop_package_is_gated():
    checks = _nix_checks()
    skips = _nix_skips()
    assert set(skips) <= set(checks), f"skip list names unknown checks: {set(skips) - set(checks)}"
    builds_desktop = sorted(name for name, body in checks.items() if "${self'.packages.desktop}" in body)
    assert builds_desktop == sorted(skips), (
        f"checks that build the Desktop package {builds_desktop} must equal the gated list {sorted(skips)}")


def test_the_windows_bundle_sdk_lane_only_runs_against_the_msix_tooling():
    doc = yaml.safe_load((REPO / ".github/workflows/windows-bundle-sdk.yml").read_text(encoding="utf-8"))
    steps = doc["jobs"]["windows-bundle-tools"]["steps"]
    probe = next(i for i, s in enumerate(steps) if s.get("id") == "suite")
    assert MSIX_TOOLING in steps[probe]["run"]
    assert steps[probe - 1]["uses"].startswith("actions/checkout@"), "probe must run right after checkout"
    ungated = [s.get("name") or s.get("uses") for s in steps[probe + 1:]
               if s.get("if") != "steps.suite.outputs.present == 'true'"]
    assert ungated == [], f"steps that run without the MSIX tooling: {ungated}"


def test_windows_only_python_lane_fits_the_standard_runner():
    doc = yaml.safe_load((REPO / ".github/workflows/tests-os.yml").read_text(encoding="utf-8"))
    job = next(j for j in doc["jobs"].values() if "matrix" in (j.get("strategy") or {}))
    entry = next(e for e in job["strategy"]["matrix"]["include"] if e.get("marker") == "windows")
    assert entry["runner"] == "windows-latest"
    assert int(entry.get("timeout", 30)) >= 60
    workers = next(s["env"]["HERMES_TEST_WORKERS"] for s in job["steps"] if "HERMES_TEST_WORKERS" in (s.get("env") or {}))
    pinned = re.search(r"marker == 'windows' && '([0-9]+)'", workers)
    assert pinned and pinned[1] == "2", workers
