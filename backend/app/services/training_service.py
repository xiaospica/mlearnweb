from typing import Any, Dict, List, Optional
from datetime import datetime
from pathlib import Path
import socket
import platform
import sys
import numpy as np
import pandas as pd

from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.database import TrainingRecord, TrainingRunMapping, get_db_session
from app.utils.mlflow_reader import mlflow_reader


def _get_cumulative_return_preview(experiment_id: str, run_id: str) -> Optional[Dict[str, Any]]:
    if not run_id or not experiment_id:
        return None
    try:
        report_df = mlflow_reader.load_portfolio_report(experiment_id, run_id)
        if report_df is None or report_df.empty or "return" not in report_df.columns:
            return None

        cum_ret = (1 + report_df["return"]).cumprod()
        total_points = len(cum_ret)
        max_points = 50
        if total_points > max_points:
            step = total_points // max_points
            sampled = cum_ret.iloc[::step].tolist()
        else:
            sampled = cum_ret.tolist()

        final_return = float(cum_ret.iloc[-1]) if len(cum_ret) > 0 else 1.0
        return {
            "values": sampled,
            "final_return": final_return,
            "total_points": total_points,
        }
    except Exception as e:
        print(f"[TrainingService] _get_cumulative_return_preview error: {e}")
        return None


def _get_merged_cumulative_return_preview(experiment_id: str, run_ids: List[str]) -> Optional[Dict[str, Any]]:
    """合并多个子运行的收益率预览
    
    按时间顺序正确衔接多个子运行的累计收益率
    """
    if not run_ids or not experiment_id:
        return None
    
    reports_data = []
    for run_id in run_ids:
        try:
            report_df = mlflow_reader.load_portfolio_report(experiment_id, run_id)
            if report_df is not None and not report_df.empty and "return" in report_df.columns:
                if not isinstance(report_df.index, (pd.DatetimeIndex, pd.Index)):
                    continue
                dates = [str(d)[:10] for d in report_df.index]
                returns = report_df["return"].dropna().tolist()
                if len(returns) > 0 and len(dates) > 0:
                    reports_data.append({
                        "run_id": run_id,
                        "dates": dates,
                        "returns": returns,
                        "start_date": dates[0] if dates else "",
                    })
        except Exception as e:
            print(f"[TrainingService] _get_merged_cumulative_return_preview error for run {run_id}: {e}")
            continue
    
    if not reports_data:
        return None
    
    reports_data.sort(key=lambda x: x.get("start_date", ""))
    
    all_cum_returns = []
    prev_base = 1.0
    
    for report in reports_data:
        returns = report["returns"]
        if not returns:
            continue
        
        cum_ret_local = np.cumprod(1 + np.array(returns))
        
        if all_cum_returns:
            base = all_cum_returns[-1]
            cum_ret_adjusted = cum_ret_local * base / cum_ret_local[0]
        else:
            cum_ret_adjusted = cum_ret_local
        
        all_cum_returns.extend(cum_ret_adjusted.tolist())
    
    if not all_cum_returns:
        return None
    
    try:
        cum_ret = np.array(all_cum_returns)
        total_points = len(cum_ret)
        max_points = 50
        if total_points > max_points:
            step = total_points // max_points
            sampled = cum_ret[::step].tolist()
        else:
            sampled = cum_ret.tolist()
        
        final_return = float(cum_ret[-1]) if len(cum_ret) > 0 else 1.0
        return {
            "values": sampled,
            "final_return": final_return,
            "total_points": total_points,
        }
    except Exception as e:
        print(f"[TrainingService] _get_merged_cumulative_return_preview calculation error: {e}")
        return None


