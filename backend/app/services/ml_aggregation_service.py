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


def get_latest_prediction(
    db: Session,
    node_id: str,
    strategy_name: str,
) -> Optional[Dict[str, Any]]:
    """Most recent cached prediction from SQLite (ml_prediction_daily).

    Used as a fallback when the realtime pass-through to vnpy webtrader is
    unavailable (trader down) — backfill/testing scenarios rely on this.
    """
    row = (
        db.query(MLPredictionDaily)
        .filter(
            MLPredictionDaily.node_id == node_id,
            MLPredictionDaily.engine == ML_ENGINE_NAME,
            MLPredictionDaily.strategy_name == strategy_name,
        )
        .order_by(MLPredictionDaily.trade_date.desc())
        .first()
    )
    if row is None:
        return None
    return _prediction_row_to_dict(row)


def get_prediction_by_date(
    db: Session,
    node_id: str,
    strategy_name: str,
    trade_date_str: str,
) -> Optional[Dict[str, Any]]:
    """按日期 YYYYMMDD 查询预测 summary。

    db 存的 trade_date 在不同写入路径下时分秒不同：
      - 回放路径 (vnpy mlearnweb_writer.write_replay_ml_metric_snapshot):
        15:00:00 (A 股收盘时间)
      - 实时 ml_snapshot_loop fallback: wall-clock now (00:00 / 任意时刻)
    精确等于 datetime(YYYY,MM,DD) 只能匹配 00:00:00 的，会漏掉 15:00:00 的回放历史。
    用 [td, td + 1day) 范围匹配整个交易日。
    """
    from datetime import timedelta as _td
    try:
        td = datetime.strptime(trade_date_str, "%Y%m%d")
    except ValueError:
        return None
    td_next = td + _td(days=1)
    row = (
        db.query(MLPredictionDaily)
        .filter(
            MLPredictionDaily.node_id == node_id,
            MLPredictionDaily.engine == ML_ENGINE_NAME,
            MLPredictionDaily.strategy_name == strategy_name,
            MLPredictionDaily.trade_date >= td,
            MLPredictionDaily.trade_date < td_next,
        )
        .first()
    )
    if row is None:
        return None
    return _prediction_row_to_dict(row)


# ---------------------------------------------------------------------------
# Rolling aggregation — ICIR + PSI trend alerts
# ---------------------------------------------------------------------------


# Import pure algorithmic functions from core — single source of truth for all
# cross-day aggregation (compute_icir / psi_trend_alerts / detect_ic_decay /
# compute_live_vs_backtest_diff). mlearnweb only glues DB-fetch + HTTP here.
from qlib_strategy_core.metrics import (
    compute_icir,
    psi_trend_alerts,
    detect_ic_decay,
    compute_live_vs_backtest_diff,
)


def compute_rolling_summary(
    db: Session,
    node_id: str,
    strategy_name: str,
    window: int = 30,
) -> Dict[str, Any]:
    """组合 ICIR + PSI trend alert + IC decay 的打包视图.

    前端 Tab2 只调这一个, 减少请求数.

    采集历史时按 days=365 取, 让 compute_icir/psi_trend_alerts/detect_ic_decay
    基于 "最近 N 条记录" 而非 "最近 N 天" 滑窗. 这样即使数据间断或只在测试期
    有几十条旧数据, ICIR/告警依然有统计意义.
    """
    history = get_metrics_history(db, node_id, strategy_name, days=365)
    return {
        "node_id": node_id,
        "strategy_name": strategy_name,
        "window": window,
        "icir_30d": compute_icir(history, 30),
        "icir_60d": compute_icir(history, 60),
        "psi_alert": psi_trend_alerts(history),
        "ic_decay": detect_ic_decay(history),
        "history_count": len(history),
    }


# ---------------------------------------------------------------------------
# backtest vs live diff — 解读 A: 对齐训练侧 MLflow pred.pkl 与 live predictions
# ---------------------------------------------------------------------------


def load_backtest_predictions(mlflow_artifacts_dir: str) -> Optional[object]:
    """Read training-side pred.pkl (MultiIndex (datetime, instrument), score)."""
    import pickle
    from pathlib import Path
    p = Path(mlflow_artifacts_dir) / "pred.pkl"
    if not p.exists():
        return None
    try:
        with open(p, "rb") as f:
            return pickle.load(f)
    except Exception:
        return None


