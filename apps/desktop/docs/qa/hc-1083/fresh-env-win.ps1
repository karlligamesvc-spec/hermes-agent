# hc-1083: run an isolated copy of a packaged APEX on a Windows test machine (fresh, empty
# environment) for the multi-bot acceptance. ASCII only: Windows PowerShell 5.1 reads a BOM-less
# .ps1 in the system code page. The checklist (README.md, same folder) explains each step.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File fresh-env-win.ps1 prepare -Root C:\apex-qa\hc-1083\run1 -Installer C:\apex-qa\APEX-x.y.z-win-x64.exe
#   ... scripts -Root <dir> [-SingleThread] [-MultiBot | -MultiBotOff] [-FastPool] [-QuitConfirm]   # writes launch-apex.cmd and watch.cmd
#   ... python  -Root <dir>                           # path of the engine's own python.exe
#   ... stop    -Root <dir>                           # stops every process under the test dir
#   ... cleanup -Root <dir> [-Delete]                 # uninstalls the copy; -Delete removes the dir
#
# Rules:
# - Start the app in the desktop session: double-click launch-apex.cmd on the machine (or over
#   ToDesk). Never through Task Scheduler: its default priority 7 means low I/O and memory
#   priority, which made first start 2x+ slower in hc-923. An SSH session has no desktop; use it
#   for prepare / python / stop / cleanup and the read-only snapshot / check.
# - A new empty -Root for every acceptance run; never prove anything on a reused home (hard rule 11).
# - -MultiBot also sets APEXNODES_SINGLE_THREAD=1: multi_bot only counts while single-thread is on.
#   -MultiBotOff sets APEXNODES_SINGLE_THREAD=1 and APEXNODES_MULTI_BOT=0: since client config v5 the
#   platform turns multi_bot on, so group A forces it off. -SingleThread alone leaves it to the platform.
# - Only install the latest release: an older copy downloads the new one and installs it when idle, and
#   the restart drops the variables set here, so the app runs on the machine's real home (hit on a Mac
#   with 0.17.65 on 2026-10-28).
# - -FastPool only for quick exploration; formal numbers use the default pool settings.
# - The quit confirmation ("work is still running, quit anyway?") is skipped unless -QuitConfirm;
#   on Windows closing the last window quits the app, so F6 in the checklist needs -QuitConfirm.
param(
  [Parameter(Mandatory = $true, Position = 0)][ValidateSet('prepare', 'scripts', 'python', 'stop', 'cleanup')][string]$Action,
  [Parameter(Mandatory = $true)][string]$Root,
  [string]$Installer,
  [switch]$SingleThread,
  [switch]$MultiBot,
  [switch]$MultiBotOff,
  [switch]$FastPool,
  [switch]$QuitConfirm,
  [switch]$Delete
)
$ErrorActionPreference = 'Stop'
$Marker = Join-Path $Root '.hc-1083-test-dir'
$App = Join-Path $Root 'app'
$HermesHome = Join-Path $Root 'home\hermes'

function Assert-TestDir {
  if (-not (Test-Path $Marker)) { throw "Not a test dir created by 'prepare': $Root" }
}

function Get-TestProcesses {
  $needle = [regex]::Escape((Resolve-Path $Root).Path)
  Get-CimInstance Win32_Process | Where-Object {
    ($_.ExecutablePath -and $_.ExecutablePath -match $needle) -or ($_.CommandLine -and $_.CommandLine -match $needle)
  }
}

