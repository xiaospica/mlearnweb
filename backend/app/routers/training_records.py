from fastapi import APIRouter, Query, Depends, Body, HTTPException
from sqlalchemy.orm import Session
from typing import List, Dict, Any

import pandas as pd
import numpy as np

from app.models.database import get_db_session, init_db
from app.services.training_service import TrainingService, InSampleBacktestService
from app.services.report_service import ReportService
from app.utils.mlflow_reader import mlflow_reader
from app.schemas.schemas import (
    TrainingRecordCreate,
    TrainingRecordUpdate,
    TrainingRecordResponse,
    RunMappingCreate,
    ApiResponse,
    InSampleBacktestRequest,
    InSampleBacktestResponse,
    GroupCreate,
    GroupUpdate,
    BatchGroupUpdate,
    GroupInfoResponse,
)

router = APIRouter(prefix="/api/training-records", tags=["training-records"])


@router.post("", response_model=ApiResponse)
def create_training_record(body: TrainingRecordCreate, db: Session = Depends(get_db_session)):
    init_db()
    # config_snapshot is declared as Dict[str, Any] in schema; pass through directly.
    snapshot_dict = body.config_snapshot
    if snapshot_dict is not None and hasattr(snapshot_dict, "model_dump"):
        snapshot_dict = snapshot_dict.model_dump()
    record = TrainingService.create_record(
        db=db,
        name=body.name,
        experiment_id=body.experiment_id,
        experiment_name=body.experiment_name,
        description=body.description,
        config_snapshot=snapshot_dict,
        command_line=body.command_line,
        category=body.category or "single",
        tags=body.tags,
    )
    return ApiResponse(
        success=True,
        message=f"训练记录已创建, ID={record.id}",
        data=_record_to_response(record),
    )


@router.get("", response_model=ApiResponse)
def list_training_records(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=1000),
    status: str = Query(None),
    category: str = Query(None),
    search: str = Query(""),
    db: Session = Depends(get_db_session),
):
    try:
        result = TrainingService.list_records(
            db=db,
            page=page,
            page_size=page_size,
            status=status,
            category=category,
            search=search,
            include_preview=True,
        )
        return ApiResponse(success=True, data=result)
    except Exception as e:
        import traceback
        print(f"[TrainingRecords] list_training_records error: {e}")
        print(traceback.format_exc())
        return ApiResponse(
            success=False,
            message=f"获取训练记录列表失败: {str(e)}",
            data={"total": 0, "page": page, "page_size": page_size, "items": []}
        )


@router.post("/batch-delete", response_model=ApiResponse)
def batch_delete_training_records(ids: List[int] = Body(..., embed=True), db: Session = Depends(get_db_session)):
    deleted_count = 0
    failed_ids = []
    for record_id in ids:
        success = TrainingService.delete_record(db, record_id)
        if success:
            deleted_count += 1
        else:
            failed_ids.append(record_id)
    if failed_ids:
        return ApiResponse(success=True, message=f"已删除 {deleted_count} 条记录，{len(failed_ids)} 条不存在", data={"deleted": deleted_count, "failed_ids": failed_ids})
    return ApiResponse(success=True, message=f"已删除 {deleted_count} 条记录", data={"deleted": deleted_count})


@router.get("/groups", response_model=ApiResponse)
def list_groups(db: Session = Depends(get_db_session)):
    from app.models.database import TrainingRecord
    from sqlalchemy import func, or_
    
    groups = []
    
    favorite_count = db.query(func.count(TrainingRecord.id)).filter(
        TrainingRecord.is_favorite == True
    ).scalar()
    groups.append(GroupInfoResponse(
        name="收藏",
        count=favorite_count,
        is_system=True,
    ))
    
    normal_count = db.query(func.count(TrainingRecord.id)).filter(
        TrainingRecord.is_favorite == False,
        or_(TrainingRecord.group_name.is_(None), TrainingRecord.group_name == "default")
    ).scalar()
    groups.append(GroupInfoResponse(
        name="普通",
        count=normal_count,
        is_system=True,
    ))
    
    custom_groups = db.query(
        TrainingRecord.group_name,
        func.count(TrainingRecord.id).label("count")
    ).filter(
        TrainingRecord.group_name.notin_(["favorite", "default"]),
        TrainingRecord.group_name.isnot(None)
    ).group_by(TrainingRecord.group_name).all()
    
    for row in custom_groups:
        groups.append(GroupInfoResponse(
            name=row[0],
            count=row[1],
            is_system=False,
        ))
    
    return ApiResponse(success=True, data=groups)