class TrainingService:

    @staticmethod
    def create_record(
        db: Session,
        name: str,
        experiment_id: str,
        experiment_name: Optional[str] = None,
        description: Optional[str] = None,
        config_snapshot: Optional[Dict[str, Any]] = None,
        command_line: Optional[str] = None,
        category: str = "single",
        tags: Optional[List[str]] = None,
    ) -> TrainingRecord:
        record = TrainingRecord(
            name=name,
            description=description,
            experiment_id=experiment_id,
            experiment_name=experiment_name,
            config_snapshot=config_snapshot,
            command_line=command_line,
            category=category,
            tags=tags or [],
            status="running",
            started_at=datetime.now(),
            hostname=socket.gethostname(),
            python_version=f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
        )
        db.add(record)
        db.commit()
        db.refresh(record)
        return record

    @staticmethod
    def list_records(
        db: Session,
        page: int = 1,
        page_size: int = 20,
        status: Optional[str] = None,
        category: Optional[str] = None,
        search: str = "",
        include_preview: bool = True,
    ) -> Dict[str, Any]:
        query = db.query(TrainingRecord)
        if status:
            query = query.filter(TrainingRecord.status == status)
        if category:
            query = query.filter(TrainingRecord.category == category)
        if search:
            query = query.filter(TrainingRecord.name.contains(search))

        total = query.count()
        records = (
            query.order_by(TrainingRecord.created_at.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
            .all()
        )
        
        record_ids = [r.id for r in records]
        mapping_counts = {}
        mapping_run_ids = {}
        if record_ids:
            from sqlalchemy import func
            counts_query = (
                db.query(
                    TrainingRunMapping.training_record_id,
                    func.count(TrainingRunMapping.id).label("count")
                )
                .filter(TrainingRunMapping.training_record_id.in_(record_ids))
                .group_by(TrainingRunMapping.training_record_id)
                .all()
            )
            mapping_counts = {item[0]: item[1] for item in counts_query}
            
            run_ids_query = (
                db.query(
                    TrainingRunMapping.training_record_id,
                    TrainingRunMapping.run_id,
                    TrainingRunMapping.rolling_index,
                )
                .filter(TrainingRunMapping.training_record_id.in_(record_ids))
                .order_by(TrainingRunMapping.training_record_id, TrainingRunMapping.rolling_index.asc().nullslast())
                .all()
            )
            for item in run_ids_query:
                if item[0] not in mapping_run_ids:
                    mapping_run_ids[item[0]] = []
                mapping_run_ids[item[0]].append(item[1])
        
        return {
            "total": total,
            "page": page,
            "page_size": page_size,
            "items": [_record_to_dict(
                r, 
                include_preview=include_preview, 
                run_mapping_count=mapping_counts.get(r.id),
                actual_run_ids=mapping_run_ids.get(r.id)
            ) for r in records],
        }

    @staticmethod
    def get_record(db: Session, record_id: int) -> Optional[Dict[str, Any]]:
        record = db.query(TrainingRecord).filter(TrainingRecord.id == record_id).first()
        if not record:
            return None
        data = _record_to_dict(record)
        mappings = (
            db.query(TrainingRunMapping)
            .filter(TrainingRunMapping.training_record_id == record_id)
            .order_by(TrainingRunMapping.rolling_index.asc().nullslast())
            .all()
        )
        data["run_mappings"] = [
            {
                "id": m.id,
                "run_id": m.run_id,
                "rolling_index": m.rolling_index,
                "segment_label": m.segment_label,
                "train_start": m.train_start.isoformat() if m.train_start else None,
                "train_end": m.train_end.isoformat() if m.train_end else None,
                "valid_start": m.valid_start.isoformat() if m.valid_start else None,
                "valid_end": m.valid_end.isoformat() if m.valid_end else None,
                "test_start": m.test_start.isoformat() if m.test_start else None,
                "test_end": m.test_end.isoformat() if m.test_end else None,
            }
            for m in mappings
        ]
        return data

    @staticmethod
    def update_record(db: Session, record_id: int, update_data: Dict[str, Any]) -> Optional[TrainingRecord]:
        record = db.query(TrainingRecord).filter(TrainingRecord.id == record_id).first()
        if not record:
            return None
        memo_changed = "memo" in update_data
        for key, value in update_data.items():
            if hasattr(record, key) and value is not None:
                setattr(record, key, value)
        db.commit()
        db.refresh(record)

        if memo_changed:
            try:
                from app.services import memo_image_service
                memo_image_service.sync_orphans(record_id, record.memo)
            except Exception as e:
                print(f"[TrainingService] memo 孤儿清理失败 record_id={record_id}: {e}")

        return record

    @staticmethod
    def delete_record(db: Session, record_id: int) -> bool:
        record = db.query(TrainingRecord).filter(TrainingRecord.id == record_id).first()
        if not record:
            return False
        db.delete(record)
        db.commit()
        try:
            from app.services import memo_image_service
            memo_image_service.delete_record_dir(record_id)
        except Exception as e:
            print(f"[TrainingService] 级联清理图片目录失败 record_id={record_id}: {e}")
        return True

    @staticmethod
    def add_run_mapping(
        db: Session,
        training_record_id: int,
        run_id: str,
        rolling_index: Optional[int] = None,
        segment_label: Optional[str] = None,
        train_start: Optional[str] = None,
        train_end: Optional[str] = None,
        valid_start: Optional[str] = None,
        valid_end: Optional[str] = None,
        test_start: Optional[str] = None,
        test_end: Optional[str] = None,
    ) -> TrainingRunMapping:
        def parse_dt(s: Optional[str]) -> Optional[datetime]:
            if not s:
                return None
            try:
                return datetime.fromisoformat(s.replace("Z", "+00:00").replace("+00:00", ""))
            except (ValueError, AttributeError):
                return None

        mapping = TrainingRunMapping(
            training_record_id=training_record_id,
            run_id=run_id,
            rolling_index=rolling_index,
            segment_label=segment_label,
            train_start=parse_dt(train_start),
            train_end=parse_dt(train_end),
            valid_start=parse_dt(valid_start),
            valid_end=parse_dt(valid_end),
            test_start=parse_dt(test_start),
            test_end=parse_dt(test_end),
        )
        db.add(mapping)

        record = db.query(TrainingRecord).filter(TrainingRecord.id == training_record_id).first()
        if record:
            current_ids = list(record.run_ids or [])
            if run_id not in current_ids:
                current_ids.append(run_id)
                record.run_ids = current_ids
                # Column(JSON) 默认不追踪 list.append 类 mutation；显式标脏确保 commit 落盘
                flag_modified(record, "run_ids")
                record.updated_at = datetime.now()

        db.commit()
        db.refresh(mapping)
        return mapping


def _record_to_dict(record: TrainingRecord, include_preview: bool = False, run_mapping_count: Optional[int] = None, actual_run_ids: Optional[List[str]] = None) -> Dict[str, Any]:
    try:
        run_ids = record.run_ids or []
        actual_run_count = run_mapping_count if run_mapping_count is not None else len(run_ids)
        effective_run_ids = actual_run_ids if actual_run_ids else run_ids
        data = {
            "id": record.id,
            "name": record.name,
            "description": record.description,
            "experiment_id": record.experiment_id,
            "experiment_name": record.experiment_name,
            "run_ids": run_ids,
            "run_count": actual_run_count,
            "config_snapshot": record.config_snapshot,
            "status": record.status,
            "started_at": record.started_at.isoformat() if record.started_at else None,
            "completed_at": record.completed_at.isoformat() if record.completed_at else None,
            "duration_seconds": record.duration_seconds,
            "command_line": record.command_line,
            "hostname": record.hostname,
            "python_version": record.python_version,
            "summary_metrics": record.summary_metrics,
            "tags": record.tags or [],
            "category": record.category,
            "memo": record.memo,
            "group_name": getattr(record, 'group_name', 'default') or 'default',
            "is_favorite": getattr(record, 'is_favorite', False) or False,
            "deployments": getattr(record, 'deployments', None) or [],
            "created_at": record.created_at.isoformat() if record.created_at else None,
            "updated_at": record.updated_at.isoformat() if record.updated_at else None,
        }

        if include_preview and effective_run_ids and record.experiment_id:
            try:
                if len(effective_run_ids) > 1:
                    preview = _get_merged_cumulative_return_preview(record.experiment_id, effective_run_ids)
                else:
                    preview = _get_cumulative_return_preview(record.experiment_id, effective_run_ids[0])
                if preview:
                    data["cumulative_return_preview"] = preview
            except Exception as e:
                print(f"[TrainingService] _record_to_dict preview error: {e}")

        return data
    except Exception as e:
        print(f"[TrainingService] _record_to_dict error: {e}")
        return {
            "id": record.id if hasattr(record, 'id') else None,
            "name": record.name if hasattr(record, 'name') else "Unknown",
            "error": str(e),
        }


def _compute_lag_ic(
    pred_aligned: "pd.DataFrame",
    label_aligned: "pd.DataFrame",
    lags: list = None,
) -> dict:
    """计算不同 lag 天数的 IC，衡量预测信号有效期。

    Args:
        pred_aligned: 预测值 DataFrame，MultiIndex (datetime, instrument)
        label_aligned: 标签值 DataFrame，MultiIndex (datetime, instrument)
        lags: 待计算的 lag 天数列表

    Returns:
        dict: {lag_str: {mean_ic, std_ic, n_dates}}
    """
    from scipy import stats as _stats

    if lags is None:
        lags = [1, 2, 3, 5, 10]

    results: dict = {}
    try:
        dates = pred_aligned.index.get_level_values(0).unique().sort_values()
    except Exception:
        return {str(lag): {"mean_ic": 0.0, "std_ic": 0.0, "n_dates": 0} for lag in lags}

    for lag in lags:
        ic_list: list = []
        for i, date in enumerate(dates):
            if i < lag:
                continue
            past_date = dates[i - lag]
            try:
                past_pred = pred_aligned.loc[past_date]
                curr_label = label_aligned.loc[date]
                # 对齐 instrument 轴
                common_inst = past_pred.index.intersection(curr_label.index)
                if len(common_inst) < 10:
                    continue
                pv = past_pred.loc[common_inst].iloc[:, 0].values if hasattr(past_pred, "iloc") else past_pred.loc[common_inst].values
                lv = curr_label.loc[common_inst].iloc[:, 0].values if hasattr(curr_label, "iloc") else curr_label.loc[common_inst].values
                ic, _ = _stats.spearmanr(pv, lv)
                if not np.isnan(ic):
                    ic_list.append(float(ic))
            except Exception:
                continue
        results[str(lag)] = {
            "mean_ic": float(np.mean(ic_list)) if ic_list else 0.0,
            "std_ic": float(np.std(ic_list)) if ic_list else 0.0,
            "n_dates": len(ic_list),
        }
    return results


def _compute_holdings_analysis(
    pred_aligned: "pd.DataFrame",
    top_k: int = 7,
) -> dict:
    """分析每日 TopK 持仓股票的频率分布。

    Args:
        pred_aligned: 预测值 DataFrame，MultiIndex (datetime, instrument)
        top_k: 每日持仓股票数

    Returns:
        dict: top_stocks 列表及汇总统计
    """
    try:
        dates = pred_aligned.index.get_level_values(0).unique()
    except Exception:
        return {"top_stocks": [], "unique_stocks": 0, "avg_holding_days": 0.0, "total_days": 0}

    hold_counts: dict = {}
    total_days = len(dates)

    for date in dates:
        try:
            day_pred = pred_aligned.loc[date]
            scores = day_pred.iloc[:, 0] if hasattr(day_pred, "iloc") else day_pred
            top_stocks = scores.nlargest(top_k).index.tolist()
            for s in top_stocks:
                hold_counts[s] = hold_counts.get(s, 0) + 1
        except Exception:
            continue

    sorted_stocks = sorted(hold_counts.items(), key=lambda x: x[1], reverse=True)
    top_20 = sorted_stocks[:20]

    return {
        "top_stocks": [
            {
                "stock_id": str(sid),
                "hold_days": int(cnt),
                "hold_rate": round(cnt / total_days, 4) if total_days > 0 else 0.0,
            }
            for sid, cnt in top_20
        ],
        "unique_stocks": len(hold_counts),
        "avg_holding_days": round(
            sum(hold_counts.values()) / len(hold_counts), 2
        ) if hold_counts else 0.0,
        "total_days": total_days,
    }


def _compute_position_analysis(seg_dir: "Path") -> dict:
    """从 portfolio_analysis 目录的 positions_normal_1day.pkl 计算仓位统计。

    Returns:
        dict: {available, dates, num_stocks, max_weights, min_weights}
    """
    import pickle as _pickle

    pos_file = seg_dir / "positions_normal_1day.pkl"
    if not pos_file.exists():
        return {"available": False}

    try:
        with open(pos_file, "rb") as f:
            positions = _pickle.load(f)
    except Exception as e:
        print(f"[PositionAnalysis] Failed to load {pos_file}: {e}", file=__import__("sys").stderr)
        return {"available": False, "error": str(e)}

    dates: list = []
    num_stocks: list = []
    max_weights: list = []
    min_weights: list = []

    for date in sorted(positions.keys()):
        pos_obj = positions[date]
        if not hasattr(pos_obj, "position"):
            continue
        weight_list = [
            float(v["weight"])
            for k, v in pos_obj.position.items()
            if "." in str(k) and isinstance(v, dict) and "weight" in v
        ]
        if not weight_list:
            continue
        dates.append(str(pd.Timestamp(date))[:10])
        num_stocks.append(len(weight_list))
        max_weights.append(round(max(weight_list) * 100, 4))
        min_weights.append(round(min(weight_list) * 100, 4))

    if not dates:
        return {"available": False, "error": "持仓数据为空"}

    return {
        "available": True,
        "dates": dates,
        "num_stocks": num_stocks,
        "max_weights": max_weights,
        "min_weights": min_weights,
    }


class InSampleBacktestService:
    """In-Sample 回测服务 - 对已有 MLflow Run 执行 train/valid/test 多 segment 预测和回测

    ⚠️ 功能冻结 - 后续修复
    ============================
    此功能当前已禁用，存在以下已知问题：
    1. 前端 insample 回测功能已禁用
    2. 后端代码有 bug，暂时冻结
    3. insample 数据现在通过训练阶段的 MULTI_SEGMENT_RECORD_CONFIG 获取

    后续修复计划：
    - 修复 IC 分析中 train/valid segment 的 label 加载问题
    - 优化多 segment 数据加载逻辑

    如需启用，请联系开发者。
    """

    @staticmethod
    def run_insample_backtest(
        experiment_id: str,
        run_id: str,
        segments: Optional[List[str]] = None,
        topk: Optional[int] = None,
        n_drop: Optional[int] = None,
        save_figures: bool = True,
    ) -> Dict[str, Any]:
        from app.core.config import settings

        if not settings.mlruns_dir:
            return {"success": False, "message": "MLRUNS_DIR is not configured", "data": None}
        mlruns_dir = Path(settings.mlruns_dir)
        run_path = mlruns_dir / experiment_id / run_id

        if not run_path.exists():
            return {"success": False, "message": f"Run 目录不存在: {run_path}", "data": None}

        artifact_uri = str(run_path / "artifacts")

        import sys as _sys
        import os as _os

        project_root = Path(__file__).resolve().parent.parent.parent.parent.parent
        strategy_dev_dir = project_root / "strategy_dev"

        path_changed = False
        if str(strategy_dev_dir) not in _sys.path:
            _sys.path.insert(0, str(strategy_dev_dir))
            path_changed = True
        if str(project_root) not in _sys.path:
            _sys.path.insert(0, str(project_root))
            path_changed = True
        
        if "insample_backtest" in _sys.modules:
            del _sys.modules["insample_backtest"]
        if "config" in _sys.modules:
            del _sys.modules["config"]

        _os.environ.setdefault("LOKY_PICKLER", "pickle")
        _os.environ.setdefault("JOBLIB_START_METHOD", "spawn")
        _os.environ.setdefault("MKL_NUM_THREADS", "1")
        _os.environ.setdefault("OMP_NUM_THREADS", "1")

        try:
            import importlib
            insample_module = importlib.import_module("insample_backtest")
            config_module = importlib.import_module("config")
            
            load_model_from_run = insample_module.load_model_from_run
            load_dataset_from_run = insample_module.load_dataset_from_run
            predict_multi_segment = insample_module.predict_multi_segment
            backtest_segment = insample_module.backtest_segment
            compute_risk_metrics = insample_module.compute_risk_metrics
            BT_CONFIG = config_module.BT_CONFIG
            BT_STRATEGY = config_module.BT_STRATEGY
        except ImportError as e:
            return {
                "success": False,
                "message": f"无法导入 insample_backtest 模块: {e}，path={_sys.path[:3]}",
                "data": None,
            }

        bt_config_ov = BT_CONFIG.copy()
        bt_strategy_ov = BT_STRATEGY.copy()
        if topk is not None:
            bt_strategy_ov["topk"] = topk
        if n_drop is not None:
            bt_strategy_ov["n_drop"] = n_drop

        try:
            model = load_model_from_run(str(run_path))
            dataset = load_dataset_from_run(str(run_path), provider_uri=None)
        except FileNotFoundError as e:
            return {"success": False, "message": f"缺少必要文件: {e}", "data": None}
        except Exception as e:
            return {"success": False, "message": f"加载模型/数据集失败: {e}", "data": None}

        preds = predict_multi_segment(model, dataset, segments=segments)

        results = {
            "run_id": run_id,
            "experiment_id": experiment_id,
            "segments": {},
        }

        for seg, pred_df in preds.items():
            report_df, indicator_dict = backtest_segment(
                pred_df=pred_df,
                segment=seg,
                bt_config=bt_config_ov,
                bt_strategy=bt_strategy_ov,
            )
            risk_metrics = compute_risk_metrics(report_df)

            seg_result = {
                "pred_shape": list(pred_df.shape),
                "n_stocks": int(len(pred_df.index.get_level_values("instrument").unique())),
                "time_range": [
                    str(pred_df.index.get_level_values("datetime").min()),
                    str(pred_df.index.get_level_values("datetime").max()),
                ],
                "risk_metrics": risk_metrics,
                "indicator_dict": {
                    k: float(v) if isinstance(v, (int, float)) else str(v)
                    for k, v in (indicator_dict or {}).items()
                } if indicator_dict else {},
            }
            results["segments"][seg] = seg_result

        return {
            "success": True,
            "message": f"In-Sample 回测完成，共处理 {len(results['segments'])} 个 segment",
            "data": results,
        }

    @staticmethod
    def load_existing_results(
        experiment_id: str,
        run_id: str,
    ) -> Dict[str, Any]:
        """加载已有的 In-Sample 回测结果（如果存在）

        检查 Run 的 artifacts 目录下是否有 portfolio_analysis_train 和 portfolio_analysis_valid 目录，
        如果有则读取其中的回测结果并返回。

        Args:
            experiment_id: MLflow experiment ID
            run_id: MLflow run ID

        Returns:
            包含已有结果的字典，包括风险指标、累计收益序列、回撤序列、换手率等详细数据
        """
        import sys
        print(f"[InSampleBacktestService] load_existing_results called for exp={experiment_id}, run={run_id}", file=sys.stderr)
        
        from app.core.config import settings
        import pickle

        if not settings.mlruns_dir:
            return {"success": False, "message": "MLRUNS_DIR is not configured", "data": None}
        mlruns_dir = Path(settings.mlruns_dir)
        run_path = mlruns_dir / experiment_id / run_id

        if not run_path.exists():
            print(f"[InSampleBacktestService] Run path not found: {run_path}", file=sys.stderr)
            return {"success": False, "message": f"Run 目录不存在: {run_path}", "data": None}

        artifacts_path = run_path / "artifacts"
        print(f"[InSampleBacktestService] Artifacts path: {artifacts_path}", file=sys.stderr)
        
        results = {
            "run_id": run_id,
            "experiment_id": experiment_id,
            "segments": {},
        }

        segment_dirs = {
            "test": artifacts_path / "portfolio_analysis",
            "train": artifacts_path / "portfolio_analysis_train",
            "valid": artifacts_path / "portfolio_analysis_valid",
        }

        for seg_name, seg_dir in segment_dirs.items():
            print(f"[InSampleBacktestService] Checking segment {seg_name}: {seg_dir}, exists={seg_dir.exists()}", file=sys.stderr)
            
            if not seg_dir.exists():
                continue

            report_file = seg_dir / "report_normal_1day.pkl"
            if not report_file.exists():
                print(f"[InSampleBacktestService] Report file not found: {report_file}", file=sys.stderr)
                continue

            try:
                with open(report_file, "rb") as f:
                    report_df = pickle.load(f)

                if report_df is None or report_df.empty:
                    print(f"[InSampleBacktestService] Report is empty for {seg_name}", file=sys.stderr)
                    continue

                returns = report_df["return"].dropna() if "return" in report_df.columns else pd.Series()
                if returns.empty:
                    print(f"[InSampleBacktestService] Returns is empty for {seg_name}", file=sys.stderr)
                    continue

                # 获取日期索引
                dates = []
                if hasattr(report_df.index, 'to_list'):
                    dates = [str(d)[:10] for d in report_df.index.to_list()]
                else:
                    dates = [str(d)[:10] for d in report_df.index]

                # 计算累计收益
                cum_ret = (1 + returns).cumprod()
                total_return = float(cum_ret.iloc[-1] / cum_ret.iloc[0] - 1) if len(cum_ret) > 1 else 0.0
                n_days = len(returns)
                ann_return = float(returns.mean() * 252)
                ann_vol = float(returns.std() * np.sqrt(252))
                sharpe = float(ann_return / ann_vol) if ann_vol > 0 else 0.0

                # 计算回撤
                running_max = cum_ret.cummax()
                drawdown = (cum_ret - running_max) / running_max
                max_dd = float(drawdown.min())

                # 基本风险指标
                risk_metrics = {
                    "available": True,
                    "total_days": int(n_days),
                    "total_return": round(total_return, 6),
                    "annualized_return": round(ann_return, 6),
                    "annualized_volatility": round(ann_vol, 6),
                    "sharpe_ratio": round(sharpe, 4),
                    "max_drawdown": round(max_dd, 6),
                    "mean_daily_return": round(float(returns.mean()), 8),
                    "std_daily_return": round(float(returns.std()), 8),
                    "win_rate": round(float((returns > 0).mean()), 4),
                }

                # 基准相关指标
                bench_cum_ret = None
                bench_drawdown = None
                if "bench" in report_df.columns:
                    bench_returns = report_df["bench"].dropna()
                    excess = returns - bench_returns
                    risk_metrics["excess_annualized_return"] = round(float(excess.mean() * 252), 6)
                    risk_metrics["information_ratio"] = round(
                        float(excess.mean() / excess.std() * np.sqrt(252)) if excess.std() > 0 else 0, 4
                    )
                    # 计算基准累计收益和回撤
                    bench_cum_ret = (1 + bench_returns).cumprod().tolist()
                    bench_running_max = pd.Series(bench_cum_ret).cummax()
                    bench_drawdown = ((pd.Series(bench_cum_ret) - bench_running_max) / bench_running_max).tolist()

                # 换手率数据
                turnover_series = None
                if "turnover" in report_df.columns:
                    turnover_series = report_df["turnover"].dropna().tolist()
                    risk_metrics["mean_turnover"] = round(float(np.mean(turnover_series)), 6)

                # 日收益率分布统计
                daily_return_dist = {
                    "available": True,
                    "mean": float(returns.mean()),
                    "std": float(returns.std()),
                    "min": float(returns.min()),
                    "max": float(returns.max()),
                    "median": float(returns.median()),
                    "skewness": float(returns.skew()) if len(returns) > 2 else 0,
                    "kurtosis": float(returns.kurtosis()) if len(returns) > 3 else 0,
                    "positive_ratio": float((returns > 0).mean()),
                    "negative_days": int((returns < 0).sum()),
                    "count": len(returns),
                }

                # 计算直方图数据
                try:
                    hist, bin_edges = np.histogram(returns, bins=30)
                    bin_centers = ((bin_edges[:-1] + bin_edges[1:]) / 2).tolist()
                    daily_return_dist["histogram"] = {
                        "counts": hist.tolist(),
                        "bins": bin_edges.tolist(),
                        "bin_centers": bin_centers,
                    }
                except Exception:
                    pass

                time_min = str(report_df.index.min())
                time_max = str(report_df.index.max())

                # 构建完整的 segment 结果
                segment_result = {
                    "pred_shape": None,
                    "n_stocks": None,
                    "time_range": [time_min, time_max],
                    "risk_metrics": risk_metrics,
                    "indicator_dict": {},
                    # 新增：详细时序数据
                    "portfolio_data": {
                        "available": True,
                        "dates": dates,
                        "cumulative_return": {
                            "strategy": cum_ret.tolist(),
                            "benchmark": bench_cum_ret,
                        },
                        "drawdown": {
                            "strategy": drawdown.tolist(),
                            "benchmark": bench_drawdown,
                        },
                        "daily_return": {
                            "strategy": returns.tolist(),
                        },
                        "turnover": turnover_series,
                    },
                    "daily_return_distribution": daily_return_dist,
                }

                # 尝试加载 IC 分析数据
                # 路径1: artifacts 目录下的 ic_analysis.json (MultiSegmentSignalRecord 生成的，包含IC和RankIC)
                ic_json_file_test = seg_dir.parent / "ic_analysis.json" if seg_name == "test" else seg_dir.parent / f"ic_analysis_{seg_name}.json"
                # 路径2: segment目录下的ic_analysis.pkl
                ic_file = seg_dir / "ic_analysis.pkl"
                # 路径3: insample_analysis目录下的JSON文件
                ic_json_file_insample = seg_dir.parent / "insample_analysis" / f"ic_analysis_{seg_name}.json"
                # 路径4: sig_analysis目录下的ic.pkl (SigAnaRecord生成的)
                sig_analysis_dir = seg_dir.parent / "sig_analysis"
                sig_ic_file = sig_analysis_dir / "ic.pkl"
                sig_ric_file = sig_analysis_dir / "ric.pkl"
                
                print(f"[InSampleBacktestService] IC JSON file (MultiSegment): {ic_json_file_test}, exists={ic_json_file_test.exists()}", file=sys.stderr)
                print(f"[InSampleBacktestService] IC JSON file (insample): {ic_json_file_insample}, exists={ic_json_file_insample.exists()}", file=sys.stderr)
                print(f"[InSampleBacktestService] IC PKL file: {ic_file}, exists={ic_file.exists()}", file=sys.stderr)
                print(f"[InSampleBacktestService] Sig IC file: {sig_ic_file}, exists={sig_ic_file.exists()}", file=sys.stderr)
                
                ic_data_loaded = False
                rank_ic_loaded = False
                
                # 优先尝试加载 MultiSegmentSignalRecord 生成的 JSON 格式 IC 数据（包含IC和RankIC）
                if ic_json_file_test.exists():
                    try:
                        import json
                        with open(ic_json_file_test, "r") as f:
                            ic_json_data = json.load(f)
                        print(f"[InSampleBacktestService] MultiSegment IC JSON data: available={ic_json_data.get('available')}, dates={len(ic_json_data.get('dates', []))}", file=sys.stderr)
                        if ic_json_data and ic_json_data.get("available"):
                            segment_result["ic_analysis"] = {
                                "available": True,
                                "dates": ic_json_data.get("dates", []),
                                "ic_values": ic_json_data.get("ic_values", []),
                                "mean_ic": ic_json_data.get("mean_ic"),
                                "std_ic": ic_json_data.get("std_ic"),
                                "icir": ic_json_data.get("icir"),
                                "hit_rate": ic_json_data.get("hit_rate"),
                                "rolling_icir": ic_json_data.get("rolling_icir"),
                                "rolling_window": ic_json_data.get("rolling_window"),
                            }
                            ic_data_loaded = True
                            # 同时加载 Rank IC 数据
                            if ic_json_data.get("rank_ic_values"):
                                segment_result["rank_ic_analysis"] = {
                                    "available": True,
                                    "dates": ic_json_data.get("dates", []),
                                    "rank_ic_values": ic_json_data.get("rank_ic_values", []),
                                    "mean_rank_ic": ic_json_data.get("mean_rank_ic"),
                                    "std_rank_ic": ic_json_data.get("std_rank_ic"),
                                    "rank_icir": ic_json_data.get("rank_icir"),
                                    "hit_rate": ic_json_data.get("rank_hit_rate"),
                                    "rolling_rank_icir": ic_json_data.get("rolling_rank_icir"),
                                    "rolling_window": ic_json_data.get("rolling_window"),
                                }
                                rank_ic_loaded = True
                            print(f"[InSampleBacktestService] MultiSegment IC JSON loaded for {seg_name}, rank_ic_loaded={rank_ic_loaded}", file=sys.stderr)
                    except Exception as e:
                        print(f"[InSampleBacktestService] Error loading MultiSegment IC JSON {seg_name}: {e}", file=sys.stderr)
                
                # 回退到 insample_analysis 目录下的 JSON 文件
                if not ic_data_loaded and ic_json_file_insample.exists():
                    try:
                        import json
                        with open(ic_json_file_insample, "r") as f:
                            ic_json_data = json.load(f)
                        print(f"[InSampleBacktestService] IC JSON data: available={ic_json_data.get('available')}, dates={len(ic_json_data.get('dates', []))}", file=sys.stderr)
                        if ic_json_data and ic_json_data.get("available"):
                            segment_result["ic_analysis"] = ic_json_data
                            ic_data_loaded = True
                            print(f"[InSampleBacktestService] IC JSON loaded for {seg_name}", file=sys.stderr)
                    except Exception as e:
                        print(f"[InSampleBacktestService] Error loading IC JSON {seg_name}: {e}", file=sys.stderr)
                
                # 回退到 PKL 格式 (segment目录)
                if not ic_data_loaded and ic_file.exists():
                    try:
                        with open(ic_file, "rb") as f:
                            ic_data = pickle.load(f)
                        if ic_data is not None and not ic_data.empty:
                            ic_values = ic_data.iloc[:, 0].tolist() if hasattr(ic_data, 'iloc') else ic_data.tolist()
                            ic_dates = [str(d)[:10] for d in ic_data.index] if hasattr(ic_data, 'index') else list(range(len(ic_values)))
                            ic_arr = np.array([v for v in ic_values if v is not None and not np.isnan(v)])
                            
                            # 计算滚动 ICIR
                            rolling_window = min(20, len(ic_arr))
                            rolling_icir = None
                            if len(ic_arr) >= rolling_window:
                                ic_series = pd.Series(ic_arr)
                                rolling_mean = ic_series.rolling(window=rolling_window).mean()
                                rolling_std = ic_series.rolling(window=rolling_window).std()
                                rolling_icir = (rolling_mean / rolling_std).tolist()
                            
                            segment_result["ic_analysis"] = {
                                "available": True,
                                "dates": ic_dates,
                                "ic_values": ic_values,
                                "mean_ic": float(np.mean(ic_arr)) if len(ic_arr) > 0 else None,
                                "std_ic": float(np.std(ic_arr)) if len(ic_arr) > 0 else None,
                                "icir": float(np.mean(ic_arr) / np.std(ic_arr)) if len(ic_arr) > 0 and np.std(ic_arr) > 0 else None,
                                "hit_rate": float((ic_arr > 0).mean()) if len(ic_arr) > 0 else None,
                                "rolling_icir": rolling_icir,
                                "rolling_window": rolling_window,
                            }
                            ic_data_loaded = True
                            print(f"[InSampleBacktestService] IC PKL loaded from segment dir for {seg_name}", file=sys.stderr)
                    except Exception as e:
                        print(f"[InSampleBacktestService] Error loading IC PKL {seg_name}: {e}")
                
                # 尝试从 sig_analysis 目录加载 IC 数据 (SigAnaRecord生成的，只针对test segment)
                if not ic_data_loaded and sig_ic_file.exists() and seg_name == "test":
                    try:
                        with open(sig_ic_file, "rb") as f:
                            ic_data = pickle.load(f)
                        if ic_data is not None and not ic_data.empty:
                            print(f"[InSampleBacktestService] Sig IC data type: {type(ic_data)}, shape: {getattr(ic_data, 'shape', 'N/A')}", file=sys.stderr)
                            
                            # 处理不同的数据格式
                            if isinstance(ic_data, pd.DataFrame):
                                ic_values = ic_data.iloc[:, 0].tolist()
                                ic_dates = [str(d)[:10] for d in ic_data.index]
                            elif isinstance(ic_data, pd.Series):
                                ic_values = ic_data.tolist()
                                ic_dates = [str(d)[:10] for d in ic_data.index]
                            else:
                                ic_values = list(ic_data)
                                ic_dates = list(range(len(ic_values)))
                            
                            ic_arr = np.array([v for v in ic_values if v is not None and not np.isnan(v)])
                            
                            if len(ic_arr) > 0:
                                # 计算滚动 ICIR
                                rolling_window = min(20, len(ic_arr))
                                rolling_icir = None
                                if len(ic_arr) >= rolling_window:
                                    ic_series = pd.Series(ic_arr)
                                    rolling_mean = ic_series.rolling(window=rolling_window).mean()
                                    rolling_std = ic_series.rolling(window=rolling_window).std()
                                    rolling_icir = (rolling_mean / rolling_std).tolist()
                                
                                segment_result["ic_analysis"] = {
                                    "available": True,
                                    "dates": ic_dates,
                                    "ic_values": ic_values,
                                    "mean_ic": float(np.mean(ic_arr)),
                                    "std_ic": float(np.std(ic_arr)),
                                    "icir": float(np.mean(ic_arr) / np.std(ic_arr)) if np.std(ic_arr) > 0 else 0,
                                    "hit_rate": float((ic_arr > 0).mean()),
                                    "rolling_icir": rolling_icir,
                                    "rolling_window": rolling_window,
                                }
                                ic_data_loaded = True
                                mean_ic = np.mean(ic_arr)
                                std_ic = np.std(ic_arr)
                                icir_val = mean_ic / std_ic if std_ic > 0 else 0
                                print(f"[InSampleBacktestService] Sig IC loaded for {seg_name}: mean_ic={mean_ic:.4f}, icir={icir_val:.4f}", file=sys.stderr)
                    except Exception as e:
                        print(f"[InSampleBacktestService] Error loading sig IC for {seg_name}: {e}", file=sys.stderr)

                # 尝试加载 Rank IC 分析数据（注意：不重置 rank_ic_loaded，保留 Path 1 已加载的状态）
                rank_ic_json_file = seg_dir.parent / "insample_analysis" / f"rank_ic_analysis_{seg_name}.json"
                print(f"[InSampleBacktestService] Rank IC JSON file: {rank_ic_json_file}, exists={rank_ic_json_file.exists()}", file=sys.stderr)
                print(f"[InSampleBacktestService] Sig RIC file: {sig_ric_file}, exists={sig_ric_file.exists()}", file=sys.stderr)
                print(f"[InSampleBacktestService] rank_ic_loaded (before secondary paths): {rank_ic_loaded}", file=sys.stderr)
                
                if rank_ic_json_file.exists():
                    try:
                        import json
                        with open(rank_ic_json_file, "r") as f:
                            rank_ic_json_data = json.load(f)
                        print(f"[InSampleBacktestService] Rank IC JSON data: available={rank_ic_json_data.get('available')}, dates={len(rank_ic_json_data.get('dates', []))}", file=sys.stderr)
                        if rank_ic_json_data and rank_ic_json_data.get("available"):
                            segment_result["rank_ic_analysis"] = rank_ic_json_data
                            rank_ic_loaded = True
                            print(f"[InSampleBacktestService] Rank IC JSON loaded for {seg_name}", file=sys.stderr)
                    except Exception as e:
                        print(f"[InSampleBacktestService] Error loading Rank IC JSON {seg_name}: {e}", file=sys.stderr)
                
                # 尝试从 sig_analysis 目录加载 Rank IC 数据
                if not rank_ic_loaded and sig_ric_file.exists() and seg_name == "test":
                    try:
                        with open(sig_ric_file, "rb") as f:
                            ric_data = pickle.load(f)
                        if ric_data is not None and not ric_data.empty:
                            print(f"[InSampleBacktestService] Sig RIC data type: {type(ric_data)}, shape: {getattr(ric_data, 'shape', 'N/A')}", file=sys.stderr)
                            
                            # 处理不同的数据格式
                            if isinstance(ric_data, pd.DataFrame):
                                ric_values = ric_data.iloc[:, 0].tolist()
                                ric_dates = [str(d)[:10] for d in ric_data.index]
                            elif isinstance(ric_data, pd.Series):
                                ric_values = ric_data.tolist()
                                ric_dates = [str(d)[:10] for d in ric_data.index]
                            else:
                                ric_values = list(ric_data)
                                ric_dates = list(range(len(ric_values)))
                            
                            ric_arr = np.array([v for v in ric_values if v is not None and not np.isnan(v)])
                            
                            if len(ric_arr) > 0:
                                # 计算滚动 Rank ICIR
                                rolling_window = min(20, len(ric_arr))
                                rolling_ricir = None
                                if len(ric_arr) >= rolling_window:
                                    ric_series = pd.Series(ric_arr)
                                    rolling_mean = ric_series.rolling(window=rolling_window).mean()
                                    rolling_std = ric_series.rolling(window=rolling_window).std()
                                    rolling_ricir = (rolling_mean / rolling_std).tolist()
                                
                                segment_result["rank_ic_analysis"] = {
                                    "available": True,
                                    "dates": ric_dates,
                                    "rank_ic_values": ric_values,
                                    "mean_rank_ic": float(np.mean(ric_arr)),
                                    "std_rank_ic": float(np.std(ric_arr)),
                                    "rank_icir": float(np.mean(ric_arr) / np.std(ric_arr)) if np.std(ric_arr) > 0 else 0,
                                    "hit_rate": float((ric_arr > 0).mean()),
                                    "rolling_rank_icir": rolling_ricir,
                                    "rolling_window": rolling_window,
                                }
                                rank_ic_loaded = True
                                mean_ric = np.mean(ric_arr)
                                std_ric = np.std(ric_arr)
                                ricir_val = mean_ric / std_ric if std_ric > 0 else 0
                                print(f"[InSampleBacktestService] Sig RIC loaded for {seg_name}: mean_ric={mean_ric:.4f}, ricir={ricir_val:.4f}", file=sys.stderr)
                    except Exception as e:
                        print(f"[InSampleBacktestService] Error loading sig RIC for {seg_name}: {e}", file=sys.stderr)

                # 方法5: 从 pred 和 label 文件计算 IC（适用于所有 segment）
                # 同时计算 pred_label_data 用于散点图和直方图
                try:
                    pred_filename = "pred.pkl" if seg_name == "test" else f"pred_{seg_name}.pkl"
                    pred_path = run_path / "artifacts" / pred_filename
                    label_filename = "label.pkl" if seg_name == "test" else f"label_{seg_name}.pkl"
                    label_path = run_path / "artifacts" / label_filename
                    
                    print(f"[InSampleBacktestService] Checking pred/label for {seg_name}", file=sys.stderr)
                    print(f"[InSampleBacktestService] pred_path: {pred_path}, exists={pred_path.exists()}", file=sys.stderr)
                    print(f"[InSampleBacktestService] label_path: {label_path}, exists={label_path.exists()}", file=sys.stderr)
                    
                    if pred_path.exists() and label_path.exists():
                        with open(pred_path, "rb") as f:
                            pred_df = pickle.load(f)
                        with open(label_path, "rb") as f:
                            label_df = pickle.load(f)
                        
                        print(f"[InSampleBacktestService] pred_df shape: {pred_df.shape}, index names: {pred_df.index.names if hasattr(pred_df.index, 'names') else 'N/A'}", file=sys.stderr)
                        print(f"[InSampleBacktestService] label_df shape: {label_df.shape}, index names: {label_df.index.names if hasattr(label_df.index, 'names') else 'N/A'}", file=sys.stderr)
                        
                        # 对齐索引
                        common_index = pred_df.index.intersection(label_df.index)
                        print(f"[InSampleBacktestService] common_index size: {len(common_index)}", file=sys.stderr)
                        
                        if len(common_index) > 0:
                            pred_aligned = pred_df.loc[common_index]
                            label_aligned = label_df.loc[common_index]
                            
                            # 计算 pred_label_data 用于散点图和直方图
                            scores_all = pred_aligned.iloc[:, 0].values if hasattr(pred_aligned, 'iloc') else pred_aligned.values.flatten()
                            labels_all = label_aligned.iloc[:, 0].values if hasattr(label_aligned, 'iloc') else label_aligned.values.flatten()
                            
                            valid_mask = ~(np.isnan(scores_all) | np.isnan(labels_all))
                            scores_valid = scores_all[valid_mask]
                            labels_valid = labels_all[valid_mask]
                            
                            if len(scores_valid) > 0:
                                from scipy.stats import pearsonr
                                corr, _ = pearsonr(scores_valid, labels_valid)
                                
                                def compute_histogram(values, n_bins=30):
                                    if len(values) == 0:
                                        return None
                                    min_val, max_val = np.min(values), np.max(values)
                                    if min_val == max_val:
                                        return {"counts": [len(values)], "bins": [min_val, max_val], "bin_centers": [min_val]}
                                    bin_edges = np.linspace(min_val, max_val, n_bins + 1)
                                    counts, _ = np.histogram(values, bins=bin_edges)
                                    bin_centers = (bin_edges[:-1] + bin_edges[1:]) / 2
                                    return {
                                        "counts": counts.tolist(),
                                        "bins": bin_edges.tolist(),
                                        "bin_centers": bin_centers.tolist(),
                                    }
                                
                                segment_result["pred_label_data"] = {
                                    "available": True,
                                    "scores": scores_valid.tolist()[:5000],
                                    "labels": labels_valid.tolist()[:5000],
                                    "correlation": float(corr),
                                    "count": len(scores_valid),
                                    "score_mean": float(np.mean(scores_valid)),
                                    "score_std": float(np.std(scores_valid)),
                                    "label_mean": float(np.mean(labels_valid)),
                                    "label_std": float(np.std(labels_valid)),
                                    "score_histogram": compute_histogram(scores_valid),
                                    "label_histogram": compute_histogram(labels_valid),
                                }
                                print(f"[InSampleBacktestService] Added pred_label_data for {seg_name}: count={len(scores_valid)}, corr={corr:.4f}", file=sys.stderr)
                            
                            # 计算 Lag IC 衰减和持仓分析
                            try:
                                segment_result["lag_ic"] = _compute_lag_ic(pred_aligned, label_aligned)
                                segment_result["holdings_analysis"] = _compute_holdings_analysis(pred_aligned, top_k=7)
                                print(f"[InSampleBacktestService] Computed lag_ic and holdings_analysis for {seg_name}", file=sys.stderr)
                            except Exception as _e:
                                print(f"[InSampleBacktestService] Error computing lag_ic/holdings for {seg_name}: {_e}", file=sys.stderr)

                            # 如果 IC 或 Rank IC 未加载，则计算
                            if not ic_data_loaded or not rank_ic_loaded:
                                print(f"[InSampleBacktestService] Computing IC from pred/label for {seg_name}", file=sys.stderr)
                                # 按日期分组计算 IC
                                if hasattr(pred_aligned.index, 'get_level_values'):
                                    from scipy import stats
                                    dates = pred_aligned.index.get_level_values(0).unique()
                                    ic_values = []
                                    rank_ic_values = []
                                    ic_dates = []
                                    rank_ic_dates = []

                                    for date in dates:
                                        try:
                                            pred_day = pred_aligned.loc[date]
                                            label_day = label_aligned.loc[date]

                                            pred_vals = pred_day.iloc[:, 0].values if hasattr(pred_day, 'iloc') else pred_day.values
                                            label_vals = label_day.iloc[:, 0].values if hasattr(label_day, 'iloc') else label_day.values

                                            if len(pred_vals) > 1 and len(label_vals) > 1:
                                                date_str = str(date)[:10]
                                                # IC (Spearman)
                                                ic, _ = stats.spearmanr(pred_vals, label_vals)
                                                if not np.isnan(ic):
                                                    ic_values.append(ic)
                                                    ic_dates.append(date_str)

                                                # Rank IC (Pearson on ranks)，使用独立的 rank_ic_dates 避免与 ic_dates 错位
                                                pred_rank = pd.Series(pred_vals).rank()
                                                label_rank = pd.Series(label_vals).rank()
                                                rank_ic, _ = stats.pearsonr(pred_rank, label_rank)
                                                if not np.isnan(rank_ic):
                                                    rank_ic_values.append(rank_ic)
                                                    rank_ic_dates.append(date_str)
                                        except Exception as day_e:
                                            pass
                                    
                                    print(f"[InSampleBacktestService] Computed {len(ic_values)} IC values for {seg_name}", file=sys.stderr)
                                    
                                    if ic_values and not ic_data_loaded:
                                        ic_arr = np.array(ic_values)
                                        rolling_window = min(20, len(ic_arr))
                                        rolling_icir = None
                                        if len(ic_arr) >= rolling_window:
                                            ic_series = pd.Series(ic_arr)
                                            rolling_mean = ic_series.rolling(window=rolling_window).mean()
                                            rolling_std = ic_series.rolling(window=rolling_window).std()
                                            rolling_icir = (rolling_mean / rolling_std).tolist()
                                        
                                        segment_result["ic_analysis"] = {
                                            "available": True,
                                            "dates": ic_dates,
                                            "ic_values": ic_values,
                                            "mean_ic": float(np.mean(ic_arr)),
                                            "std_ic": float(np.std(ic_arr)),
                                            "icir": float(np.mean(ic_arr) / np.std(ic_arr)) if np.std(ic_arr) > 0 else 0,
                                            "hit_rate": float((ic_arr > 0).mean()),
                                            "rolling_icir": rolling_icir,
                                            "rolling_window": rolling_window,
                                        }
                                        ic_data_loaded = True
                                        print(f"[InSampleBacktestService] Computed IC for {seg_name}: mean_ic={np.mean(ic_arr):.4f}", file=sys.stderr)
                                    
                                    if rank_ic_values and not rank_ic_loaded:
                                        ric_arr = np.array(rank_ic_values)
                                        rolling_window = min(20, len(ric_arr))
                                        rolling_ricir = None
                                        if len(ric_arr) >= rolling_window:
                                            ric_series = pd.Series(ric_arr)
                                            rolling_mean = ric_series.rolling(window=rolling_window).mean()
                                            rolling_std = ric_series.rolling(window=rolling_window).std()
                                            rolling_ricir = (rolling_mean / rolling_std).tolist()
                                        
                                        segment_result["rank_ic_analysis"] = {
                                            "available": True,
                                            "dates": rank_ic_dates,
                                            "rank_ic_values": rank_ic_values,
                                            "mean_rank_ic": float(np.mean(ric_arr)),
                                            "std_rank_ic": float(np.std(ric_arr)),
                                            "rank_icir": float(np.mean(ric_arr) / np.std(ric_arr)) if np.std(ric_arr) > 0 else 0,
                                            "hit_rate": float((ric_arr > 0).mean()),
                                            "rolling_rank_icir": rolling_ricir,
                                            "rolling_window": rolling_window,
                                        }
                                        rank_ic_loaded = True
                                        print(f"[InSampleBacktestService] Computed Rank IC for {seg_name}: mean_ric={np.mean(ric_arr):.4f}", file=sys.stderr)
                except Exception as e:
                    print(f"[InSampleBacktestService] Error computing IC from pred/label for {seg_name}: {e}", file=sys.stderr)

                # 仓位分析
                try:
                    segment_result["position_analysis"] = _compute_position_analysis(seg_dir)
                    if segment_result["position_analysis"].get("available"):
                        print(f"[InSampleBacktestService] Loaded position analysis for {seg_name}: {len(segment_result['position_analysis']['dates'])} days", file=sys.stderr)
                except Exception as e:
                    print(f"[InSampleBacktestService] Error computing position analysis for {seg_name}: {e}", file=sys.stderr)

                print(f"[InSampleBacktestService] Segment {seg_name} result: hasIC={bool(segment_result.get('ic_analysis'))}, hasRankIC={bool(segment_result.get('rank_ic_analysis'))}", file=sys.stderr)
                results["segments"][seg_name] = segment_result

            except Exception as e:
                print(f"[InSampleBacktestService] Error loading {seg_name}: {e}")
                continue

        if not results["segments"]:
            return {
                "success": False,
                "message": "未找到已有的 In-Sample 回测结果，请先运行 In-Sample 回测",
                "data": None,
            }

        return {
            "success": True,
            "message": f"已加载 {len(results['segments'])} 个 segment 的回测结果",
            "data": results,
        }
