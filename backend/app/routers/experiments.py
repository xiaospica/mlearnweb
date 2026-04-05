from fastapi import APIRouter, Query

from app.services.experiment_service import ExperimentService
from app.schemas.schemas import ExperimentListResponse, ApiResponse

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