@router.put("/batch-group", response_model=ApiResponse)
def batch_update_group(body: BatchGroupUpdate, db: Session = Depends(get_db_session)):
    from app.models.database import TrainingRecord
    
    if not body.record_ids or len(body.record_ids) == 0:
        return ApiResponse(success=False, message="请选择要分组的记录")
    
    if not body.group_name or not body.group_name.strip():
        return ApiResponse(success=False, message="分组名称不能为空")
    
    updated = 0
    for record_id in body.record_ids:
        record = db.query(TrainingRecord).filter(TrainingRecord.id == record_id).first()
        if record and not record.is_favorite:
            record.group_name = body.group_name.strip()
            updated += 1
    
    if updated == 0:
        return ApiResponse(success=False, message="收藏的记录不能移至其他分组，请取消收藏后再操作")
    
    db.commit()
    return ApiResponse(success=True, message=f"已将 {updated} 条记录移至 '{body.group_name}' 分组")


@router.put("/groups/{old_name}", response_model=ApiResponse)
def rename_group(old_name: str, body: GroupUpdate, db: Session = Depends(get_db_session)):
    from app.models.database import TrainingRecord
    
    if old_name in ("收藏", "普通", "favorite", "default"):
        return ApiResponse(success=False, message="系统分组不可重命名")
    
    records = db.query(TrainingRecord).filter(TrainingRecord.group_name == old_name).all()
    count = len(records)
    
    for record in records:
        record.group_name = body.name
    
    db.commit()
    return ApiResponse(success=True, message=f"已将分组 '{old_name}' 重命名为 '{body.name}'，影响 {count} 条记录")


@router.delete("/groups/{group_name}", response_model=ApiResponse)
def dissolve_group(group_name: str, db: Session = Depends(get_db_session)):
    from app.models.database import TrainingRecord
    
    if group_name in ("收藏", "普通", "favorite", "default"):
        return ApiResponse(success=False, message="系统分组不可解散")
    
    records = db.query(TrainingRecord).filter(TrainingRecord.group_name == group_name).all()
    count = len(records)
    
    for record in records:
        record.group_name = "default"
    
    db.commit()
    return ApiResponse(success=True, message=f"已解散分组 '{group_name}'，{count} 条记录归回普通")


@router.post("/insample-backtest", response_model=InSampleBacktestResponse)
def run_insample_backtest(request: InSampleBacktestRequest):
    result = InSampleBacktestService.run_insample_backtest(
        experiment_id=request.experiment_id,
        run_id=request.run_id,
        segments=request.segments,
        topk=request.topk,
        n_drop=request.n_drop,
        save_figures=request.save_figures,
    )
    return InSampleBacktestResponse(
        success=result.get("success", False),
        message=result.get("message", ""),
        data=result.get("data"),
    )


@router.get("/insample-backtest/{experiment_id}/{run_id}", response_model=InSampleBacktestResponse)
def get_existing_insample_results(experiment_id: str, run_id: str):
    result = InSampleBacktestService.load_existing_results(
        experiment_id=experiment_id,
        run_id=run_id,
    )
    return InSampleBacktestResponse(
        success=result.get("success", False),
        message=result.get("message", ""),
        data=result.get("data"),
    )


@router.get("/{record_id}", response_model=ApiResponse)
def get_training_record(record_id: int, db: Session = Depends(get_db_session)):
    record = TrainingService.get_record(db, record_id)
    if not record:
        return ApiResponse(success=False, message=f"训练记录 {record_id} 不存在", data=None)
    return ApiResponse(success=True, data=record)