def load_live_predictions(
    output_root: str,
    strategy_name: str,
    days: int = 30,
) -> Optional[object]:
    """Concatenate recent days' predictions.parquet from disk.

    Reads ``{output_root}/{strategy_name}/{yyyymmdd}/predictions.parquet``.
    Returns a MultiIndex (datetime, instrument) DataFrame with column ``score``.
    """
    import pandas as pd
    from pathlib import Path
    strat_dir = Path(output_root) / strategy_name
    if not strat_dir.exists():
        return None
    day_dirs = sorted(
        (d for d in strat_dir.iterdir() if d.is_dir() and d.name.isdigit() and len(d.name) == 8),
        reverse=True,
    )[:days]
    frames = []
    for d in day_dirs:
        p = d / "predictions.parquet"
        if not p.exists():
            continue
        try:
            frames.append(pd.read_parquet(p))
        except Exception:
            continue
    if not frames:
        return None
    # Concatenated pred_df; duplicates handled by (datetime,instrument) uniqueness
    return pd.concat(frames).sort_index()


# ---------------------------------------------------------------------------
# 股票代码 → 名称 lookup (读 vnpy_tushare_pro 落盘的 stock_list.parquet)
# ---------------------------------------------------------------------------


_STOCK_NAME_CACHE: Dict[str, Any] = {"mtime": 0.0, "mapping": {}, "path": None}


def _resolve_stock_list_path() -> Optional["Path"]:
    """查找 stock_list.parquet.

    1. env ``TUSHARE_STOCK_LIST_PATH`` 显式指定 (含文件名)
    2. env ``QS_DATA_ROOT`` 推导 ``{root}/stock_data/stock_list.parquet``
    3. vnpy_strategy_dev 默认位置 ``F:/Quant/vnpy/vnpy_strategy_dev/stock_data/stock_list.parquet``
       (与 ``TushareApiClient`` 当前 ``DATA_DIR = cwd/stock_data`` 一致)
    """
    import os
    from pathlib import Path
    env = os.getenv("TUSHARE_STOCK_LIST_PATH")
    if env:
        p = Path(env)
        if p.exists():
            return p
    qs_root = os.getenv("QS_DATA_ROOT")
    if qs_root:
        p = Path(qs_root) / "stock_data" / "stock_list.parquet"
        if p.exists():
            return p
    default = Path("F:/Quant/vnpy/vnpy_strategy_dev/stock_data/stock_list.parquet")
    if default.exists():
        return default
    return None


def get_stock_name_map() -> Dict[str, str]:
    """返回 ts_code → 股票中文简称字典 (带 mtime 缓存).

    查不到或文件不存在返回空字典, 调用方应 fallback 到 ts_code 显示.
    """
    import pandas as pd
    path = _resolve_stock_list_path()
    if path is None:
        return {}
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return _STOCK_NAME_CACHE.get("mapping", {}) or {}
    if (
        _STOCK_NAME_CACHE["mapping"]
        and _STOCK_NAME_CACHE["path"] == path
        and _STOCK_NAME_CACHE["mtime"] == mtime
    ):
        return _STOCK_NAME_CACHE["mapping"]
    try:
        df = pd.read_parquet(path, columns=["ts_code", "name"])
    except Exception as e:  # noqa: BLE001
        logger.warning("读取 stock_list.parquet 失败 path=%s err=%s", path, e)
        return _STOCK_NAME_CACHE.get("mapping", {}) or {}
    mapping = {
        str(c): str(n)
        for c, n in zip(df["ts_code"].tolist(), df["name"].tolist())
        if isinstance(c, str) and c
    }
    _STOCK_NAME_CACHE.update({"mtime": mtime, "mapping": mapping, "path": path})
    logger.info("stock_name_map reloaded: path=%s rows=%d", path, len(mapping))
    return mapping


# ---------------------------------------------------------------------------
# 最新 metric snapshot (用于 RPC 超时时的 SQLite fallback)
# ---------------------------------------------------------------------------


