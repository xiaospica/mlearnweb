from fastapi import APIRouter, Query

from app.services.report_service import ReportService
from app.schemas.schemas import ReportDataResponse, ChartDataResponse, ApiResponse

router = APIRouter(prefix="/api/runs", tags=["reports"])


@router.get("/{run_id}/report", response_model=ReportDataResponse)
def get_full_report(
    run_id: str,
    exp_id: str = Query(..., description="实验ID"),
):
    report = ReportService.get_full_report(exp_id, run_id)
    if "error" in report:
        return ReportDataResponse(success=False, message=report["error"], data=report)
    return ReportDataResponse(success=True, data=report)


@router.get("/{run_id}/charts/portfolio", response_model=ChartDataResponse)
def get_portfolio_chart_data(
    run_id: str,
    exp_id: str = Query(..., description="实验ID"),
):
    data = ReportService._get_portfolio_chart_data(exp_id, run_id)
    return ChartDataResponse(success=True, data=data)


@router.get("/{run_id}/charts/ic", response_model=ChartDataResponse)
def get_ic_chart_data(
    run_id: str,
    exp_id: str = Query(..., description="实验ID"),
):
    data = ReportService._get_ic_chart_data(exp_id, run_id)
    return ChartDataResponse(success=True, data=data)


@router.get("/{run_id}/charts/risk", response_model=ChartDataResponse)
def get_risk_chart_data(
    run_id: str,
    exp_id: str = Query(..., description="实验ID"),
):
    data = ReportService._get_risk_metrics(exp_id, run_id)
    return ChartDataResponse(success=True, data=data)


@router.get("/{run_id}/charts/prediction", response_model=ChartDataResponse)
def get_prediction_chart_data(
    run_id: str,
    exp_id: str = Query(..., description="实验ID"),
):
    data = ReportService._get_prediction_stats(exp_id, run_id)
    return ChartDataResponse(success=True, data=data)