@router.put("/{record_id}", response_model=ApiResponse)
def update_training_record(record_id: int, body: TrainingRecordUpdate, db: Session = Depends(get_db_session)):
    update_data = body.model_dump(exclude_unset=True)
    if body.completed_at is not None:
        update_data["completed_at"] = body.completed_at
    record = TrainingService.update_record(db, record_id, update_data)
    if not record:
        return ApiResponse(success=False, message=f"训练记录 {record_id} 不存在", data=None)
    return ApiResponse(success=True, message="更新成功", data=_record_to_response(record))


@router.delete("/{record_id}", response_model=ApiResponse)
def delete_training_record(record_id: int, db: Session = Depends(get_db_session)):
    success = TrainingService.delete_record(db, record_id)
    if not success:
        return ApiResponse(success=False, message=f"训练记录 {record_id} 不存在", data=None)
    return ApiResponse(success=True, message="删除成功")


@router.post("/{record_id}/runs", response_model=ApiResponse)
def add_run_mapping(
    record_id: int,
    body: RunMappingCreate,
    db: Session = Depends(get_db_session),
):
    mapping = TrainingService.add_run_mapping(
        db=db,
        training_record_id=record_id,
        run_id=body.run_id,
        rolling_index=body.rolling_index,
        segment_label=body.segment_label,
        train_start=body.train_start,
        train_end=body.train_end,
        valid_start=body.valid_start,
        valid_end=body.valid_end,
        test_start=body.test_start,
        test_end=body.test_end,
    )
    return ApiResponse(
        success=True,
        message=f"Run映射已添加 (mapping_id={mapping.id})",
        data={"mapping_id": mapping.id, "run_id": body.run_id},
    )


@router.get("/{record_id}/merged-report", response_model=ApiResponse)
def get_merged_report(record_id: int, db: Session = Depends(get_db_session)):
    record = TrainingService.get_record(db, record_id)
    if not record:
        raise HTTPException(status_code=404, detail=f"训练记录 {record_id} 不存在")

    run_mappings = record.get("run_mappings", [])
    if not run_mappings:
        raise HTTPException(status_code=400, detail="该训练记录没有关联的子运行")

    experiment_id = record.get("experiment_id")
    if not experiment_id:
        raise HTTPException(status_code=400, detail="该训练记录没有关联的实验ID")

    all_reports = []
    for mapping in run_mappings:
        run_id = mapping.get("run_id")
        if not run_id:
            continue

        try:
            report_df = mlflow_reader.load_portfolio_report(experiment_id, run_id)
            if report_df is not None and not report_df.empty and "return" in report_df.columns:
                all_reports.append({
                    "run_id": run_id,
                    "rolling_index": mapping.get("rolling_index"),
                    "segment_label": mapping.get("segment_label"),
                    "test_start": mapping.get("test_start"),
                    "test_end": mapping.get("test_end"),
                    "report_df": report_df,
                })
        except Exception as e:
            print(f"加载 run {run_id} 的 portfolio 数据失败: {e}")
            continue

    if len(all_reports) == 0:
        raise HTTPException(status_code=400, detail="无法加载任何子运行的 portfolio 数据")

    merged_data = _merge_rolling_returns(all_reports)
    merged_metrics = _compute_merged_metrics(merged_data)
    
    ic_analysis = _merge_ic_analysis(experiment_id, [m["run_id"] for m in run_mappings])
    monthly_returns = _compute_monthly_returns(merged_data)
    annual_returns = _compute_annual_returns(merged_data)
    rolling_stats = _compute_rolling_stats(merged_data)

    return ApiResponse(
        success=True,
        data={
            "record_info": {
                "id": record_id,
                "name": record.get("name"),
                "category": record.get("category"),
                "total_runs": len(run_mappings),
                "successful_runs": len(all_reports),
            },
            "merged_report": merged_data,
            "merged_metrics": merged_metrics,
            "ic_analysis": ic_analysis,
            "monthly_returns": monthly_returns,
            "annual_returns": annual_returns,
            "rolling_stats": rolling_stats,
            "individual_runs": [
                {
                    "run_id": r["run_id"][:16] + "...",
                    "rolling_index": r["rolling_index"],
                    "segment_label": r["segment_label"],
                    "test_range": f"{r['test_start'][:10] if r['test_start'] else '?'} ~ {r['test_end'][:10] if r['test_end'] else '?'}",
                    "data_points": len(r["report_df"]),
                }
                for r in all_reports
            ],
        },
    )


