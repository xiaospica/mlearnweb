# mlearnweb 架构文档

面向希望**深入理解代码结构、做二次开发或跨仓集成**的读者。本文档和代码强耦合,改代码时一起改文档。

## 双进程模型

```
┌──────────────────────────────────────┐
│ app.main :8000  (uvicorn 可多 worker)│
│                                       │
│ 职责:                                 │
│  - MLflow experiments / runs 查询    │
│  - training_records 管理             │
│  - factor_docs 静态页               │
│  - model_interpretability (SHAP)    │
│                                       │
│ 依赖:                                 │
│  - MLflow 文件系统 (mlruns/)         │
│  - SQLite (training_records*)        │
│  - qlib (用于读 pkl 模型)            │
└──────────────────────────────────────┘
                 │
          同一 SQLite (WAL)
                 │
┌──────────────────────────────────────┐
│ app.live_main :8100  (单 worker)     │
│                                       │
│ 职责:                                 │
│  - live-trading 多节点聚合            │
│  - ML 监控 (metrics / rolling / 告警) │
│  - snapshot_loop 协程 (10s)           │
│  - ml_snapshot_loop 协程 (60s)        │
│                                       │
│ 依赖:                                 │
│  - vnpy_nodes.yaml                   │
│  - HTTP 到 vnpy 节点 /api/v1/*       │
│  - SQLite (strategy_equity_snapshots, │
│            ml_metric_snapshots 等)   │
└──────────────────────────────────────┘
```

**为什么双进程不合一**:
- 研究侧有 SHAP 等重 CPU 任务,会阻塞事件循环
- 实盘侧的 snapshot 协程对 latency 敏感,不能被研究侧拖慢
- 研究侧 `--reload` 热重启不影响实盘状态
- SQLite WAL 支持多进程并发,正好利用

## Router → Service → Model 分层

```
HTTP Request
    ↓
routers/*.py
    ↓ 只做 URL 参数解析 + pydantic 校验
    ↓ Depends(get_db_session) 注入 DB session
    ↓
services/*.py
    ↓ 纯业务逻辑, 返回 dict / dataclass
    ↓ 调 models/* 操作 ORM
    ↓ 调 utils/* 读外部数据 (MLflow / vnpy)
    ↓
models/*.py (SQLAlchemy ORM)
    ↓
SQLite (mlearnweb.db)
```

**纪律**(任何 PR reviewer 都要查):
- router 里**不能**直接 `db.query(Model)`
- service 里**不能**返回 `JSONResponse` / `HTTPException`(应抛原生 Python 异常,router 捕获再转 HTTP)
- model 里**不能**写业务逻辑,只管 columns + `__table_args__`

## 路由全表

### 研究侧 (`app.main:8000`)

| 方法 | 路径 | 文件 | 用途 |
|---|---|---|---|
| GET | `/api/experiments/` | `routers/experiments.py` | 列实验 |
| GET | `/api/experiments/{id}` | 同 | 实验详情 |
| GET | `/api/experiments/{id}/summary` | 同 | 统计汇总 |
| GET | `/api/runs/` | `routers/runs.py` | 列 run(分页) |
| GET | `/api/runs/{run_id}` | 同 | run 详情 |
| GET | `/api/runs/{run_id}/params` | 同 | 参数 |
| GET | `/api/runs/{run_id}/metrics` | 同 | 指标 |
| GET | `/api/runs/{run_id}/artifacts` | 同 | 工件列表 |
| GET | `/api/runs/{run_id}/shap-analysis` | 同 | SHAP 值 |
| GET | `/api/runs/{run_id}/report` | `routers/reports.py` | 回测报告 |
| GET | `/api/runs/{run_id}/charts/*` | 同 | 图表数据 |
| POST | `/api/training-records/` | `routers/training_records.py` | 创建 |
| GET | `/api/training-records/` | 同 | 列表 + 搜索 |
| PUT | `/api/training-records/{id}` | 同 | 更新 |
| DELETE | `/api/training-records/{id}` | 同 | 删除 |
| GET | `/api/training-records/groups` | 同 | 分组列表 |
| POST | `/api/training-records/insample-backtest` | 同 | 样本内回测 |
| POST | `/api/training-records/{id}/images` | `routers/training_record_images.py` | 上传图片 |
| GET | `/api/factor-docs/*` | `routers/factor_docs.py` | 因子文档静态 |

