#requires -RunAsAdministrator
<#
.SYNOPSIS
    卸载 install_services.ps1 装的 mlearnweb NSSM 服务.

.DESCRIPTION
    stop + remove 2 个监控端服务 (research + live).
    不删 mlearnweb.db / 不删日志 / 不删配置文件.

.PARAMETER NssmPath
    nssm.exe 路径. 默认 'nssm'.

.EXAMPLE
    PS C:\> .\deploy\uninstall_services.ps1
#>

[CmdletBinding()]
param(
    [string]$NssmPath = "nssm"
)

$nssmExe = Get-Command $NssmPath -ErrorAction SilentlyContinue
if (-not $nssmExe) {
    Write-Error "[X] nssm 未找到"
    exit 1
}

# 监控端 2 个服务 (推理端 vnpy_headless 在另一项目, 不在这里管)
$services = @("mlearnweb_research", "mlearnweb_live")

foreach ($svc in $services) {
    & $nssmExe.Source status $svc 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "─── 卸载 $svc ───" -ForegroundColor Cyan
        & $nssmExe.Source stop $svc | Out-Null
        Start-Sleep -Seconds 2
        & $nssmExe.Source remove $svc confirm | Out-Null
        Write-Host "[OK] $svc 已卸载"
    } else {
        Write-Host "[i] $svc 不存在, 跳过"
    }
}

Write-Host ""
Write-Host "[OK] mlearnweb NSSM 服务已卸载"
Write-Host "[i] mlearnweb.db / 日志 / vnpy_nodes.yaml 等保留, 未删除"
