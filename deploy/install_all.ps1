#requires -RunAsAdministrator
<#
.SYNOPSIS
    mlearnweb 一站式部署 — venv + pip + npm build + NSSM 服务化, 30 分钟内可用.

.DESCRIPTION
    幂等脚本, 重跑不会重建已存在 venv / dist. Phase 4 W4.4.

    步骤:
      1. 前置依赖检查 (python 3.11+, node 18+, git, nssm)
      2. $DataRoot 子目录: config / logs / db
      3. backend venv (创建一次, requirements.txt 安装)
      4. frontend npm build (dist 比 src 新就跳过)
      5. .env 复制模板 (已存在跳过, 不覆盖用户配置)
      6. 调 install_services.ps1 装两个 NSSM 服务 (research + live)
      7. 启动 + 健康检查

    跨机部署 (Phase 3 解耦后): mlearnweb 进程不读任何 vnpy 推理机本地文件,
    所有数据走 vnpy webtrader HTTP. 部署时仅需保证 vnpy_nodes.yaml 里
    base_url 可达.

    防火墙 / Defender 排除留给运维手动加 (V1 不做自动化, 防误操作).

.PARAMETER DataRoot
    运行时数据 + 配置 + 日志根目录. 强制参数. 推荐独立盘符防 C: 满.
    e.g. ``D:\mlearnweb_data``. 创建子目录 config/logs/db.

.PARAMETER MLearnwebRoot
    仓库根, 默认 ``$PSScriptRoot\..``. 99% 不需要传.

.PARAMETER PythonExe
    Python 3.11+ 解释器, 默认走 PATH. 装 venv 用; venv 装好后服务用 venv python.

