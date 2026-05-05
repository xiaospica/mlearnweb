"""Live-trading uvicorn entry point.

Runs as a separate OS process from app.main so that research workloads on
:8000 (MLflow reads, SHAP loading, backtest requests) cannot stall the vnpy
poll loop or the live_trading endpoints on :8100. Shares the same codebase,
config, and mlearnweb.db (SQLite WAL mode) with app.main — the only reason
this file exists is process isolation.

Start with:
    uvicorn app.live_main:app --port 8100 --reload
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.models.database import init_db
from app.routers import live_trading, ml_monitoring
from app.services.deployment_sync_service import sync_deployments
from app.services.vnpy.client import get_vnpy_client
from app.services.vnpy.live_trading_service import snapshot_loop
from app.services.vnpy.ml_monitoring_service import ml_snapshot_loop
from app.services.vnpy.historical_metrics_sync_service import historical_metrics_sync_loop
from app.services.vnpy.replay_equity_sync_service import replay_equity_sync_loop
from app.services.vnpy.watchdog_service import watchdog_loop

logger = logging.getLogger(__name__)


async def deployment_sync_loop():
    """Phase 3B：周期扫描 vnpy 节点策略，反查 run_id，写 TrainingRecord.deployments。

    启动时立即跑一次，之后每 settings.deployment_sync_interval_seconds 跑一次。
    异常吞掉只 log warn，不影响主流程。
    """
    from app.models.database import get_db_session
    from app.services.app_settings_service import get_runtime_setting

    while True:
        try:
            client = get_vnpy_client()
            db_gen = get_db_session()
            db = next(db_gen)
            try:
                stats = await sync_deployments(db, client)
                if stats.get("scanned", 0) > 0:
                    logger.info("[deployment_sync] %s", stats)
            finally:
                with contextlib.suppress(Exception):
                    db.close()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("[deployment_sync] iteration failed: %s", exc)
        try:
            interval = max(
                60,
                int(
                    get_runtime_setting(
                        "deployment_sync_interval_seconds",
                        default=settings.deployment_sync_interval_seconds,
                    )
                ),
            )
            await asyncio.sleep(interval)
        except asyncio.CancelledError:
            raise


@asynccontextmanager
async def lifespan(app: FastAPI):
    # eager-build the multi-node client so any yaml / network issue surfaces at startup
    get_vnpy_client()

    # 注: 早期这里调 ml_metrics_backfill_service.backfill_all_strategies 兜底,
    # 但那是在 mlearnweb 端扫 D:\ml_output / D:\vnpy_data\... 自己算 IC 的
    # 误工实现 (违反"推理端算单日, 监控端跨天聚合"原则). vendor + vnpy_ml_strategy
    # IC 闭环已补全 (vnpy commit bc28425), 现在 IC 完全由推理端负责; mlearnweb
    # 启动后只需 historical_metrics_sync_loop 5min 一次 HTTP 拉到本地即可.

    equity_task = asyncio.create_task(snapshot_loop())
    ml_task = asyncio.create_task(ml_snapshot_loop())
    # 方案 §2.4.5 — 同步推理机回填的历史 IC 到 SQLite (5min 一次)
    hist_sync_task = asyncio.create_task(historical_metrics_sync_loop())
    # A1/B2 解耦 — 拉 vnpy 端本地 replay_history.db 的回放权益快照 (5min 一次)
    replay_equity_task = asyncio.create_task(replay_equity_sync_loop())
    # Phase 3B — 部署追踪扫描 (10min 一次)
    deployment_task = asyncio.create_task(deployment_sync_loop())
    # P1-3 Plan A — vnpy 节点 watchdog (默认 60s 探活, 连续 3 次 offline 发邮件)
    watchdog_task = asyncio.create_task(watchdog_loop())
    tasks = (
        equity_task, ml_task, hist_sync_task, replay_equity_task,
        deployment_task, watchdog_task,
    )
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()
        for task in tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await task
        await get_vnpy_client().close()


app = FastAPI(
    title="mlearnweb live trading API",
    description="实盘交易监控与控制 (vnpy multi-node client)",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# trigger WAL pragma + ensure tables exist (esp. strategy_equity_snapshots)
init_db()

app.include_router(live_trading.router)
app.include_router(ml_monitoring.router)


@app.get("/")
def root():
    return {
        "service": "mlearnweb live trading API",
        "version": "1.0.0",
        "docs": "/docs",
        "endpoints": {
            "nodes": "/api/live-trading/nodes",
            "strategies": "/api/live-trading/strategies",
        },
    }


@app.get("/health")
def health_check():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8100, reload=True)
