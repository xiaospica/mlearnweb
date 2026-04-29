from fastapi import APIRouter, Depends, Query
from typing import Dict, Any, List
import traceback
import logging
import numpy as np
from sqlalchemy.orm import Session

from app.models.database import get_db_session
from app.services.run_service import RunService
from app.services.report_service import ReportService
from app.schemas.schemas import RunListResponse, RunDetailResponse, ApiResponse
from app.utils.mlflow_reader import mlflow_reader

router = APIRouter(prefix="/api/runs", tags=["runs"])
logger = logging.getLogger(__name__)


def _convert_to_serializable(obj: Any) -> Any:
    """递归转换 numpy 类型为 Python 原生类型，以便 JSON 序列化"""
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    elif isinstance(obj, (np.integer, np.int64, np.int32)):
        return int(obj)
    elif isinstance(obj, (np.floating, np.float64, np.float32)):
        return float(obj)
    elif isinstance(obj, np.bool_):
        return bool(obj)
    elif isinstance(obj, dict):
        return {k: _convert_to_serializable(v) for k, v in obj.items()}
    elif isinstance(obj, (list, tuple)):
        return [_convert_to_serializable(item) for item in obj]
    elif obj is None or isinstance(obj, (str, int, float, bool)):
        return obj
    else:
        try:
            return str(obj)
        except Exception:
            return None


