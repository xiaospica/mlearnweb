#requires -RunAsAdministrator
<#
.SYNOPSIS
    监控端 NSSM 服务化 — mlearnweb 双 uvicorn (research :8000 + live :8100).

.DESCRIPTION
    本脚本只装**监控端服务** — mlearnweb backend 双 uvicorn. 推理端
    (vnpy_strategy_dev) 是独立项目, 通常部署在另一台机器, 用 vnpy_strategy_dev
    自己的 deploy 脚本安装.

    服务清单 (监控端):
      mlearnweb_research   研究侧 uvicorn :8000 (训练记录 / 实验列表 / SHAP)
      mlearnweb_live       实盘侧 uvicorn :8100 (5 个 sync_loop / 控制 endpoint)

    前端 (Vite :5173) 默认**不**装服务. 生产环境推荐:
      * 用 npm run build 产 dist/, 然后 nginx / IIS 服务静态文件
      * 开发环境直接 npm run dev (本目录脚本不管)

    NSSM 安装: https://nssm.cc/  或  choco install nssm

.PARAMETER NssmPath
    nssm.exe 路径. 默认 'nssm' (假定已在 PATH).

.PARAMETER MLearnwebRoot
    mlearnweb 仓库根. 默认 ``$PSScriptRoot\..`` (脚本所在 ``deploy/`` 上一级).
    本脚本随仓库一起 ship, 99% 用例不需要传.

.PARAMETER PythonExe
    Python 3.11 解释器 (qlib + lightgbm + mlflow 依赖). 默认 ``$null`` →
    自动 ``Get-Command python`` 找系统 PATH 上的. install_all.ps1 会显式
    传 venv python (推荐).

.PARAMETER LogRoot
    NSSM 日志输出目录. **强制参数** — 必须传, 不再默认 D:\mlearnweb_logs.
    install_all.ps1 会传 ``$DataRoot\logs``; 直接用 install_services.ps1 时
    用户必须显式选盘符.

.EXAMPLE
    PS C:\> .\deploy\install_services.ps1 -LogRoot D:\mlearnweb_data\logs

.EXAMPLE
    # 显式传 venv python
    PS C:\> .\deploy\install_services.ps1 -PythonExe D:\mlearnweb_data\venv\Scripts\python.exe -LogRoot D:\mlearnweb_data\logs

.NOTES
    管理员权限必须. 卸载用 deploy\uninstall_services.ps1.
    推理端 (vnpy_strategy_dev) 部署见 vnpy_strategy_dev 项目 deploy/.
#>

[CmdletBinding()]
param(
    [string]$NssmPath      = "nssm",
    [string]$MLearnwebRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string]$PythonExe     = $null,
    [Parameter(Mandatory = $true)]
    [string]$LogRoot,
    [string]$EnvFile       = $null
)

# PythonExe 默认: PATH 上的 python. install_all.ps1 应显式传 venv python.
if (-not $PythonExe) {
    $foundPython = Get-Command python -ErrorAction SilentlyContinue
    if (-not $foundPython) {
        Write-Error "[X] PythonExe 未传 + PATH 上找不到 python. 装 Python 3.11 或显式传 -PythonExe."
        exit 1
    }
    $PythonExe = $foundPython.Source
    Write-Host "[OK] 自动选 Python = $PythonExe"
}

# ─── 前置检查 ─────────────────────────────────────────────────────────────

function Test-PathOrFail {
    param([string]$Path, [string]$What)
    if (-not (Test-Path $Path)) {
        Write-Error "[X] $What 不存在: $Path"
        exit 1
    }
}

Write-Host ("=" * 60)
Write-Host "监控端 NSSM 服务化 (mlearnweb 双 uvicorn)"
Write-Host ("=" * 60)

# 1. NSSM
$nssmExe = Get-Command $NssmPath -ErrorAction SilentlyContinue
if (-not $nssmExe) {
    Write-Error "[X] nssm 未找到 (路径: $NssmPath). 装 NSSM (https://nssm.cc/) 或 choco install nssm"
    exit 1
}
Write-Host "[OK] nssm = $($nssmExe.Source)"

# 2. 关键路径
Test-PathOrFail $MLearnwebRoot "MLearnwebRoot"
Test-PathOrFail $PythonExe "PythonExe"
Test-PathOrFail "$MLearnwebRoot\backend\app\main.py" "backend\app\main.py (research 入口)"
Test-PathOrFail "$MLearnwebRoot\backend\app\live_main.py" "backend\app\live_main.py (live 入口)"
if ($EnvFile) {
    Test-PathOrFail $EnvFile "EnvFile"
    $EnvFile = (Resolve-Path $EnvFile).Path
    Write-Host "[OK] env file = $EnvFile"
}

Write-Host "[OK] 路径 + 配置 检查通过"

