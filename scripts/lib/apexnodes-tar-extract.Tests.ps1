# Behavioural tests for Expand-TarGzManaged (hc-642).
#
# This function only ever runs on the failure path -- tar.exe present but not
# launchable -- so nothing else in the suite would ever execute it. Per
# AGENTS.md #14, a branch that is only reached during a failure has to be
# tested by manufacturing that failure, which here means calling the extractor
# directly and comparing the tree it produces against the tarball's contents.
#
# Plain PowerShell (no Pester): the installer itself runs under Windows
# PowerShell 5.1 and nothing in this repo's CI installs Pester. Exits non-zero
# on the first failure.
#
# Fixtures are built with tar at test time -- creating an archive with tar is
# fine, the thing under test is our READER.

$ErrorActionPreference = 'Stop'

# install.ps1 owns these reporters. The lib already self-stubs them when
# dot-sourced standalone, but define them here too so the test's own output
# stays readable and indented with the assertions it belongs to.
function Write-Info    { param($m) Write-Host "    [info] $m" }
function Write-Warn    { param($m) Write-Host "    [warn] $m" }
function Write-Success { param($m) Write-Host "    [ok]   $m" }

. (Join-Path $PSScriptRoot 'apexnodes-region-detect.ps1')

$script:Failures = 0
function Assert-True($cond, $msg) {
    if ($cond) { Write-Host "  ok   $msg" }
    else { Write-Host "  FAIL $msg" -ForegroundColor Red; $script:Failures++ }
}
function Assert-Eq($actual, $expected, $msg) {
    Assert-True ($actual -eq $expected) "$msg (got '$actual', want '$expected')"
}

