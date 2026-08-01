# hc-657: publish the desktop installer + electron-updater feed to Tencent COS.
#
# WHY THIS IS A SCRIPT AND NOT INLINE YAML
#
# It used to be ~30 lines inside desktop-windows.yml: download coscli, then
# `coscli cp` each file in a loop. Nothing bounded those transfers and nothing
# retried them. Three of the last twelve Windows releases burned EXACTLY 75
# minutes (the job's timeout-minutes) and shipped nothing, while the six that
# worked finished the whole job -- build included -- in 8 to 23 minutes. So the
# link is not slow; it intermittently STALLS, and an unbounded stall inside a
# fixed job budget converts one dead socket into a total release loss.
#
# Raising timeout-minutes only buys a longer stall. The fix is to bound each
# attempt so a hung transfer is detected in minutes and retried.
#
# NOTE ON "timeout + kill", which was rejected once before: in hc-632 a timeout
# around `winget install` was rejected, correctly, because it MASKED the real
# problem -- those packages had no China mirror, and the answer was to mirror
# them to our own COS so the slow path stopped existing. Here there is no
# dependency to remove: uploading our own 120 MB installer to our own bucket IS
# the deliverable. Bounding an unreliable network call so it can be retried is
# the handling, not a workaround for something we should have deleted.
#
# TWO PHASES, IN ORDER (this is the property that matters)
#
#   1. push every binary, and prove each one is actually fetchable
#   2. only then flip latest.yml, the file the shell updater polls
#
# The old loop happened to iterate exe -> blockmap -> latest.yml, so it got
# this right by accident of array order, with nothing asserting it. If the feed
# is ever written before its binaries land, every client that polls in that
# window resolves an installer that returns 404. Phase 2 is gated on phase 1
# here, and `Test-FeedReferencesOnlyPublishedFiles` refuses a feed naming a file
# this run did not publish.
#
# Verification is deliberately not "coscli exited 0": that only proves the
# client thought it sent bytes. We re-read each object over plain HTTPS and
# compare Content-Length to the local file, because the thing users depend on
# is the object being served, not the upload call returning.
#
# Dot-source this file to get the functions; it runs nothing on import so the
# tests beside it can drive each piece with injected failures.

Set-StrictMode -Version Latest

function Invoke-WithRetry {
    <#
    .SYNOPSIS
      Run an operation up to $Attempts times with linear backoff.
    .DESCRIPTION
      Mirrors the withRetry idiom in apps/desktop/scripts/assert-release-preflight.cjs
      (hc-655), including its rule: retry only transport-shaped failures. A
      definitive negative -- a file that is missing, a feed that names the wrong
      package -- must fail on the first attempt rather than be retried into a
      timeout, so callers raise those as terminating errors outside the
      operation block.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][scriptblock]$Operation,
        [Parameter(Mandatory)][string]$Description,
        [int]$Attempts = 3,
        [int]$DelaySeconds = 10
    )
    for ($i = 1; $i -le $Attempts; $i++) {
        try {
            return & $Operation
        } catch {
            if ($i -eq $Attempts) {
                throw "$Description failed after $Attempts attempt(s): $($_.Exception.Message)"
            }
            $wait = $DelaySeconds * $i
            Write-Host "$Description failed (attempt $i/$Attempts): $($_.Exception.Message); retrying in ${wait}s"
            Start-Sleep -Seconds $wait
        }
    }
}

function Invoke-BoundedProcess {
    <#
    .SYNOPSIS
      Run an executable under a hard wall-clock limit.
    .DESCRIPTION
      This is the piece the old inline loop lacked. `coscli cp` on a stalled
      connection never returns, so without a bound the process sits until the
      JOB is killed -- which is why the failures land at exactly 75 minutes and
      produce no artifact. Killing a stalled attempt converts an unbounded hang
      into an ordinary retryable error.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][string[]]$ArgumentList,
        [int]$TimeoutSeconds = 600
    )
    $proc = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -PassThru -NoNewWindow
    if (-not $proc.WaitForExit($TimeoutSeconds * 1000)) {
        try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch { }
        throw "timed out after ${TimeoutSeconds}s (no progress; treating as a stalled transfer)"
    }
    if ($proc.ExitCode -ne 0) {
        throw "exited with code $($proc.ExitCode)"
    }
}

function Get-RemoteContentLength {
    <#
    .SYNOPSIS
      Content-Length of a published object, or throw if it is not served.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Url, [int]$TimeoutSeconds = 60)
    $resp = Invoke-WebRequest -Uri $Url -Method Head -TimeoutSec $TimeoutSeconds -UseBasicParsing
    return [int64]$resp.Headers['Content-Length']
}

