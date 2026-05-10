# mlearnweb 测试指南

## 测试矩阵

| 层 | 类型 | 工具 | 位置 | 跑法 |
|---|---|---|---|---|
| 后端单元 | 业务逻辑 | pytest + unittest.mock | `mlearnweb/tests/test_backend/` | `pytest tests/test_backend/ -v` |
| 后端集成 | API 端到端 | FastAPI TestClient | 同上 | 同上 |
| 前端类型 | TS 静态检查 | tsc | — | `cd frontend && npx tsc --noEmit` |
| 前端 lint | eslint | eslint | — | `cd frontend && npm run lint` |
| 前端构建 | 完整打包 | vite | — | `cd frontend && npm run build` |
| 端到端 | 数据流 + UI | 手测 + curl | — | 见下文 |

## 后端单元测试

```bash
cd mlearnweb/backend
E:/ssd_backup/Pycharm_project/python-3.11.0-amd64/python.exe -m pytest tests/test_backend/ -v
```

现有测试:
- `test_experiment_service.py` — MLflow 读取
- `test_training_service.py` — CRUD
- `test_vnpy_client.py` — HTTP 多节点 + JWT 缓存
- `test_live_trading_service.py` — snapshot_loop 行为
- `test_ml_monitoring_service.py` — ml_snapshot_loop + UPSERT
- `test_ml_aggregation_service.py` — ICIR / PSI 告警 (调 core.metrics)

**关键**:单元测试**不**应访问真实 MLflow / vnpy。用 `tmp_path` 造小 mlruns 目录 + `httpx.MockTransport` 替 vnpy HTTP。

## 集成测试

### 模拟 vnpy 节点 + mlearnweb 完整链路

```python
# tests/test_backend/test_ml_monitoring_integration.py (示意)
from fastapi.testclient import TestClient
from app.live_main import app

def test_metrics_rolling_end_to_end(tmp_path, monkeypatch):
    # 1. tmp SQLite
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path}/test.db")
    # 2. mock vnpy client 返回固定 metrics
    monkeypatch.setattr("app.services.vnpy.client.VnpyMultiNodeClient.get_ml_metrics_latest", ...)
    # 3. TestClient 调 rolling
    client = TestClient(app)
    r = client.get("/api/live-trading/ml/local/demo/metrics/rolling?window=30")
    assert r.status_code == 200
    assert "ic_decay" in r.json()["data"]
```

## 端到端测试(完整链路)

### 纯 mlearnweb 路径(vnpy 不必活)

见仓库根 `mlearnweb/backend/scripts/phase27_backfill_inference.py`。

1. 跑 `python mlearnweb/backend/scripts/phase27_backfill_inference.py` → 产出 33 天假数据 → 写 SQLite
2. 启 `app.main:8000` + `app.live_main:8100` + `frontend` npm run dev
3. 浏览器 `http://localhost:5173/live-trading/local/MlStrategy/phase27_test` 验证 Tab2 全部渲染

### 真实 vnpy 联动(完整)

见 `vnpy_strategy_dev/vnpy_ml_strategy/test/smoke_full_pipeline.py`:

```bash
cd /f/Quant/vnpy/vnpy_strategy_dev
F:/Program_Home/vnpy/python.exe -u vnpy_ml_strategy/test/smoke_full_pipeline.py
```

该脚本:
- 起 vnpy 全栈(MLEngine + TushareProEngine + WebTraderApp)
- 派生 webtrader uvicorn :8001 子进程
- 派生 mlearnweb app.live_main :8100 子进程
- 调 `DailyIngestPipeline.ingest_today` 拉真实今日数据
- 调 `run_pipeline_now` 跑 subprocess 推理
- 等 ml_snapshot_loop tick 70s
- 做 12 条断言(数据落盘 / 推理成功 / SQLite 入库)

## 回归测试

### Phase-1 数值回归

1e-9 容差比对:重构后训出来的预测和基线完全一致。

```bash
cd qlib_strategy_dev
E:/ssd_backup/Pycharm_project/python-3.11.0-amd64/python.exe tests/regression/verify_regression.py
# 退出码 0 = PASS, 1 = FAIL, 2 = 基线缺失
```

### ML 指标对齐

`ml_aggregation_service` 迁移到 core 时的合约测试:

```bash
E:/ssd_backup/Pycharm_project/python-3.11.0-amd64/python.exe -m pytest \
    tests/test_backend/test_ml_aggregation_service.py -v \
    -k "test_compute_icir or test_psi_trend_alerts"
```

## 前端

### 类型检查

```bash
cd frontend
npx tsc --noEmit
```

### Lint

```bash
npm run lint
```

### 构建烟测

```bash
npm run build
```

成功后 `frontend/dist/` 产出 html + assets,部署到 Nginx 即可。

### 手动 UI 验证清单

打开 `http://localhost:5173/live-trading/local/MlStrategy/phase27_test` 后核对:

| Tab | 区块 | 预期 |
|---|---|---|
| 1 收益曲线与持仓 | 收益曲线 | 有 curve 数据点 |
| 1 | 当前持仓 | 空表(干跑)或有行 |
| 1 | 最新 TopK 信号 | 7 行表格,含 rank / instrument / score / weight |
| 1 | 参数 | 显示 bundle_dir / trigger_time=21:00 等 |
| 2 策略监控 | KPI 6 格 | IC / RankIC / PSI mean / 样本数 / ICIR / model 版本 |
| 2 | IC 衰减告警 | (若 IC 负向衰减) 红色 Alert |
| 2 | IC / RankIC 时序图 | 多点折线 |
| 2 | PSI 时序 | 多点折线 + 0.25 阈值线 |
| 2 | 直方图 + top PSI | 直方图 + top-10 条形图 |
| 2 | 历史预测回溯 | 日期选择器 + 选中日期的 topk 表 |
| 2 | 回测 vs 实盘一致性 | 输入框(mlflow_run_dir) + "运行对比"按钮 |

## CI 建议

### pre-commit / pre-push hook

```bash
# .git/hooks/pre-push (bash)
#!/bin/bash
set -e
cd mlearnweb/backend && pytest tests/test_backend/ -x
cd ../frontend && npx tsc --noEmit && npm run lint
cd ../.. && python tests/regression/verify_regression.py
```

### GitHub Actions 样板

```yaml
name: mlearnweb CI
on: [push, pull_request]
jobs:
  backend:
    runs-on: windows-latest  # 匹配开发环境
    steps:
      - uses: actions/checkout@v4
        with: { submodules: recursive }
      - uses: actions/setup-python@v5
        with: { python-version: '3.11' }
      - run: pip install -r mlearnweb/backend/requirements.txt
      - run: pip install -e vendor/qlib_strategy_core
      - run: cd mlearnweb/backend && pytest tests/test_backend/ -v

  frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: cd mlearnweb/frontend && npm ci && npx tsc --noEmit && npm run lint
```

## 性能基线(断言用)

| 指标 | 基线 | 测试 |
|---|---|---|
| `pytest tests/test_backend/` | < 30 s | `pytest --durations=10` |
| Phase-1 回归 | 1e-9 对齐 | `verify_regression.py` 退出 0 |
| smoke_full_pipeline | < 5 min (有缓存 < 2 min) | 观察 "所有断言通过" |
| `/api/runs` 分页 30 条 | < 200 ms | `ab -n 100 -c 10 http://...` |
| SHAP 页面首次加载 | < 3 s | DevTools Network tab |

超出需排查瓶颈(SQLite 索引 / MLflow artifact 磁盘 / Python 进程数)。

## 覆盖率

```bash
cd mlearnweb/backend
pytest --cov=app --cov-report=html tests/test_backend/
open htmlcov/index.html
```

目标覆盖:
- `services/` ≥ 80%(核心业务)
- `routers/` ≥ 60%(薄层, 主要测 param 解析 + 异常映射)
- `models/` — 不测(ORM 声明, SQLAlchemy 已经验证)
- `utils/` ≥ 70%

## 常见问题

### 测试本地过但 CI 挂

- Windows 路径大小写(开发 Windows, CI Linux)→ 用 `pathlib.Path` 代替字符串拼接
- 时区:`datetime.now()` 在 Windows 默认本地, Linux 默认 UTC → 用 `datetime.now(timezone.utc)` 或明确 `ZoneInfo`
- SQLite 版本:Windows 内置版本旧 → `pip install pysqlite3-binary`

### `ml_snapshot_loop` 测不到

协程测试需 `pytest-asyncio`:

```python
import pytest

@pytest.mark.asyncio
async def test_ml_snapshot_tick(tmp_path, monkeypatch):
    ...
```

### FastAPI TestClient 穿透 lifespan

用 `with TestClient(app) as client:` 形式,让 lifespan 的 async 任务跑起来,结束 block 自动清理。

## 相关文档

- [DEVELOPMENT.md](./DEVELOPMENT.md) — 开发环境 + 分层纪律
- [DEPLOYMENT.md](./DEPLOYMENT.md) — 生产部署 + 监控
- [ARCHITECTURE.md](./ARCHITECTURE.md) — 组件职责 + DB schema
## Live-Trading Event Center Tests

实盘事件中台相关修改至少覆盖：

- risk normalization：`REJECTED`、`ORDER_JUNK`、撤单再报 `R`、普通 `CANCELLED`、长时间 `PARTTRADED`、`last_status=failed`、`replay_status=error`。
- API degradation：orders/risk-events 空数据不 500；节点不可达返回 node-level critical risk event。
- event bus：多 SSE client fanout、client unsubscribe、heartbeat、普通事件 coalesce、`error/critical` 不被 coalesce 延迟。
- WS collector：`strategy/order/trade/position/account/log` topic 能发布对应 invalidation；普通策略日志进入 `runtime_log`，拒单/log 异常写入风险事件。
- P3 event store：风险事件 dedupe、历史过滤、`ack_at/ack_by`、默认隐藏已确认事件，`include_ack=true` 可回看。
- REST fallback：WS connected 的 node 跳过 REST fingerprint 热路径；WS disconnected 后 fingerprint 继续发布事件。
- production proxy：`/api/live-trading/events` 在 `app.main` 单端口代理下必须保持 streaming，不允许读成 `upstream.content` 后返回。
- frontend：`cmd /c npm run build`，并手工验证 SSE connected 时策略详情卡片不再高频轮询，SSE disconnected 时 fallback polling 生效。

推荐后端命令：

```bash
python -m pytest tests/test_backend/test_live_trading.py -q --basetemp .pytest_tmp
```