### 实盘侧 (`app.live_main:8100`)

| 方法 | 路径 | 文件 | 用途 | ops_password |
|---|---|---|---|---|
| GET | `/api/live-trading/nodes` | `routers/live_trading.py` | 节点状态 | — |
| GET | `/api/live-trading/strategies` | 同 | 策略聚合列表 | — |
| GET | `/api/live-trading/strategies/{node}/{eng}/{name}` | 同 | 策略详情 | — |
| POST | `/api/live-trading/strategies` | 同 | 创建策略 | ✓ |
| POST | `/api/live-trading/strategies/{n}/{e}/{name}/init` | 同 | init | ✓ |
| POST | `/api/live-trading/strategies/{n}/{e}/{name}/start` | 同 | start | ✓ |
| POST | `/api/live-trading/strategies/{n}/{e}/{name}/stop` | 同 | stop | ✓ |
| PATCH | `/api/live-trading/strategies/{n}/{e}/{name}` | 同 | 改参数 | ✓ |
| DELETE | `/api/live-trading/strategies/{n}/{e}/{name}` | 同 | 删除 | ✓ |
| GET | `/api/live-trading/ml/{n}/{name}/metrics/history?days=N` | `routers/ml_monitoring.py` | 历史指标 | — |
| GET | `/api/live-trading/ml/{n}/{name}/metrics/rolling?window=N` | 同 | ICIR + 告警 | — |
| GET | `/api/live-trading/ml/{n}/{name}/metrics/latest` | 同 | 实时 pass-through | — |
| GET | `/api/live-trading/ml/{n}/{name}/prediction/latest/summary` | 同 | 最新 pred(带 SQLite fallback) | — |
| GET | `/api/live-trading/ml/{n}/{name}/prediction/summary/{YYYYMMDD}` | 同 | 按日查 | — |
| GET | `/api/live-trading/ml/{n}/{name}/backtest-diff?mlflow_run_dir=...` | 同 | 回测-实盘差异 | — |
| GET | `/api/live-trading/ml/health` | 同 | 多节点健康聚合 | — |

## DB Schema

```
training_records              (研究侧)
  id PK
  name, group_name, experiment_id, description
  status, config_json, log_text
  created_at, updated_at

training_run_mappings         (研究侧, M:1 → training_records)
  id PK
  training_record_id FK
  run_id, recorder_id, seg_index

strategy_equity_snapshots     (实盘侧, 时间序列)
  id PK
  node_id, engine, strategy_name, ts
  equity, pnl, positions_count, strategy_value, account_equity, source_label
  UNIQUE (node_id, engine, strategy_name, ts)
  INDEX ix_ses_identity_ts (node_id, engine, strategy_name, ts)
  INDEX ix_ses_ts (ts)       # 用于跨策略的 retention cleanup

ml_metric_snapshots           (Phase 3)
  id PK
  node_id, engine, strategy_name, trade_date
  ic, rank_ic, psi_mean, psi_max, psi_n_over_0_25
  psi_by_feature_json, ks_by_feature_json, feat_missing_json
  pred_mean, pred_std, pred_zero_ratio, n_predictions
  model_run_id, core_version, status
  created_at, updated_at
  UNIQUE (node_id, engine, strategy_name, trade_date)

ml_prediction_daily           (Phase 3)
  id PK
  node_id, engine, strategy_name, trade_date
  topk_json, score_histogram_json
  n_symbols, coverage_ratio, pred_mean, pred_std, model_run_id, status
  created_at, updated_at
  UNIQUE (node_id, engine, strategy_name, trade_date)
```

## Services 职责表

### 研究侧

| 文件 | 主类 / 函数 | 职责 |
|---|---|---|
| `experiment_service.py` | `list_experiments` / `get_experiment` | MLflow 实验查询 + 字段规整 |
| `run_service.py` | `get_run_detail` / `load_params` / `load_metrics` | MLflow run 字段 + artifact 读 |
| `report_service.py` | `build_report` | 回测报告聚合 + 图表数据生成 |
| `training_service.py` | `create_training_record` / `update_run_mappings` | CRUD + log 管理 |
| `model_interpretability_service.py` | `load_shap` / `compute_feature_importance` | SHAP 值读取 + 预计算 |
| `memo_image_service.py` | `save_image` / `cleanup_orphans` | 图片上传 + 清理 |
| `utils/mlflow_reader.py` | 低层 API | 解析 `mlruns/{exp_id}/{run_id}/` 目录结构 |

