"""Guards for hc-632 — the optional Windows CLIs must come from our own mirror.

WHAT BROKE. 2026-07-31, a real first install on a mainland-China Windows box
hung 18+ minutes on the "prerequisites" stage. Every *mandatory* download in the
chain already had a China route (uv/git/runtime from COS, PyPI from TUNA,
CPython/Node/npm/Electron/Playwright from npmmirror) and finished in ~17s total.
The stall was `winget install --source winget` fetching ripgrep and ffmpeg: the
only downloads left in the whole install with no China mirror.

WHAT THESE TESTS PIN. The fix is that those two artifacts are mirrored onto our
COS and installed from there, ahead of any package manager. Three ways to
silently lose that, each of which restores the 18-minute stall:

1. Reordering, so a package manager runs before the COS attempt.
2. Region-gating the COS helper, which is how hc-474's F2 failure stranded a
   mainland install on github in the first place.
3. Installing the binaries somewhere the runtime cannot see them. Both lookups
   are shutil.which() -- tools/tts_tool.py:_has_ffmpeg and the rg invocation in
   tools/file_operations.py -- so "the copy succeeded" is not the same claim as
   "the tool is installed", and only PATH settles it.

Plus the publisher's integrity gate, exercised against real corrupt archives:
an incomplete zip on COS is worse than no zip, because the installer downloads
it, fails to expand it, and falls back anyway -- having burned the bandwidth
first. Not hypothetical: the first fetch of the 105MB ffmpeg build for this
mirror came back as 1.1MB through a proxy and looked fine until it was opened.

The .ps1 side is pinned at the source level (no pwsh on dev Macs / CI images),
mirroring tests/test_install_sh_default_to_cos.py's approach; the publisher is
imported and run for real.
"""

from __future__ import annotations

import importlib.util
import io
import re
import sys
import zipfile
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
LIB_PS1 = REPO_ROOT / "scripts" / "lib" / "apexnodes-region-detect.ps1"
INSTALL_PS1 = REPO_ROOT / "scripts" / "install.ps1"
PUBLISHER = REPO_ROOT / "scripts" / "mirror-optional-packages.py"


def _load_publisher():
    spec = importlib.util.spec_from_file_location("mirror_optional_packages", PUBLISHER)
    module = importlib.util.module_from_spec(spec)
    # Register before exec: dataclasses resolves annotations through
    # sys.modules and blows up on a module that is not there yet.
    sys.modules["mirror_optional_packages"] = module
    spec.loader.exec_module(module)
    return module


def _strip_ps_comments(source: str) -> str:
    """Drop whole-line PowerShell comments.

    The ordering assertions below are about executable order, and the comments
    explaining this fix necessarily name winget -- matching those would make the
    guard fire on its own documentation. Blank the lines instead of deleting
    them so reported offsets still map onto the real file.
    """
    return "\n".join("" if line.lstrip().startswith("#") else line for line in source.splitlines())


def _install_system_packages_body(*, keep_comments: bool = False) -> str:
    """The source of Install-SystemPackages, up to the next top-level function."""
    text = INSTALL_PS1.read_text(encoding="utf-8")
    start = text.index("function Install-SystemPackages")
    rest = text[start + 1 :]
    end = rest.index("\nfunction ")
    body = rest[:end]
    return body if keep_comments else _strip_ps_comments(body)


# --------------------------------------------------------------------------
# 1. COS is attempted, and attempted FIRST
# --------------------------------------------------------------------------


def test_cos_install_is_attempted_before_any_package_manager():
    body = _install_system_packages_body()
    cos_at = body.index("Install-OptionalPkgFromCos")
    for manager in ("winget", "choco", "scoop"):
        # First mention of the manager anywhere in the function, including the
        # `Get-Command winget` capability probe -- keeping the COS attempt ahead
        # of even that keeps the ordering unambiguous for a future reader.
        assert cos_at < body.index(manager), (
            f"{manager} is reached before the COS mirror attempt; a CN install "
            "would stall on the unmirrored source again (hc-632)"
        )


def test_cn_region_installs_rather_than_skips():
    """The CN path must end with the tools installed, not politely skipped.

    An earlier revision of this fix short-circuited on HERMES_CN_MIRRORS and
    printed a manual command instead. That traded an 18-minute stall for a
    permanently degraded install, which is not the same as fixing it.
    """
    body = _install_system_packages_body(keep_comments=True)
    assert "HERMES_CN_MIRRORS" not in body, (
        "Install-SystemPackages must not branch on region: the COS mirror serves "
        "every region, and a CN-only skip means CN users never get these tools"
    )


def test_success_is_confirmed_through_path_not_return_value():
    body = _install_system_packages_body()
    cos_at = body.index("Install-OptionalPkgFromCos")
    tail = body[cos_at:]
    assert "Register-ApexToolsPath" in tail, "installed binaries must be put on PATH"
    for probe in ("Get-Command rg", "Get-Command ffmpeg"):
        assert probe in tail, (
            f"after the COS install, {probe!r} must confirm the runtime can "
            "actually resolve it -- shutil.which() is the run-time authority"
        )


# --------------------------------------------------------------------------
# 2. The helper itself: region-independent, never throws, lands on PATH
# --------------------------------------------------------------------------


def _helper_body() -> str:
    text = LIB_PS1.read_text(encoding="utf-8")
    start = text.index("function Install-OptionalPkgFromCos")
    rest = text[start + 1 :]
    end = rest.index("\nfunction ") if "\nfunction " in rest else len(rest)
    return _strip_ps_comments(rest[:end])


