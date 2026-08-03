# hc-657: behavioural tests for publish-desktop-cos.ps1.
#
# These exist because the thing being fixed only happens on a FAILURE path. The
# old inline publish loop "worked" on every run that did not stall, which is
# exactly why a missing retry survived in it for months (AGENTS.md #14: a branch
# only taken during a fault can only be verified by injecting the fault).
#
# So every case here injects a fault: a transfer that fails twice, one that
# never succeeds, one that reports success while serving nothing, and a feed
# that names a package the run did not publish. Each asserts the observable
# consequence -- how many attempts were made, whether the feed was written,
# whether the script threw -- and not merely that some string is present.
#
# Plain PowerShell on purpose: no Pester dependency, so the release gate cannot
# break on a test-framework version. Run it directly; a non-zero exit is a
# failure.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'publish-desktop-cos.ps1')

$script:Failures = @()
$script:Passes = 0

function Assert-That {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][bool]$Condition, [string]$Detail = '')
    if ($Condition) {
        $script:Passes++
        Write-Host "  ok   $Name"
    } else {
        $script:Failures += "$Name $Detail"
        Write-Host "  FAIL $Name $Detail"
    }
}

function New-FakeRelease {
    param([string]$FeedBody)
    $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("hc657-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $dir | Out-Null
    Set-Content -Path (Join-Path $dir 'APEX-9.9.9-win-x64.exe') -Value 'INSTALLER-BYTES' -NoNewline -Encoding ascii
    if (-not $PSBoundParameters.ContainsKey('FeedBody')) {
        $FeedBody = "version: 9.9.9`nfiles:`n  - url: APEX-9.9.9-win-x64.exe`n"
    }
    Set-Content -Path (Join-Path $dir 'latest.yml') -Value $FeedBody -NoNewline -Encoding ascii
    return $dir
}

# Serves whatever the uploader claimed to upload, at its true on-disk size.
function New-Recorder {
    return [pscustomobject]@{ Uploads = New-Object System.Collections.ArrayList; Sizes = @{} }
}

Write-Host 'hc-657 publish-desktop-cos tests'

# --- 1. a transfer that fails twice must still complete -----------------------
Write-Host 'case: transient upload failure is retried, not fatal'
$dir = New-FakeRelease
$rec = New-Recorder
$script:attempt = 0
$uploader = {
    param($LocalPath, $Key)
    $script:attempt++
    if ($script:attempt -lt 3) { throw "simulated stall" }
    [void]$rec.Uploads.Add($Key)
    $rec.Sizes[$Key] = (Get-Item $LocalPath).Length
}
$verifier = { param($Url); return $rec.Sizes[(($Url -split '/') | Select-Object -Skip 3) -join '/'] }
$threw = $null
try {
    Publish-DesktopRelease -ReleaseDir $dir -Prefix 'desktop/win-x64' -BaseUrl 'https://example.test' `
        -Uploader $uploader -Verifier $verifier -Attempts 3 -RetryDelaySeconds 0 | Out-Null
} catch { $threw = $_ }
Assert-That -Name 'succeeds despite two failed attempts' -Condition ($null -eq $threw) -Detail "threw: $threw"
Assert-That -Name 'the feed was published' -Condition ($rec.Uploads -contains 'desktop/win-x64/latest.yml')
Remove-Item -Recurse -Force $dir

# --- 2. a transfer that never succeeds must fail loudly -----------------------
# The old loop had no retry, but it also had no way to distinguish "gave up"
# from "still going" -- it just hung. Exhausting retries has to throw.
Write-Host 'case: exhausted retries throw instead of returning quietly'
$dir = New-FakeRelease
$rec = New-Recorder
$calls = 0
$uploader = { param($LocalPath, $Key); $script:calls++; throw 'always down' }
$verifier = { param($Url); return 0 }
$threw = $null
try {
    Publish-DesktopRelease -ReleaseDir $dir -Prefix 'desktop/win-x64' -BaseUrl 'https://example.test' `
        -Uploader $uploader -Verifier $verifier -Attempts 3 -RetryDelaySeconds 0 | Out-Null
} catch { $threw = $_ }
Assert-That -Name 'throws once attempts are exhausted' -Condition ($null -ne $threw)
Assert-That -Name 'tried exactly Attempts times' -Condition ($script:calls -eq 3) -Detail "calls=$script:calls"
Assert-That -Name 'never wrote the feed' -Condition (-not ($rec.Uploads -contains 'desktop/win-x64/latest.yml'))
Remove-Item -Recurse -Force $dir

# --- 3. THE ordering property: feed must never precede its binaries -----------
# This is the one that protects users rather than the job. If the binary cannot
# be served, publishing latest.yml would point every polling client at a 404.
Write-Host 'case: feed is not flipped when a binary cannot be served'
$dir = New-FakeRelease
$rec = New-Recorder
$uploader = { param($LocalPath, $Key); [void]$rec.Uploads.Add($Key) }   # "succeeds"...
$verifier = { param($Url); throw '404 not found' }                      # ...but nothing is served
$threw = $null
try {
    Publish-DesktopRelease -ReleaseDir $dir -Prefix 'desktop/win-x64' -BaseUrl 'https://example.test' `
        -Uploader $uploader -Verifier $verifier -Attempts 2 -RetryDelaySeconds 0 | Out-Null
} catch { $threw = $_ }
Assert-That -Name 'unserved binary fails the publish' -Condition ($null -ne $threw)
Assert-That -Name 'latest.yml was NOT uploaded' -Condition (-not ($rec.Uploads -contains 'desktop/win-x64/latest.yml')) `
    -Detail ("uploads=" + ($rec.Uploads -join ','))
Remove-Item -Recurse -Force $dir

# --- 4. exit code 0 is not proof: a truncated object must be caught -----------
Write-Host 'case: a short object is rejected even though the upload "succeeded"'
$dir = New-FakeRelease
$rec = New-Recorder
$uploader = { param($LocalPath, $Key); [void]$rec.Uploads.Add($Key) }
$verifier = { param($Url); return 1 }   # one byte served, installer is longer
$threw = $null
try {
    Publish-DesktopRelease -ReleaseDir $dir -Prefix 'desktop/win-x64' -BaseUrl 'https://example.test' `
        -Uploader $uploader -Verifier $verifier -Attempts 1 -RetryDelaySeconds 0 | Out-Null
} catch { $threw = $_ }
Assert-That -Name 'size mismatch fails the publish' -Condition ($null -ne $threw)
Assert-That -Name 'latest.yml was NOT uploaded after a truncated binary' `
    -Condition (-not ($rec.Uploads -contains 'desktop/win-x64/latest.yml'))
Remove-Item -Recurse -Force $dir

# --- 5. a feed naming an unbuilt package is refused before anything uploads ---
Write-Host 'case: feed referencing a package this run did not build is refused'
$dir = New-FakeRelease -FeedBody "version: 9.9.9`nfiles:`n  - url: APEX-0.0.1-win-x64.exe`n"
$rec = New-Recorder
$uploader = { param($LocalPath, $Key); [void]$rec.Uploads.Add($Key) }
$verifier = { param($Url); return 1 }
$threw = $null
try {
    Publish-DesktopRelease -ReleaseDir $dir -Prefix 'desktop/win-x64' -BaseUrl 'https://example.test' `
        -Uploader $uploader -Verifier $verifier -Attempts 1 -RetryDelaySeconds 0 | Out-Null
} catch { $threw = $_ }
Assert-That -Name 'mismatched feed fails the publish' -Condition ($null -ne $threw)
Assert-That -Name 'nothing at all was uploaded' -Condition ($rec.Uploads.Count -eq 0) `
    -Detail ("uploads=" + ($rec.Uploads -join ','))
Remove-Item -Recurse -Force $dir

# --- 5b. the Content-Length shape, per PowerShell major version ---------------
# The first real release under this script uploaded 115 MB in 7.7s and then
# failed verification on all three attempts: under pwsh 7 the header comes back
# as a String[], and [int64] on an array throws. Every case above injects a fake
# -Verifier, so nothing ever executed the real one -- the seam that made the
# ordering testable is precisely what left this untested (AGENTS.md #14, from
# the inside).
Write-Host 'case: Content-Length parses on both PowerShell header shapes'
Assert-That -Name 'pwsh 7 String[] header' -Condition ((ConvertTo-ContentLength -HeaderValue @('120671920')) -eq 120671920)
Assert-That -Name 'Windows PowerShell 5.1 scalar header' -Condition ((ConvertTo-ContentLength -HeaderValue '120671920') -eq 120671920)
Assert-That -Name 'multi-valued header takes the first' -Condition ((ConvertTo-ContentLength -HeaderValue @('42', '99')) -eq 42)
Assert-That -Name 'whitespace tolerated' -Condition ((ConvertTo-ContentLength -HeaderValue @(' 7 ')) -eq 7)
foreach ($bad in @(@{ v = $null; n = 'null' }, @{ v = @(); n = 'empty array' }, @{ v = ''; n = 'empty string' })) {
    $threw = $null
    try { ConvertTo-ContentLength -HeaderValue $bad.v | Out-Null } catch { $threw = $_ }
    Assert-That -Name "missing header ($($bad.n)) throws rather than reading as 0" -Condition ($null -ne $threw)
}

# --- 6. the stall bound itself ------------------------------------------------
Write-Host 'case: a process that never returns is killed and reported as a stall'
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$threw = $null
try {
    if ($IsWindows -or $null -eq $IsWindows) {
        Invoke-BoundedProcess -FilePath 'powershell' -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 120') -TimeoutSeconds 3
    } else {
        Invoke-BoundedProcess -FilePath '/bin/sleep' -ArgumentList @('120') -TimeoutSeconds 3
    }
} catch { $threw = $_ }
$sw.Stop()
Assert-That -Name 'a hung process throws' -Condition ($null -ne $threw)
Assert-That -Name 'it is killed near the bound, not left to run' -Condition ($sw.Elapsed.TotalSeconds -lt 30) `
    -Detail "elapsed=$([int]$sw.Elapsed.TotalSeconds)s"
Assert-That -Name 'the error names it a stall' -Condition ("$threw" -match 'stalled|timed out') -Detail "$threw"

Write-Host ''
if ($script:Failures.Count -gt 0) {
    Write-Host "FAILED ($($script:Failures.Count)):"
    $script:Failures | ForEach-Object { Write-Host "  - $_" }
    exit 1
}
Write-Host "all $script:Passes assertions passed"
