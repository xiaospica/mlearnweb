"""ML 跨天聚合 — ICIR / PSI 趋势告警 / 回测-实盘差异.

Phase 3.3. 推理端(vnpy subprocess)只算单日指标,本服务从 MLMetricSnapshot /
MLPredictionDaily 时序里做跨天累计. 读路径:
    /api/live-trading/ml/{node_id}/{strategy_name}/metrics/history
    /api/live-trading/ml/{node_id}/{strategy_name}/metrics/rolling
    /api/live-trading/ml/{node_id}/{strategy_name}/prediction/summary/{yyyymmdd}
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from app.models.ml_monitoring import MLMetricSnapshot, MLPredictionDaily

logger = logging.getLogger(__name__)


ML_ENGINE_NAME = "MlStrategy"


# ---------------------------------------------------------------------------
# Row → dict helpers
# ---------------------------------------------------------------------------


def _metric_row_to_dict(row: MLMetricSnapshot) -> Dict[str, Any]:
    return {
        "node_id": row.node_id,
        "engine": row.engine,
        "strategy_name": row.strategy_name,
        "trade_date": row.trade_date.strftime("%Y-%m-%d") if row.trade_date else None,
        "ic": row.ic,
        "rank_ic": row.rank_ic,
        "psi_mean": row.psi_mean,
        "psi_max": row.psi_max,
        "psi_n_over_0_25": row.psi_n_over_0_25,
        "psi_by_feature": _safe_json(row.psi_by_feature_json),
        "ks_by_feature": _safe_json(row.ks_by_feature_json),
        "pred_mean": row.pred_mean,
        "pred_std": row.pred_std,
        "pred_zero_ratio": row.pred_zero_ratio,
        "n_predictions": row.n_predictions,
        "feat_missing": _safe_json(row.feat_missing_json),
        "model_run_id": row.model_run_id,
        "core_version": row.core_version,
        "status": row.status,
    }


def _prediction_row_to_dict(row: MLPredictionDaily) -> Dict[str, Any]:
    return {
        "node_id": row.node_id,
        "engine": row.engine,
        "strategy_name": row.strategy_name,
        "trade_date": row.trade_date.strftime("%Y-%m-%d") if row.trade_date else None,
        "topk": _safe_json(row.topk_json) or [],
        "score_histogram": _safe_json(row.score_histogram_json) or [],
        "n_symbols": row.n_symbols,
        "coverage_ratio": row.coverage_ratio,
        "pred_mean": row.pred_mean,
        "pred_std": row.pred_std,
        "model_run_id": row.model_run_id,
        "status": row.status,
    }


def _safe_json(raw: Optional[str]) -> Any:
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        return None


# ---------------------------------------------------------------------------
# Time-series queries
# ---------------------------------------------------------------------------


def get_metrics_history(
    db: Session,
    node_id: str,
    strategy_name: str,
    days: int = 30,
) -> List[Dict[str, Any]]:
    """按 trade_date 升序返回最近 N 日指标."""
    cutoff = datetime.now() - timedelta(days=days)
    rows = (
        db.query(MLMetricSnapshot)
        .filter(
            MLMetricSnapshot.node_id == node_id,
            MLMetricSnapshot.engine == ML_ENGINE_NAME,
            MLMetricSnapshot.strategy_name == strategy_name,
            MLMetricSnapshot.trade_date >= cutoff,
        )
        .order_by(MLMetricSnapshot.trade_date.asc())
        .all()
    )
    return [_metric_row_to_dict(r) for r in rows]


def get_prediction_by_date(
    db: Session,
    node_id: str,
    strategy_name: str,
    trade_date_str: str,
) -> Optional[Dict[str, Any]]:
    """按日期 YYYYMMDD 查询预测 summary."""
    try:
        td = datetime.strptime(trade_date_str, "%Y%m%d")
    except ValueError:
        return None
    row = (
        db.query(MLPredictionDaily)
        .filter(
            MLPredictionDaily.node_id == node_id,
            MLPredictionDaily.engine == ML_ENGINE_NAME,
            MLPredictionDaily.strategy_name == strategy_name,
            MLPredictionDaily.trade_date == td,
        )
        .first()
    )
    if row is None:
        return None
    return _prediction_row_to_dict(row)


# ---------------------------------------------------------------------------
# Rolling aggregation — ICIR + PSI trend alerts
# ---------------------------------------------------------------------------


def _mean_std(values: List[float]) -> Tuple[Optional[float], Optional[float]]:
    """numpy-free mean/std. Returns (None, None) on empty."""
    valid = [v for v in values if v is not None]
    if len(valid) < 2:
        return (valid[0] if valid else None, None)
    m = sum(valid) / len(valid)
    var = sum((v - m) ** 2 for v in valid) / (len(valid) - 1)
    return m, var ** 0.5


def compute_icir(metrics_series: List[Dict[str, Any]], window: int) -> Dict[str, Any]:
    """Rolling ICIR = mean(ic) / std(ic) over the last ``window`` days.

    Returns ``{window, icir, ic_mean, ic_std, n_samples}``.
    """
    recent = metrics_series[-window:] if len(metrics_series) > window else metrics_series
    ics = [m.get("ic") for m in recent]
    mean, std = _mean_std(ics)
    icir = (mean / std) if (mean is not None and std not in (None, 0.0)) else None
    return {
        "window": window,
        "icir": icir,
        "ic_mean": mean,
        "ic_std": std,
        "n_samples": sum(1 for v in ics if v is not None),
    }


def psi_trend_alerts(
    metrics_series: List[Dict[str, Any]],
    threshold: float = 0.25,
    consecutive_days: int = 3,
) -> Dict[str, Any]:
    """连续 N 日 psi_mean > threshold 触发告警.

    Returns ``{triggered, threshold, consecutive_days, last_streak_days,
               first_alert_date}``.
    """
    streak = 0
    max_streak = 0
    first_alert_date: Optional[str] = None
    for m in metrics_series:
        psi = m.get("psi_mean")
        if psi is not None and psi > threshold:
            streak += 1
            if streak == consecutive_days and first_alert_date is None:
                first_alert_date = m.get("trade_date")
            max_streak = max(max_streak, streak)
        else:
            streak = 0
    return {
        "triggered": max_streak >= consecutive_days,
        "threshold": threshold,
        "consecutive_days": consecutive_days,
        "last_streak_days": streak,
        "max_streak_days": max_streak,
        "first_alert_date": first_alert_date,
    }


def compute_rolling_summary(
    db: Session,
    node_id: str,
    strategy_name: str,
    window: int = 30,
) -> Dict[str, Any]:
    """组合 ICIR + PSI trend alert 的打包视图.

    前端 Tab2 只调这一个, 减少请求数.
    """
    history = get_metrics_history(db, node_id, strategy_name, days=max(window * 2, 60))
    return {
        "node_id": node_id,
        "strategy_name": strategy_name,
        "window": window,
        "icir_30d": compute_icir(history, 30),
        "icir_60d": compute_icir(history, 60),
        "psi_alert": psi_trend_alerts(history),
        "history_count": len(history),
    }


# ---------------------------------------------------------------------------
# backtest vs live diff — Phase 3.5+ 扩展位
# ---------------------------------------------------------------------------


def backtest_vs_live_diff(
    db: Session,
    node_id: str,
    strategy_name: str,
    backtest_dir: Optional[str] = None,
) -> Dict[str, Any]:
    """对齐 backtest/ 目录与 live predictions/ 算差异. 当前返回占位.

    真实实现需要读 bundle 里带的 backtest predictions parquet — 留到有实际
    回测数据后再启用.
    """
    return {
        "available": False,
        "reason": "backtest vs live diff pending Phase 3.5+ wiring",
    }
