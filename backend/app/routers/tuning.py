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
import os
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
    TuningJobUpdateRequest,
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


@router.patch("/jobs/{job_id}", response_model=ApiResponse)
def update_tuning_job(
    job_id: int,
    body: TuningJobUpdateRequest,
    db: Session = Depends(get_db_session),
):
    """V3.7: 重命名 + 编辑描述。"""
    job = _get_job_or_404(db, job_id)
    if body.name is not None:
        job.name = body.name.strip()
    if body.description is not None:
        job.description = body.description.strip() or None
    db.commit()
    db.refresh(job)
    return ApiResponse(success=True, message="已更新", data=_job_to_response(job))


@router.delete("/jobs/{job_id}", response_model=ApiResponse)
def delete_tuning_job(job_id: int, db: Session = Depends(get_db_session)):
    """全量删除调参 job：DB 行 + workdir + 关联训练记录 + mlflow 物理文件.

    清理顺序：
        1. 收集 trials 的 run_id → 反查 training_run_mappings → training_record_ids
        2. 收集这些 record 的全部 run_ids（5 期）+ experiment_id
        3. 删 training_records（DB CASCADE 自动删 training_run_mappings）
        4. 删 tuning_job（DB CASCADE 自动删 tuning_trials）
        5. 删 workdir（trials.csv / overrides / optuna_study.db 等）
        6. 删 mlflow run 物理目录（mlruns/<exp>/<run_id>/）

    步骤 1 必须在 step 4 之前执行（CASCADE 删 trials 后就拿不到 run_id 了）。
    workdir + mlflow 文件清理放在 DB commit 后，文件删除失败不影响 DB 一致性。
    """
    import shutil
    from pathlib import Path
    from app.models.database import TrainingRecord, TrainingRunMapping

    job = _get_job_or_404(db, job_id)
    if job.status in ("running", "searching", "finalizing"):
        if tuning_service.is_pid_alive(job.pid, job.pid_started_at):
            raise HTTPException(
                status_code=409,
                detail="job 还在运行，请先调 /cancel",
            )
        # 进程死了但 status 没更新，自动 zombie
        job.status = "zombie"

    workdir = Path(job.workdir) if job.workdir else None

    # ---- 1. 通过 trial.run_id 反查关联的 training_records ----
    trial_run_ids = [t.run_id for t in job.trials if t.run_id]
    record_ids: set[int] = set()
    if trial_run_ids:
        mappings = (
            db.query(TrainingRunMapping)
            .filter(TrainingRunMapping.run_id.in_(trial_run_ids))
            .all()
        )
        for m in mappings:
            record_ids.add(m.training_record_id)

    # ---- 2. 收集这些 records 的所有 run_ids + experiment_id（删 mlflow 物理文件用）----
    mlflow_runs_to_delete: list[tuple[str, str]] = []  # (experiment_id, run_id)
    for rid in record_ids:
        rec = db.query(TrainingRecord).filter(TrainingRecord.id == rid).first()
        if not rec:
            continue
        all_mappings = (
            db.query(TrainingRunMapping)
            .filter(TrainingRunMapping.training_record_id == rid)
            .all()
        )
        for m in all_mappings:
            mlflow_runs_to_delete.append((rec.experiment_id, m.run_id))

    # ---- 3. 删 training_records（CASCADE 删 mappings）----
    deleted_records = 0
    for rid in record_ids:
        rec = db.query(TrainingRecord).filter(TrainingRecord.id == rid).first()
        if rec:
            db.delete(rec)
            deleted_records += 1

    # ---- 4. 删 tuning_job（CASCADE 删 tuning_trials）----
    db.delete(job)
    db.commit()

    # ---- 5. 删 workdir ----
    if workdir and workdir.is_dir():
        try:
            shutil.rmtree(workdir)
        except OSError as exc:
            print(f"[Tuning] WARN: 删 workdir 失败: {exc}")

    # ---- 6. 删 mlflow run 物理目录 ----
    mlruns_root = Path(
        os.environ.get(
            "MLRUNS_ROOT",
            r"F:\Quant\code\qlib_strategy_dev\mlruns",
        )
    )
    deleted_mlflow = 0
    for exp_id, run_id in mlflow_runs_to_delete:
        mlrun_dir = mlruns_root / exp_id / run_id
        if mlrun_dir.is_dir():
            try:
                shutil.rmtree(mlrun_dir)
                deleted_mlflow += 1
            except OSError as exc:
                print(f"[Tuning] WARN: 删 mlflow run {run_id} 失败: {exc}")

    print(
        f"[Tuning] deleted job {job_id}: "
        f"{deleted_records} training_records, {deleted_mlflow} mlflow runs, workdir cleaned"
    )
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
    """V3.7: 对选中 trial 创建衍生验证 job（不再 inplace 跑子进程）.

    返回 new_job_id；前端跳转到 /workbench/jobs/<new_job_id> 查看进度。
    源 job 的"跨期验证"Tab 改为列出所有衍生 job（GET /derived）。
    """
    source_job = _get_job_or_404(db, job_id)
    if source_job.status not in ("done", "cancelled", "failed", "zombie"):
        raise HTTPException(
            status_code=409,
            detail=f"源 job 状态 {source_job.status} 不允许创建验证 job；需先完成搜索",
        )
    try:
        derived = tuning_service.create_verification_job(
            db,
            source_job,
            trial_numbers=body.trial_numbers,
            custom_segments=[s.model_dump() for s in body.custom_segments],
            seed=body.seed,
            num_threads=body.num_threads,
            reproduce_seeds=body.reproduce_seeds,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    msg = (
        f"已创建衍生验证 job #{derived.id}（{len(body.trial_numbers)} trial × "
        f"{len(body.custom_segments)} 期"
        + (f" + reproduce {len(body.reproduce_seeds)} seed" if body.reproduce_seeds else "")
        + "）；正在跑子进程"
    )
    return ApiResponse(success=True, message=msg, data=_job_to_response(derived))


@router.get("/jobs/{job_id}/derived", response_model=ApiResponse)
def list_derived_jobs(job_id: int, db: Session = Depends(get_db_session)):
    """V3.7: 列出某 source job 的全部衍生验证 job（按创建时间倒序）。"""
    _get_job_or_404(db, job_id)  # 确保 source 存在
    derived = tuning_service.get_derived_jobs(db, job_id)
    return ApiResponse(
        success=True,
        data={
            "parent_job_id": job_id,
            "items": [_job_to_response(d) for d in derived],
        },
    )


@router.get("/jobs/{job_id}/walk-forward-results", response_model=ApiResponse)
def get_walk_forward_results(job_id: int, db: Session = Depends(get_db_session)):
    """读 walk_forward.csv + reproduce.csv（如有）返聚合 JSON.

    V3.7: 此 endpoint 应该在【衍生验证 job】上调用（job 是验证 job 自己）。
    """
    job = _get_job_or_404(db, job_id)
    return ApiResponse(success=True, data=tuning_service.get_walk_forward_results(job))


@router.get("/jobs/{job_id}/walk-forward-log", response_model=ApiResponse)
def get_walk_forward_log(
    job_id: int,
    tail_bytes: int = Query(16384, ge=512, le=1048576),
    db: Session = Depends(get_db_session),
):
    """读衍生验证 job 的 walk_forward.stdout.log 末尾。"""
    job = _get_job_or_404(db, job_id)
    text = tuning_service.get_walk_forward_log(job, tail_bytes=tail_bytes)
    return ApiResponse(success=True, data={"job_id": job.id, "text": text})


@router.get("/jobs/{job_id}/param-importance", response_model=ApiResponse)
def get_param_importance(job_id: int, db: Session = Depends(get_db_session)):
    """V3.8: 用 Optuna fANOVA 算各 search_space 参数对 valid_sharpe 的贡献度。"""
    job = _get_job_or_404(db, job_id)
    return ApiResponse(success=True, data=tuning_service.get_param_importance(job))


@router.get("/jobs/{job_id}/deployment-manifest", response_model=ApiResponse)
def get_deployment_manifest(job_id: int, db: Session = Depends(get_db_session)):
    """V3.9: 只读返回部署 manifest（mlflow_run_id / bundle_dir / experiment_id 等）.

    供前端"跳转部署页"流程预填字段（不调用 vnpy，不创建实例）。
    """
    job = _get_job_or_404(db, job_id)
    try:
        manifest = tuning_service._build_deployment_manifest(db, job)
        return ApiResponse(success=True, data=manifest)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


# ---------------------------------------------------------------------------
# Finalize / 部署
# ---------------------------------------------------------------------------


@router.post("/jobs/{job_id}/finalize", response_model=ApiResponse)
def finalize_tuning_job(
    job_id: int,
    body: TuningFinalizeRequest,
    db: Session = Depends(get_db_session),
):
    """V3.5 零成本 finalize：把 trial 已有的 training_record 挂到 job 上。

    搜索过程每个 trial subprocess 已经创建了独立 training_record（含 SHAP /
    收益曲线 / IC 分析等完整 artifact），finalize 不再重新训练，只需要
    通过 trial.run_id 反查 training_run_mappings 拿到 record_id。

    用户视角：点 Finalize → 立即返回 → 跳训练记录页查看完整训练成果。
    """
    job = _get_job_or_404(db, job_id)

    try:
        record_id = tuning_service.finalize_job(
            db, job, trial_number=body.trial_number,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    return ApiResponse(
        success=True,
        message=f"已索引到现有训练记录 #{record_id}",
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

    try:
        result = tuning_service.deploy_job_to_vnpy(
            db,
            job,
            node_id=body.node_id,
            engine=body.engine,
            class_name=body.class_name,
            strategy_name=body.strategy_name,
            vt_symbol=body.vt_symbol,
            setting_overrides=body.setting_overrides,
        )
    except ValueError as exc:
        # 业务校验错误（job 没 finalize / record 不存在等）
        raise HTTPException(status_code=400, detail=str(exc))
    except RuntimeError as exc:
        # vnpy 节点不可达（V3.6 retry 3 次后仍失败）
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=502,
            detail=f"调 vnpy 后端失败（未预期的错误）: {exc}",
        )

    return ApiResponse(
        success=True,
        message="已转调 vnpy create_strategy",
        data=result,
    )