def test_helper_gates_only_on_cos_being_configured():
    body = _helper_body()
    assert "if (-not (Test-CosConfigured)) { return $false }" in body
    for region_signal in ("HERMES_CN_MIRRORS", "APEXNODES_REGION", "Resolve-ApexRegion"):
        assert region_signal not in body, (
            f"{region_signal} must not gate the COS download (hc-474 F2: a "
            "misdetected region stranded a mainland install on github)"
        )


def test_helper_never_throws_into_the_install():
    """Optional means optional: a failed mirror fetch reports and returns $false."""
    body = _helper_body()
    assert "catch {" in body and "return $false" in body
    assert "throw" not in body, "a failed optional install must never abort the install"


def test_helper_installs_beside_path_registration_not_into_uv_bin():
    lib = LIB_PS1.read_text(encoding="utf-8")
    assert "function Get-ApexToolsDir" in lib
    assert "function Register-ApexToolsPath" in lib
    body = _helper_body()
    assert "Get-ApexToolsDir" in body
    assert 'Join-Path $HermesHome "bin"' not in body, (
        "these go in $HermesHome\\tools, not bin: bin holds our managed uv and "
        "putting it on the user's PATH would shadow a system uv"
    )


def test_ffprobe_ships_with_ffmpeg():
    # Assert the COPY, not the mention: an earlier draft of this guard only
    # checked that "ffprobe.exe" appeared somewhere in the function, which the
    # Get-ChildItem -Filter line satisfies all by itself. Deleting the copy
    # left it green.
    assert "Copy-Item $probe.FullName (Join-Path $toolsDir 'ffprobe.exe') -Force" in _helper_body(), (
        "ffprobe is in the same archive and skills shell out to it; installing "
        "one without the other is a half install"
    )


# --------------------------------------------------------------------------
# 3. Publisher and consumer agree on names, and the integrity gate holds
# --------------------------------------------------------------------------


def test_published_object_names_match_the_url_the_installer_builds():
    module = _load_publisher()
    published = {art.object_name for art in module.ARTIFACTS}

    body = _helper_body()
    assert '$url = "$base/$Package-$triple.zip"' in body

    packages = re.search(r"ValidateSet\(([^)]*)\)", body).group(1)
    packages = re.findall(r"'([^']+)'", packages)
    assert set(packages) == {"ripgrep", "ffmpeg"}

    triples = set(re.findall(r"'((?:x86_64|aarch64)-pc-windows-msvc)'", body))
    expected = {f"{p}-{t}.zip" for p in packages for t in triples}
    # ffmpeg is x64-only upstream, so the installer never asks for its aarch64
    # object -- everything the installer CAN ask for must exist.
    reachable = expected - {"ffmpeg-aarch64-pc-windows-msvc.zip"}
    assert reachable <= published, f"installer can request unpublished objects: {reachable - published}"


def test_integrity_gate_rejects_the_archives_that_would_hurt_users():
    """Reverse validation (AGENTS.md #14): make the failure, see the gate fire."""
    module = _load_publisher()

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("ripgrep-x/rg.exe", b"MZ" + b"\x00" * 4096)
    good = buf.getvalue()

    # Baseline: a sound archive passes, so a green result below means something.
    assert module.verify(good, "rg.exe") == "ripgrep-x/rg.exe"

    with pytest.raises(zipfile.BadZipFile):
        module.verify(good[: len(good) // 4], "rg.exe")  # truncated, the real-world case

    half = len(good) // 2
    corrupt = good[:half] + bytes([good[half] ^ 0xFF]) + good[half + 1 :]
    with pytest.raises((ValueError, zipfile.BadZipFile)):
        module.verify(corrupt, "rg.exe")  # CRC mismatch

    with pytest.raises(ValueError):
        module.verify(good, "ffmpeg.exe")  # right zip, wrong contents


# --------------------------------------------------------------------------
# 4. The desktop shell must expose the tools dir to the processes it spawns
# --------------------------------------------------------------------------


def test_desktop_puts_the_tools_dir_on_the_child_process_path():
    """install.ps1's User-PATH write does not reach the already-running shell.

    That write goes to the registry. The Electron main process started BEFORE
    the install ran, so its PATH -- and every child's, including the gateway --
    still predates it until the app restarts. Without the tools dir in the
    shell's own PATH composition, a fresh install leaves ripgrep and ffmpeg on
    disk and invisible to shutil.which() for the entire first session, which is
    the same "installed but not really" failure the PATH re-check in
    Install-SystemPackages exists to prevent.
    """
    main_ts = (REPO_ROOT / "apps" / "desktop" / "electron" / "main.ts").read_text(encoding="utf-8")

    assert "function hermesManagedToolsPathEntries" in main_ts
    assert "hermesManagedToolsPathEntries()" in main_ts.split("function pathWithHermesManagedNode", 1)[1], (
        "the tools dir must be composed into pathWithHermesManagedNode, which is "
        "what every spawned child (gateway, backend, updater) actually inherits"
    )
    entries = main_ts.split("function hermesManagedToolsPathEntries", 1)[1].split("}", 1)[0]
    assert "filter(directoryExists)" in entries, (
        "resolve per call like the node dirs -- a directory created mid-session "
        "must be picked up by the next spawn, not only after a restart"
    )


def test_pinned_versions_are_concrete():
    module = _load_publisher()
    for value in (module.RIPGREP_VERSION, module.FFMPEG_VERSION):
        assert re.fullmatch(r"\d+\.\d+\.\d+", value), (
            "versions are pinned so the COS path and the package-manager "
            "fallback install the same thing"
        )