@router.get("/{record_id}/log", response_model=ApiResponse)
def get_training_log(record_id: int, db: Session = Depends(get_db_session)):
    from app.models.database import TrainingRecord
    
    record = db.query(TrainingRecord).filter(TrainingRecord.id == record_id).first()
    if not record:
        raise HTTPException(status_code=404, detail=f"训练记录 {record_id} 不存在")
    
    return ApiResponse(
        success=True,
        data={
            "log_content": record.log_content or "",
            "has_log": bool(record.log_content),
        }
    )


@router.put("/{record_id}/log", response_model=ApiResponse)
def update_training_log(
    record_id: int,
    log_content: str = Body(..., embed=True),
    append: bool = Body(False, embed=True),
    db: Session = Depends(get_db_session)
):
    from app.models.database import TrainingRecord
    
    record = db.query(TrainingRecord).filter(TrainingRecord.id == record_id).first()
    if not record:
        raise HTTPException(status_code=404, detail=f"训练记录 {record_id} 不存在")
    
    if append and record.log_content:
        record.log_content = record.log_content + "\n" + log_content
    else:
        record.log_content = log_content
    
    db.commit()
    db.refresh(record)
    
    return ApiResponse(
        success=True,
        message="日志已更新",
        data={"log_length": len(record.log_content or "")}
    )


def _merge_rolling_returns(reports: List[Dict]) -> Dict[str, Any]:
    sorted_reports = sorted(
        reports,
        key=lambda x: (x.get("rolling_index") or 0, x.get("test_start") or "")
    )

    all_dates = []
    all_returns = []
    all_cum_returns = []
    run_boundaries = []

    prev_base = 1.0

    for idx, report in enumerate(sorted_reports):
        df = report["report_df"].copy()

        if not isinstance(df.index, pd.DatetimeIndex):
            try:
                df.index = pd.to_datetime(df.index)
            except Exception:
                pass

        if "return" not in df.columns:
            continue

        dates = [str(d)[:10] for d in df.index]
        returns = df["return"].tolist()

        cum_ret_local = (pd.Series(returns) + 1).cumprod().tolist()

        if idx > 0 and len(all_cum_returns) > 0:
            base = all_cum_returns[-1] if all_cum_returns else 1.0
            cum_ret_adjusted = [r * base / cum_ret_local[0] if cum_ret_local[0] != 0 else r * base for r in cum_ret_local]
        else:
            cum_ret_adjusted = cum_ret_local

        if dates:
            run_boundaries.append({
                "start_date": dates[0],
                "end_date": dates[-1],
                "run_index": report.get("rolling_index"),
                "segment_label": report.get("segment_label"),
            })

        all_dates.extend(dates)
        all_returns.extend(returns)
        all_cum_returns.extend(cum_ret_adjusted)

    if not all_dates:
        return {"available": False, "error": "No valid data to merge"}

    all_bench = []
    for report in sorted_reports:
        df = report["report_df"]
        if "bench" in df.columns:
            all_bench.extend(df["bench"].tolist())

    all_turnover = []
    for report in sorted_reports:
        df = report["report_df"]
        if "turnover" in df.columns:
            all_turnover.extend(df["turnover"].tolist())

    result = {
        "available": True,
        "dates": all_dates,
        "total_days": len(all_dates),
        "cumulative_return": all_cum_returns,
        "daily_return": all_returns,
        "run_boundaries": run_boundaries,
    }

    if all_bench and len(all_bench) == len(all_dates):
        result["benchmark_cum_return"] = (pd.Series(all_bench) + 1).cumprod().tolist()
        result["daily_benchmark"] = all_bench

    if all_turnover and len(all_turnover) == len(all_dates):
        result["turnover"] = all_turnover

    return result


