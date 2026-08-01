# ===========================================================================
# scripts/lib/apexnodes-region-detect.ps1
# ---------------------------------------------------------------------------
# Sourceable ApexNodes overlay: COS-first artifact sourcing + CN mirror env.
# Windows twin of scripts/lib/apexnodes-region-detect.sh -- keep the two in step
# (probe, precedence rules, env-var names, COS layout are identical).
#
# hc-474 (default-to-COS): the COS download helpers below are region-
# independent -- every install with HERMES_RUNTIME_COS_BASE configured tries our
# public-read COS bucket FIRST and falls back to the official foreign source
# only when COS fails. Region detection no longer gates any make-or-break
# install path; it only tunes the third-party package mirrors, where a wrong
# guess costs speed, never success.
#
# This file remains the SINGLE SOURCE OF TRUTH for the region decision and the
# mirror env values. It is an ApexNodes overlay seam (see apex_overlay/README.md):
# the file lives in OUR namespace under scripts/lib/, which upstream Hermes
# never creates (zero merge-conflict surface). install.ps1 stays byte-for-byte
# upstream apart from one self-locating dot-source plus a few one-line call sites.
#
# Dot-source it (NOT call-operator) so its functions land in the caller's scope
# and can read install.ps1's script-scope state ($HermesHome, $InstallDir,
# $Commit, $Branch) and write $script:UvCmd:
#   . "$PSScriptRoot\lib\apexnodes-region-detect.ps1"
#   Resolve-ApexRegion          # sets $env:HERMES_CN_MIRRORS from the region
#   Set-ApexCnMirrorEnv         # exports CN mirror env iff CN
# COS download helpers (also defined here):
#   Install-UvFromCos           # sets $script:UvCmd on success (COS-first)
#   Install-RuntimeFromCos      # populates $InstallDir (COS-first)
#   Install-GitFromCos          # populates $HermesHome\git (COS-first)
#
# Upstream parity: with HERMES_RUNTIME_COS_BASE unset AND HERMES_CN_MIRRORS
# unset/0 every function is a no-op and the installer behaves byte-for-byte
# like upstream. Only our own channels (desktop bundle, ops) set the COS base.
#
# install.ps1 provides Write-Info / Write-Warn / Write-Success and Get-WindowsArch
# before these run. When this lib is dot-sourced standalone (e.g. a unit test)
# those may be absent, so define no-op-safe fallbacks here -- only if missing.
# ===========================================================================

if (-not (Get-Command Write-Info -ErrorAction SilentlyContinue)) {
    function Write-Info    { param([string]$Message) Write-Host $Message }
}
if (-not (Get-Command Write-Warn -ErrorAction SilentlyContinue)) {
    function Write-Warn    { param([string]$Message) Write-Host $Message }
}
if (-not (Get-Command Write-Success -ErrorAction SilentlyContinue)) {
    function Write-Success { param([string]$Message) Write-Host $Message }
}

# ===========================================================================
# ApexNodes China mirror mode (opt-in via HERMES_CN_MIRRORS=1)
# ===========================================================================
# OFF by default: with the flag unset Set-ApexCnMirrorEnv does nothing and the
# third-party package sources stay byte-for-byte upstream. Since hc-474 this
# flag governs ONLY the third-party mirror env below -- the COS artifact helpers
# are region-independent and keyed solely on HERMES_RUNTIME_COS_BASE (see
# Test-CosConfigured). The split is deliberate:
#   * Our runtime source + uv + PortableGit come from our own public-read COS
#     bucket for EVERY region (COS-first, foreign fallback) -- see
#     Install-RuntimeFromCos / Install-UvFromCos / Install-GitFromCos.
#   * Public third-party deps use an established CN mirror below, but only on
#     CN deployments -- TUNA (pypi) has no global CDN and pointing the world
#     at CN mirrors would degrade non-CN installs.
# Each value only sets when unset so an operator can override any single
# mirror via the real environment.
function Test-CnEnabled { return ($env:HERMES_CN_MIRRORS -eq "1") }

# hc-474: "is COS-first configured for this install channel?" -- true whenever
# the public-read COS base is present (desktop bundle / ops set it; the
# upstream path never does). This -- not the region -- gates every COS
# artifact path, including install.ps1's interrupted-install reuse branch for
# a COS-populated (git-less) checkout.
function Test-CosConfigured { return (-not [string]::IsNullOrWhiteSpace($env:HERMES_RUNTIME_COS_BASE)) }