# 3. 日志目录
if (-not (Test-Path $LogRoot)) {
    New-Item -ItemType Directory -Path $LogRoot -Force | Out-Null
    Write-Host "[OK] 创建日志目录 $LogRoot"
}


# ─── 服务通用安装 helper ──────────────────────────────────────────────────

function Install-NssmService {
    param(
        [string]$Name,
        [string]$Application,
        [string]$Arguments,
        [string]$WorkingDirectory,
        [string]$Description
    )

    Write-Host ""
    Write-Host "─── 安装服务: $Name ───" -ForegroundColor Cyan

    & $nssmExe.Source status $Name 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  [!] $Name 已存在, 先 stop + remove"
        & $nssmExe.Source stop $Name | Out-Null
        Start-Sleep -Seconds 2
        & $nssmExe.Source remove $Name confirm | Out-Null
    }

    & $nssmExe.Source install $Name $Application $Arguments | Out-Null
    & $nssmExe.Source set $Name AppDirectory $WorkingDirectory | Out-Null
    & $nssmExe.Source set $Name AppStdout "$LogRoot\$Name.log" | Out-Null
    & $nssmExe.Source set $Name AppStderr "$LogRoot\$Name.err" | Out-Null
    & $nssmExe.Source set $Name AppRotateFiles 1 | Out-Null
    & $nssmExe.Source set $Name AppRotateOnline 1 | Out-Null
    & $nssmExe.Source set $Name AppRotateBytes 10485760 | Out-Null
    & $nssmExe.Source set $Name AppRestartDelay 10000 | Out-Null
    & $nssmExe.Source set $Name Start SERVICE_AUTO_START | Out-Null
    & $nssmExe.Source set $Name Description $Description | Out-Null
    $envLines = @("PYTHONUNBUFFERED=1", "PYTHONIOENCODING=utf-8")
    if ($EnvFile) {
        $envLines += "MLEARNWEB_ENV_FILE=$EnvFile"
    }
    & $nssmExe.Source set $Name AppEnvironmentExtra ($envLines -join "`r`n") | Out-Null

    Write-Host "[OK] $Name 装好 (logs -> $LogRoot\$Name.log)"
}


# ─── 1. mlearnweb_research (uvicorn :8000) ──────────────────────────────

Install-NssmService `
    -Name "mlearnweb_research" `
    -Application $PythonExe `
    -Arguments "-m uvicorn app.main:app --host 0.0.0.0 --port 8000 --log-level info" `
    -WorkingDirectory "$MLearnwebRoot\backend" `
    -Description "mlearnweb 研究侧 (实验/训练记录/SHAP/因子文档)"


# ─── 2. mlearnweb_live (uvicorn :8100) ──────────────────────────────────

Install-NssmService `
    -Name "mlearnweb_live" `
    -Application $PythonExe `
    -Arguments "-m uvicorn app.live_main:app --host 127.0.0.1 --port 8100 --log-level info" `
    -WorkingDirectory "$MLearnwebRoot\backend" `
    -Description "mlearnweb 实盘监控 (5 个 sync_loop fanout 拉推理端 / 控制 endpoint)"


# ─── 启动 + 状态 ─────────────────────────────────────────────────────────

Write-Host ""
Write-Host ("=" * 60)
Write-Host "启动所有服务..." -ForegroundColor Cyan
Write-Host ("=" * 60)

$services = @("mlearnweb_research", "mlearnweb_live")
foreach ($svc in $services) {
    Write-Host ""
    & $nssmExe.Source start $svc
    Start-Sleep -Seconds 3
    $status = & $nssmExe.Source status $svc
    if ($status -match "RUNNING") {
        Write-Host "[OK] $svc -> RUNNING" -ForegroundColor Green
    } else {
        Write-Host "[!] $svc -> $status (检查 $LogRoot\$svc.err)" -ForegroundColor Yellow
    }
}


# ─── 验收 ────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host ("=" * 60)
Write-Host "验收 cmd:"
Write-Host ("=" * 60)
Write-Host @"

# 1. 服务状态
nssm status mlearnweb_research
nssm status mlearnweb_live

# 2. 端口 (启动 ~5s 后)
Test-NetConnection 127.0.0.1 -Port 8000   # research
Test-NetConnection 127.0.0.1 -Port 8100   # live

# 3. 实时日志
Get-Content $LogRoot\mlearnweb_live.log -Wait -Tail 50

# 4. 拉推理端测试 (确认 vnpy_nodes.yaml 中 base_url 可达)
Get-Content $MLearnwebRoot\backend\vnpy_nodes.yaml

# 5. 前端 (install_all.ps1 writes FRONTEND_DIST_DIR and app.main serves dist)
Get-Content $EnvFile

# 6. 浏览器
# http://<监控机IP>:8000/

# 7. 卸载
.\deploy\uninstall_services.ps1
"@
