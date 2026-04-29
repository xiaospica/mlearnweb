from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.models.database import get_db_session
from app.services.experiment_service import ExperimentService
from app.services.run_cleanup_service import (
    list_unlinked_runs,
    soft_delete_runs,
)
from app.schemas.schemas import (
    ApiResponse,
    ExperimentListResponse,
    RunCleanupRequest,
    RunCleanupResponse,
)

router = APIRouter(prefix="/api/experiments", tags=["experiments"])


@router.get("", response_model=ExperimentListResponse)
def list_experiments(
    search: str = Query("", description="按实验名搜索"),
):
    experiments = ExperimentService.list_experiments(search=search)
    return ExperimentListResponse(
        success=True,
        message=f"获取到 {len(experiments)} 个实验",
        data={"total": len(experiments), "items": experiments},
    )


@router.get("/{experiment_id}", response_model=ApiResponse)
def get_experiment(experiment_id: str):
    exp = ExperimentService.get_experiment(experiment_id)
    if not exp:
        return ApiResponse(success=False, message=f"实验 {experiment_id} 不存在", data=None)
    return ApiResponse(success=True, data=exp)


@router.get("/{experiment_id}/summary", response_model=ApiResponse)
def get_experiment_summary(experiment_id: str):
    summary = ExperimentService.get_experiment_summary(experiment_id)
    if not summary:
        return ApiResponse(success=False, message=f"实验 {experiment_id} 不存在", data=None)
    return ApiResponse(success=True, data=summary)


@router.get("/{experiment_id}/unlinked-runs", response_model=ApiResponse)
def get_unlinked_runs(
    experiment_id: str,
    db: Session = Depends(get_db_session),
):
    """列出当前实验中未被任何训练记录/调参/部署/在线监控引用的 run。

    供前端"清理未关联记录"Modal 弹窗预览使用，含估算磁盘大小。
    """
    data = list_unlinked_runs(db, experiment_id)
    return ApiResponse(success=True, data=data)


@router.post("/{experiment_id}/runs/cleanup", response_model=RunCleanupResponse)
def cleanup_runs(
    experiment_id: str,
    payload: RunCleanupRequest,
    db: Session = Depends(get_db_session),
):
    """软删 run：把目录从 mlruns/{exp_id}/{run_id}/ 移到 mlruns/.trash/{exp_id}/{run_id}/。

    - select="all_unlinked"：后端重新扫描未关联 run 后批量删，忽略 run_ids
    - select="manual"：按传入 run_ids 删，后端会再做一次保护校验
    回收站可由用户手动 ``rm -rf mlruns/.trash`` 真正释放磁盘。
    """
    if payload.select == "all_unlinked":
        unlinked = list_unlinked_runs(db, experiment_id)
        target_run_ids = [item["run_id"] for item in unlinked.get("items", [])]
    else:
        target_run_ids = payload.run_ids or []

    result = soft_delete_runs(db, experiment_id, target_run_ids)
    deleted_count = len(result.get("deleted", []))
    skipped_count = len(result.get("skipped", []))
    failed_count = len(result.get("failed", []))
    return RunCleanupResponse(
        success=True,
        message=(
            f"已软删 {deleted_count} 个 run；跳过 {skipped_count}（受保护）；"
            f"失败 {failed_count}。释放 {result.get('freed_bytes', 0)} 字节。"
        ),
        data=result,
    )
