"""InSample 分层回测服务

复用 MultiSegmentSignalRecord 产出的 pred_{segment}.pkl / label_{segment}.pkl，
对 train/valid/test 三段分别调用 qlib 的 model_performance_graph 生成分层
累计收益曲线（5 组 + Long-Short + Long-Average）及其配套的分布/QQ 图。
"""
from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

import pandas as pd

from app.utils.mlflow_reader import mlflow_reader

logger = logging.getLogger(__name__)

SEGMENTS: List[str] = ["train", "valid", "test"]


def _artifact_file_names(segment: str) -> Dict[str, str]:
    """返回指定 segment 的 pred/label 文件名。

    test 段复用 SignalRecord 默认的 pred.pkl / label.pkl；
    train/valid 段为 MultiSegmentSignalRecord 额外产出的 pred_{seg}.pkl / label_{seg}.pkl。
    """
    if segment == "test":
        return {"pred": "pred.pkl", "label": "label.pkl"}
    return {"pred": f"pred_{segment}.pkl", "label": f"label_{segment}.pkl"}


def _load_pred_label_for_segment(
    experiment_id: str,
    run_id: str,
    segment: str,
) -> Optional[pd.DataFrame]:
    names = _artifact_file_names(segment)
    base = mlflow_reader.mlruns_dir / experiment_id / run_id / "artifacts"
    pred_path = base / names["pred"]
    label_path = base / names["label"]

    if not pred_path.exists() or not label_path.exists():
        logger.info(
            "[InsampleLayered] segment=%s missing files (pred=%s label=%s)",
            segment, pred_path.exists(), label_path.exists(),
        )
        return None

    pred_df = mlflow_reader._load_pickle(pred_path)
    label_df = mlflow_reader._load_pickle(label_path)
    if pred_df is None or label_df is None:
        return None

    combined = pd.concat([label_df, pred_df], axis=1, sort=True).reindex(label_df.index)
    combined.columns = ["label", "score"]
    combined = combined.dropna(subset=["score"])
    if combined.empty:
        return None
    return combined


def _extract_time_range(df: pd.DataFrame) -> Optional[List[str]]:
    if df is None or df.empty:
        return None
    try:
        if isinstance(df.index, pd.MultiIndex):
            dates = df.index.get_level_values(0)
        else:
            dates = df.index
        return [str(pd.Timestamp(dates.min()).date()), str(pd.Timestamp(dates.max()).date())]
    except Exception:
        return None


def _convert_value(obj: Any) -> Any:
    try:
        import numpy as np
    except ImportError:
        np = None  # type: ignore
    if np is not None:
        if isinstance(obj, np.ndarray):
            return obj.tolist()
        if isinstance(obj, (np.integer,)):
            return int(obj)
        if isinstance(obj, (np.floating,)):
            return float(obj)
        if isinstance(obj, np.bool_):
            return bool(obj)
    if isinstance(obj, dict):
        return {str(k): _convert_value(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_convert_value(v) for v in obj]
    if isinstance(obj, (str, int, float, bool)) or obj is None:
        return obj
    try:
        return str(obj)
    except Exception:
        return None


class InsampleLayeredService:
    """为 train/valid/test 三段生成 qlib model_performance_graph 图表数据。"""

    @staticmethod
    def get_layered_figures(experiment_id: str, run_id: str) -> Dict[str, Any]:
        print(
            f"[InsampleLayered] exp_id={experiment_id} run_id={run_id}",
            file=sys.stderr,
        )
        try:
            from qlib.contrib.report import analysis_model
        except ImportError as e:
            return {
                "available": False,
                "error": "qlib_import_failed",
                "detail": str(e),
            }

        segments_result: Dict[str, Any] = {}
        any_segment_ok = False

        for seg in SEGMENTS:
            pred_label = _load_pred_label_for_segment(experiment_id, run_id, seg)
            if pred_label is None:
                segments_result[seg] = {
                    "available": False,
                    "error": "artifacts_missing",
                }
                continue

            segment_entry: Dict[str, Any] = {
                "available": True,
                "sample_count": int(len(pred_label)),
                "time_range": _extract_time_range(pred_label),
                "figures": [],
            }

            try:
                figs = analysis_model.model_performance_graph(
                    pred_label, show_notebook=False
                )
                if figs:
                    segment_entry["figures"] = [_convert_value(fig.to_dict()) for fig in figs]
                any_segment_ok = True
            except Exception as e:  # noqa: BLE001
                logger.warning(
                    "[InsampleLayered] segment=%s model_performance_graph failed: %s",
                    seg, e,
                )
                segment_entry["available"] = False
                segment_entry["error"] = "figure_build_failed"
                segment_entry["detail"] = str(e)

            segments_result[seg] = segment_entry

        return {
            "available": any_segment_ok,
            "segments": segments_result,
        }