### 实盘侧

| 文件 | 主类 / 函数 | 职责 |
|---|---|---|
| `vnpy/registry.py` | `load_nodes` | `vnpy_nodes.yaml` → `Node` 列表 |
| `vnpy/client.py` | `VnpyMultiNodeClient` + `_PerNodeClient` | HTTP + JWT + 30 min token cache |
| `vnpy/live_trading_service.py` | `snapshot_loop` / `list_strategy_summaries` / `get_strategy_detail` | 10s 轮询 + SQLite 入库 + 聚合查询 |
| `vnpy/ml_monitoring_service.py` | `ml_snapshot_loop` + `_upsert_metric` / `_upsert_prediction` | 60s 轮询 ML 指标 + UPSERT |
| `vnpy/deps.py` | `require_ops_password` | `X-Ops-Password` header 校验 |
| `ml_aggregation_service.py` | `get_metrics_history` / `compute_rolling_summary` / `backtest_vs_live_diff` | SQLite 读 + 调 `qlib_strategy_core.metrics` 算子 |

**核心原则**:实盘侧 `ml_aggregation_service` **不**自己实现 ICIR / PSI 告警等算法,只做 DB 取数 + HTTP 包装,算法全在 `qlib_strategy_core.metrics`(v4.1 line 249 "单一真相源")。

## Frontend 架构

### 页面路由 (`src/App.tsx`)

```
/                                  → TrainingRecordsPage (默认)
/training/:id                      → TrainingDetailPage
/experiments                       → HomePage (实验列表)
/experiments/:expId                → ExperimentDetailPage
/report/:expId/:runId              → ReportPage
/live-trading                      → LiveTradingPage (策略汇总)
/live-trading/:nodeId/:engine/:name → LiveTradingStrategyDetailPage (Tab1 收益曲线, Tab2 ML 监控)
/help/*                            → HelpLayout
```

### 关键组件(`src/pages/live-trading/components/`)

| 组件 | Tab | 数据源 |
|---|---|---|
| `FullEquityChart` | Tab1 | `/live-trading/strategies/.../curve` |
| `PositionsTable` | Tab1 | `detail.positions` |
| `LatestTopkCard` | Tab1 (ML only) | `/ml/.../prediction/latest/summary` (带 SQLite fallback) |
| `MlMonitorPanel` | Tab2 | history / rolling / prediction |
| `BacktestDiffPanel` | Tab2 | `/ml/.../backtest-diff` |
| `PredictionHistoryPanel` | Tab2 | `/ml/.../prediction/summary/{date}` |
| `StrategyActions` / `StrategyCreateWizard` / `StrategyEditModal` | 顶部 / 弹窗 | POST / PATCH 相关 |

### 状态管理

- **服务端状态**:`@tanstack/react-query` (staleTime=5min, retry=1)
- **UI 状态**:`useState`
- **运维 token**:`useOpsPassword` hook + `sessionStorage` (tab 关闭失效)

### Vite proxy

`frontend/vite.config.ts`:
```ts
proxy: {
  "/api/live-trading": "http://localhost:8100",
  "/api": "http://localhost:8000",
}
```

路径后缀匹配,因此 `/api/live-trading/*` 先命中。

## 鉴权

```
浏览器                mlearnweb :8100                vnpy :8001
 │                          │                            │
 │ GET /live-trading/       │                            │
 │  strategies (无需 token) │                            │
 ├─────────────────────────►│                            │
 │                          │  POST /api/v1/token        │
 │                          │   (username/password YAML) │
 │                          ├───────────────────────────►│
 │                          │◄──── access_token ────────┤
 │                          │  GET /api/v1/strategy      │
 │                          │   Authorization: Bearer    │
 │                          ├───────────────────────────►│
 │                          │◄───── 策略列表 ────────────┤
 │◄─── 聚合列表 ────────────┤                            │
 │                                                       │
 │ POST /live-trading/strategies                         │
 │  X-Ops-Password: xxx (需匹配 LIVE_TRADING_OPS_PASSWORD)│
 ├─────────────────────────►│                            │
 │                          │ (同上 JWT 流程)            │
 │                          ├───────────────────────────►│
```

