# mlearnweb 部署指南

## 拓扑

```
┌─────────────────────────────────────────────────────┐
│ mlearnweb 机 (Windows Server 或 Linux)              │
│                                                      │
│  ┌──────────────────┐    ┌──────────────────────┐  │
│  │ app.main :8000   │    │ app.live_main :8100  │  │
│  │ 研究侧 API       │    │ 实盘侧 + snapshot    │  │
│  └────────┬─────────┘    └──────────┬───────────┘  │
│           │      同一 SQLite (WAL)    │             │
│           └─────────┬──────────────────┘             │
│                     ▼                                │
│                mlearnweb.db                          │
│                                                      │
│  ┌──────────────────────────────────────────────┐  │
│  │ frontend (Vite build → static 文件)          │  │
│  │ 由 Nginx serve                                │  │
│  └──────────────────────────────────────────────┘  │
│                                                      │
└──────┬───────────────────────────────────────────┬─┘
       │                                           │
   HTTP :8001 (JWT)                    研究机 MLflow
       │                                           │
┌──────▼────────┐                        ┌────────▼────────┐
│ vnpy 节点 1   │                        │ mlruns/ 目录     │
│ (vnpy_webtrader)│                      │ + qs_exports/    │
└───────────────┘                        └──────────────────┘
       │
   autossh 隧道 (多节点场景)
       │
┌──────▼────────┐
│ vnpy 节点 N   │
└───────────────┘
```

## 环境变量(`.env` 或 systemd EnvironmentFile)

**必设**:

| 变量 | 示例 | 作用 |
|---|---|---|
| `MLRUNS_DIR` | `/data/mlruns` | MLflow 根目录 (需读权限) |
| `VNPY_NODES_CONFIG_PATH` | `/etc/mlearnweb/vnpy_nodes.yaml` | vnpy 节点清单 |

**可选**:

| 变量 | 默认 | 作用 |
|---|---|---|
| `DATABASE_URL` | `sqlite:///./mlearnweb.db` | SQLite 路径(建议用绝对路径) |
| `VNPY_REQUEST_TIMEOUT` | `10.0` | HTTP 超时 (秒) |
| `VNPY_POLL_INTERVAL_SECONDS` | `10` | 实盘快照轮询间隔 |
| `VNPY_SNAPSHOT_RETENTION_DAYS` | `30` | 实盘快照保留天数 |
| `LIVE_TRADING_OPS_PASSWORD` | 空 | 实盘写操作密码,空=关闭写鉴权 |
| `ML_LIVE_OUTPUT_ROOT` | 空 | backtest-vs-live 查询默认 live 根目录 |

## systemd 服务样板 (Linux)

`/etc/systemd/system/mlearnweb-main.service`:

```ini
[Unit]
Description=mlearnweb research backend (:8000)
After=network.target

[Service]
Type=exec
User=mlearnweb
WorkingDirectory=/opt/mlearnweb/backend
EnvironmentFile=/etc/mlearnweb/mlearnweb.env
ExecStart=/opt/mlearnweb/venv/bin/python -m uvicorn app.main:app \
    --host 127.0.0.1 --port 8000 --workers 4 --proxy-headers
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/mlearnweb-live.service`:

