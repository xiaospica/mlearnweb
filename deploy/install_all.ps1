#requires -RunAsAdministrator
<#
.SYNOPSIS
    One-command Windows deployment for mlearnweb.

.DESCRIPTION
    Creates a self-contained runtime under DataRoot, installs Python and
    frontend dependencies, writes production bootstrap config, installs two
    NSSM services, starts them, and validates /health.

    DataRoot layout:
      config/.env            bootstrap env read through MLEARNWEB_ENV_FILE
      config/vnpy_nodes.yaml vnpy node registry
      db/mlearnweb.db        SQLite WAL database
      uploads/               memo/training uploads
      logs/                  NSSM stdout/stderr
      venv/                  backend Python environment

.PARAMETER DataRoot
    Runtime data/config/log root. Example: D:\mlearnweb_data

.PARAMETER MLearnwebRoot
    mlearnweb repository root. Defaults to this script's parent directory.

.PARAMETER PythonExe
    Python 3.11+ used to create the backend venv. Defaults to python on PATH.

.PARAMETER StrategyCorePath
    Local qlib_strategy_core checkout. Auto-detected from
    <MLearnwebRoot>\vendor\qlib_strategy_core or
    <MLearnwebRoot>\..\vendor\qlib_strategy_core.

.PARAMETER PipIndexUrl
    Optional pip mirror URL.

.PARAMETER SkipFrontend
    Skip npm install/build. Services still use FRONTEND_DIST_DIR when it exists.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$DataRoot,
    [string]$MLearnwebRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string]$PythonExe = $null,
    [string]$StrategyCorePath = $null,
    [string]$PipIndexUrl = $null,
    [switch]$SkipFrontend
)

$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host ("=== " + $Message + " ===") -ForegroundColor Cyan
}

function Resolve-AbsolutePath {
    param([string]$PathValue)
    $item = Resolve-Path $PathValue -ErrorAction Stop
    return $item.Path
}

function Test-Tool {
    param([string]$Name, [string]$Hint)
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $cmd) {
        throw "Missing tool '$Name'. $Hint"
    }
    Write-Host "[OK] $Name = $($cmd.Source)"
    return $cmd.Source
}

function Convert-ToSqliteUrlPath {
    param([string]$PathValue)
    return ($PathValue -replace "\\", "/")
}

function Set-EnvKey {
    param(
        [string]$File,
        [string]$Key,
        [string]$Value
    )
    $line = "$Key=$Value"
    if (-not (Test-Path $File)) {
        Set-Content -Path $File -Value $line -Encoding utf8
        return
    }
    $lines = @(Get-Content -Path $File -Encoding utf8)
    $pattern = "^\s*#?\s*$([regex]::Escape($Key))\s*="
    $updated = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match $pattern) {
            $lines[$i] = $line
            $updated = $true
        }
    }
    if (-not $updated) {
        $lines += $line
    }
    Set-Content -Path $File -Value $lines -Encoding utf8
}

function Add-EnvCommentIfMissing {
    param(
        [string]$File,
        [string]$Key,
        [string]$CommentedLine
    )
    $lines = if (Test-Path $File) { @(Get-Content -Path $File -Encoding utf8) } else { @() }
    $pattern = "^\s*#?\s*$([regex]::Escape($Key))\s*="
    $exists = $false
    foreach ($line in $lines) {
        if ($line -match $pattern) {
            $exists = $true
            break
        }
    }
    if (-not $exists) {
        Add-Content -Path $File -Value $CommentedLine -Encoding utf8
    }
}

function Find-StrategyCorePath {
    if ($StrategyCorePath) {
        return $StrategyCorePath
    }
    if ($env:QLIB_STRATEGY_CORE_PATH) {
        return $env:QLIB_STRATEGY_CORE_PATH
    }
    $candidates = @(
        (Join-Path $MLearnwebRoot "vendor\qlib_strategy_core"),
        (Join-Path (Split-Path $MLearnwebRoot -Parent) "vendor\qlib_strategy_core")
    )
    foreach ($candidate in $candidates) {
        if (Test-Path (Join-Path $candidate "pyproject.toml")) {
            return $candidate
        }
    }
    return $null
}

