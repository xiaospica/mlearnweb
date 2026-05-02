"""一次性脚本：从 D:/ml_output/{strategy}/{day}/predictions.parquet 算
score_histogram + pred_mean / pred_std / pred_zero_ratio + n_predictions，
UPDATE ml_metric_snapshots + ml_prediction_daily 行。

为什么需要：
  vnpy vendor 的 run_inference batch 模式刻意不写 metrics.json (注释"简化版")，
  所以 ml_metric_snapshots 的 psi_mean / pred_mean / pred_std 字段全 None,
  ml_prediction_daily 的 score_histogram_json 全是空 [] →
  策略监控 tab 的 "预测分数直方图" 等图表无数据。

PSI 计算需要 baseline_parquet 对比, 先跳过 (PSI 是模型监控指标, 跟训练时点
特征分布对比, 单日维度无意义); 重点回填 histogram + pred_stats 让前端可见。
"""
from __future__ import annotations

import json
import sqlite3
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List

import numpy as np
import pandas as pd

OUTPUT_ROOT = Path(r"D:/ml_output")
MLEARNWEB_DB = Path(r"f:/Quant/code/qlib_strategy_dev/mlearnweb/backend/mlearnweb.db")


def _compute_score_histogram(scores: pd.Series, n_bins: int = 20) -> List[Dict[str, float]]:
    """与 qlib_strategy_core.metrics.compute_score_histogram 同源."""
    arr = scores.dropna().to_numpy()
    if arr.size == 0:
        return []
    counts, edges = np.histogram(arr, bins=n_bins)
    return [
        {
            "bin_left": float(edges[i]),
            "bin_right": float(edges[i + 1]),
            "count": int(counts[i]),
        }
        for i in range(n_bins)
    ]


def _compute_pred_stats(scores: pd.Series) -> Dict[str, Any]:
    arr = scores.dropna().to_numpy()
    if arr.size == 0:
        return {"pred_mean": None, "pred_std": None, "pred_zero_ratio": None, "n_predictions": 0}
    return {
        "pred_mean": float(arr.mean()),
        "pred_std": float(arr.std()),
        "pred_zero_ratio": float((arr == 0).mean()),
        "n_predictions": int(arr.size),
    }


def backfill_strategy(strategy_name: str) -> int:
    base = OUTPUT_ROOT / strategy_name
    if not base.exists():
        print(f"  no dir: {base}")
        return 0

    conn = sqlite3.connect(str(MLEARNWEB_DB))
    cur = conn.cursor()

    n_metric_updated = 0
    n_pred_updated = 0
    for day_dir in sorted(base.iterdir()):
        if not day_dir.is_dir() or not day_dir.name.isdigit():
            continue
        pred_path = day_dir / "predictions.parquet"
        if not pred_path.exists():
            continue
        try:
            day = datetime.strptime(day_dir.name, "%Y%m%d").date()
            day_start = datetime.combine(day, datetime.min.time())
            day_end = day_start + timedelta(days=1)
        except Exception:
            continue
        try:
            pred = pd.read_parquet(pred_path)
        except Exception as e:
            print(f"  [skip] {day} read err: {e}")
            continue
        if pred.empty:
            continue
        scores = pred["score"] if "score" in pred.columns else pred.iloc[:, 0]

        stats = _compute_pred_stats(scores)
        histogram = _compute_score_histogram(scores, n_bins=20)
        hist_json = json.dumps(histogram, ensure_ascii=False)

        # UPDATE ml_metric_snapshots: pred_mean/std/zero_ratio/n_predictions
        n = cur.execute(
            """UPDATE ml_metric_snapshots SET
                   pred_mean = COALESCE(pred_mean, ?),
                   pred_std = COALESCE(pred_std, ?),
                   pred_zero_ratio = COALESCE(pred_zero_ratio, ?),
                   n_predictions = COALESCE(n_predictions, ?)
               WHERE strategy_name = ? AND trade_date >= ? AND trade_date < ?""",
            (stats["pred_mean"], stats["pred_std"], stats["pred_zero_ratio"], stats["n_predictions"],
             strategy_name, day_start, day_end),
        ).rowcount
        n_metric_updated += n

        # UPDATE ml_prediction_daily: score_histogram_json + pred_mean/std + n_symbols
        n = cur.execute(
            """UPDATE ml_prediction_daily SET
                   score_histogram_json = ?,
                   pred_mean = COALESCE(pred_mean, ?),
                   pred_std = COALESCE(pred_std, ?),
                   n_symbols = COALESCE(NULLIF(n_symbols, 0), ?)
               WHERE strategy_name = ? AND trade_date >= ? AND trade_date < ?""",
            (hist_json, stats["pred_mean"], stats["pred_std"], stats["n_predictions"],
             strategy_name, day_start, day_end),
        ).rowcount
        n_pred_updated += n

    conn.commit()
    conn.close()
    print(f"  ml_metric_snapshots updated: {n_metric_updated}")
    print(f"  ml_prediction_daily updated: {n_pred_updated}")
    return n_metric_updated + n_pred_updated


if __name__ == "__main__":
    strategies = sys.argv[1:] or ["csi300_lgb_headless"]
    for s in strategies:
        print(f"=== {s} ===")
        backfill_strategy(s)