```ini
[Unit]
Description=mlearnweb live-trading backend (:8100)
After=network.target mlearnweb-main.service

[Service]
Type=exec
User=mlearnweb
WorkingDirectory=/opt/mlearnweb/backend
EnvironmentFile=/etc/mlearnweb/mlearnweb.env
# live_main 的 ml_snapshot_loop 是 lifespan 协程, 不支持 --workers >1
ExecStart=/opt/mlearnweb/venv/bin/python -m uvicorn app.live_main:app \
    --host 127.0.0.1 --port 8100 --proxy-headers
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

**注意**:
- `app.main` 可以 `--workers 4`(stateless);`app.live_main` **不可以**(`ml_snapshot_loop` 需要单实例,多 worker 会并发轮询造成重复入库)
- 生产启用 `--proxy-headers` 让 FastAPI 识别 Nginx 转发的 `X-Forwarded-For`

## Nginx 反代

```nginx
server {
    listen 443 ssl http2;
    server_name mlearnweb.example.com;
    ssl_certificate /etc/letsencrypt/live/mlearnweb.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mlearnweb.example.com/privkey.pem;

    # 前端静态 (npm run build 后的 dist/)
    root /opt/mlearnweb/frontend/dist;
    index index.html;
    location / {
        try_files $uri $uri/ /index.html;  # SPA fallback
    }

    # 研究侧 API
    location /api/experiments/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
    location /api/runs/ { proxy_pass http://127.0.0.1:8000; }
    location /api/reports/ { proxy_pass http://127.0.0.1:8000; }
    location /api/training-records/ { proxy_pass http://127.0.0.1:8000; }
    location /api/factor-docs/ { proxy_pass http://127.0.0.1:8000; }

    # 实盘侧 API
    location /api/live-trading/ {
        proxy_pass http://127.0.0.1:8100;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

## 多节点 vnpy (autossh 隧道)

每台 vnpy 节点本地端口 8001 **不对外暴露**,靠 ssh 反向隧道接入 mlearnweb 机:

```bash
# 在 vnpy 节点上起隧道
autossh -fN -M 0 \
    -o "ServerAliveInterval 30" -o "ServerAliveCountMax 3" \
    -R 18001:127.0.0.1:8001 mlearnweb@mlearnweb-host
```

`mlearnweb` 机的 `vnpy_nodes.yaml`:

```yaml
nodes:
  - node_id: beijing_node1
    base_url: http://127.0.0.1:18001
    username: vnpy
    password: vnpy_prod_password
    enabled: true
  - node_id: shanghai_node1
    base_url: http://127.0.0.1:18002
    username: vnpy
    password: vnpy_prod_password
    enabled: true
```

## 数据库备份恢复

**备份(热备)**:

```bash
# SQLite 在 WAL 模式下, sqlite3.exe 的 .backup 命令可以一致性备份 without lock
sqlite3 /opt/mlearnweb/backend/mlearnweb.db ".backup /backup/mlearnweb-$(date +%Y%m%d).db"
```

**恢复**:

```bash
systemctl stop mlearnweb-live mlearnweb-main
cp /backup/mlearnweb-20260417.db /opt/mlearnweb/backend/mlearnweb.db
rm -f /opt/mlearnweb/backend/mlearnweb.db-wal /opt/mlearnweb/backend/mlearnweb.db-shm
systemctl start mlearnweb-main mlearnweb-live
```

**关键**:恢复时必须删 `.db-wal` + `.db-shm`(否则 SQLite 会尝试回放旧 WAL,和新 db 内容不匹配)。

## 日志收集

uvicorn 日志到 stdout/stderr,systemd 自动收到 journald:

```bash
journalctl -u mlearnweb-main.service -f     # 研究侧
journalctl -u mlearnweb-live.service -f     # 实盘侧
journalctl -u mlearnweb-live.service --since "today" | grep ml_snapshot
```

推荐配 `loguru` 或 `structlog` 输出 JSON,然后接 ELK / Loki 集中查询。

## 关键指标监控

| 指标 | 数据源 | 告警阈值 |
|---|---|---|
| SQLite 大小 | `stat mlearnweb.db` | > 5 GB (retention 误配可能无限增长) |
| `ml_metric_snapshots` 最新 trade_date | `SELECT MAX(trade_date) FROM ml_metric_snapshots` | < today-2d (snapshot_loop 挂了) |
| `app.live_main` 协程存活 | `curl :8100/api/live-trading/ml/health` | 非 200 或 strategies 空 |
| vnpy 节点可达性 | `curl :8100/api/live-trading/nodes` | any node `ok=false` |
| CPU / 内存 | systemd / top | > 80% 持续 5 min |

## 升级部署(滚动)

```bash
# 1. 在测试环境拉 main
cd /opt/mlearnweb_staging
git fetch && git reset --hard origin/main
git submodule update --recursive

# 2. 跑迁移 / 测试
pytest backend/tests/ -v

# 3. 生产机:先停实盘侧,再升级,再启
systemctl stop mlearnweb-live
cd /opt/mlearnweb
git fetch && git reset --hard origin/main
git submodule update --recursive
pip install -r backend/requirements.txt
(cd frontend && npm install && npm run build)
systemctl restart mlearnweb-main  # reload 不中断研究侧
systemctl start mlearnweb-live
```

如果 DB schema 变了(新增表/列),会在首次 import `models/database.py` 时 `create_all`,自动建表。已有数据不影响。**删列 / 改约束** 需手写 migration(未集成 Alembic)。

## 数据库 schema 迁移(手工)

当前项目没用 Alembic。schema 变更流程:

1. 改 `models/*.py`
2. 在 `create_all_tables` 里的 `_ensure_*_columns` 函数里加新列(见 `database.py`)
3. 走测试环境跑一次 → 验证新列进数据库
4. 生产执行:停 live_main → 手工 `ALTER TABLE ... ADD COLUMN ...`(如 `_ensure_*_columns` 做了自动补) → 启动

## 安全

- JWT 密钥:`backend/app/services/vnpy/deps.py` 有硬编码的 `SECRET_KEY`,生产**必须**从 env 读(已留 TODO,当前是开发默认)
- ops_password:若启用实盘写操作,`LIVE_TRADING_OPS_PASSWORD` 必设 + 前端通过 `X-Ops-Password` header 双因素
- SQLite 文件权限:生产仅 mlearnweb 用户可读写,0600
- vnpy 节点 8001 **永不对外暴露**,始终走 autossh 隧道

## 性能基线

| 场景 | 指标 | 备注 |
|---|---|---|
| `/api/runs` 分页 30 条 | < 200 ms | MLflow artifact read 瓶颈 |
| `/api/live-trading/strategies` 单节点 | < 500 ms (含 HTTP 到 vnpy) | JWT cache 后 < 100 ms |
| `/api/live-trading/ml/*/metrics/rolling` | < 150 ms | 读 SQLite + in-mem 聚合 |
| SHAP 页面 | < 3 s | 首次加载 pickle, 之后 lru_cache |

超出预期需看 `journalctl` 慢查询。
