from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError

from app.core.config import settings
from app.models.database import init_db
from app.routers import experiments, runs, reports, training_records

app = FastAPI(
    title="QLib Backtest Dashboard API",
    description="量化回测结果可视化看板后端API",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
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

app.include_router(experiments.router)
app.include_router(runs.router)
app.include_router(reports.router)
app.include_router(training_records.router)


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
        },
    }


@app.get("/health")
def health_check():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000, reload=True)