# ===========================================================================
# ApexNodes region detection (decides whether CN mirror env gets injected)
# ===========================================================================
# Twin of the "ApexNodes region detection" block in the .sh lib. hc-474 demoted
# this from install-path gatekeeper to mirror tuner: the COS helpers below no
# longer consult the region at all, so the ONLY thing decided here is whether
# Set-ApexCnMirrorEnv exports the third-party CN package mirrors. A wrong
# answer costs download speed, never install success. Precedence:
#   1. $env:HERMES_CN_MIRRORS already set -> respect verbatim, skip detection.
#   2. $env:APEXNODES_REGION = cn|global -> explicit operator/user override.
#   3. neither set -> fresh decisive probe, defaulting to "global" on doubt.
#
# hc-474 heuristic diet: the old timezone gate + npmmirror-vs-npmjs race and
# the $HermesHome\.apexnodes-region cache READ (plus its stale-'global'
# self-heal) are deleted -- the cache made a one-shot misdetection permanent
# (the F2 failure) and only existed to amortize probe cost back when the probe
# gated the fatal runtime-clone path. Every resolve now probes fresh (bounded)
# and the cache file is WRITE-ONLY telemetry: the runtime region signal
# (apex_overlay/region.py rule 3) still reads it, install-time code never does.
# Diagnostics use Write-Info/Write-Warn (information stream, never stdout) so
# the manifest / stage JSON frames the bootstrap runner parses stay clean.

# hc-636: measure the route we actually care about, not a proxy for geography.
#
# This used to ask "is github.com reachable?" and treat NO as "in China". That
# is a proxy signal, and mainland access to github is INTERMITTENT: on
# 2026-07-31 the same physical machine answered cn on one run and global on the
# next, 90 minutes apart. The costs of the two errors are wildly unequal --
# mirrors used from abroad are merely slower, upstream used from the mainland is
# tens of minutes or a failure -- so a coin-flip signal is the wrong shape.
#
# Instead: time both PyPI routes and take the faster one. That is the quantity
# the answer is FOR, so it cannot be right about geography and wrong about
# outcome. Probe hosts are the ones the bytes come from (files.pythonhosted.org
# vs the mirror), not the index hosts.
$script:PypiUpstreamProbe = "https://files.pythonhosted.org/packages/"
$script:PypiMirrorProbe = "https://pypi.tuna.tsinghua.edu.cn/packages/"
# How much faster upstream must be before we abandon the mirror. Both real
# cases clear 3x by a wide margin; the band it governs is where both routes
# work, so landing on the mirror there costs nothing.
$script:UpstreamMargin = 3

# Elapsed ms for a HEAD against $Url, or $null when the host gave no answer at
# all. ANY http status counts as an answer -- 403/404 from a live host is a
# perfectly good latency sample. Measuring the HOST rather than an object means
# the probe cannot rot when a path is renamed.
function Measure-HostResponse {
    param([Parameter(Mandatory)][string] $Url, [int] $TimeoutSec = 5)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        Invoke-WebRequest -Uri $Url -Method Head -TimeoutSec $TimeoutSec -UseBasicParsing | Out-Null
        return [int]$sw.ElapsedMilliseconds
    } catch {
        # An HTTP error status carries a Response -- the host answered, and the
        # timing is valid. A timeout or DNS/socket failure carries none.
        if ($_.Exception.Response) { return [int]$sw.ElapsedMilliseconds }
        return $null
    }
}

# $true when the domestic mirror is the better PyPI route from here.
function Test-PypiRouteIsDomestic {
    $upstream = Measure-HostResponse -Url $script:PypiUpstreamProbe
    $mirror = Measure-HostResponse -Url $script:PypiMirrorProbe

    # Best-of-2 for the MIRROR only, and the asymmetry is why. A mirror spike
    # makes us abandon the mirror -> a mainland install pays tens of minutes. An
    # upstream spike makes us keep the mirror -> nobody is hurt. So re-sample
    # exactly the side whose noise causes the expensive error, and do not pay a
    # second upstream probe (which is the one that times out where it matters).
    if ($null -ne $mirror) {
        $second = Measure-HostResponse -Url $script:PypiMirrorProbe
        if (($null -ne $second) -and ($second -lt $mirror)) { $mirror = $second }
    }

    # Order matters, and encodes the asymmetry: every ambiguous case resolves
    # toward the mirror. Upstream silent (including a box with no network at
    # all) -> mirror; only a demonstrably-working upstream beside a silent
    # mirror picks global.
    if ($null -eq $upstream) { return $true }
    if ($null -eq $mirror) { return $false }

    # Global requires upstream to be DECISIVELY faster (>= 3x), not merely
    # ahead. A bare `<` makes near-parity a coin flip -- the same defect being
    # fixed here, one threshold down: a host measured 135 vs 158 ms on one
    # sample and 376 vs 190 on the next. Both real cases clear this margin
    # easily (mainland: upstream times out; abroad: the mirror is far away), so
    # the margin only governs the parity band, and there both routes work --
    # which makes the mirror the safe side to land on.
    return ($mirror -le ($upstream * $script:UpstreamMargin))
}