function Get-FeedReferencedNames {
    <#
    .SYNOPSIS
      File names an electron-updater feed points clients at.
    .DESCRIPTION
      latest.yml carries `url: APEX-<ver>-win-x64.exe` (plus `path:` on some
      electron-builder versions). Those are the names a client will request, so
      they are exactly what has to exist in the bucket already.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$FeedText)
    $names = @()
    foreach ($line in ($FeedText -split "`r?`n")) {
        if ($line -match '^\s*-?\s*(url|path)\s*:\s*(.+?)\s*$') {
            $value = $Matches[2].Trim(("'" + '"'))
            if ($value) { $names += $value }
        }
    }
    return @($names | Sort-Object -Unique)
}

function Test-FeedReferencesOnlyPublishedFiles {
    <#
    .SYNOPSIS
      Throw when the feed names something this run did not publish.
    .DESCRIPTION
      A feed advertising a package that is not in the bucket is worse than a
      failed release: the job goes green, and every client that polls gets a
      404 mid-update. Not retryable -- it means the feed and the binaries
      disagree, and trying again cannot change that.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$FeedText,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$PublishedNames
    )
    $referenced = Get-FeedReferencedNames -FeedText $FeedText
    $missing = @($referenced | Where-Object { $PublishedNames -notcontains $_ })
    if ($missing.Count -gt 0) {
        throw ("latest.yml points at file(s) this run did not publish: " +
               ($missing -join ', ') +
               ". Publishing it would advertise an installer that 404s.")
    }
    return $referenced
}

function Publish-DesktopRelease {
    <#
    .SYNOPSIS
      Publish binaries, prove they are served, then flip the updater feed.
    .PARAMETER Uploader
      scriptblock ($LocalPath, $ObjectKey). Injected by the tests so the
      ordering and retry behaviour can be driven without a network or a bucket.
    .PARAMETER Verifier
      scriptblock ($Url) returning the served byte count.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ReleaseDir,
        [Parameter(Mandatory)][string]$Prefix,
        [Parameter(Mandatory)][string]$BaseUrl,
        [Parameter(Mandatory)][scriptblock]$Uploader,
        [Parameter(Mandatory)][scriptblock]$Verifier,
        [int]$Attempts = 3,
        [int]$RetryDelaySeconds = 10
    )

    $feedPath = Join-Path $ReleaseDir 'latest.yml'
    if (-not (Test-Path $feedPath)) {
        throw "latest.yml missing under $ReleaseDir (the updater feed would be dead)"
    }
    $binaries = @(Get-ChildItem -Path (Join-Path $ReleaseDir '*.exe') -ErrorAction SilentlyContinue) +
                @(Get-ChildItem -Path (Join-Path $ReleaseDir '*.blockmap') -ErrorAction SilentlyContinue)
    if (-not ($binaries | Where-Object { $_.Extension -eq '.exe' })) {
        throw "no .exe found under $ReleaseDir"
    }

    # Fail before uploading anything if the feed and the build already disagree.
    $feedText = Get-Content -Path $feedPath -Raw
    Test-FeedReferencesOnlyPublishedFiles -FeedText $feedText -PublishedNames @($binaries.Name) | Out-Null

    # -- phase 1: binaries, each proven fetchable before the feed moves --------
    $published = @()
    foreach ($file in $binaries) {
        $key = "$Prefix/$($file.Name)"
        Invoke-WithRetry -Description "upload $($file.Name)" -Attempts $Attempts -DelaySeconds $RetryDelaySeconds -Operation {
            & $Uploader $file.FullName $key
        } | Out-Null
        $served = Invoke-WithRetry -Description "verify $($file.Name) is served" -Attempts $Attempts -DelaySeconds $RetryDelaySeconds -Operation {
            & $Verifier "$BaseUrl/$key"
        }
        if ([int64]$served -ne [int64]$file.Length) {
            throw "published $key is $served bytes but the local file is $($file.Length) -- refusing to advertise a truncated installer"
        }
        $published += $file.Name
        Write-Host "COS publish OK (verified): $key"
    }

    # -- phase 2: the feed, only now -------------------------------------------
    $feedKey = "$Prefix/latest.yml"
    Invoke-WithRetry -Description 'upload latest.yml' -Attempts $Attempts -DelaySeconds $RetryDelaySeconds -Operation {
        & $Uploader $feedPath $feedKey
    } | Out-Null
    Invoke-WithRetry -Description 'verify latest.yml is served' -Attempts $Attempts -DelaySeconds $RetryDelaySeconds -Operation {
        & $Verifier "$BaseUrl/$feedKey"
    } | Out-Null
    Write-Host "COS publish OK (verified): $feedKey"

    return [pscustomobject]@{ Published = $published; Feed = $feedKey }
}
