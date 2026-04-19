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
from app.services.vnpy.client import get_vnpy_client
from app.services.vnpy.live_trading_service import snapshot_loop
from app.services.vnpy.ml_monitoring_service import ml_snapshot_loop

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # eager-build the multi-node client so any yaml / network issue surfaces at startup
    get_vnpy_client()
    equity_task = asyncio.create_task(snapshot_loop())
    ml_task = asyncio.create_task(ml_snapshot_loop())
    try:
        yield
    finally:
        for task in (equity_task, ml_task):
            task.cancel()
        for task in (equity_task, ml_task):
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
