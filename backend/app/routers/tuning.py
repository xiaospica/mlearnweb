"""调参工作台路由（auto_tune 集成到 mlearnweb 前端）.

12 个 endpoint:
    POST   /api/tuning/jobs                        创建 job
    GET    /api/tuning/jobs                        列表
    GET    /api/tuning/jobs/{id}                   详情（job + trials 摘要）
    DELETE /api/tuning/jobs/{id}                   删除（仅 done/cancelled/failed/zombie 允许）
    POST   /api/tuning/jobs/{id}/start             启动 subprocess
    POST   /api/tuning/jobs/{id}/cancel            优雅取消
    GET    /api/tuning/jobs/{id}/trials            trial 列表（按 valid_sharpe 降序）
    GET    /api/tuning/jobs/{id}/progress          轻量进度（用于轮询）
    GET    /api/tuning/jobs/{id}/events            SSE 实时事件流
    GET    /api/tuning/jobs/{id}/logs              subprocess 日志末尾
    POST   /api/tuning/jobs/{id}/finalize          用 best trial 跑正式训练（写 training_records）
    POST   /api/tuning/jobs/{id}/deploy            一键部署到 vnpy 实盘（V2，目前仅占位）
"""

from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.database import TuningJob, TuningTrial, get_db_session
from app.schemas.schemas import (
    ApiResponse,
    TuningJobCreate,
    TuningJobResponse,
    TuningTrialResponse,
    TuningProgressResponse,
    TuningFinalizeRequest,
    TuningDeployRequest,
    TuningQueueReorderRequest,
    TuningWalkForwardRequest,
)
from app.services import tuning_service


router = APIRouter(prefix="/api/tuning", tags=["tuning"])


# ---------------------------------------------------------------------------
# 工具
# ---------------------------------------------------------------------------


def _job_to_response(job: TuningJob) -> Dict[str, Any]:
    return TuningJobResponse.model_validate(job).model_dump(mode="json")


def _trial_to_response(trial: TuningTrial) -> Dict[str, Any]:
    return TuningTrialResponse.model_validate(trial).model_dump(mode="json")


def _get_job_or_404(db: Session, job_id: int) -> TuningJob:
    job = db.query(TuningJob).filter(TuningJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail=f"tuning job {job_id} 不存在")
    return job


# ---------------------------------------------------------------------------
# Job 生命周期
# ---------------------------------------------------------------------------