.PARAMETER PipIndexUrl
    可选 pip 镜像 URL (国内推荐 ``https://pypi.tuna.tsinghua.edu.cn/simple``).

.PARAMETER SkipFrontend
    跳过 npm install / build. dev 调试时可省 ~3 分钟; 生产部署不要传.

.EXAMPLE
    # 标准部署
    PS C:\> .\deploy\install_all.ps1 -DataRoot D:\mlearnweb_data

.EXAMPLE
    # 国内镜像 + 显式 python
    PS C:\> .\deploy\install_all.ps1 `
        -DataRoot D:\mlearnweb_data `
        -PythonExe C:\Python311\python.exe `
        -PipIndexUrl https://pypi.tuna.tsinghua.edu.cn/simple

.NOTES
    管理员权限必须. 卸载用 ``deploy\uninstall_services.ps1`` (只删服务保留数据).
    清理数据手动 ``Remove-Item -Recurse $DataRoot``.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$DataRoot,
    [string]$MLearnwebRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string]$PythonExe     = $null,
    [string]$PipIndexUrl   = $null,
    [switch]$SkipFrontend
)

$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Msg)
    Write-Host ""
    Write-Host ("─── " + $Msg + " ") -ForegroundColor Cyan -NoNewline
    Write-Host ("─" * [Math]::Max(0, 60 - $Msg.Length))
}

function Test-Tool {
    param([string]$Name, [string]$Hint)
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $cmd) {
        Write-Error "[X] 缺 $Name. $Hint"
        exit 1
    }
    Write-Host "[OK] $Name = $($cmd.Source)"
    return $cmd.Source
}

# ─── Step 1: 前置依赖 ────────────────────────────────────────────────────
Write-Step "Step 1/7 — 前置依赖"

if (-not $PythonExe) {
    $PythonExe = Test-Tool "python" "装 Python 3.11+ (python.org / winget install Python.Python.3.11)"
} else {
    if (-not (Test-Path $PythonExe)) {
        Write-Error "[X] PythonExe 不存在: $PythonExe"
        exit 1
    }
    Write-Host "[OK] python = $PythonExe (用户指定)"
}

# Python version 校验 — 3.11+ 是 qlib + pandas + pydantic v2 的下限.
$pyVer = & $PythonExe -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
if ([version]$pyVer -lt [version]"3.11") {
    Write-Error "[X] Python $pyVer 太老, 需要 3.11+"
    exit 1
}
Write-Host "[OK] Python 版本 $pyVer"

if (-not $SkipFrontend) {
    Test-Tool "node" "装 Node.js 18+ (nodejs.org / winget install OpenJS.NodeJS.LTS)" | Out-Null
    Test-Tool "npm"  "随 node 一起装" | Out-Null
}
Test-Tool "nssm" "装 NSSM (https://nssm.cc/ / choco install nssm / winget install NSSM.NSSM)" | Out-Null

# ─── Step 2: $DataRoot 子目录 ────────────────────────────────────────────
Write-Step "Step 2/7 — DataRoot 子目录"

$configDir = Join-Path $DataRoot "config"
$logsDir   = Join-Path $DataRoot "logs"
$dbDir     = Join-Path $DataRoot "db"

foreach ($d in @($DataRoot, $configDir, $logsDir, $dbDir)) {
    if (-not (Test-Path $d)) {
        New-Item -ItemType Directory -Path $d -Force | Out-Null
        Write-Host "[OK] 创建 $d"
    } else {
        Write-Host "[SKIP] 已存在 $d"
    }
}

# ─── Step 3: backend venv + pip ──────────────────────────────────────────
Write-Step "Step 3/7 — backend venv + pip install"

$backendDir = Join-Path $MLearnwebRoot "backend"
$venvDir    = Join-Path $DataRoot "venv"
$venvPython = Join-Path $venvDir "Scripts\python.exe"

if (-not (Test-Path $venvPython)) {
    Write-Host "创建 venv → $venvDir"
    & $PythonExe -m venv $venvDir
    if ($LASTEXITCODE -ne 0) { Write-Error "[X] venv 创建失败"; exit 1 }
} else {
    Write-Host "[SKIP] venv 已存在"
}

$reqFile = Join-Path $backendDir "requirements.txt"
if (-not (Test-Path $reqFile)) {
    Write-Error "[X] 缺 $reqFile"
    exit 1
}

$pipArgs = @("install", "-r", $reqFile, "--upgrade")
if ($PipIndexUrl) {
    $pipArgs += @("-i", $PipIndexUrl)
}
Write-Host "pip install (~2-5 分钟)..."
& $venvPython -m pip $pipArgs
if ($LASTEXITCODE -ne 0) { Write-Error "[X] pip install 失败"; exit 1 }
Write-Host "[OK] backend 依赖装好"

# ─── Step 4: frontend npm build ──────────────────────────────────────────
if ($SkipFrontend) {
    Write-Step "Step 4/7 — frontend (跳过)"
    Write-Host "[SKIP] -SkipFrontend 已传, 不构建前端 dist."
    Write-Host "       浏览器访问需要单独起 vite dev (npm run dev) 或之后再 build."
} else {
    Write-Step "Step 4/7 — frontend npm build"

    $frontendDir = Join-Path $MLearnwebRoot "frontend"
    if (-not (Test-Path (Join-Path $frontendDir "package.json"))) {
        Write-Error "[X] 缺 $frontendDir\package.json"
        exit 1
    }

    Push-Location $frontendDir
    try {
        # 检查 dist 是否新于 src — 跳过重复构建
        $distDir = Join-Path $frontendDir "dist"
        $needBuild = $true
        if (Test-Path $distDir) {
            $distMtime = (Get-Item $distDir).LastWriteTime
            $srcMtime = (Get-ChildItem (Join-Path $frontendDir "src") -Recurse -File |
                Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime
            if ($distMtime -gt $srcMtime) {
                Write-Host "[SKIP] dist 比 src 新 (dist=$distMtime, src=$srcMtime)"
                $needBuild = $false
            }
        }
        if ($needBuild) {
            Write-Host "npm install (~1-3 分钟)..."
            & npm install
            if ($LASTEXITCODE -ne 0) { Write-Error "[X] npm install 失败"; exit 1 }
            Write-Host "npm run build (~30s-1 分钟)..."
            & npm run build
            if ($LASTEXITCODE -ne 0) { Write-Error "[X] npm run build 失败"; exit 1 }
            Write-Host "[OK] frontend dist 构建完成"
        }
    } finally {
        Pop-Location
    }
}

# ─── Step 5: .env 配置 ───────────────────────────────────────────────────
Write-Step "Step 5/7 — .env 配置 (不覆盖已存在)"

$envExample = Join-Path $backendDir ".env.example"
$envTarget  = Join-Path $backendDir ".env"
if (Test-Path $envTarget) {
    Write-Host "[SKIP] .env 已存在, 不覆盖. 手动检查下列字段:"
    Write-Host "       FRONTEND_DIST_DIR (W4.1 单端口模式)"
    Write-Host "       VNPY_NODES_CONFIG_PATH (yaml 路径)"
    Write-Host "       LIVE_TRADING_OPS_PASSWORD (实盘写鉴权)"
} elseif (Test-Path $envExample) {
    Copy-Item $envExample $envTarget
    Write-Host "[OK] 复制 .env.example → .env"
    Write-Host ""
    Write-Host "  [!] 必须编辑 $envTarget 配置以下字段:" -ForegroundColor Yellow
    Write-Host "      FRONTEND_DIST_DIR=$($MLearnwebRoot -replace '\\', '\\')\\frontend\\dist"
    Write-Host "      VNPY_NODES_CONFIG_PATH=$($backendDir -replace '\\', '\\')\\vnpy_nodes.yaml"
    Write-Host ""
} else {
    Write-Warning "[!] 缺 .env.example, 跳过"
}

# vnpy_nodes.yaml 提示 (不自动创建 — 让用户主动配置避免空配跑空轮询)
$nodesYaml = Join-Path $backendDir "vnpy_nodes.yaml"
if (-not (Test-Path $nodesYaml)) {
    Write-Host ""
    Write-Host "  [!] 缺 $nodesYaml" -ForegroundColor Yellow
    Write-Host "      复制 vnpy_nodes.yaml.example 后编辑 base_url / username / password"
}

# ─── Step 6: NSSM 服务化 ─────────────────────────────────────────────────
Write-Step "Step 6/7 — NSSM 服务化 (调 install_services.ps1)"

$installSvcScript = Join-Path $PSScriptRoot "install_services.ps1"
& $installSvcScript -MLearnwebRoot $MLearnwebRoot -PythonExe $venvPython -LogRoot $logsDir

# ─── Step 7: 健康检查 ────────────────────────────────────────────────────
Write-Step "Step 7/7 — 启动 + 健康检查"

Start-Sleep -Seconds 5  # 给两个 uvicorn 进程时间初始化 DB + 监听端口

$ports = @(
    @{ Name = "research (8000)"; Port = 8000 },
    @{ Name = "live (8100)";     Port = 8100 }
)
$allOk = $true
foreach ($p in $ports) {
    $tcp = Test-NetConnection -ComputerName 127.0.0.1 -Port $p.Port -InformationLevel Quiet -WarningAction SilentlyContinue
    if ($tcp) {
        Write-Host "[OK] $($p.Name) 监听" -ForegroundColor Green
    } else {
        Write-Host "[!] $($p.Name) 未监听 — 检查 $logsDir\mlearnweb_*.err" -ForegroundColor Yellow
        $allOk = $false
    }
}

if ($allOk) {
    try {
        $health = Invoke-RestMethod "http://127.0.0.1:8000/health" -TimeoutSec 5
        Write-Host "[OK] /health = $($health | ConvertTo-Json -Compress)" -ForegroundColor Green
    } catch {
        Write-Host "[!] /health 调用失败: $_" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host ("=" * 60)
Write-Host "部署完成 — 浏览器访问:" -ForegroundColor Cyan
Write-Host ("=" * 60)
if ($SkipFrontend) {
    Write-Host "  开发模式 (前端未构建): cd frontend; npm run dev → http://127.0.0.1:5173/"
} else {
    Write-Host "  生产单端口: http://<本机IP>:8000/"
}
Write-Host ""
Write-Host "服务管理:"
Write-Host "  nssm status mlearnweb_research"
Write-Host "  nssm status mlearnweb_live"
Write-Host "  Get-Content $logsDir\mlearnweb_live.log -Wait -Tail 50"
Write-Host ""
Write-Host "卸载 (保留数据):"
Write-Host "  .\deploy\uninstall_services.ps1"
