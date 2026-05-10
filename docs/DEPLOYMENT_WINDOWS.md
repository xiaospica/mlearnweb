# Windows Server 部署手册

mlearnweb 的目标是在干净 Windows Server 2022 上 30 分钟内可用。2026-05-10 后的整改把 P0 配置落点、依赖补齐、监听策略和 smoke/health 骨架纳入脚本；正式交付前仍需以干净 Windows Server smoke 部署作为验收门槛。优先级清单见 [`docs/plan/mlearnweb-independent-deploy-roadmap.md`](plan/mlearnweb-independent-deploy-roadmap.md)。

## 前置依赖

| 软件 | 版本 | 安装命令 |
|---|---|---|
| Python | 3.11+ | `winget install Python.Python.3.11` |
| Node.js | 18+ LTS | `winget install OpenJS.NodeJS.LTS` |
| Git | 任意 | `winget install Git.Git` |
| NSSM | 2.24+ | `winget install NSSM.NSSM` 或 https://nssm.cc/ |

校验：

```powershell
python --version  # 期望 3.11.x 或更新
node --version    # 期望 v18.x 或更新
nssm --version    # 期望 NSSM 2.24
```

## 标准部署

```powershell
# 管理员 PowerShell
git clone <仓库地址> C:\mlearnweb
cd C:\mlearnweb\deploy

# 一站式部署：生成 DataRoot config\.env，安装依赖，构建前端，安装双服务
.\install_all.ps1 -DataRoot D:\mlearnweb_data
```

`-DataRoot` 是运行时数据 + 配置 + 日志根目录，建议独立盘符防 C: 满。脚本会创建：

- `D:\mlearnweb_data\config\` — 用户配置 (`config\.env` 由 NSSM 注入 `MLEARNWEB_ENV_FILE`)
- `D:\mlearnweb_data\logs\` — NSSM 日志输出
- `D:\mlearnweb_data\db\` — SQLite WAL 文件
- `D:\mlearnweb_data\uploads\` — memo / training 上传文件
- `D:\mlearnweb_data\venv\` — Python 虚拟环境

## 脚本执行步骤

1. 前置依赖检查 (python / node / npm / nssm)
2. 创建 DataRoot 子目录
3. 创建 venv → `pip install -r requirements.txt`，并安装 `vendor\qlib_strategy_core`
4. `npm install + npm run build` (dist 比 src 新会跳过)
5. 写入 `DataRoot\config\.env`：`DATABASE_URL` / `UPLOAD_DIR` / `FRONTEND_DIST_DIR` / `VNPY_NODES_CONFIG_PATH`
6. 调 `install_services.ps1` 装两个 NSSM 服务，研究侧监听 `0.0.0.0:8000`，实盘侧仅监听 `127.0.0.1:8100`
7. 启动 + 健康检查 (`Test-NetConnection` + `/health`)

## 必须的配置项

部署完成后检查 `D:\mlearnweb_data\config\.env`：

```ini
# 脚本自动写入
DATABASE_URL=sqlite:///D:/mlearnweb_data/db/mlearnweb.db
UPLOAD_DIR=D:\mlearnweb_data\uploads
FRONTEND_DIST_DIR=C:\mlearnweb\frontend\dist
VNPY_NODES_CONFIG_PATH=D:\mlearnweb_data\config\vnpy_nodes.yaml

# 可选 — 研究侧外部只读挂载；未配置时实验/研究页降级为空
MLRUNS_DIR=D:\readonly_mount\mlruns

# 可选 — 训练工作台；未配置时禁用调参入口，不影响 dashboard/live-trading
STRATEGY_DEV_ROOT=D:\apps\qlib_strategy_dev

# 推荐 — 实盘写鉴权口令 (留空则关闭鉴权, 任何人都能 init/start/stop 策略!)
LIVE_TRADING_OPS_PASSWORD=<强口令>

# 可选 — 邮件告警 (节点掉线 / 异常自动发邮件)
SMTP_SERVER=smtp.exmail.qq.com
SMTP_USERNAME=alert@example.com
SMTP_PASSWORD=<授权码>
SMTP_SENDER=alert@example.com
SMTP_RECEIVER=ops@example.com
```

`vnpy_nodes.yaml` 模板：

```yaml
nodes:
  - node_id: prod_node_1
    base_url: http://10.0.0.10:8001    # vnpy_webtrader 监听地址
    username: vnpy
    password: <密码>
    enabled: true
```

跨节点推荐 SSH 隧道：vnpy 节点 8001 不直接对外，本机 `autossh -fN -M 0 -L 18001:127.0.0.1:8001 user@cloudN` 转发后，`base_url: http://127.0.0.1:18001`。

