<#
.SYNOPSIS
    Deployment smoke test for mlearnweb.

.DESCRIPTION
    Verifies backend imports, optionally builds the frontend, and checks a
    running research service /health endpoint.
#>

[CmdletBinding()]
param(
    [string]$MLearnwebRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string]$PythonExe = $null,
    [string]$BackendUrl = "http://127.0.0.1:8000",
    [switch]$SkipFrontendBuild,
    [switch]$SkipHealth
)

$ErrorActionPreference = "Stop"

if (-not $PythonExe) {
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if (-not $cmd) {
        throw "python not found. Pass -PythonExe."
    }
    $PythonExe = $cmd.Source
}

$MLearnwebRoot = (Resolve-Path $MLearnwebRoot).Path
$backendDir = Join-Path $MLearnwebRoot "backend"
$frontendDir = Join-Path $MLearnwebRoot "frontend"

Write-Host "== backend import smoke =="
Push-Location $backendDir
try {
    & $PythonExe -c "import app.main; import app.live_main; print('backend imports ok')"
    if ($LASTEXITCODE -ne 0) { throw "backend import smoke failed" }
} finally {
    Pop-Location
}

if (-not $SkipFrontendBuild) {
    Write-Host "== frontend build smoke =="
    Push-Location $frontendDir
    try {
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw "frontend build failed" }
    } finally {
        Pop-Location
    }
}

if (-not $SkipHealth) {
    Write-Host "== /health smoke =="
    $health = Invoke-RestMethod "$($BackendUrl.TrimEnd('/'))/health" -TimeoutSec 10
    $json = $health | ConvertTo-Json -Depth 8 -Compress
    Write-Host $json
    if ($health.status -eq "error") {
        throw "/health returned error"
    }
}

Write-Host "smoke test ok"