@router.post("/jobs", response_model=ApiResponse)
def create_tuning_job(body: TuningJobCreate, db: Session = Depends(get_db_session)):
    """创建调参 job（仅入库，不启动 subprocess；调 /start 才启动）.

    V3.3: body.enqueue=True 时创建后立即入队，由后台 scheduler 在 runner
    空闲时自动启动；start_* 字段同时持久化到 job 行，确保 scheduler 能
    用与手动启动一致的运行参数。
    """
    study_name = f"workbench_job_{int(time.time() * 1000)}"
    job = TuningJob(
        name=body.name,
        description=body.description,
        status="created",
        search_mode=body.search_mode,
        config_snapshot=body.config_snapshot,
        optuna_study_name=study_name,
        optuna_study_db_path="",  # start 时填
        workdir="",  # start 时填
        n_trials_target=body.n_trials,
        start_n_jobs=body.n_jobs,
        start_num_threads=body.num_threads,
        start_seed=body.seed,
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    enqueued = False
    if body.enqueue:
        tuning_service.enqueue_job(db, job)
        enqueued = True

    msg = (
        f"调参 job 已创建 (id={job.id}) 并入队 (queue_position={job.queue_position})"
        if enqueued
        else f"调参 job 已创建 (id={job.id})"
    )
    return ApiResponse(success=True, message=msg, data=_job_to_response(job))


@router.get("/jobs", response_model=ApiResponse)
def list_tuning_jobs(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    status: Optional[str] = Query(None),
    db: Session = Depends(get_db_session),
):
    q = db.query(TuningJob).order_by(TuningJob.id.desc())
    if status:
        q = q.filter(TuningJob.status == status)
    total = q.count()
    items = q.offset((page - 1) * page_size).limit(page_size).all()
    return ApiResponse(
        success=True,
        data={
            "total": total,
            "page": page,
            "page_size": page_size,
            "items": [_job_to_response(j) for j in items],
        },
    )


@router.get("/jobs/{job_id}", response_model=ApiResponse)
def get_tuning_job(job_id: int, db: Session = Depends(get_db_session)):
    job = _get_job_or_404(db, job_id)
    # 拉触发一次状态对账（使 status / trial 计数 / best 都最新）
    tuning_service.reconcile_job_status(db, job)
    return ApiResponse(success=True, data=_job_to_response(job))


@router.delete("/jobs/{job_id}", response_model=ApiResponse)
def delete_tuning_job(job_id: int, db: Session = Depends(get_db_session)):
    job = _get_job_or_404(db, job_id)
    if job.status in ("running", "searching", "finalizing"):
        if tuning_service.is_pid_alive(job.pid, job.pid_started_at):
            raise HTTPException(
                status_code=409,
                detail="job 还在运行，请先调 /cancel",
            )
        # 进程死了但 status 没更新，自动 zombie
        job.status = "zombie"
    db.delete(job)
    db.commit()
    return ApiResponse(success=True, message=f"job {job_id} 已删除")


@router.post("/jobs/{job_id}/start", response_model=ApiResponse)
def start_tuning_job(
    job_id: int,
    n_jobs: int = Query(1, ge=1, le=4),
    num_threads: int = Query(20, ge=1, le=64),
    seed: int = Query(42, ge=0),
    db: Session = Depends(get_db_session),
):
    job = _get_job_or_404(db, job_id)
    if job.status not in ("created", "cancelled", "failed", "zombie", "done"):
        raise HTTPException(
            status_code=409,
            detail=f"job 状态 {job.status} 不允许启动；仅 created/cancelled/failed/zombie/done 可重启",
        )
    job = tuning_service.start_job_subprocess(
        db, job, n_jobs=n_jobs, num_threads=num_threads, seed=seed
    )
    return ApiResponse(
        success=True,
        message=f"job {job.id} 已启动 pid={job.pid}",
        data=_job_to_response(job),
    )


@router.post("/jobs/{job_id}/cancel", response_model=ApiResponse)
def cancel_tuning_job(job_id: int, db: Session = Depends(get_db_session)):
    job = _get_job_or_404(db, job_id)
    job = tuning_service.cancel_job_subprocess(db, job)
    return ApiResponse(
        success=True,
        message=f"job {job_id} 已取消",
        data=_job_to_response(job),
    )


# ---------------------------------------------------------------------------
# V3.3 队列调度（搜索任务 queue：晚上批量提交，scheduler 串行自动跑）
# ---------------------------------------------------------------------------


@router.get("/queue", response_model=ApiResponse)
def get_queue(db: Session = Depends(get_db_session)):
    """返回当前队列里的全部 job（按 queue_position ASC）+ runner 状态。"""
    queued = tuning_service.get_queued_jobs(db)
    busy = tuning_service._runner_busy(db)
    return ApiResponse(
        success=True,
        data={
            "items": [_job_to_response(j) for j in queued],
            "runner_busy": _job_to_response(busy) if busy else None,
        },
    )


@router.post("/jobs/{job_id}/enqueue", response_model=ApiResponse)
def enqueue_tuning_job(job_id: int, db: Session = Depends(get_db_session)):
    """把指定 job 加入队尾。"""
    job = _get_job_or_404(db, job_id)
    try:
        job = tuning_service.enqueue_job(db, job)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    return ApiResponse(
        success=True,
        message=f"job {job_id} 入队 (queue_position={job.queue_position})",
        data=_job_to_response(job),
    )


@router.post("/jobs/{job_id}/dequeue", response_model=ApiResponse)
def dequeue_tuning_job(job_id: int, db: Session = Depends(get_db_session)):
    """把指定 job 移出队列（不影响其 status）。"""
    job = _get_job_or_404(db, job_id)
    job = tuning_service.dequeue_job(db, job)
    return ApiResponse(
        success=True,
        message=f"job {job_id} 已移出队列",
        data=_job_to_response(job),
    )


@router.post("/queue/reorder", response_model=ApiResponse)
def reorder_queue(
    body: TuningQueueReorderRequest, db: Session = Depends(get_db_session)
):
    """按 body.job_ids 顺序重排队列（全量替换语义）。"""
    try:
        jobs = tuning_service.reorder_queue(db, body.job_ids)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return ApiResponse(
        success=True,
        message=f"已重排队列（{len(jobs)} 项）",
        data={"items": [_job_to_response(j) for j in jobs]},
    )


# ---------------------------------------------------------------------------
# Trial / 进度 / 日志
# ---------------------------------------------------------------------------


@router.get("/jobs/{job_id}/trials", response_model=ApiResponse)
def list_tuning_trials(
    job_id: int,
    sort_by: str = Query("valid_sharpe", pattern="^(valid_sharpe|test_sharpe|trial_number)$"),
    desc: bool = Query(True),
    only_completed: bool = Query(False),
    db: Session = Depends(get_db_session),
):
    job = _get_job_or_404(db, job_id)
    # 触发一次 csv → DB 同步，确保拉到最新
    tuning_service.reconcile_job_status(db, job)
    q = db.query(TuningTrial).filter(TuningTrial.tuning_job_id == job.id)
    if only_completed:
        q = q.filter(TuningTrial.state == "completed")
    sort_col = getattr(TuningTrial, sort_by)
    q = q.order_by(sort_col.desc().nulls_last() if desc else sort_col.asc().nulls_last())
    trials = q.all()
    return ApiResponse(
        success=True,
        data={
            "job_id": job.id,
            "total": len(trials),
            "items": [_trial_to_response(t) for t in trials],
        },
    )


@router.get("/jobs/{job_id}/progress", response_model=ApiResponse)
def get_tuning_progress(job_id: int, db: Session = Depends(get_db_session)):
    job = _get_job_or_404(db, job_id)
    progress = tuning_service.get_job_progress(db, job)
    return ApiResponse(success=True, data=progress)


@router.get("/jobs/{job_id}/logs", response_model=ApiResponse)
def get_tuning_logs(
    job_id: int,
    tail_bytes: int = Query(16384, ge=512, le=1048576),
    source: str = Query("tuning", pattern="^(tuning|stdout|all)$"),
    db: Session = Depends(get_db_session),
):
    job = _get_job_or_404(db, job_id)
    text = tuning_service.get_log_tail(job, tail_bytes=tail_bytes, source=source)
    return ApiResponse(
        success=True,
        data={
            "job_id": job.id,
            "log_path": job.log_path,
            "source": source,
            "text": text,
        },
    )


@router.get("/jobs/{job_id}/events")
async def tuning_job_events(job_id: int, db: Session = Depends(get_db_session)):
    """SSE 实时事件流。

    实现策略：服务端每秒检查 progress，有变化时 push。
    用 FastAPI 原生 StreamingResponse（避免 sse-starlette 新依赖）。
    """
    job = _get_job_or_404(db, job_id)
    job_id_local = job.id

    async def event_stream():
        last_done = -1
        last_status = ""
        idle_count = 0
        # 推送初始 progress
        yield f"event: hello\ndata: {json.dumps({'job_id': job_id_local})}\n\n"
        while True:
            # 重新拿 db session（避免事件流持有长连接 session）
            from app.models.database import get_db_session as _get_db
            db2 = next(_get_db())
            try:
                j = db2.query(TuningJob).filter(TuningJob.id == job_id_local).first()
                if not j:
                    yield f"event: error\ndata: {json.dumps({'msg': 'job 不存在'})}\n\n"
                    break
                progress = tuning_service.get_job_progress(db2, j)
                changed = (
                    progress["n_trials_done"] != last_done
                    or progress["status"] != last_status
                )
                if changed:
                    yield f"event: progress\ndata: {json.dumps(progress, default=str)}\n\n"
                    last_done = progress["n_trials_done"]
                    last_status = progress["status"]
                    idle_count = 0
                else:
                    idle_count += 1
                    # 30 秒没更新发个心跳防止前端超时
                    if idle_count >= 30:
                        yield f": heartbeat\n\n"
                        idle_count = 0
                # 终态退出
                if progress["status"] in ("done", "cancelled", "failed", "zombie"):
                    yield f"event: end\ndata: {json.dumps(progress, default=str)}\n\n"
                    break
            finally:
                db2.close()
            await asyncio.sleep(1.0)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # nginx 禁用缓冲
        },
    )