def _compute_merged_metrics(merged_data: Dict[str, Any]) -> Dict[str, Any]:
    if not merged_data.get("available"):
        return {"available": False}

    returns = pd.Series(merged_data.get("daily_return", [])).dropna()
    if len(returns) == 0:
        return {"available": False}

    cum_ret = pd.Series(merged_data.get("cumulative_return", []))

    metrics = {
        "available": True,
        "total_trading_days": int(len(returns)),
        "total_return": float((cum_ret.iloc[-1] / cum_ret.iloc[0] - 1)) if len(cum_ret) > 1 else 0,
        "annualized_return": float(returns.mean() * 252),
        "mean_daily_return": float(returns.mean()),
        "std_daily_return": float(returns.std()),
        "max_drawdown": float(_calc_max_drawdown(cum_ret)),
        "sharpe_ratio": float(returns.mean() / returns.std() * np.sqrt(252)) if returns.std() > 0 else None,
        "sortino_ratio": float(_calc_sortino_ratio(returns)),
        "calmar_ratio": float(returns.mean() * 252 / abs(_calc_max_drawdown(cum_ret))) if abs(_calc_max_drawdown(cum_ret)) > 0 else None,
        "win_rate": float((returns > 0).mean()),
        "profit_loss_ratio": float(abs(returns[returns > 0].mean()) / abs(returns[returns < 0].mean())) if (returns < 0).any() else None,
        "max_single_day_gain": float(returns.max()),
        "max_single_day_loss": float(returns.min()),
        "number_of_runs": len(merged_data.get("run_boundaries", [])),
    }

    if "daily_benchmark" in merged_data:
        bench_returns = pd.Series(merged_data["daily_benchmark"]).dropna()
        excess_returns = returns - bench_returns
        metrics.update({
            "excess_annualized_return": float(excess_returns.mean() * 252),
            "tracking_error": float(excess_returns.std() * np.sqrt(252)),
            "information_ratio": float(excess_returns.mean() / excess_returns.std() * np.sqrt(252)) if excess_returns.std() > 0 else None,
        })

    return metrics


def _calc_max_drawdown(cum_returns: pd.Series) -> float:
    running_max = cum_returns.cummax()
    drawdown = (cum_returns - running_max) / running_max
    return drawdown.min()


def _calc_sortino_ratio(returns: pd.Series, risk_free_rate: float = 0.0) -> float:
    excess_returns = returns - risk_free_rate
    downside_returns = returns[returns < 0]
    downside_std = downside_returns.std() if len(downside_returns) > 0 else 0.0001
    return float(excess_returns.mean() / downside_std * np.sqrt(252))


def _merge_ic_analysis(experiment_id: str, run_ids: List[str]) -> Dict[str, Any]:
    all_ic = []
    all_dates = []
    
    for run_id in run_ids:
        try:
            ic_data = mlflow_reader.load_ic_analysis(experiment_id, run_id)
            ic_df = ic_data.get("ic")
            if ic_df is not None and len(ic_df) > 0:
                if hasattr(ic_df.index, "to_list"):
                    dates = [str(d)[:10] for d in ic_df.index.to_list()]
                else:
                    dates = list(range(len(ic_df)))
                ic_values = ic_df.tolist() if isinstance(ic_df, pd.Series) else ic_df.iloc[:, 0].tolist()
                all_dates.extend(dates)
                all_ic.extend(ic_values)
        except Exception:
            continue
    
    if not all_ic:
        return {"available": False}
    
    ic_arr = np.array([ic for ic in all_ic if ic is not None and not np.isnan(ic)])
    
    return {
        "available": True,
        "dates": all_dates,
        "ic_values": all_ic,
        "mean_ic": float(np.mean(ic_arr)) if len(ic_arr) > 0 else None,
        "std_ic": float(np.std(ic_arr)) if len(ic_arr) > 0 else None,
        "icir": float(np.mean(ic_arr) / np.std(ic_arr)) if len(ic_arr) > 0 and np.std(ic_arr) > 0 else None,
        "hit_rate": float((ic_arr > 0).mean()) if len(ic_arr) > 0 else None,
    }