@router.get("", response_model=RunListResponse)
def list_runs(
    exp_id: str = Query(..., description="实验ID"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    status: str = Query(None, description="状态过滤: RUNNING/SCHEDULED/FINISHED/FAILED/KILLED"),
    sort_by: str = Query("start_time", description="排序字段"),
    order: str = Query("desc", description="排序方向: asc/desc"),
    db: Session = Depends(get_db_session),
):
    result = RunService.list_runs(
        experiment_id=exp_id,
        page=page,
        page_size=page_size,
        status_filter=status,
        sort_by=sort_by,
        order=order,
        db=db,
    )
    return RunListResponse(
        success=True,
        data=result,
    )


@router.get("/{run_id}", response_model=ApiResponse)
def get_run_detail(
    run_id: str,
    exp_id: str = Query(..., description="实验ID"),
):
    detail = RunService.get_run_detail(exp_id, run_id)
    if not detail:
        return ApiResponse(success=False, message=f"运行记录 {run_id} 不存在", data=None)
    return ApiResponse(success=True, data=detail)


@router.get("/{run_id}/params", response_model=ApiResponse)
def get_run_params(
    run_id: str,
    exp_id: str = Query(..., description="实验ID"),
):
    params = RunService.get_run_params(exp_id, run_id)
    return ApiResponse(success=True, data=params)


@router.get("/{run_id}/metrics", response_model=ApiResponse)
def get_run_metrics(
    run_id: str,
    exp_id: str = Query(..., description="实验ID"),
):
    metrics = RunService.get_run_metrics(exp_id, run_id)
    return ApiResponse(success=True, data=metrics)


@router.get("/{run_id}/artifacts", response_model=ApiResponse)
def get_run_artifacts(
    run_id: str,
    exp_id: str = Query(..., description="实验ID"),
):
    artifacts = RunService.get_run_artifacts(exp_id, run_id)
    return ApiResponse(success=True, data=artifacts)


@router.get("/{run_id}/tags", response_model=ApiResponse)
def get_run_tags(
    run_id: str,
    exp_id: str = Query(..., description="实验ID"),
):
    tags = RunService.get_run_tags(exp_id, run_id)
    return ApiResponse(success=True, data=tags)


@router.get("/{run_id}/report", response_model=ApiResponse)
def get_run_report(
    run_id: str,
    exp_id: str = Query(..., description="实验ID"),
):
    report = ReportService.get_full_report(exp_id, run_id)
    if "error" in report:
        return ApiResponse(success=False, message=report["error"], data=None)
    return ApiResponse(success=True, data=report)


@router.get("/{run_id}/qlib-figures", response_model=ApiResponse)
def get_qlib_figures(
    run_id: str,
    exp_id: str = Query(..., description="实验ID"),
):
    """获取 QLib 标准分析图表
    
    使用 QLib 标准分析函数生成图表，包括：
    - 回报分析图表 (report_graph)
    - 风险分析图表 (risk_analysis_graph)
    - IC分析图表 (score_ic_graph)
    - 模型性能图表 (model_performance_graph)
    
    Args:
        run_id: 运行记录ID
        exp_id: 实验ID
        
    Returns:
        ApiResponse: 包含所有图表JSON数据的响应
    """
    import sys
    print(f"\n{'='*60}", file=sys.stderr)
    print(f"[QLib分析] 开始处理请求", file=sys.stderr)
    print(f"  - exp_id: {exp_id}", file=sys.stderr)
    print(f"  - run_id: {run_id}", file=sys.stderr)
    print(f"  - mlruns_dir: {mlflow_reader.mlruns_dir}", file=sys.stderr)
    print(f"{'='*60}", file=sys.stderr)
    
    try:
        from qlib.contrib.report import analysis_position, analysis_model
        print("[QLib分析] ✓ QLib模块导入成功", file=sys.stderr)
    except ImportError as e:
        error_msg = f"无法导入 QLib 分析模块: {str(e)}"
        print(f"[QLib分析] ✗ {error_msg}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return ApiResponse(
            success=False,
            message=error_msg,
            data={"available": False, "error": "qlib_import_failed", "detail": str(e)}
        )
    
    try:
        print(f"[QLib分析] 加载数据文件...", file=sys.stderr)
        print(f"  - portfolio_report路径: {mlflow_reader.mlruns_dir / exp_id / run_id / 'artifacts/portfolio_analysis/report_normal_1day.pkl'}", file=sys.stderr)
        
        report_normal_df = mlflow_reader.load_portfolio_report(exp_id, run_id)
        print(f"  - report_normal_df: {type(report_normal_df)}, shape={getattr(report_normal_df, 'shape', None)}", file=sys.stderr)
        
        analysis_df = mlflow_reader.load_port_analysis_df(exp_id, run_id)
        print(f"  - analysis_df: {type(analysis_df)}, shape={getattr(analysis_df, 'shape', None)}", file=sys.stderr)
        
        pred_label = mlflow_reader.load_prediction_data(exp_id, run_id)
        print(f"  - pred_label: {type(pred_label)}, shape={getattr(pred_label, 'shape', None)}", file=sys.stderr)
        
        print(f"[QLib分析] ✓ 数据加载完成", file=sys.stderr)
    except Exception as e:
        error_msg = f"加载数据失败: {str(e)}"
        print(f"[QLib分析] ✗ {error_msg}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return ApiResponse(
            success=False,
            message=error_msg,
            data={"available": False, "error": "data_load_failed", "detail": str(e)}
        )
    
    if report_normal_df is None and pred_label is None:
        print(f"[QLib分析] ✗ 没有可用的分析数据", file=sys.stderr)
        return ApiResponse(
            success=False,
            message="没有可用的分析数据（portfolio报告和预测数据均为空）",
            data={"available": False, "error": "no_data_available"}
        )
    
    result: Dict[str, Any] = {
        "available": True,
        "report_figures": [],
        "risk_figures": [],
        "ic_figures": [],
        "model_figures": []
    }
    
    if report_normal_df is not None and not report_normal_df.empty:
        print(f"[QLib分析] 生成回报分析图表...", file=sys.stderr)
        try:
            report_figs = analysis_position.report_graph(report_normal_df, show_notebook=False)
            if report_figs:
                result["report_figures"] = [fig.to_dict() for fig in report_figs]
                print(f"[QLib分析] ✓ 回报分析图表: {len(result['report_figures'])} 个", file=sys.stderr)
        except Exception as e:
            error_msg = f"生成回报分析图表失败: {str(e)}"
            print(f"[QLib分析] ✗ {error_msg}", file=sys.stderr)
            import traceback
            traceback.print_exc()
            result["report_figures"] = [{"error": error_msg}]
    
    if analysis_df is not None and report_normal_df is not None and not report_normal_df.empty:
        print(f"[QLib分析] 生成风险分析图表...", file=sys.stderr)
        try:
            risk_figs = analysis_position.risk_analysis_graph(analysis_df, report_normal_df, show_notebook=False)
            if risk_figs:
                result["risk_figures"] = [fig.to_dict() for fig in risk_figs]
                print(f"[QLib分析] ✓ 风险分析图表: {len(result['risk_figures'])} 个", file=sys.stderr)
        except Exception as e:
            error_msg = f"生成风险分析图表失败: {str(e)}"
            print(f"[QLib分析] ✗ {error_msg}", file=sys.stderr)
            import traceback
            traceback.print_exc()
            result["risk_figures"] = [{"error": error_msg}]
    
    if pred_label is not None and not pred_label.empty:
        print(f"[QLib分析] 生成IC分析图表...", file=sys.stderr)
        try:
            ic_figs = analysis_position.score_ic_graph(pred_label, show_notebook=False)
            if ic_figs:
                result["ic_figures"] = [fig.to_dict() for fig in ic_figs]
                print(f"[QLib分析] ✓ IC分析图表: {len(result['ic_figures'])} 个", file=sys.stderr)
        except Exception as e:
            error_msg = f"生成IC分析图表失败: {str(e)}"
            print(f"[QLib分析] ✗ {error_msg}", file=sys.stderr)
            import traceback
            traceback.print_exc()
            result["ic_figures"] = [{"error": error_msg}]
    
    if pred_label is not None and not pred_label.empty:
        print(f"[QLib分析] 生成模型性能图表...", file=sys.stderr)
        try:
            model_figs = analysis_model.model_performance_graph(pred_label, show_notebook=False)
            if model_figs:
                result["model_figures"] = [fig.to_dict() for fig in model_figs]
                print(f"[QLib分析] ✓ 模型性能图表: {len(result['model_figures'])} 个", file=sys.stderr)
        except Exception as e:
            error_msg = f"生成模型性能图表失败: {str(e)}"
            print(f"[QLib分析] ✗ {error_msg}", file=sys.stderr)
            import traceback
            traceback.print_exc()
            result["model_figures"] = [{"error": error_msg}]
    
    print(f"[QLib分析] ✓ 请求处理完成", file=sys.stderr)
    print(f"[QLib分析] 转换数据为可序列化格式...", file=sys.stderr)
    serializable_result = _convert_to_serializable(result)
    print(f"{'='*60}\n", file=sys.stderr)
    return ApiResponse(success=True, data=serializable_result)


@router.get("/{run_id}/insample-layered", response_model=ApiResponse)
def get_insample_layered(
    run_id: str,
    exp_id: str = Query(..., description="实验ID"),
):
    """获取 train/valid/test 三段分层回测图表（qlib model_performance_graph）"""
    from app.services.insample_layered_service import InsampleLayeredService

    result = InsampleLayeredService.get_layered_figures(exp_id, run_id)
    if not result.get("available"):
        return ApiResponse(
            success=False,
            message=result.get("detail") or "分层回测数据不可用",
            data=result,
        )
    return ApiResponse(success=True, data=result)


@router.get("/{run_id}/feature-importance")
def get_feature_importance(
    run_id: str,
    exp_id: str = Query(..., description="实验ID"),
):
    """获取模型特征重要性
    
    从 LightGBM 模型中提取特征重要性：
    - Split Importance: 特征被用于分裂的次数
    - Gain Importance: 特征带来的信息增益总和
    """
    from app.services.model_interpretability_service import ModelInterpretabilityService
    
    result = ModelInterpretabilityService.get_feature_importance(exp_id, run_id)
    
    if not result.get("available"):
        return ApiResponse(
            success=False,
            message=result.get("error", "无法获取特征重要性"),
            data=result
        )
    
    return ApiResponse(success=True, data=result)


@router.get("/{run_id}/shap-analysis")
def get_shap_analysis(
    run_id: str,
    exp_id: str = Query(..., description="实验ID"),
    sample_size: int = Query(500, ge=100, le=5000, description="采样数量"),
    segment: str = Query("test", description="数据段(train/valid/test)"),
):
    """获取 SHAP 分析数据
    
    使用 SHAP (SHapley Additive exPlanations) 进行模型解释：
    - 全局特征重要性
    - SHAP 值分布
    - 特征交互效应
    """
    from app.services.model_interpretability_service import ModelInterpretabilityService
    
    result = ModelInterpretabilityService.compute_shap_values(
        exp_id, run_id, sample_size, segment
    )
    
    if not result.get("available"):
        return ApiResponse(
            success=False,
            message=result.get("error", "无法计算SHAP值"),
            data=result
        )
    
    serializable_result = _convert_to_serializable(result)
    return ApiResponse(success=True, data=serializable_result)


@router.get("/{run_id}/model-interpretability")
def get_model_interpretability(
    run_id: str,
    exp_id: str = Query(..., description="实验ID"),
):
    """获取完整的模型可解释性分析

    包含：
    - 特征重要性分析
    - SHAP 值分析
    """
    from app.services.model_interpretability_service import ModelInterpretabilityService

    result = ModelInterpretabilityService.get_full_analysis(exp_id, run_id)

    serializable_result = _convert_to_serializable(result)
    return ApiResponse(success=True, data=serializable_result)


@router.get("/{run_id}/shap-heatmap")
def get_shap_heatmap(
    run_id: str,  # noqa: ARG001 — kept for URL path consistency
    experiment_id: str = Query(..., description="实验ID，用于跨所有 rolling period 汇总 SHAP 数据"),
):
    """获取实验下所有 rolling period 的 SHAP 重要性热力图数据。

    返回矩阵：行=top-20特征，列=各 period（时间顺序）。
    """
    from app.services.model_interpretability_service import ModelInterpretabilityService

    try:
        data = ModelInterpretabilityService.get_shap_heatmap_across_runs(experiment_id)
        return ApiResponse(success=True, data=data)
    except Exception as e:
        return ApiResponse(success=False, message=str(e), data=None)