# ---------------------------------------------------------------------------
# V3.4 跨期验证 + 多 seed 复跑（post-search 验证）
# ---------------------------------------------------------------------------


@router.post("/jobs/{job_id}/walk-forward", response_model=ApiResponse)
def start_walk_forward(
    job_id: int,
    body: TuningWalkForwardRequest,
    db: Session = Depends(get_db_session),
):
    """对选中的 N 个 trial 启动跨期 walk_forward（+ 可选 multi-seed reproduce）。

    复用既有 finalize_best.walk_forward / reproduce CLI（只在前面套了一层
    post_search_runner 串行执行器），不重复实现跨期逻辑。

    要求 job 已完成搜索（done/cancelled/failed/zombie）；trial_numbers 内每个
    trial 必须存在于 tuning_trials 表（CSV 解析时会校验）。
    """
    job = _get_job_or_404(db, job_id)
    if job.status not in ("done", "cancelled", "failed", "zombie"):
        raise HTTPException(
            status_code=409,
            detail=f"job 状态 {job.status} 不允许启动跨期验证；需先完成搜索",
        )
    try:
        result = tuning_service.start_walk_forward_subprocess(
            db,
            job,
            trial_numbers=body.trial_numbers,
            seed=body.seed,
            num_threads=body.num_threads,
            reproduce_seeds=body.reproduce_seeds,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    msg = (
        f"已启动 walk_forward 子进程（{len(body.trial_numbers)} trial × seed={body.seed}）"
        + (f" + reproduce ({len(body.reproduce_seeds)} seed)" if body.reproduce_seeds else "")
    )
    return ApiResponse(success=True, message=msg, data=result)


@router.get("/jobs/{job_id}/walk-forward-results", response_model=ApiResponse)
def get_walk_forward_results(job_id: int, db: Session = Depends(get_db_session)):
    """读 walk_forward.csv + reproduce.csv（如有）返聚合 JSON。

    前端用此作为轮询入口，配合 GET /walk-forward-log 查看实时日志。
    """
    job = _get_job_or_404(db, job_id)
    return ApiResponse(success=True, data=tuning_service.get_walk_forward_results(job))


@router.get("/jobs/{job_id}/walk-forward-log", response_model=ApiResponse)
def get_walk_forward_log(
    job_id: int,
    tail_bytes: int = Query(16384, ge=512, le=1048576),
    db: Session = Depends(get_db_session),
):
    """读 walk_forward.stdout.log 末尾。"""
    job = _get_job_or_404(db, job_id)
    text = tuning_service.get_walk_forward_log(job, tail_bytes=tail_bytes)
    return ApiResponse(success=True, data={"job_id": job.id, "text": text})


# ---------------------------------------------------------------------------
# Finalize / 部署
# ---------------------------------------------------------------------------


@router.post("/jobs/{job_id}/finalize", response_model=ApiResponse)
def finalize_tuning_job(
    job_id: int,
    body: TuningFinalizeRequest,
    db: Session = Depends(get_db_session),
):
    """用指定 trial 的超参跑一次正式训练，写入 training_records 表。

    与命令行训练 100% 同链路：调 tushare_hs300_rolling_train.py +
    --training-record-id 参数，让 RollingPipeline.DashboardRecorder 在 batch
    模式下追加 run mapping，结果在 / (TrainingRecordsPage) 自然显示。
    """
    job = _get_job_or_404(db, job_id)
    if job.status not in ("done", "cancelled"):
        raise HTTPException(
            status_code=409,
            detail=f"job 状态 {job.status} 不允许 finalize；需先完成搜索（status={job.status}）",
        )

    try:
        record_id = tuning_service.finalize_job(
            db,
            job,
            trial_number=body.trial_number,
            seed=body.seed,
            name=body.name,
            description=body.description,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    return ApiResponse(
        success=True,
        message=f"已启动 finalize 训练，training_record_id={record_id}",
        data={
            "tuning_job_id": job.id,
            "training_record_id": record_id,
            "trial_number": body.trial_number,
        },
    )


@router.post("/jobs/{job_id}/deploy", response_model=ApiResponse)
def deploy_tuning_job(
    job_id: int,
    body: TuningDeployRequest,
    db: Session = Depends(get_db_session),
):
    """从工作台一键部署到 vnpy 实盘。

    前提：job 必须已 finalize 完成（生成 deployment_manifest.json）。
    内部读 manifest 组装 vnpy setting，转调既有 POST /api/live-trading/strategies/{node_id}/{engine}.
    """
    job = _get_job_or_404(db, job_id)
    if not job.finalized_training_record_id:
        raise HTTPException(
            status_code=409,
            detail="job 尚未 finalize；请先调 /finalize 完成正式训练",
        )

    # 从 X-Ops-Password header 透传到 vnpy 后端
    from fastapi import Header as _Header  # 延迟导入避免顶部依赖

    try:
        result = tuning_service.deploy_job_to_vnpy(
            job,
            node_id=body.node_id,
            engine=body.engine,
            class_name=body.class_name,
            strategy_name=body.strategy_name,
            vt_symbol=body.vt_symbol,
            setting_overrides=body.setting_overrides,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=502,
            detail=f"调 vnpy 后端失败: {exc}",
        )

    return ApiResponse(
        success=True,
        message="已转调 vnpy create_strategy",
        data=result,
    )
