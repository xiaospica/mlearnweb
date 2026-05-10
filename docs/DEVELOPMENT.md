# mlearnweb 开发指南

面向**第一次接触 mlearnweb 代码的 AI / 开发者**。目标:30 分钟内能在本地启起后端 + 前端,跑通一次接口调用。

## 前提环境

| 组件 | 版本 | 备注 |
|---|---|---|
| Python | **3.11** (`E:/ssd_backup/Pycharm_project/python-3.11.0-amd64/python.exe`) | 不要用 vnpy 的 3.13;mlearnweb 依赖 qlib_strategy_core,而 core 当前只在 py311 验过 |
| Node.js | ≥ 18 | Vite 5 要求 |
| Git | ≥ 2.40 | submodule recursive 支持 |
| SQLite | 系统自带 | WAL 模式,两进程并发读写 |

## 首次拉代码

```bash
git clone --recursive git@github.com:xiaospica/qlib_strategy_dev.git
cd qlib_strategy_dev/mlearnweb

# 安装 Python 依赖 (mlearnweb 直接用 py311, 不用虚拟环境也可, 但推荐 venv)
E:/ssd_backup/Pycharm_project/python-3.11.0-amd64/python.exe -m pip install -r backend/requirements.txt
E:/ssd_backup/Pycharm_project/python-3.11.0-amd64/python.exe -m pip install -e ../vendor/qlib_strategy_core

# 前端依赖
cd frontend
npm install
cd ..
```

## 一键启动 (3 进程)

| 进程 | 端口 | 作用 | 启动命令 |
|---|---|---|---|
| `app.main` | 8000 | 研究侧 API (experiments / runs / training-records / factor-docs) | `cd backend && uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload` |
| `app.live_main` | 8100 | 实盘侧 API (live-trading / ml monitoring) + `ml_snapshot_loop` | `cd backend && uvicorn app.live_main:app --host 0.0.0.0 --port 8100 --reload` |
| `frontend` | 5173 | Vite dev + HMR,代理 `/api/*` | `cd frontend && npm run dev` |

两个后端**必须用同一个 Python 解释器** (SQLite WAL 要求) ,前端 Vite proxy 把 `/api/live-trading/*` 转 `:8100`,其他 `/api/*` 转 `:8000` (见 `frontend/vite.config.ts`)。

## 数据库

首次启动 `app.main` 会自动 `Base.metadata.create_all(engine)` 建表(见 `app/models/database.py:create_all_tables`),WAL 模式通过 `connect` 事件 `PRAGMA journal_mode=WAL` 启用。

备份:停 live_main → 复制 `backend/mlearnweb.db` + `.db-wal` + `.db-shm` → 启动。**不要**只复制 `.db` 文件(WAL 里的未合并数据会丢)。

## 分层纪律(**强制遵守**)

```
routers/          ← 只做 URL 解析 + Pydantic 校验 + 调 service
services/         ← 业务逻辑, 返回 dict / dataclass / pydantic
models/           ← SQLAlchemy ORM, 只管 schema 不管业务
schemas/          ← Pydantic Request/Response 模型
utils/            ← 无状态工具函数 (mlflow_reader 等)
```

**禁止**:
- router 里查数据库(用 `Depends(get_db_session)` + 调 service)
- service 里处理 HTTP 请求/响应(用纯 dict / 抛 `HTTPException` 也算违规,应在 router 捕获 service 的 ValueError)
- model 里写业务逻辑

## vnpy_nodes.yaml (实盘侧必配)

```yaml
nodes:
  - node_id: local
    base_url: http://127.0.0.1:8001
    username: vnpy
    password: vnpy
    enabled: true
```

- `.gitignore` 忽略此文件,仓库里有 `vnpy_nodes.yaml.example` 样板
- 多节点:加多个 item,每个独立 JWT session
- 节点改动后需**重启 `app.live_main`**(YAML 在启动时加载一次)

## 日常开发流程

新增一个 mlearnweb 功能(比如加个 ML 指标):