- mlearnweb 对**读**接口不要求运维密码(任何能访问 :8100 的人都能看)
- mlearnweb 对**写**接口要求 `X-Ops-Password` header 匹配 `LIVE_TRADING_OPS_PASSWORD`
- mlearnweb → vnpy 用 JWT (30 min 自动刷新)

## 和 vnpy 的契约

### vnpy_nodes.yaml

```yaml
nodes:
  - node_id: local       # 唯一 ID, 前端 URL 用
    base_url: http://127.0.0.1:8001
    username: vnpy
    password: vnpy
    enabled: true
```

- `vnpy.username` / `vnpy.password` 对应 vnpy_webtrader 的 `web_trader_setting.json`
- `enabled: false` 的节点 `client.py` 会 skip(保留在列表,UI 显示 disabled)
- 节点增减**需重启 live_main**

### vnpy /api/v1/* 关键契约

| vnpy 端点 | mlearnweb 用途 |
|---|---|
| `POST /api/v1/token` | 取 JWT |
| `GET /api/v1/node/info` | discovery + display_name |
| `GET /api/v1/node/health` | uptime / engines |
| `GET /api/v1/strategy` | 策略实例列表 (all engines) |
| `GET /api/v1/strategy/engines` | 本节点支持的策略 engine 清单 |
| `POST /api/v1/strategy` | 创建策略 |
| `POST /api/v1/strategy/{n}/{e}/{name}/init|start|stop` | 控制 |
| `GET /api/v1/account` / `/position` / `/order` / `/trade` | 实时数据 |
| `GET /api/v1/ml/health` | ML 策略清单 (独立) |
| `GET /api/v1/ml/strategies/{name}/metrics/latest` | MetricsCache 最新 |
| `GET /api/v1/ml/strategies/{name}/metrics?days=N` | ring buffer |
| `GET /api/v1/ml/strategies/{name}/prediction/latest/summary` | topk + histogram |

### schema_version 跨仓

- `diagnostics.json.schema_version = 1`(子进程三件套)
- vnpy 收到非 1 则拒绝 + 告警
- 升级时保证两侧同时 bump + 双写一个版本

## 扩展路径(已实现 / 待做)

- ✅ ML 监控 Tab2(Phase 3.4)
- ✅ IC 衰减告警(Phase 4)
- ✅ 回测-实盘一致性 Panel(Phase 4)
- ✅ 历史预测回溯(Phase 4)
- ⬜ 多节点告警聚合(当前逐节点独立)
- ✅ WebSocket 实时推送(`app.live_main` 后端 collector，前端仍只接 mlearnweb SSE)
- ⬜ 用户权限分级(当前 ops_password 单级)
- ⬜ Alembic DB migration(当前靠 `create_all` + 手工 `ALTER`)
## Live-Trading Event Center

实盘侧 `app.live_main` 现在包含一个进程内事件中台：

- `services/vnpy/live_trading_events.py` 提供 in-memory event bus、SSE payload、query group 映射与 750ms coalesce。
- `services/vnpy/risk_event_service.py` 将 strategy variables、orders、node/gateway health 归一为实时 `StrategyRiskEvent`。
- `services/vnpy/ws_collector_service.py` 由 `app.live_main` 连接 vnpy `/api/v1/ws?token=...`，处理 `strategy/order/trade/position/account/log` topic，并统一转成内部事件。
- `services/vnpy/rest_fingerprint_service.py` 保留为 fallback：WS 在线节点跳过热路径，WS 断线节点继续使用 REST 指纹检测策略状态、持仓、订单和风险摘要变化。
- `services/vnpy/live_trading_event_store.py` 将关键事件写入 `live_trading_events` 表，支持 dedupe、历史过滤和 `ack_at/ack_by`。
- `/api/live-trading/events` 只推 query invalidation 事件，不推完整业务数据；前端收到后再通过 REST 拉取权威数据。
- 生产单端口模式下，`app.main` 的 `_live_proxy.py` 对 `/api/live-trading/events` 使用 streaming 透传，避免 SSE 被缓冲。

长期边界：
- mlearnweb 不修改 vnpy 仓库；vnpy WS 由后端统一认证、重连、降噪和 fanout。
- 前端不直连 vnpy `/api/v1/ws`，只订阅 mlearnweb `/api/live-trading/events`。
- `live_trading_events` 当前使用 SQLite + WAL；复杂用户权限和 vnpy 侧结构化字段仍是后续增强。
