# mlearnweb/deploy/ — 监控端部署脚本

⚠️ **本目录只装监控端服务** — mlearnweb backend 双 uvicorn (research + live).

推理端 (vnpy_strategy_dev) 是**独立项目**, 通常部署在另一台机器, 用
`vnpy_strategy_dev/deploy/` 自己的安装脚本.

---

## 部署架构总览

```
┌────────────────────────────────────┐         ┌────────────────────────────────────┐
│  推理服务器 (vnpy_strategy_dev)    │         │  监控服务器 (本目录, mlearnweb)    │
│                                    │         │                                    │
│  NSSM service: vnpy_headless       │  HTTP   │  NSSM service: mlearnweb_research  │
│  ├ vnpy 主进程 + 双 cron           │ ◄────── │  └ uvicorn :8000 (训练记录/实验)   │
│  ├ webtrader uvicorn :8001 (子)    │  pulls  │                                    │
│  └ 推理子进程 (spawn 短)            │         │  NSSM service: mlearnweb_live      │
│                                    │         │  └ uvicorn :8100 (5 sync_loop)     │
│  vnpy_strategy_dev/deploy/         │         │  └ 通过 vnpy_nodes.yaml 找推理端   │
└────────────────────────────────────┘         │                                    │
                                                │  本目录 mlearnweb/deploy/ 安装    │
                                                └────────────────────────────────────┘
```

**mlearnweb 不依赖** vnpy_strategy_dev 仓库 — 通过 HTTP REST 拉推理端数据.
两个项目可以**完全独立部署 / 升级 / 重启**.

---

## 监控端服务清单 (本目录)

| 服务名 | 进程 | 端口 | 备注 |
|---|---|---|---|
| `mlearnweb_research` | uvicorn `app.main:app` | 8000 | research 侧: 训练记录 / 实验列表 / SHAP / 因子文档 |
| `mlearnweb_live` | uvicorn `app.live_main:app` | 8100 | 实盘侧: 5 个 sync_loop 周期拉推理端 + 控制 endpoint |

**前端** (Vite :5173) 默认**不**装服务. 推荐:
- 生产: `npm run build` → `dist/` 用 nginx / IIS 服务静态文件
- 开发: 另起 `npm run dev`

---

## 文件清单

| 文件 | 作用 |
|---|---|
| `install_services.ps1` | 一键装监控端 NSSM 服务 (research + live) |
| `uninstall_services.ps1` | 一键卸载 |
| `README.md` | 本文档 |

## 前置要求

1. **NSSM** 已装 (https://nssm.cc/ 或 `choco install nssm`)
2. **以 Administrator 运行 PowerShell**
3. **Python 3.11** 已装 + 装好 backend/requirements.txt 依赖
4. `backend/vnpy_nodes.yaml` 已配 (指向推理端的 vnpy_webtrader HTTP 8001)

## 配置 vnpy_nodes.yaml (关键)

mlearnweb 通过这个 yaml 找推理端. 例:

```yaml
nodes:
  - node_id: prod-shanghai
    base_url: http://192.168.1.100:8001    # ← 推理机 IP + vnpy_webtrader 端口
    username: vnpy
    password: vnpy
    enabled: true
    mode: live          # live (实盘真账户) / sim (全模拟); 决定前端 mode badge 颜色

# 多推理机 (多策略组分布部署):
  # - node_id: prod-shenzhen
  #   base_url: http://192.168.1.101:8001
  #   ...
```

**单机开发** (推理 + 监控同机):
```yaml
nodes:
  - node_id: local
    base_url: http://127.0.0.1:8001
    ...
```

## 一键装

```powershell
# 推荐：一站式安装会生成 DataRoot 配置并安装服务
.\deploy\install_all.ps1 -DataRoot D:\mlearnweb_data

# 仅安装/重装 NSSM 服务（已有 DataRoot config\.env 时使用）
.\deploy\install_services.ps1 `
    -MLearnwebRoot "D:\apps\mlearnweb" `
    -PythonExe "D:\mlearnweb_data\venv\Scripts\python.exe" `
    -LogRoot "D:\mlearnweb_data\logs" `
    -EnvFile "D:\mlearnweb_data\config\.env"
```

## NSSM 配置详情

每个服务都设了:
- `AppStdout` / `AppStderr` → `D:\mlearnweb_data\logs\<service>.{log,err}`
- `AppRotateFiles=1 AppRotateBytes=10MB` → 日志滚动
- `AppRestartDelay=10s` → 崩溃自动重启
- `Start=SERVICE_AUTO_START` → 开机自启

## 日常运维

```powershell
# 状态
nssm status mlearnweb_research
nssm status mlearnweb_live

# 重启
nssm restart mlearnweb_live

# 实时日志
Get-Content D:\mlearnweb_logs\mlearnweb_live.log -Wait -Tail 50

# 端口
Test-NetConnection 127.0.0.1 -Port 8000
Test-NetConnection 127.0.0.1 -Port 8100

# 测推理端可达
Test-NetConnection 192.168.1.100 -Port 8001    # 用 vnpy_nodes.yaml 配的 IP
```

## 卸载

```powershell
.\deploy\uninstall_services.ps1
# 服务卸载, 保留 mlearnweb.db / 日志 / 配置 (不删)
```

## 故障排查

### sync_loop 拉不到推理端数据 (前端权益曲线断档)

```powershell
# 1. 看 mlearnweb_live 日志
Get-Content D:\mlearnweb_logs\mlearnweb_live.log -Wait -Tail 100 |
    Select-String "vnpy.client"

# 期望看到:
#   [vnpy.client] node=prod-shanghai authenticated, JWT cached
#
# 错误信号:
#   [vnpy.client] node=... probe failed: Connection refused / timeout
#       → 推理端 vnpy_headless 没起 / 防火墙
#   [vnpy.client] node=... 401 Unauthorized
#       → vnpy_nodes.yaml username/password 与推理端 vt_setting.json 不一致
```

### mlearnweb_research 启动失败

```powershell
Get-Content D:\mlearnweb_logs\mlearnweb_research.err -Tail 50
```

常见:
- `ModuleNotFoundError: fastapi` → `pip install -r backend/requirements.txt`
- `OperationalError: unable to open database` → `mlearnweb.db` 文件权限问题

### Vite 前端跑不起来

`npm install` 后跑 `npm run dev`. NSSM 不管前端服务 (复杂度太高 + 前端通常用
nginx/IIS 服务静态文件).

## 进一步阅读

- [`backend/app/services/vnpy/`](../backend/app/services/vnpy/) — 5 个 sync_loop 实现
- vnpy_strategy_dev 项目 deploy/ — 推理端独立部署脚本