1. `schemas/schemas.py` 定义 Pydantic 请求/响应
2. `services/xxx_service.py` 写业务逻辑
3. `routers/xxx.py` 暴露 API, `app.main.py` / `app.live_main.py` include_router
4. `frontend/src/types/` 加 TS 类型
5. `frontend/src/services/` 封装 axios 调用
6. `frontend/src/pages/` 写页面
7. `tests/test_backend/` 写集成测试(`FastAPI TestClient`)
8. 手测 `http://localhost:5173` 确认端到端通

## 常见问题

### SQLite 锁死 (database is locked)

**症状**:两进程同时写,`OperationalError`。
**解决**:确认 `database.py` 的 `connect` 事件设置了 `PRAGMA journal_mode=WAL`。两进程都走**同一个** `database.py` 路径。

### CORS 报错

**症状**:浏览器 console `No 'Access-Control-Allow-Origin'`。
**解决**:检查 `app/core/config.py` 的 `cors_origins` 是否含前端 URL。本地开发默认 `http://localhost:5173` + `http://localhost:3000`。

### 前端访问后端 502

**症状**:访问 `/api/live-trading/*` 返回 502。
**解决**:
1. 确认 `app.live_main` 在 `:8100`(而非 8101 等)
2. 确认 `frontend/vite.config.ts` 的 proxy 目标是 `http://localhost:8100`
3. Chrome DevTools Network → 看 request 真实落地 URL

### mlflow artifact 读不到

**症状**:`model_interpretability_service` 抛 `FileNotFoundError`。
**解决**:确认 `MLRUNS_DIR` env 变量(或 `core/config.py:mlruns_dir` 默认值)指向正确的 mlruns 根目录。老 run 可能需要 `qlib_strategy_core._compat.install_finder()` 兼容旧 module_path。

### 聚宽 CSV 成分股缺失 (ML 监控面板空)

**症状**:Tab2 无 ICIR / 告警。
**解决**:确认 vnpy 侧 `F:/Quant/jointquant/index/hs300_index_info_*.csv` 最新 date >= today-35d。手工从聚宽下载更新。

## 测试

```bash
# 后端单元测试
cd backend
pytest tests/test_backend/ -v

# 前端 lint/typecheck
cd frontend
npm run lint
npx tsc --noEmit
```

端到端测试见 vnpy 侧 `vnpy_ml_strategy/test/smoke_full_pipeline.py`,会起整条链路(含 mlearnweb live_main)做 12 条断言。

## 相关文档

- [ARCHITECTURE.md](./ARCHITECTURE.md) — 架构分层 + 路由全表 + DB schema
- [DEPLOYMENT.md](./DEPLOYMENT.md) — 部署 / systemd / Nginx
- [TESTING.md](./TESTING.md) — 测试矩阵
- [mlearnweb-technical-design.md](./mlearnweb-technical-design.md) — 最初的技术设计(保留)
- [api.md](./api.md) — vnpy 节点侧 API 契约
## Live-Trading Card Refresh Rules

新增或修改 `frontend/src/pages/live-trading/` 下的卡片时：

- 数据读取继续使用 React Query 和 `frontend/src/services/liveTradingService.ts` / `mlMonitoringService.ts`。
- query key 必须集中在 `liveTradingRefresh.ts`。
- 刷新触发必须接入 `useLiveTradingInvalidations()` 的 query group invalidation。
- 策略详情卡片不要新增独立高频 `refetchInterval`。SSE connected 时应停止周期轮询，SSE disconnected 时只允许低频 fallback。
- 新卡片需要在 `liveTradingRefresh.ts` 中声明对应 query group 映射，而不是在组件里自定义刷新节奏。
- 风险事件必须来自后端 `risk-events` API；前端不直接解析 vnpy 原始 order/log payload。
- 已确认风险事件默认从列表中隐藏；确认操作调用 `liveTradingService.ackRiskEvent()`，必须通过 `useOpsPassword().guardWrite()`。
- 后端新增 vnpy WS topic 处理时，只改 `services/vnpy/ws_collector_service.py` 的 topic → `LiveTradingEvent` 映射；不要让前端连接 vnpy WS。