Write-Step "Step 1/7 prerequisites"

if (-not $PythonExe) {
    $PythonExe = Test-Tool "python" "Install Python 3.11+ or pass -PythonExe."
} elseif (-not (Test-Path $PythonExe)) {
    throw "PythonExe does not exist: $PythonExe"
}
$PythonExe = Resolve-AbsolutePath $PythonExe

$pyVer = & $PythonExe -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
if ([version]$pyVer -lt [version]"3.11") {
    throw "Python $pyVer is too old. Python 3.11+ is required."
}
Write-Host "[OK] Python $pyVer"

if (-not $SkipFrontend) {
    Test-Tool "node" "Install Node.js 18+." | Out-Null
    Test-Tool "npm" "Install npm with Node.js." | Out-Null
}
Test-Tool "nssm" "Install NSSM and add it to PATH." | Out-Null

Write-Step "Step 2/7 DataRoot directories"

$MLearnwebRoot = Resolve-AbsolutePath $MLearnwebRoot
$DataRoot = [System.IO.Path]::GetFullPath($DataRoot)
$configDir = Join-Path $DataRoot "config"
$logsDir = Join-Path $DataRoot "logs"
$dbDir = Join-Path $DataRoot "db"
$uploadsDir = Join-Path $DataRoot "uploads"
$tuningRunsDir = Join-Path $DataRoot "tuning\runs"

foreach ($dir in @($DataRoot, $configDir, $logsDir, $dbDir, $uploadsDir, $tuningRunsDir)) {
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        Write-Host "[OK] created $dir"
    } else {
        Write-Host "[SKIP] exists $dir"
    }
}

Write-Step "Step 3/7 backend venv and pip install"

$backendDir = Join-Path $MLearnwebRoot "backend"
$venvDir = Join-Path $DataRoot "venv"
$venvPython = Join-Path $venvDir "Scripts\python.exe"
$reqFile = Join-Path $backendDir "requirements.txt"

if (-not (Test-Path $reqFile)) {
    throw "Missing requirements file: $reqFile"
}
if (-not (Test-Path $venvPython)) {
    & $PythonExe -m venv $venvDir
    if ($LASTEXITCODE -ne 0) { throw "venv creation failed" }
}

$pipArgs = @("install", "-r", $reqFile, "--upgrade")
if ($PipIndexUrl) {
    $pipArgs += @("-i", $PipIndexUrl)
}
& $venvPython -m pip $pipArgs
if ($LASTEXITCODE -ne 0) { throw "pip install requirements failed" }

$resolvedStrategyCore = Find-StrategyCorePath
if (-not $resolvedStrategyCore) {
    throw "qlib_strategy_core checkout not found. Provide -StrategyCorePath or include vendor\qlib_strategy_core."
}
$resolvedStrategyCore = Resolve-AbsolutePath $resolvedStrategyCore
& $venvPython -m pip install -e $resolvedStrategyCore
if ($LASTEXITCODE -ne 0) { throw "pip install qlib_strategy_core failed" }
Write-Host "[OK] qlib_strategy_core installed from $resolvedStrategyCore"

Write-Step "Step 4/7 frontend build"

$frontendDir = Join-Path $MLearnwebRoot "frontend"
$frontendDist = Join-Path $frontendDir "dist"
if ($SkipFrontend) {
    Write-Host "[SKIP] frontend build skipped"
} else {
    if (-not (Test-Path (Join-Path $frontendDir "package.json"))) {
        throw "Missing frontend package.json: $frontendDir"
    }
    Push-Location $frontendDir
    try {
        & npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
    } finally {
        Pop-Location
    }
}

Write-Step "Step 5/7 DataRoot config"

$envTarget = Join-Path $configDir ".env"
$dbPath = Join-Path $dbDir "mlearnweb.db"
$nodesYaml = Join-Path $configDir "vnpy_nodes.yaml"
$joinquantDir = Join-Path $DataRoot "joinquant_exports"
if (-not (Test-Path $joinquantDir)) {
    New-Item -ItemType Directory -Path $joinquantDir -Force | Out-Null
}

