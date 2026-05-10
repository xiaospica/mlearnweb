import matplotlib
matplotlib.use('Agg')

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.config import settings
from app.models.database import init_db, get_db_session
from app.routers import experiments, runs, reports, training_records, factor_docs, training_record_images, tuning, settings as settings_router, joinquant_exports
from app.routers import _live_proxy

logger = logging.getLogger(__name__)


class SPAStaticFiles(StaticFiles):
    """StaticFiles with React Router history fallback.

    Starlette's ``html=True`` serves ``index.html`` for directory requests, but
    it does not automatically map arbitrary client routes such as
    ``/live-trading`` back to the SPA entrypoint. Keep normal static file
    serving first, then fall back to ``index.html`` only for non-API paths.
    """

    _fallback_excluded_prefixes = (
        "api/",
        "docs",
        "redoc",
        "openapi.json",
    )

    async def get_response(self, path: str, scope):
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            request_path = str(scope.get("path") or "")
            if (
                exc.status_code != 404
                or self._is_fallback_excluded(path)
                or self._is_fallback_excluded(request_path)
            ):
                raise
            return await super().get_response("index.html", scope)

    @classmethod
    def _is_fallback_excluded(cls, path: str) -> bool:
        normalized = path.lstrip("/")
        return any(
            normalized == prefix.rstrip("/") or normalized.startswith(prefix)
            for prefix in cls._fallback_excluded_prefixes
        )


@asynccontextmanager
async def lifespan(app: FastAPI):
    """启动时执行 tuning 孤儿恢复 + 启动队列 scheduler 后台 task。"""
    import asyncio

    # 1) 孤儿恢复（防 --reload 重启留下的僵尸 job）
    try:
        from app.services.tuning_service import reconcile_orphans
        db = next(get_db_session())
        try:
            stats = reconcile_orphans(db)
            print(f"[Startup] tuning orphan reconcile: {stats}")
        finally:
            db.close()
    except Exception as exc:
        print(f"[Startup] tuning orphan reconcile failed (non-fatal): {exc}")

    # 2) 队列 scheduler（V3.3）：每 30s 检查一次，runner 空闲且有队首时自动启动
    scheduler_task: "asyncio.Task | None" = None
    try:
        from app.services import tuning_service
        if tuning_service.is_tuning_enabled():
            scheduler_task = asyncio.create_task(
                tuning_service.queue_scheduler_loop(get_db_session, interval_sec=30.0)
            )
            print("[Startup] tuning queue scheduler started")
        else:
            print("[Startup] tuning disabled; queue scheduler not started")
    except Exception as exc:
        print(f"[Startup] tuning queue scheduler failed to start (non-fatal): {exc}")

    try:
        yield
    finally:
        if scheduler_task is not None:
            scheduler_task.cancel()
            try:
                await scheduler_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            print("[Shutdown] tuning queue scheduler stopped")
        # W4.1 — 释放 live-proxy 的 httpx connection pool
        try:
            await _live_proxy.close_proxy_client()
        except Exception:
            pass


app = FastAPI(
    title="QLib Backtest Dashboard API",
    description="量化回测结果可视化看板后端API",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
    lifespan=lifespan,
)


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    print(f"[ERROR] RequestValidationError: {exc.errors()}")
    return JSONResponse(
        status_code=422,
        content={"detail": exc.errors()},
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

init_db()

app.mount("/uploads", StaticFiles(directory=str(settings.upload_dir)), name="uploads")

app.include_router(experiments.router)
app.include_router(runs.router)
app.include_router(reports.router)
app.include_router(training_records.router)
app.include_router(training_record_images.router)
app.include_router(factor_docs.router)
app.include_router(tuning.router)
app.include_router(settings_router.router)
app.include_router(joinquant_exports.router)
# W4.1 — /api/live-trading/* 反代到 mlearnweb_live (8100). 必须挂在
# include_router 完成 (research 侧 API 优先) + 在 StaticFiles 之前 (catch-all
# / SPA fallback 不能吞 API).
app.include_router(_live_proxy.router)


@app.get("/")
def root():
    """Serve SPA index in production, otherwise return API root info.

    Starlette routes are evaluated in registration order. Because this exact
    "/" API route is registered before the catch-all StaticFiles mount below,
    a configured frontend dist would otherwise still return the JSON API root
    for http://host:8000/. Explicitly serve index.html here when production
    frontend assets are available.
    """
    if settings.frontend_dist_dir:
        index_path = Path(settings.frontend_dist_dir) / "index.html"
        if index_path.is_file():
            return FileResponse(index_path)
    return {
        "service": "QLib Backtest Dashboard API",
        "version": "1.0.0",
        "docs": "/docs",
        "endpoints": {
            "experiments": "/api/experiments",
            "runs": "/api/runs?exp_id=xxx",
            "reports": "/api/runs/{run_id}/report?exp_id=xxx",
            "training_records": "/api/training-records",
            "tuning": "/api/tuning/jobs",
            "live_trading_proxy": "/api/live-trading/* → :8100",
        },
    }


@app.get("/health")
def health_check():
    from app.services.health_service import deployment_health

    return deployment_health()


# W4.1 — 单端口生产部署: 把前端 dist mount 在 / (api 路由 + 反代之后).
# StaticFiles(html=True) 自动处理 SPA 模式 (任何 404 路径返 index.html 让
# react-router 接管). 留 None / 路径不存在时跳过, 浏览器走 Vite dev server.
_dist_dir = settings.frontend_dist_dir
if _dist_dir:
    _dist_path = Path(_dist_dir)
    if _dist_path.is_dir():
        # name="frontend" 与 /uploads 错开避免 starlette 重复 mount 警告.
        app.mount("/", SPAStaticFiles(directory=str(_dist_path), html=True), name="frontend")
        logger.info("[main] frontend dist mounted: %s", _dist_path)
    else:
        logger.warning(
            "[main] frontend_dist_dir 配了但路径不存在, 跳过 mount: %s",
            _dist_path,
        )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000, reload=True)
