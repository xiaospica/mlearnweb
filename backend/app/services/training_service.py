from typing import Any, Dict, List, Optional
from datetime import datetime
from pathlib import Path
import socket
import platform
import sys
import numpy as np
import pandas as pd

from sqlalchemy.orm import Session

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
            started_at=datetime.utcnow(),
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
        for key, value in update_data.items():
            if hasattr(record, key) and value is not None:
                setattr(record, key, value)
        db.commit()
        db.refresh(record)
        return record

    @staticmethod
    def delete_record(db: Session, record_id: int) -> bool:
        record = db.query(TrainingRecord).filter(TrainingRecord.id == record_id).first()
        if not record:
            return False
        db.delete(record)
        db.commit()
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
            current_ids = record.run_ids or []
            if run_id not in current_ids:
                current_ids.append(run_id)
                record.run_ids = current_ids
                record.updated_at = datetime.utcnow()

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


class InSampleBacktestService:
    """In-Sample 回测服务 - 对已有 MLflow Run 执行 train/valid/test 多 segment 预测和回测"""

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
        from app.core.config import settings
        import pickle

        mlruns_dir = Path(settings.mlruns_dir)
        run_path = mlruns_dir / experiment_id / run_id

        if not run_path.exists():
            return {"success": False, "message": f"Run 目录不存在: {run_path}", "data": None}

        artifacts_path = run_path / "artifacts"
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
            if not seg_dir.exists():
                continue

            report_file = seg_dir / "report_normal_1day.pkl"
            if not report_file.exists():
                continue

            try:
                with open(report_file, "rb") as f:
                    report_df = pickle.load(f)

                if report_df is None or report_df.empty:
                    continue

                returns = report_df["return"].dropna() if "return" in report_df.columns else pd.Series()
                if returns.empty:
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
                ic_file = seg_dir / "ic_analysis.pkl"
                if ic_file.exists():
                    try:
                        with open(ic_file, "rb") as f:
                            ic_data = pickle.load(f)
                        if ic_data is not None and not ic_data.empty:
                            ic_values = ic_data.iloc[:, 0].tolist() if hasattr(ic_data, 'iloc') else ic_data.tolist()
                            ic_dates = [str(d)[:10] for d in ic_data.index] if hasattr(ic_data, 'index') else list(range(len(ic_values)))
                            ic_arr = np.array([v for v in ic_values if v is not None and not np.isnan(v)])
                            segment_result["ic_analysis"] = {
                                "available": True,
                                "dates": ic_dates,
                                "ic_values": ic_values,
                                "mean_ic": float(np.mean(ic_arr)) if len(ic_arr) > 0 else None,
                                "std_ic": float(np.std(ic_arr)) if len(ic_arr) > 0 else None,
                                "icir": float(np.mean(ic_arr) / np.std(ic_arr)) if len(ic_arr) > 0 and np.std(ic_arr) > 0 else None,
                                "hit_rate": float((ic_arr > 0).mean()) if len(ic_arr) > 0 else None,
                            }
                    except Exception:
                        pass

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
