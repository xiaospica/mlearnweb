import matplotlib
matplotlib.use('Agg')

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.exceptions import RequestValidationError

from app.core.config import settings
from app.models.database import init_db, get_db_session
from app.routers import experiments, runs, reports, training_records, factor_docs, training_record_images, tuning


@asynccontextmanager
async def lifespan(app: FastAPI):
    """启动时执行 tuning 孤儿恢复（防 --reload 重启留下的僵尸 job）"""
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
    yield


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


@app.on_event("startup")
def _reconcile_tuning_orphans_on_startup():
    """FastAPI 重启时扫描所有 status=running 的 tuning job，pid 不存在则置 zombie。

    防止后端 --reload 重启后留下的孤儿状态污染前端 UI。
    """
    try:
        from app.services.tuning_service import reconcile_orphans
        from app.models.database import get_db_session
        db = next(get_db_session())
        try:
            stats = reconcile_orphans(db)
            print(f"[Startup] tuning orphan reconcile: {stats}")
        finally:
            db.close()
    except Exception as exc:
        print(f"[Startup] tuning orphan reconcile failed (非阻塞): {exc}")


@app.get("/")
def root():
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
        },
    }


@app.get("/health")
def health_check():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000, reload=True)