if (-not (Test-Path $envTarget)) {
    @(
        "# mlearnweb production bootstrap config",
        "# Generated by deploy/install_all.ps1. Reruns update DataRoot-owned keys."
    ) | Set-Content -Path $envTarget -Encoding utf8
}

Set-EnvKey $envTarget "DATA_ROOT" $DataRoot
Set-EnvKey $envTarget "DATABASE_URL" ("sqlite:///" + (Convert-ToSqliteUrlPath $dbPath))
Set-EnvKey $envTarget "UPLOAD_DIR" $uploadsDir
Set-EnvKey $envTarget "FRONTEND_DIST_DIR" $frontendDist
Set-EnvKey $envTarget "VNPY_NODES_CONFIG_PATH" $nodesYaml
Set-EnvKey $envTarget "LIVE_MAIN_INTERNAL_URL" "http://127.0.0.1:8100"
Set-EnvKey $envTarget "TUNING_RUNS_ROOT" $tuningRunsDir
Set-EnvKey $envTarget "JOINQUANT_EXPORT_DIR" $joinquantDir
Set-EnvKey $envTarget "VNPY_SIM_DB_ROOT" ""
Add-EnvCommentIfMissing $envTarget "MLRUNS_DIR" "# MLRUNS_DIR=D:\path\to\readonly\mlruns"
Add-EnvCommentIfMissing $envTarget "STRATEGY_DEV_ROOT" "# STRATEGY_DEV_ROOT=D:\path\to\qlib_strategy_dev"
Add-EnvCommentIfMissing $envTarget "TUNING_PYTHON_EXE" "# TUNING_PYTHON_EXE=D:\path\to\python.exe"

if (-not (Test-Path $nodesYaml)) {
    $nodesExample = Join-Path $backendDir "vnpy_nodes.yaml.example"
    if (Test-Path $nodesExample) {
        Copy-Item $nodesExample $nodesYaml
        Write-Host "[OK] copied vnpy_nodes.yaml.example to $nodesYaml"
    } else {
        @(
            "nodes:",
            "  - node_id: local",
            "    base_url: http://127.0.0.1:8001",
            "    username: vnpy",
            "    password: vnpy",
            "    enabled: false",
            "    mode: sim"
        ) | Set-Content -Path $nodesYaml -Encoding utf8
        Write-Host "[OK] created disabled vnpy_nodes.yaml template at $nodesYaml"
    }
}

Write-Host "[OK] env file: $envTarget"

Write-Step "Step 6/7 NSSM services"

$installSvcScript = Join-Path $PSScriptRoot "install_services.ps1"
& $installSvcScript `
    -MLearnwebRoot $MLearnwebRoot `
    -PythonExe $venvPython `
    -LogRoot $logsDir `
    -EnvFile $envTarget
if ($LASTEXITCODE -ne 0) { throw "install_services.ps1 failed" }

Write-Step "Step 7/7 health check"

Start-Sleep -Seconds 5

$ports = @(
    @{ Name = "research"; Host = "127.0.0.1"; Port = 8000 },
    @{ Name = "live"; Host = "127.0.0.1"; Port = 8100 }
)
$allOk = $true
foreach ($p in $ports) {
    $ok = Test-NetConnection -ComputerName $p.Host -Port $p.Port -InformationLevel Quiet -WarningAction SilentlyContinue
    if ($ok) {
        Write-Host "[OK] $($p.Name) listening on $($p.Host):$($p.Port)" -ForegroundColor Green
    } else {
        Write-Host "[WARN] $($p.Name) is not listening. Check $logsDir\mlearnweb_$($p.Name).err" -ForegroundColor Yellow
        $allOk = $false
    }
}

if ($allOk) {
    try {
        $health = Invoke-RestMethod "http://127.0.0.1:8000/health" -TimeoutSec 10
        Write-Host "[OK] /health = $($health | ConvertTo-Json -Compress)" -ForegroundColor Green
    } catch {
        Write-Host "[WARN] /health failed: $_" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "Deployment finished."
Write-Host "Open: http://<server-ip>:8000/"
Write-Host "Logs: $logsDir"
Write-Host "Config: $envTarget"