function Resolve-ApexRegion {
    # Rule 1: explicit HERMES_CN_MIRRORS wins; do not touch it, do not probe.
    if (-not [string]::IsNullOrEmpty($env:HERMES_CN_MIRRORS)) { return }

    # Rule 2: explicit region knob.
    $region = ("$env:APEXNODES_REGION").Trim().ToLowerInvariant()
    switch ($region) {
        { $_ -in @('cn','china','mainland') } {
            $env:HERMES_CN_MIRRORS = '1'
            Write-Info "ApexNodes region: cn (from APEXNODES_REGION) -- using China mirrors"
            return
        }
        { $_ -in @('global','intl','international','foreign','row') } {
            $env:HERMES_CN_MIRRORS = '0'
            Write-Info "ApexNodes region: global (from APEXNODES_REGION) -- using default sources"
            return
        }
        '' { }  # fall through to auto-detect
        default {
            Write-Warn "Unknown APEXNODES_REGION='$env:APEXNODES_REGION' (expected cn|global) -- auto-detecting"
        }
    }

    # Rule 3: fresh decisive probe -- whichever PyPI route is actually faster
    # from this machine wins. See Test-PypiRouteIsDomestic for why this replaced
    # the old github-reachability proxy (hc-636) and why ambiguity now resolves
    # toward the mirror instead of away from it.
    $detected = if (Test-PypiRouteIsDomestic) { 'cn' } else { 'global' }

    # Telemetry write (best-effort; never fail the install). Install-time code
    # never reads this back -- the runtime region signal (apex_overlay/region.py)
    # does. Delete the file or set APEXNODES_REGION to steer runtime behavior.
    try {
        if (-not (Test-Path $HermesHome)) { New-Item -ItemType Directory -Force -Path $HermesHome | Out-Null }
        Set-Content -Path (Join-Path $HermesHome ".apexnodes-region") -Value $detected -Encoding ASCII -ErrorAction SilentlyContinue
    } catch { }

    if ($detected -eq 'cn') {
        $env:HERMES_CN_MIRRORS = '1'
        Write-Info "ApexNodes region: cn (auto-detected) -- using China mirrors"
        Write-Info "  (override with APEXNODES_REGION=global if this is wrong)"
    } else {
        $env:HERMES_CN_MIRRORS = '0'
        # Quiet on the global path to keep upstream/CI output byte-clean.
    }
}

