# hc-1083: run an isolated copy of a packaged APEX on a Windows test machine (fresh, empty
# environment) for the multi-bot acceptance. ASCII only: Windows PowerShell 5.1 reads a BOM-less
# .ps1 in the system code page. The checklist (README.md, same folder) explains each step.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File fresh-env-win.ps1 prepare -Root C:\apex-qa\hc-1083\run1 -Installer C:\apex-qa\APEX-x.y.z-win-x64.exe
#   ... scripts -Root <dir> [-MultiBot] [-FastPool]   # writes launch-apex.cmd and watch.cmd
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
# - -FastPool only for quick exploration; formal numbers use the default pool settings.
param(
  [Parameter(Mandatory = $true, Position = 0)][ValidateSet('prepare', 'scripts', 'python', 'stop', 'cleanup')][string]$Action,
  [Parameter(Mandatory = $true)][string]$Root,
  [string]$Installer,
  [switch]$MultiBot,
  [switch]$FastPool,
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
    "App version: $((Get-Item $exe).VersionInfo.ProductVersion)"
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
      'set HERMES_DESKTOP_IGNORE_EXISTING=1',
      'set HERMES_DESKTOP_SKIP_QUIT_CONFIRM=1'
    )
    if ($MultiBot) { $lines += 'set APEXNODES_MULTI_BOT=1' }
    if ($FastPool) { $lines += 'set HERMES_DESKTOP_POOL_IDLE_MS=60000', 'set HERMES_DESKTOP_POOL_KEEPALIVE_FRESH_MS=120000' }
    $lines += 'echo %date% %time% launch multi_bot=%APEXNODES_MULTI_BOT% >> "%~dp0launches.log"', 'start "" "%~dp0app\APEX.exe"'
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
    "Wrote launch-apex.cmd and watch.cmd (multi-bot switch: $([bool]$MultiBot); fast pool: $([bool]$FastPool)). Copy multi_bot_qa.py into $Root."
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