修改 `.env` 或 `vnpy_nodes.yaml` 后重启服务：

```powershell
nssm restart mlearnweb_research
nssm restart mlearnweb_live
```

## 浏览器访问

- 单端口生产模式: `http://<本机IP>:8000/`（W4.1 反代 `/api/live-trading/*` → 8100）
- 调试模式（`-SkipFrontend` 部署）: 单独 `cd frontend; npm run dev` → `http://127.0.0.1:5173/`

## 服务管理

```powershell
# 状态
nssm status mlearnweb_research    # 期望 SERVICE_RUNNING
nssm status mlearnweb_live

# 启停
nssm start mlearnweb_research
nssm stop  mlearnweb_research
nssm restart mlearnweb_research

# 实时日志
Get-Content D:\mlearnweb_data\logs\mlearnweb_live.log -Wait -Tail 50
Get-Content D:\mlearnweb_data\logs\mlearnweb_live.err -Wait -Tail 50

# 健康检查
Invoke-RestMethod http://127.0.0.1:8000/health
Invoke-RestMethod http://127.0.0.1:8100/health
```

## 卸载

```powershell
# 仅删服务 (保留 venv / dist / .env / SQLite)
.\deploy\uninstall_services.ps1

# 完整清理 (含数据)
.\deploy\uninstall_services.ps1
Remove-Item -Recurse -Force D:\mlearnweb_data
```

## 排错

### 1. 服务起不来 (SERVICE_PAUSED / NSSM_FAULT)

查 `D:\mlearnweb_data\logs\mlearnweb_*.err`。常见原因：

- `.env` 缺 `VNPY_NODES_CONFIG_PATH` → live_main 启动 fail-fast
- vnpy_nodes.yaml 格式错（YAML 缩进 / 引号）
- 端口 8000/8100 被占（`netstat -ano | findstr "8000 8100"`）

### 2. 前端白屏 / 404

- 检查 `FRONTEND_DIST_DIR` 是否绝对路径 + `Test-Path` 真实存在
- `frontend\dist\index.html` 存在? 没有 → `cd frontend; npm run build`
- 浏览器 DevTools Network: `/api/live-trading/*` 是否 200? 502 → `live_main` 没起

### 3. /api/live-trading/* 返 502

```json
{
  "success": false,
  "message": "实盘服务 http://127.0.0.1:8100 未启动",
  "warning": "live_main 进程不可达 — 检查 mlearnweb_live 服务状态"
}
```

→ `nssm status mlearnweb_live` 应是 `SERVICE_RUNNING`。如不是 → 查 `mlearnweb_live.err`。

### 4. vnpy 节点全显示 offline

- mlearnweb 与 vnpy 节点之间的网络可达性 → `Test-NetConnection vnpy_node_ip -Port 8001`
- 开发机 `http_proxy` 环境变量影响 → mlearnweb httpx `trust_env=False` 已规避，但 vnpy 节点本身也要确认无代理拦截
- vnpy_nodes.yaml `username/password` 与 vnpy 节点 `web_trader_setting.json` 一致?

### 5. SQLite WAL 性能问题

- `D:\mlearnweb_data\db\` (或 backend 目录) 加入 Defender 排除：
  ```powershell
  Add-MpPreference -ExclusionPath D:\mlearnweb_data
  ```
- 双进程同时写 → 已用 WAL 模式 (`PRAGMA journal_mode=WAL`)，并发 OK

## 升级流程

```powershell
# 1. 停服
nssm stop mlearnweb_research
nssm stop mlearnweb_live

# 2. 拉新代码
cd C:\mlearnweb
git pull --rebase
git submodule update --init --recursive  # 若用 submodule 集成

# 3. 重装依赖 (requirements.txt / package.json 改动时)
& D:\mlearnweb_data\venv\Scripts\python.exe -m pip install -r backend\requirements.txt --upgrade
cd frontend; npm install; npm run build; cd ..

# 4. 启服
nssm start mlearnweb_research
nssm start mlearnweb_live
```

升级期间 SQLite 数据库不变，配置 `.env` 不动，已有训练记录 / 策略状态保留。

## 防火墙 / 网络分段

mlearnweb 默认监听 127.0.0.1:8000 + 127.0.0.1:8100，内网访问需要：

```powershell
# 8000 入站 (限内网, 不要开公网)
New-NetFirewallRule -DisplayName "mlearnweb-research" `
    -Direction Inbound -Protocol TCP -LocalPort 8000 `
    -Profile Domain,Private -RemoteAddress LocalSubnet -Action Allow

# 8100 不需要开 — 仅本机 :8000 反代会用
```

公网部署强烈建议挂 nginx 反代 + HTTPS（mlearnweb 自身不带 TLS，也不带速率限制）。