# Export the CN mirror env (no-op unless CN mode is on). Idempotent: every value
# only sets when unset so a pre-set operator override is preserved.
function Set-ApexCnMirrorEnv {
    if (-not (Test-CnEnabled)) { return }
    # Python package index -> Tsinghua TUNA (PyPI mirror).
    if (-not $env:UV_DEFAULT_INDEX)         { $env:UV_DEFAULT_INDEX = "https://pypi.tuna.tsinghua.edu.cn/simple" }
    if (-not $env:UV_INDEX_URL)             { $env:UV_INDEX_URL = $env:UV_DEFAULT_INDEX }
    if (-not $env:PIP_INDEX_URL)            { $env:PIP_INDEX_URL = "https://pypi.tuna.tsinghua.edu.cn/simple" }
    # uv-managed CPython (astral python-build-standalone) -> npmmirror binary mirror.
    if (-not $env:UV_PYTHON_INSTALL_MIRROR) { $env:UV_PYTHON_INSTALL_MIRROR = "https://registry.npmmirror.com/-/binary/python-build-standalone" }
    # npm registry + Electron binaries -> npmmirror.
    if (-not $env:npm_config_registry)      { $env:npm_config_registry = "https://registry.npmmirror.com" }
    if (-not $env:ELECTRON_MIRROR)          { $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/" }
    # Node.js dist tarballs -> npmmirror binary mirror (consumed by Install-Node).
    if (-not $env:HERMES_NODE_DIST_BASE)    { $env:HERMES_NODE_DIST_BASE = "https://registry.npmmirror.com/-/binary/node" }
    # hc-476: Playwright's Chromium download (~170MB, no CN CDN) -> npmmirror's
    # official binary-mirror-config value (cnpm/binary-mirror-config "china"
    # ENVS). Read natively by `playwright install` itself, so this covers every
    # call site (install.sh/.ps1 AND the runtime autoinstall in browser_tool.py).
    if (-not $env:PLAYWRIGHT_DOWNLOAD_HOST) { $env:PLAYWRIGHT_DOWNLOAD_HOST = "https://cdn.npmmirror.com/binaries/playwright" }
}

# ===========================================================================
# COS-first download helpers (hc-474: every region, foreign fallback)
# ===========================================================================

# COS-first: fetch a prebuilt uv from our public-read COS bucket before the
# astral.sh installer (which downloads from github.com, blocked in mainland
# China). Mirrors install.sh's apexnodes_install_uv_from_cos. The publish script
# ships uv-<triple>.zip (astral's Windows uv is a .zip, not .tar.gz). Returns
# $true with $script:UvCmd set on success; $false on any failure so Install-Uv
# falls through to the astral path.
function Install-UvFromCos {
    if (-not (Test-CosConfigured)) { return $false }

    $arch = Get-WindowsArch
    $triple = if ($arch -eq 'arm64') { 'aarch64-pc-windows-msvc' } else { 'x86_64-pc-windows-msvc' }
    $base = $env:HERMES_RUNTIME_COS_BASE.TrimEnd('/')
    $url = "$base/uv-$triple.zip"
    $binDir = Join-Path $HermesHome "bin"
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
    $tmp = Join-Path $env:TEMP ("hermes-uv-" + [System.Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    try {
        Write-Info "Fetching uv from COS mirror: $url"
        Invoke-WebRequest -Uri $url -OutFile (Join-Path $tmp "uv.zip") -UseBasicParsing
        Expand-Archive -Path (Join-Path $tmp "uv.zip") -DestinationPath $tmp -Force
        $uvExe = Get-ChildItem -Path $tmp -Recurse -Filter "uv.exe" | Select-Object -First 1
        if (-not $uvExe) {
            Write-Warn "uv.exe not found inside COS archive -- will try the astral.sh installer"
            return $false
        }
        Copy-Item $uvExe.FullName (Join-Path $binDir "uv.exe") -Force
        $uvxExe = Get-ChildItem -Path $tmp -Recurse -Filter "uvx.exe" | Select-Object -First 1
        if ($uvxExe) { Copy-Item $uvxExe.FullName (Join-Path $binDir "uvx.exe") -Force }
        $managedUv = Join-Path $binDir "uv.exe"
        if (-not (Test-Path $managedUv)) { return $false }
        $script:UvCmd = $managedUv
        $version = & $managedUv --version
        Write-Success "Managed uv installed from COS mirror ($version)"
        return $true
    } catch {
        Write-Warn "COS uv install failed ($_) -- will try the astral.sh installer"
        return $false
    } finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
}

# Pure-.NET .tar.gz extractor, used ONLY when tar.exe cannot be launched
# (hc-642). Some endpoint-security products deny execution of System32 binaries
# from a script host: a mainland Windows first install was observed failing with
#   程序"tar.exe"无法运行: 拒绝访问
# which, because this script runs with EAP=Stop, turned into a terminating error
# that took down the whole COS fast path. The install then fell back to
# git-over-SSH -> git-over-HTTPS -> ZIP and sat in `repository` for 3h50m before
# the user cancelled. The download had already succeeded; only the unpack failed.
#
# Deliberately narrow. Regular files, directories, and the two long-name
# mechanisms (GNU 'L' and pax 'x' path=) are handled because that is what
# `git archive` emits. ANY other entry type returns $false so the caller keeps
# its existing git fallback rather than silently materialising a partial tree --
# a half-extracted runtime would fail much later and much more confusingly than
# a clone.
#
# .NET's TarFile (System.Formats.Tar) would do this in one line but it is .NET 7+;
# the installer runs under Windows PowerShell 5.1 / .NET Framework, so the 512-byte
# header walk below is the portable option.
function Expand-TarGzManaged {
    param(
        [Parameter(Mandatory)][string] $Tarball,
        [Parameter(Mandatory)][string] $Destination,
        [int] $StripComponents = 0
    )

    $BLOCK = 512
    $gz = $null; $tar = $null
    try {
        $gz = [System.IO.File]::OpenRead($Tarball)
        $tar = New-Object System.IO.Compression.GZipStream($gz, [System.IO.Compression.CompressionMode]::Decompress)

        $header = New-Object byte[] $BLOCK
        $pendingName = $null   # set by a preceding 'L' or 'x' entry
        $zeroBlocks = 0

        # Read exactly $count bytes; $false when the stream ends early.
        $readFull = {
            param($buf, $count)
            $got = 0
            while ($got -lt $count) {
                $n = $tar.Read($buf, $got, $count - $got)
                if ($n -le 0) { return $false }
                $got += $n
            }
            return $true
        }

        while ($true) {
            if (-not (& $readFull $header $BLOCK)) { break }

            # Two consecutive all-zero blocks terminate the archive.
            $isZero = $true
            foreach ($b in $header) { if ($b -ne 0) { $isZero = $false; break } }
            if ($isZero) {
                $zeroBlocks++
                if ($zeroBlocks -ge 2) { break }
                continue
            }
            $zeroBlocks = 0

            $str = {
                param($off, $len)
                $s = [System.Text.Encoding]::UTF8.GetString($header, $off, $len)
                $nul = $s.IndexOf([char]0)
                if ($nul -ge 0) { $s = $s.Substring(0, $nul) }
                return $s.Trim()
            }

            $name = & $str 0 100
            $prefix = & $str 345 155
            if ($prefix) { $name = "$prefix/$name" }
            $typeflag = [char]$header[156]

            $sizeOct = & $str 124 12
            if ([string]::IsNullOrWhiteSpace($sizeOct)) { $size = 0 }
            else {
                try { $size = [Convert]::ToInt64($sizeOct, 8) }
                catch { Write-Warn "tar: unreadable size field for '$name'"; return $false }
            }
            $padded = [int][Math]::Ceiling($size / [double]$BLOCK) * $BLOCK

            # Entry payload (only read when we need it or must skip it).
            $readPayload = {
                $buf = New-Object byte[] $padded
                if ($padded -gt 0 -and -not (& $readFull $buf $padded)) { return $null }
                return $buf
            }

            # if/elseif, NOT switch: in PowerShell `continue` inside a switch
            # continues the SWITCH, not the enclosing loop, so a `continue` here
            # would fall through to the type check below and reject the very
            # headers it just consumed. (Caught by the round-trip test: tar
            # encodes a non-ASCII filename as a pax 'x' header, which turned
            # into "entry type 'x' unsupported".)
            if ($typeflag -eq 'L') {
                # GNU long name: payload IS the next entry's name
                $buf = & $readPayload
                if ($null -eq $buf) { return $false }
                $s = [System.Text.Encoding]::UTF8.GetString($buf, 0, [int]$size)
                $pendingName = $s.TrimEnd([char]0).Trim()
                continue
            }
            elseif ($typeflag -eq 'x') {
                # pax extended header: take `path=` if present. git archive uses
                # this for long paths AND for any name that is not plain ASCII.
                $buf = & $readPayload
                if ($null -eq $buf) { return $false }
                $text = [System.Text.Encoding]::UTF8.GetString($buf, 0, [int]$size)
                foreach ($line in $text -split "`n") {
                    # records are "<len> key=value"
                    $m = [regex]::Match($line, '^\d+\s+path=(.*)$')
                    if ($m.Success) { $pendingName = $m.Groups[1].Value.Trim() }
                }
                continue
            }
            elseif ($typeflag -eq 'g') {
                # global pax header: metadata for the whole archive, ignore it
                if ($null -eq (& $readPayload)) { return $false }
                continue
            }

            if ($pendingName) { $name = $pendingName; $pendingName = $null }

            # Strip leading path components (the archive is --prefix=hermes-agent/).
            $rel = $name -replace '\\', '/'
            if ($StripComponents -gt 0) {
                $parts = $rel.Split('/') | Where-Object { $_ -ne '' }
                if ($parts.Count -le $StripComponents) { $rel = '' }
                else { $rel = ($parts[$StripComponents..($parts.Count - 1)]) -join '/' }
            }

            # Refuse anything that would escape $Destination (tar-slip).
            if ($rel -match '(^|/)\.\.(/|$)' -or $rel -match '^([A-Za-z]:|/)') {
                Write-Warn "tar: refusing unsafe entry path '$name'"
                return $false
            }

            if ($typeflag -eq '5') {
                if ($rel) { New-Item -ItemType Directory -Force -Path (Join-Path $Destination $rel) | Out-Null }
                if ($padded -gt 0 -and $null -eq (& $readPayload)) { return $false }
                continue
            }

            if ($typeflag -ne '0' -and $typeflag -ne [char]0) {
                # Symlink/hardlink/device/fifo — not something we can fabricate
                # faithfully here. Bail so the caller clones instead.
                Write-Warn "tar: entry type '$typeflag' unsupported ('$name') -- falling back"
                return $false
            }

            $buf = & $readPayload
            if ($null -eq $buf) { return $false }
            if (-not $rel) { continue }

            $target = Join-Path $Destination $rel
            $parent = Split-Path -Parent $target
            if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
            $fs = [System.IO.File]::Create($target)
            try { $fs.Write($buf, 0, [int]$size) } finally { $fs.Dispose() }
        }
        return $true
    } catch {
        Write-Warn "tar: managed extraction failed ($_)"
        return $false
    } finally {
        if ($tar) { $tar.Dispose() }
        if ($gz) { $gz.Dispose() }
    }
}

# COS-first: download the pinned runtime source tarball from our public-read
# COS bucket before any git clone of github.com (blocked/slow in mainland
# China). Mirrors install.sh's apexnodes_download_runtime_tarball -- the tarball
# is `git archive --prefix=hermes-agent/` of the pinned commit (clean source
# tree, NO .git), keyed by the pinned commit (preferred) or branch so the COS
# object matches the desktop build stamp. Returns $true with $InstallDir
# populated on success; $false (and $InstallDir removed) on any failure so
# Install-Repository falls back to a normal git clone.
function Install-RuntimeFromCos {
    if (-not (Test-CosConfigured)) { return $false }

    $key = if ($Commit) { $Commit } else { $Branch }
    if ([string]::IsNullOrWhiteSpace($key)) { return $false }

    $base = $env:HERMES_RUNTIME_COS_BASE.TrimEnd('/')
    $url = "$base/hermes-agent-$key.tar.gz"
    $tmp = Join-Path $env:TEMP ("hermes-src-" + [System.Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    $tarball = Join-Path $tmp "runtime.tar.gz"
    try {
        Write-Info "Downloading runtime source from COS mirror: $url"
        Invoke-WebRequest -Uri $url -OutFile $tarball -UseBasicParsing
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
        # Archive built with --prefix=hermes-agent/, so strip the leading dir.
        # Extract with Windows' OWN bsdtar (System32\tar.exe, Win10 1803+): it treats
        # C:\ paths natively. Bare `tar` resolves to PortableGit's GNU tar (its usr\bin
        # is on PATH) which misreads the "C:" in the archive path as a remote host:path
        # -> "tar (child): Cannot connect to C: resolve failed" (the observed COS-extract
        # failure that fell back to a github clone). GNU tar needs --force-local; bsdtar
        # does not, so prefer bsdtar by full path and only fall back to GNU tar.
        $extracted = $false
        $sysTar = Join-Path $env:SystemRoot "System32\tar.exe"
        try {
            $global:LASTEXITCODE = 0
            if (Test-Path $sysTar) {
                & $sysTar -xzf $tarball -C $InstallDir --strip-components=1
            } else {
                & tar --force-local -xzf $tarball -C $InstallDir --strip-components=1
            }
            $extracted = ($LASTEXITCODE -eq 0)
            if (-not $extracted) { Write-Warn "tar exited $LASTEXITCODE -- retrying with the managed extractor" }
        } catch {
            # hc-642: tar.exe is PRESENT but cannot be launched -- endpoint
            # security denying execution of System32 binaries from a script host
            # ("程序\"tar.exe\"无法运行: 拒绝访问"). With EAP=Stop that is a
            # terminating error, which used to take the whole COS path down and
            # send the install into the hours-long git/ZIP fallback chain. The
            # tarball is already on disk; unpack it ourselves instead.
            Write-Warn "tar could not be run ($_) -- using the managed extractor"
        }
        if (-not $extracted) {
            # A partial tar run may have left files behind; start clean so the
            # pyproject.toml check below cannot pass on a half-written tree.
            Remove-Item -Recurse -Force $InstallDir -ErrorAction SilentlyContinue
            New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
            $extracted = Expand-TarGzManaged -Tarball $tarball -Destination $InstallDir -StripComponents 1
        }
        if (-not $extracted) {
            Write-Warn "COS runtime tarball could not be extracted -- falling back to git clone"
            if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir -ErrorAction SilentlyContinue }
            return $false
        }
        if (-not (Test-Path (Join-Path $InstallDir "pyproject.toml"))) {
            Write-Warn "COS runtime tarball missing pyproject.toml -- falling back to git clone"
            if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir -ErrorAction SilentlyContinue }
            return $false
        }
        Write-Success "Runtime source ready from COS mirror ($key)"
        return $true
    } catch {
        Write-Warn "COS runtime download failed ($_) -- falling back to git clone"
        if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir -ErrorAction SilentlyContinue }
        return $false
    } finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
}

# COS-first: fetch PortableGit from our public-read COS bucket before the
# git-for-windows GitHub release (github.com releases are slow / blocked in
# mainland China, throttled elsewhere). The publish script stages the SAME
# asset name git-for-windows ships (PortableGit-<ver>-64-bit.7z.exe /
# -arm64.7z.exe) under the COS base, so the extraction path is byte-identical to
# Install-Git's github stage. Returns $true with $HermesHome\git populated and the
# session PATH pointing at it on success; $false on any failure so Install-Git
# falls through to the github download. 32-bit gets no COS git (PortableGit is
# 64-bit/arm64 only) -- Install-Git owns that MinGit fallback. The caller (Install-Git)
# persists the User PATH + git-bash env, shared with the github path.
function Install-GitFromCos {
    if (-not (Test-CosConfigured)) { return $false }

    # Keep $gitVer in lockstep with Install-Git's $gitVer in scripts/install.ps1.
    $gitVer = "2.54.0"
    $arch = Get-WindowsArch
    if ($arch -eq 'arm64') {
        $assetName = "PortableGit-$gitVer-arm64.7z.exe"
    } elseif ($arch -eq 'x64') {
        $assetName = "PortableGit-$gitVer-64-bit.7z.exe"
    } else {
        return $false  # 32-bit: no PortableGit build -- let Install-Git fall through to MinGit.
    }

    $base = $env:HERMES_RUNTIME_COS_BASE.TrimEnd('/')
    $url = "$base/$assetName"
    $gitDir = Join-Path $HermesHome "git"
    $tmpFile = Join-Path $env:TEMP $assetName
    try {
        Write-Info "Fetching PortableGit from COS mirror: $url"
        Invoke-WebRequest -Uri $url -OutFile $tmpFile -UseBasicParsing

        if (Test-Path $gitDir) { Remove-Item -Recurse -Force $gitDir -ErrorAction SilentlyContinue }
        New-Item -ItemType Directory -Path $gitDir -Force | Out-Null

        # PortableGit is a self-extracting 7z archive: `-o<target> -y` (silent).
        $extractProc = Start-Process -FilePath $tmpFile `
            -ArgumentList "-o`"$gitDir`"", "-y" `
            -NoNewWindow -Wait -PassThru
        if ($extractProc.ExitCode -ne 0) {
            Write-Warn "COS PortableGit extraction failed (exit $($extractProc.ExitCode)) -- will try the github download"
            return $false
        }
        $gitExe = Join-Path $gitDir "cmd\git.exe"
        if (-not (Test-Path $gitExe)) {
            Write-Warn "COS PortableGit missing git.exe -- will try the github download"
            return $false
        }
        # Session PATH so the rest of this install run can use git. (User-PATH
        # persist + Set-GitBashEnvVar are done by the caller, shared with the github path.)
        $env:Path = "$gitDir\cmd;$env:Path"
        $version = & $gitExe --version
        Write-Success "PortableGit installed from COS mirror ($version)"
        return $true
    } catch {
        Write-Warn "COS PortableGit install failed ($_) -- will try the github download"
        return $false
    } finally {
        Remove-Item -Force $tmpFile -ErrorAction SilentlyContinue
    }
}

# Where COS-mirrored third-party CLIs land. Separate from $HermesHome\bin on
# purpose -- see the note on Install-OptionalPkgFromCos below.
function Get-ApexToolsDir { return (Join-Path $HermesHome "tools") }

# Put the tools dir on PATH for (a) this process, so the caller's post-install
# Get-Command verification actually sees what we just installed, and (b) the
# User scope, so it survives into the shells the agent spawns later.
#
# User-scope persistence is best-effort via Set-UserEnvSafe when install.ps1 has
# dot-sourced us (group-policy-locked HKCU\Environment killed an install once
# already, 2026-07-05). The process-scope half always works and is what the
# desktop shell inherits, so a locked registry costs a future shell, not this
# install.
function Register-ApexToolsPath {
    $toolsDir = Get-ApexToolsDir
    if (-not (Test-Path $toolsDir)) { return }

    $current = $env:PATH -split ';'
    if ($current -notcontains $toolsDir) { $env:PATH = "$toolsDir;$env:PATH" }

    try {
        $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
        $userPathItems = if ($userPath) { $userPath -split ";" } else { @() }
        if ($userPathItems -notcontains $toolsDir) {
            $userPathItems += $toolsDir
            if (Get-Command Set-UserEnvSafe -ErrorAction SilentlyContinue) {
                Set-UserEnvSafe "Path" ($userPathItems -join ";") | Out-Null
            } else {
                [Environment]::SetEnvironmentVariable("Path", ($userPathItems -join ";"), "User")
            }
        }
    } catch {
        Write-Warn "Could not persist $toolsDir to the User PATH: $($_.Exception.Message)"
    }
}

# COS-first for the two OPTIONAL system packages (hc-632). Same shape as
# Install-UvFromCos / Install-GitFromCos above: fetch our own mirrored copy of
# the exact upstream artifact and extract the binary.
#
# Target is $HermesHome\tools, NOT $HermesHome\bin. Both runtime lookups are
# shutil.which() -- tools/tts_tool.py:_has_ffmpeg and tools/file_operations.py's
# rg invocation -- so unlike uv (always called by absolute path) these two must
# be ON PATH to count as installed. $HermesHome\bin holds our managed uv, and
# putting that on the user's PATH would shadow a system uv they never asked us
# to touch. A separate dir keeps the PATH entry to exactly what we mean by it.
#
# WHY THIS EXISTS AT ALL. 2026-07-31, a real first install on a mainland-China
# Windows box: every mandatory stage finished in ~17s total because each one
# already had a China route (uv/git/runtime -> COS, PyPI -> TUNA, CPython/node/
# npm/Electron/Playwright -> npmmirror). Then the install sat for 18+ minutes on
# `winget install --source winget` for ripgrep and ffmpeg -- the one download in
# the whole chain with no China mirror. The first patch only time-boxed and
# skipped it; Kael's call was the right one: mirror the files instead, so a CN
# install gets the same complete result as everyone else rather than a degraded
# one. A timeout is a seatbelt, not a road.
#
# Objects are published by scripts/mirror-optional-packages.py (integrity-gated:
# a zip that fails CRC or lacks the expected .exe is never uploaded).
# ffmpeg ships x64 only upstream; Windows-on-ARM runs it under emulation, which
# is exactly what `winget install Gyan.FFmpeg` lands there too.
function Install-OptionalPkgFromCos {
    param(
        [Parameter(Mandatory)][ValidateSet('ripgrep', 'ffmpeg')][string] $Package
    )
    if (-not (Test-CosConfigured)) { return $false }

    $arch = Get-WindowsArch
    if ($Package -eq 'ripgrep') {
        $triple = if ($arch -eq 'arm64') { 'aarch64-pc-windows-msvc' } else { 'x86_64-pc-windows-msvc' }
        $exeName = 'rg.exe'
    } else {
        $triple = 'x86_64-pc-windows-msvc'
        $exeName = 'ffmpeg.exe'
    }

    $base = $env:HERMES_RUNTIME_COS_BASE.TrimEnd('/')
    $url = "$base/$Package-$triple.zip"
    $toolsDir = Get-ApexToolsDir
    New-Item -ItemType Directory -Path $toolsDir -Force | Out-Null
    $tmp = Join-Path $env:TEMP ("hermes-$Package-" + [System.Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    try {
        Write-Info "Fetching $Package from COS mirror: $url"
        Invoke-WebRequest -Uri $url -OutFile (Join-Path $tmp "$Package.zip") -UseBasicParsing
        Expand-Archive -Path (Join-Path $tmp "$Package.zip") -DestinationPath $tmp -Force
        $exe = Get-ChildItem -Path $tmp -Recurse -Filter $exeName | Select-Object -First 1
        if (-not $exe) {
            Write-Warn "$exeName not found inside COS archive -- falling back to the package managers"
            return $false
        }
        Copy-Item $exe.FullName (Join-Path $toolsDir $exeName) -Force
        # ffmpeg's own probe tool ships in the same archive and several skills
        # shell out to it; installing one without the other is a half install.
        if ($Package -eq 'ffmpeg') {
            $probe = Get-ChildItem -Path $tmp -Recurse -Filter 'ffprobe.exe' | Select-Object -First 1
            if ($probe) { Copy-Item $probe.FullName (Join-Path $toolsDir 'ffprobe.exe') -Force }
        }
        Write-Success "$Package installed from COS mirror"
        return $true
    } catch {
        Write-Warn "COS $Package install failed ($_) -- falling back to the package managers"
        return $false
    } finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
}