function New-Workspace {
    $w = Join-Path ([System.IO.Path]::GetTempPath()) ("hc642-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $w | Out-Null
    return $w
}

# -- 1. round-trip: files, nesting, deep path, UTF-8 name ------------------
Write-Host "test: round-trips a git-archive-shaped tarball"
$ws = New-Workspace
try {
    $src = Join-Path $ws 'hermes-agent'
    # A >100-char path forces the long-name mechanism (GNU 'L' or pax 'x'),
    # which is exactly what a real repo tree hits.
    $deep = Join-Path $src ('a/' + ('nested-directory-with-a-long-name/' * 4).TrimEnd('/'))
    New-Item -ItemType Directory -Force -Path $deep | Out-Null
    Set-Content -LiteralPath (Join-Path $src 'pyproject.toml') -Value "[project]`nname = 'hermes-agent'`n" -NoNewline
    Set-Content -LiteralPath (Join-Path $src 'README.md') -Value "hello" -NoNewline
    Set-Content -LiteralPath (Join-Path $deep 'deep.txt') -Value "deep-content" -NoNewline
    # A non-ASCII filename is exactly what tar encodes via a pax 'x' header, so
    # this case must survive -- but built from code points, because this .ps1
    # must stay pure ASCII (Windows PowerShell 5.1 reads a BOM-less script in
    # the system ANSI code page and a stray byte desyncs the parser).
    $cjkName = [string][char]0x8BF4 + [string][char]0x660E + '.txt'   # U+8BF4 U+660E
    # Non-ASCII name: the header is decoded as UTF-8, not the OEM code page.
    Set-Content -LiteralPath (Join-Path $src $cjkName) -Value "zh" -NoNewline

    $tgz = Join-Path $ws 'runtime.tar.gz'
    Push-Location $ws
    try { & tar -czf $tgz 'hermes-agent' } finally { Pop-Location }
    Assert-Eq $LASTEXITCODE 0 'fixture tarball built'

    $dest = Join-Path $ws 'out'
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    $ok = Expand-TarGzManaged -Tarball $tgz -Destination $dest -StripComponents 1

    Assert-True $ok 'extractor reports success'
    Assert-True (Test-Path (Join-Path $dest 'pyproject.toml')) 'pyproject.toml extracted (the caller gates on this)'
    Assert-Eq (Get-Content -Raw -LiteralPath (Join-Path $dest 'README.md')) 'hello' 'file content preserved'
    Assert-Eq (Get-Content -Raw -LiteralPath (Join-Path $dest $cjkName)) 'zh' 'UTF-8 filename preserved'
    $deepOut = Join-Path $dest ('a/' + ('nested-directory-with-a-long-name/' * 4) + 'deep.txt')
    Assert-True (Test-Path -LiteralPath $deepOut) 'long (>100 char) path extracted'
    Assert-Eq (Get-Content -Raw -LiteralPath $deepOut) 'deep-content' 'long-path file content preserved'
    # StripComponents=1 must have removed the --prefix dir, not kept it.
    Assert-True (-not (Test-Path (Join-Path $dest 'hermes-agent'))) 'strip-components=1 removed the archive prefix'

    # Byte-for-byte against tar's own output, so the reader cannot pass by
    # agreeing with itself.
    $ref = Join-Path $ws 'ref'
    New-Item -ItemType Directory -Force -Path $ref | Out-Null
    & tar -xzf $tgz -C $ref --strip-components=1
    $mine = Get-ChildItem -Recurse -File -LiteralPath $dest | ForEach-Object { $_.FullName.Substring($dest.Length).Replace('\','/') } | Sort-Object
    $theirs = Get-ChildItem -Recurse -File -LiteralPath $ref | ForEach-Object { $_.FullName.Substring($ref.Length).Replace('\','/') } | Sort-Object
    Assert-Eq (($mine -join '|')) (($theirs -join '|')) 'file set identical to tar -xzf'
} finally { Remove-Item -Recurse -Force $ws -ErrorAction SilentlyContinue }

# -- 2. unsupported entry type must BAIL, not half-extract -----------------
Write-Host "test: bails on an entry type it cannot reproduce"
$ws = New-Workspace
try {
    $src = Join-Path $ws 'hermes-agent'
    New-Item -ItemType Directory -Force -Path $src | Out-Null
    Set-Content -LiteralPath (Join-Path $src 'real.txt') -Value "x" -NoNewline
    # Build a tar containing a symlink entry. mklink needs privilege on Windows,
    # so synthesise the header directly instead: type '2' = symlink.
    $tar = Join-Path $ws 'withlink.tar'
    $fs = [System.IO.File]::Create($tar)
    try {
        function Write-TarHeader($stream, $name, $type, $size) {
            $h = New-Object byte[] 512
            $enc = [System.Text.Encoding]::UTF8
            $nb = $enc.GetBytes($name);            [Array]::Copy($nb, 0, $h, 0, $nb.Length)
            $mb = $enc.GetBytes("0000644`0");      [Array]::Copy($mb, 0, $h, 100, $mb.Length)
            $sb = $enc.GetBytes(([Convert]::ToString($size, 8)).PadLeft(11, '0') + "`0")
            [Array]::Copy($sb, 0, $h, 124, $sb.Length)
            $tb = $enc.GetBytes(([Convert]::ToString(0, 8)).PadLeft(11, '0') + "`0")
            [Array]::Copy($tb, 0, $h, 136, $tb.Length)
            $h[156] = [byte][char]$type
            $ub = $enc.GetBytes("ustar`0" + "00");  [Array]::Copy($ub, 0, $h, 257, $ub.Length)
            for ($i = 148; $i -lt 156; $i++) { $h[$i] = [byte][char]' ' }   # checksum field = spaces while summing
            $sum = 0; foreach ($b in $h) { $sum += $b }
            $cb = $enc.GetBytes(([Convert]::ToString($sum, 8)).PadLeft(6, '0') + "`0 ")
            [Array]::Copy($cb, 0, $h, 148, $cb.Length)
            $stream.Write($h, 0, 512)
        }
        Write-TarHeader $fs 'hermes-agent/real.txt' '0' 1
        $data = New-Object byte[] 512; $data[0] = [byte][char]'x'
        $fs.Write($data, 0, 512)
        Write-TarHeader $fs 'hermes-agent/link.txt' '2' 0          # <- symlink
        $zero = New-Object byte[] 1024; $fs.Write($zero, 0, 1024)  # end of archive
    } finally { $fs.Dispose() }

    $tgz = Join-Path $ws 'withlink.tar.gz'
    $in = [System.IO.File]::OpenRead($tar); $out = [System.IO.File]::Create($tgz)
    $gz = New-Object System.IO.Compression.GZipStream($out, [System.IO.Compression.CompressionMode]::Compress)
    try { $in.CopyTo($gz) } finally { $gz.Dispose(); $out.Dispose(); $in.Dispose() }

    $dest = Join-Path $ws 'out'
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    $ok = Expand-TarGzManaged -Tarball $tgz -Destination $dest -StripComponents 1
    Assert-True (-not $ok) 'returns $false on an unsupported entry (caller then clones)'
} finally { Remove-Item -Recurse -Force $ws -ErrorAction SilentlyContinue }

# -- 3. tar-slip: a path escaping the destination must be refused ----------
Write-Host "test: refuses an entry that escapes the destination"
$ws = New-Workspace
try {
    $tar = Join-Path $ws 'evil.tar'
    $fs = [System.IO.File]::Create($tar)
    try {
        Write-TarHeader $fs 'hermes-agent/../../escaped.txt' '0' 1
        $data = New-Object byte[] 512; $data[0] = [byte][char]'x'
        $fs.Write($data, 0, 512)
        $zero = New-Object byte[] 1024; $fs.Write($zero, 0, 1024)
    } finally { $fs.Dispose() }
    $tgz = Join-Path $ws 'evil.tar.gz'
    $in = [System.IO.File]::OpenRead($tar); $out = [System.IO.File]::Create($tgz)
    $gz = New-Object System.IO.Compression.GZipStream($out, [System.IO.Compression.CompressionMode]::Compress)
    try { $in.CopyTo($gz) } finally { $gz.Dispose(); $out.Dispose(); $in.Dispose() }

    $dest = Join-Path $ws 'out'
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    $ok = Expand-TarGzManaged -Tarball $tgz -Destination $dest -StripComponents 1
    Assert-True (-not $ok) 'returns $false on a ../ escape'
    Assert-True (-not (Test-Path (Join-Path $ws 'escaped.txt'))) 'nothing written outside the destination'
} finally { Remove-Item -Recurse -Force $ws -ErrorAction SilentlyContinue }

# -- 4. THE point of hc-642: tar cannot be launched, COS path still works --
# The extractor being correct proves nothing on its own -- what broke the real
# install was the WIRING: `& $sysTar` throwing (EAP=Stop) took down the whole
# COS branch and sent it into the hours-long git/ZIP fallback. Reproduce that
# exact failure: a tar.exe that exists but is not a runnable image.
Write-Host "test: tar.exe present but unlaunchable -> COS path still succeeds"
$ws = New-Workspace
try {
    $src = Join-Path $ws 'hermes-agent'
    New-Item -ItemType Directory -Force -Path $src | Out-Null
    Set-Content -LiteralPath (Join-Path $src 'pyproject.toml') -Value "[project]" -NoNewline
    Set-Content -LiteralPath (Join-Path $src 'hermes_cli.py') -Value "print(1)" -NoNewline
    $tgz = Join-Path $ws 'runtime.tar.gz'
    Push-Location $ws
    try { & tar -czf $tgz 'hermes-agent' } finally { Pop-Location }

    # Fake System32 holding a tar.exe that is NOT a valid executable -> launching
    # it throws, which is what an AV denial looks like to this script.
    $fakeRoot = Join-Path $ws 'fakeroot'
    New-Item -ItemType Directory -Force -Path (Join-Path $fakeRoot 'System32') | Out-Null
    Set-Content -LiteralPath (Join-Path $fakeRoot 'System32\tar.exe') -Value 'not an executable' -NoNewline

    # Shadow the download so the test never touches the network; the lib calls
    # Invoke-WebRequest unqualified, so a function here wins over the cmdlet.
    function Invoke-WebRequest {
        param($Uri, $OutFile, [switch]$UseBasicParsing)
        Copy-Item -LiteralPath $script:FixtureTarball -Destination $OutFile -Force
    }
    $script:FixtureTarball = $tgz

    $savedRoot = $env:SystemRoot
    $savedCos = $env:HERMES_RUNTIME_COS_BASE
    $dest = Join-Path $ws 'install'
    # Install-RuntimeFromCos has no param() -- it reads these from the scope
    # install.ps1 dot-sources it into, so the test has to supply them the same way.
    $Commit = 'deadbeef'
    $Branch = ''
    $InstallDir = $dest
    try {
        $env:SystemRoot = $fakeRoot
        $env:HERMES_RUNTIME_COS_BASE = 'https://example.invalid/runtime'
        $ok = Install-RuntimeFromCos
    } finally {
        $env:SystemRoot = $savedRoot
        $env:HERMES_RUNTIME_COS_BASE = $savedCos
    }

    Assert-True $ok 'Install-RuntimeFromCos succeeds even though tar could not run'
    Assert-True (Test-Path (Join-Path $dest 'pyproject.toml')) 'runtime source materialised (no git clone needed)'
    Assert-True (Test-Path (Join-Path $dest 'hermes_cli.py')) 'full tree extracted, not just the gated file'
} finally { Remove-Item -Recurse -Force $ws -ErrorAction SilentlyContinue }

Write-Host ""
if ($script:Failures -gt 0) { Write-Host "$($script:Failures) assertion(s) FAILED" -ForegroundColor Red; exit 1 }
Write-Host "all assertions passed" -ForegroundColor Green
exit 0