def _compute_monthly_returns(merged_data: Dict[str, Any]) -> Dict[str, Any]:
    if not merged_data.get("available"):
        return {"available": False}
    
    dates = merged_data.get("dates", [])
    returns = merged_data.get("daily_return", [])
    
    if not dates or not returns:
        return {"available": False}
    
    try:
        df = pd.DataFrame({
            "date": pd.to_datetime(dates),
            "return": returns,
        })
        df = df.dropna()
        
        monthly_returns = df.groupby(df["date"].dt.to_period("M"))["return"].apply(lambda x: (1 + x).prod() - 1)
        
        monthly_data = []
        for period, ret in monthly_returns.items():
            if pd.notna(ret):
                monthly_data.append({
                    "month": str(period),
                    "year": period.year,
                    "month_num": period.month,
                    "return": float(ret),
                })
        
        years = sorted(list(set([d["year"] for d in monthly_data])))
        months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        
        heatmap_data = []
        for d in monthly_data:
            heatmap_data.append([str(d["year"]), d["month_num"] - 1, d["return"]])
        
        return {
            "available": True,
            "monthly_list": monthly_data,
            "years": [str(y) for y in years],
            "months": months,
            "heatmap_data": heatmap_data,
            "histogram": {
                "values": [d["return"] for d in monthly_data],
                "labels": [d["month"] for d in monthly_data],
            },
        }
    except Exception:
        return {"available": False}


def _compute_annual_returns(merged_data: Dict[str, Any]) -> Dict[str, Any]:
    if not merged_data.get("available"):
        return {"available": False}

    dates = merged_data.get("dates", [])
    returns = merged_data.get("daily_return", [])

    if not dates or not returns:
        return {"available": False}

    try:
        df = pd.DataFrame({
            "date": pd.to_datetime(dates),
            "return": returns,
        })
        df = df.dropna()

        annual_returns = df.groupby(df["date"].dt.year)["return"].apply(lambda x: (1 + x).prod() - 1)

        annual_dict = {}
        benchmark_annual = {}
        annual_list = []

        for year, ret in annual_returns.items():
            if pd.notna(ret):
                annual_dict[str(year)] = float(ret)
                annual_list.append({"year": int(year), "return": float(ret)})

        if "benchmark_daily_return" in merged_data and merged_data["benchmark_daily_return"]:
            bench_df = pd.DataFrame({
                "date": pd.to_datetime(dates),
                "return": merged_data["benchmark_daily_return"],
            })
            bench_df = bench_df.dropna()
            bench_annual = bench_df.groupby(bench_df["date"].dt.year)["return"].apply(lambda x: (1 + x).prod() - 1)
            for year, ret in bench_annual.items():
                if pd.notna(ret):
                    benchmark_annual[str(year)] = float(ret)

        return {
            "available": len(annual_dict) > 0,
            "annual_returns": annual_dict,
            "benchmark_annual_returns": benchmark_annual,
            "annual_list": annual_list,
        }
    except Exception:
        return {"available": False}


def _compute_rolling_stats(merged_data: Dict[str, Any], window: int = 20) -> Dict[str, Any]:
    if not merged_data.get("available"):
        return {"available": False}
    
    returns = merged_data.get("daily_return", [])
    dates = merged_data.get("dates", [])
    
    if not returns or len(returns) < window:
        return {"available": False, "error": "Not enough data for rolling stats"}
    
    try:
        returns_series = pd.Series(returns).dropna()
        
        rolling_mean = returns_series.rolling(window=window).mean()
        rolling_std = returns_series.rolling(window=window).std()
        rolling_sharpe = rolling_mean / rolling_std * np.sqrt(252)
        
        cum_returns = (1 + returns_series).cumprod()
        rolling_max = cum_returns.rolling(window=window).max()
        rolling_dd = (cum_returns - rolling_max) / rolling_max
        
        return {
            "available": True,
            "dates": dates[:len(returns_series)],
            "window": window,
            "rolling_return": rolling_mean.tolist(),
            "rolling_volatility": (rolling_std * np.sqrt(252)).tolist(),
            "rolling_sharpe": rolling_sharpe.tolist(),
            "rolling_drawdown": rolling_dd.tolist(),
        }
    except Exception:
        return {"available": False}


def _record_to_response(record) -> dict:
    from app.services.training_service import _record_to_dict
    return _record_to_dict(record)
