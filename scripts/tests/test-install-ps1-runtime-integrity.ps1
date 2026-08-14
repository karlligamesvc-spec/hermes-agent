$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$installScript = Join-Path $repoRoot "scripts\install.ps1"
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($installScript, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw "install.ps1 parse errors: $($errors -join '; ')" }

function Get-InstallerFunctionText([string]$Name) {
    $fn = $ast.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $Name
    }, $true) | Select-Object -First 1
    if (-not $fn) { throw "$Name not found in install.ps1" }
    return $fn.Extent.Text
}

# Evaluate at script scope so the imported functions remain callable below.
Invoke-Expression (Get-InstallerFunctionText "Test-HermesRuntimeImports")
Invoke-Expression (Get-InstallerFunctionText "Invoke-UvSyncLocked")

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("hc727-runtime-integrity-" + [Guid]::NewGuid())
$script:InstallDir = $tempRoot
$venv = Join-Path $tempRoot "venv"
New-Item -ItemType Directory -Path (Join-Path $tempRoot "hermes_cli") -Force | Out-Null
Set-Content -Path (Join-Path $tempRoot "hermes_cli\__init__.py") -Value ""
Set-Content -Path (Join-Path $tempRoot "hermes_cli\config.py") -Value ""
Set-Content -Path (Join-Path $tempRoot "dotenv.py") -Value ""

try {
    & python -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw "python -m venv failed" }
    $python = Join-Path $venv "Scripts\python.exe"

    if (Test-HermesRuntimeImports $python) {
        throw "runtime probe accepted a real venv missing PyYAML"
    }
    Set-Content -Path (Join-Path $tempRoot "yaml.py") -Value ""
    if (-not (Test-HermesRuntimeImports $python)) {
        throw "runtime probe rejected the complete synthetic launch boundary"
    }

    function Invoke-WithoutIndexEnv {
        param([Parameter(Mandatory)][scriptblock] $Body)
        & $Body
    }
    function Invoke-NativeWithRelaxedErrorAction {
        param([Parameter(Mandatory)][scriptblock] $Body)
        & $Body
    }
    $script:capturedUvArgs = @()
    $script:UvCmd = {
        $script:capturedUvArgs = @($args)
        $global:LASTEXITCODE = 0
    }
    Invoke-UvSyncLocked -Reinstall
    if ($script:capturedUvArgs -notcontains "--reinstall") {
        throw "locked repair did not invoke uv sync --reinstall"
    }
    if ($script:capturedUvArgs -notcontains "--locked") {
        throw "locked repair lost the uv.lock integrity gate"
    }
} finally {
    Remove-Item -Recurse -Force $tempRoot -ErrorAction SilentlyContinue
}

Write-Host "install.ps1 runtime integrity behavior: PASS"