def get_latest_metric_snapshot(
    db: Session,
    node_id: str,
    strategy_name: str,
) -> Optional[Dict[str, Any]]:
    """Most-recent cached metric snapshot from SQLite.

    Used as fallback when realtime pass-through to vnpy fails (RPC timeout / trader down).
    """
    row = (
        db.query(MLMetricSnapshot)
        .filter(
            MLMetricSnapshot.node_id == node_id,
            MLMetricSnapshot.engine == ML_ENGINE_NAME,
            MLMetricSnapshot.strategy_name == strategy_name,
        )
        .order_by(MLMetricSnapshot.trade_date.desc())
        .first()
    )
    if row is None:
        return None
    return _metric_row_to_dict(row)


# ---------------------------------------------------------------------------
# 全量预测 — 读 predictions.parquet (qlib subprocess 产物) + name enrichment
# ---------------------------------------------------------------------------


def get_all_predictions_by_date(
    strategy_name: str,
    yyyymmdd: str,
    live_output_root: str,
) -> List[Dict[str, Any]]:
    """读 ``{live_output_root}/{strategy_name}/{yyyymmdd}/predictions.parquet``,
    返回全量预测列表 (按 score 降序排序, 已加 rank + 股票中文名).

    Returns
    -------
    list of dict: ``[{"rank": int, "instrument": str, "name": str|None,
                      "score": float}, ...]``; 文件不存在时返回 ``[]``.
    """
    import pandas as pd
    from pathlib import Path
    path = Path(live_output_root) / strategy_name / yyyymmdd / "predictions.parquet"
    if not path.exists():
        return []
    try:
        df = pd.read_parquet(path)
    except Exception as e:  # noqa: BLE001
        logger.warning("读取 predictions.parquet 失败 path=%s err=%s", path, e)
        return []

    # predictions.parquet 是 MultiIndex (datetime, instrument), column "score"
    df = df.reset_index()
    if "instrument" not in df.columns:
        # 尝试常见的列名兜底
        for cand in ("symbol", "ts_code", "code"):
            if cand in df.columns:
                df = df.rename(columns={cand: "instrument"})
                break
        else:
            logger.warning("predictions.parquet 缺 instrument 列: %s", df.columns.tolist())
            return []
    if "score" not in df.columns:
        logger.warning("predictions.parquet 缺 score 列: %s", df.columns.tolist())
        return []

    # 若有多个 datetime (不应出现, 但防御性处理), 只保留最大日期
    if "datetime" in df.columns:
        last_dt = df["datetime"].max()
        df = df[df["datetime"] == last_dt]

    name_map = get_stock_name_map()
    df = df[["instrument", "score"]].copy()
    df["name"] = df["instrument"].map(name_map)
    df = df.sort_values("score", ascending=False).reset_index(drop=True)
    df["rank"] = range(1, len(df) + 1)

    out: List[Dict[str, Any]] = []
    for _, r in df.iterrows():
        score_val = r.get("score")
        out.append({
            "rank": int(r["rank"]),
            "instrument": str(r["instrument"]),
            "name": (str(r["name"]) if pd.notna(r.get("name")) else None),
            "score": float(score_val) if pd.notna(score_val) else None,
        })
    return out


def backtest_vs_live_diff(
    db: Session,
    node_id: str,
    strategy_name: str,
    mlflow_artifacts_dir: Optional[str] = None,
    live_output_root: Optional[str] = None,
    recent_days: int = 30,
) -> Dict[str, Any]:
    """解读 A: 对比训练侧 backtest predictions 与 live predictions per date.

    输入: MLflow artifacts 目录 (pred.pkl) + live predictions 目录根.
    输出: per_date correlation + coverage_ratio + corr_mean + n_dates_in_overlap.
    """
    if not mlflow_artifacts_dir or not live_output_root:
        return {
            "available": False,
            "reason": "需配置 mlflow_artifacts_dir 和 live_output_root",
        }
    bt = load_backtest_predictions(mlflow_artifacts_dir)
    if bt is None:
        return {"available": False, "reason": f"pred.pkl 不存在: {mlflow_artifacts_dir}"}
    live = load_live_predictions(live_output_root, strategy_name, days=recent_days)
    if live is None:
        return {"available": False, "reason": f"live predictions 不存在: {live_output_root}/{strategy_name}"}
    result = compute_live_vs_backtest_diff(live, bt)
    return {
        "available": True,
        "backtest_source": mlflow_artifacts_dir,
        **result,
    }