switch ($Action) {
  'prepare' {
    if ((Test-Path $HermesHome) -and (Get-ChildItem $HermesHome -Force | Select-Object -First 1)) {
      throw "$HermesHome is not empty; use a new empty -Root for a fresh environment"
    }
    if (-not $Installer) { throw 'prepare needs -Installer (APEX-x.y.z-win-x64.exe)' }
    New-Item -ItemType Directory -Force -Path $HermesHome, (Join-Path $Root 'home\userdata'), (Join-Path $Root 'home\cwd'), (Join-Path $Root 'runs') | Out-Null
    Set-Content -Path $Marker -Encoding ASCII -Value "hc-1083 test dir created $((Get-Date).ToUniversalTime().ToString('s'))Z from $Installer"
    # NSIS: /S silent; /D= must come last and unquoted. A per-user install into the test dir adds
    # one HKCU uninstall entry and a Start-menu shortcut; 'cleanup' runs the uninstaller.
    $proc = Start-Process -FilePath $Installer -ArgumentList '/S', '/currentuser', "/D=$App" -PassThru -Wait
    if ($proc.ExitCode -ne 0) { throw "Installer exit code $($proc.ExitCode)" }
    $exe = Join-Path $App 'APEX.exe'
    if (-not (Test-Path $exe)) { throw "Installer did not produce $exe" }
    $version = (Get-Item $exe).VersionInfo.ProductVersion
    "App version: $version"
    # Only the latest release: an older copy updates itself when idle and the restart loses the test env.
    $feed = ((Get-Content (Join-Path $App 'resources\app-update.yml')) -match '^url:' | Select-Object -First 1) -replace '^url:\s*', ''
    $latest = $null
    try { $latest = (((Invoke-WebRequest -UseBasicParsing -TimeoutSec 15 "$feed/win-x64/latest.yml").Content -split "`n") -match '^version:' | Select-Object -First 1) -replace '^version:\s*', '' } catch { }
    if (-not $latest -or $latest.Trim() -ne $version.Trim()) {
      $uninstaller = Get-ChildItem $App -Filter 'Uninstall*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($uninstaller) { Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S', '/currentuser' -Wait }
      throw "Refused: installer is $version, latest on the feed is '$latest'. An older copy updates itself and loses isolation."
    }
    "Latest on the feed is also $latest"
    $other = Get-Process APEX -ErrorAction SilentlyContinue | Where-Object { $_.Path -and -not $_.Path.StartsWith($App) }
    if ($other) { 'Note: another APEX is running on this machine; quit it before the run so nobody clicks the wrong window.' }
    "Ready: $Root"
  }
  'scripts' {
    Assert-TestDir
    $lines = @(
      '@echo off',
      'rem hc-1083 isolated launch: double-click this file (never start it from Task Scheduler)',
      'set "HERMES_HOME=%~dp0home\hermes"',
      'set "HERMES_DESKTOP_USER_DATA_DIR=%~dp0home\userdata"',
      'set "HERMES_DESKTOP_CWD=%~dp0home\cwd"',
      'set HERMES_DESKTOP_IGNORE_EXISTING=1'
    )
    if (-not $QuitConfirm) { $lines += 'set HERMES_DESKTOP_SKIP_QUIT_CONFIRM=1' }
    if ($MultiBot -and $MultiBotOff) { throw 'Pick one of -MultiBot and -MultiBotOff' }
    if ($SingleThread -or $MultiBot -or $MultiBotOff) { $lines += 'set APEXNODES_SINGLE_THREAD=1' }
    if ($MultiBot) { $lines += 'set APEXNODES_MULTI_BOT=1' }
    if ($MultiBotOff) { $lines += 'set APEXNODES_MULTI_BOT=0' }
    if ($FastPool) { $lines += 'set HERMES_DESKTOP_POOL_IDLE_MS=60000', 'set HERMES_DESKTOP_POOL_KEEPALIVE_FRESH_MS=120000' }
    $lines += 'echo %date% %time% launch single_thread=%APEXNODES_SINGLE_THREAD% multi_bot=%APEXNODES_MULTI_BOT% >> "%~dp0launches.log"', 'start "" "%~dp0app\APEX.exe"'
    Set-Content -Path (Join-Path $Root 'launch-apex.cmd') -Encoding ASCII -Value $lines
    $watch = @(
      '@echo off',
      'rem hc-1083 watcher, run in the desktop session: watch.cmd <scenario>, e.g. watch.cmd E1',
      'set "NAME=%~1"',
      'if "%NAME%"=="" set "NAME=run"',
      'for /d %%V in ("%~dp0home\hermes\versions\*") do set "PY=%%V\venv\Scripts\python.exe"',
      '"%PY%" -I "%~dp0multi_bot_qa.py" watch --home "%~dp0home\hermes" --out "%~dp0runs\watch-%NAME%.jsonl" --uss',
      'pause'
    )
    Set-Content -Path (Join-Path $Root 'watch.cmd') -Encoding ASCII -Value $watch
    "Wrote launch-apex.cmd and watch.cmd (single-thread: $([bool]($SingleThread -or $MultiBot -or $MultiBotOff)); multi-bot: $(if ($MultiBot) { 'on' } elseif ($MultiBotOff) { 'off' } else { 'platform' }); fast pool: $([bool]$FastPool); quit confirm: $([bool]$QuitConfirm)). Copy multi_bot_qa.py into $Root."
  }
  'python' {
    $py = Get-ChildItem (Join-Path $HermesHome 'versions\*\venv\Scripts\python.exe') -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $py) { throw 'No engine yet: double-click launch-apex.cmd and wait for the bundled engine to activate' }
    $py.FullName
  }
  'stop' {
    Assert-TestDir
    $procs = @(Get-TestProcesses)
    $main = @($procs | Where-Object { $_.Name -eq 'APEX.exe' -and -not ($procs.ProcessId -contains $_.ParentProcessId) })
    foreach ($p in $main) { Stop-Process -Id $p.ProcessId -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 10
    $left = @(Get-TestProcesses)
    foreach ($p in $left) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    "Stopped $($main.Count) main process(es); $($left.Count) still running after 10 s were force-stopped: $(($left | ForEach-Object { $_.Name }) -join ', ')"
  }
  'cleanup' {
    Assert-TestDir
    if (@(Get-TestProcesses).Count -gt 0) { throw "Processes still running under $Root; run 'stop' first" }
    $uninstaller = Get-ChildItem $App -Filter 'Uninstall*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($uninstaller) { Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S', '/currentuser' -Wait; 'Uninstalled the test copy (HKCU uninstall entry, shortcuts).' }
    if ($Delete) { Remove-Item -Recurse -Force $Root; "Deleted $Root" }
  }
}
