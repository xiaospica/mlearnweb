"""训练记录对比服务

对 2~3 条训练记录并行加载合并报告，返回对比所需的全部数据。
底层复用 routers.training_records 中已有的 merged-report helpers，避免重复实现。
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List

from sqlalchemy.orm import Session

from app.services.training_service import TrainingService
from app.utils.mlflow_reader import mlflow_reader

logger = logging.getLogger(__name__)

MIN_COMPARE = 2
MAX_COMPARE = 3


class TrainingCompareService:
    @staticmethod
    def get_compare_data(db: Session, ids: List[int]) -> Dict[str, Any]:
        if len(ids) < MIN_COMPARE or len(ids) > MAX_COMPARE:
            raise ValueError(
                f"对比条数需在 {MIN_COMPARE}~{MAX_COMPARE} 之间，当前传入 {len(ids)} 条"
            )
        if len(set(ids)) != len(ids):
            raise ValueError("ids 不能重复")

        # 避免 router 级别的循环导入，延迟 import helpers
        from app.routers.training_records import (
            _compute_annual_returns,
            _compute_merged_metrics,
            _compute_monthly_returns,
            _compute_rolling_stats,
            _merge_ic_analysis,
            _merge_rolling_returns,
        )

        records_out: List[Dict[str, Any]] = []
        for rid in ids:
            record = TrainingService.get_record(db, rid)
            if not record:
                records_out.append({
                    "id": rid,
                    "available": False,
                    "error": "record_not_found",
                })
                continue

            entry: Dict[str, Any] = {
                "id": rid,
                "available": False,
                "name": record.get("name"),
                "category": record.get("category"),
                "experiment_id": record.get("experiment_id"),
                "experiment_name": record.get("experiment_name"),
                "status": record.get("status"),
                "summary_metrics": record.get("summary_metrics") or {},
                "config_snapshot": record.get("config_snapshot") or {},
                "tags": record.get("tags") or [],
                "merged_report": None,
                "merged_metrics": None,
                "ic_analysis": None,
                "monthly_returns": None,
                "annual_returns": None,
                "rolling_stats": None,
                "individual_runs": [],
            }

            run_mappings = record.get("run_mappings") or []
            experiment_id = record.get("experiment_id")
            if not run_mappings or not experiment_id:
                records_out.append(entry)
                continue

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
                except Exception as e:  # noqa: BLE001
                    logger.warning(
                        "[TrainingCompare] load_portfolio_report failed id=%s run_id=%s: %s",
                        rid, run_id, e,
                    )
                    continue

            if not all_reports:
                records_out.append(entry)
                continue

            merged_data = _merge_rolling_returns(all_reports)
            merged_metrics = _compute_merged_metrics(merged_data)
            ic_analysis = _merge_ic_analysis(experiment_id, [r["run_id"] for r in all_reports])
            monthly_returns = _compute_monthly_returns(merged_data)
            annual_returns = _compute_annual_returns(merged_data)
            rolling_stats = _compute_rolling_stats(merged_data)

            entry.update({
                "available": True,
                "merged_report": merged_data,
                "merged_metrics": merged_metrics,
                "ic_analysis": ic_analysis,
                "monthly_returns": monthly_returns,
                "annual_returns": annual_returns,
                "rolling_stats": rolling_stats,
                "individual_runs": [
                    {
                        "run_id": (r["run_id"][:16] + "...") if len(r["run_id"]) > 16 else r["run_id"],
                        "rolling_index": r["rolling_index"],
                        "segment_label": r["segment_label"],
                        "test_range": f"{(r['test_start'] or '?')[:10]} ~ {(r['test_end'] or '?')[:10]}",
                        "data_points": len(r["report_df"]),
                    }
                    for r in all_reports
                ],
            })
            records_out.append(entry)

        return {"records": records_out}
