"""ML 指标自动回填 service (从 D:/ml_output predictions.parquet 算).

为什么需要：
  vnpy vendor 的 run_inference **batch 模式** 刻意不写 metrics.json
  (cli/run_inference.py:206 注释"简化版"), 单独跑的 backfill 脚本只是
  一次性补救。用户每次 reset_sim_state + 重启 vnpy 后图表又空了。

修法：把 backfill 提升成 mlearnweb 后台自动逻辑：
  1. lifespan startup 调一次 — 启动后立即兜底
  2. ml_snapshot_loop 每 60s tick 末尾调一次 — 持续保持新数据齐全
  3. 幂等 (UPDATE WHERE ... IS NULL OR = '[]'), 已有真值不被覆盖

回填字段：
  - ml_metric_snapshots: pred_mean / pred_std / pred_zero_ratio / n_predictions /
    ic / rank_ic
  - ml_prediction_daily: score_histogram_json / pred_mean / pred_std / n_symbols

PSI 需要 baseline.parquet 训练时点对比, 工作量大单独立项跟踪 (留空)。
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
from sqlalchemy import update as sa_update
from sqlalchemy.orm import sessionmaker, Session

from app.core.config import settings
from app.models.database import engine as db_engine
from app.models.ml_monitoring import MLMetricSnapshot, MLPredictionDaily

logger = logging.getLogger(__name__)


_SCORE_HIST_BINS = 20
_FORWARD_DAYS = 11   # qlib label 公式 Ref($close,-11)/Ref($close,-1)-1 forward 11d


def _compute_score_histogram(scores: pd.Series, n_bins: int = _SCORE_HIST_BINS) -> List[Dict[str, float]]:
    """与 qlib_strategy_core.metrics.compute_score_histogram 同源."""
    arr = scores.dropna().to_numpy()
    if arr.size == 0:
        return []
    counts, edges = np.histogram(arr, bins=n_bins)
    return [
        {"bin_left": float(edges[i]), "bin_right": float(edges[i + 1]), "count": int(counts[i])}
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


def _next_trade_day(trade_dates: List[pd.Timestamp], d: pd.Timestamp, offset: int) -> Optional[pd.Timestamp]:
    """从 trade_dates 找 d 之后第 offset 个交易日; 越界返 None."""
    try:
        i = trade_dates.index(d)
    except ValueError:
        for i, td in enumerate(trade_dates):
            if td >= d:
                break
        else:
            return None
    ni = i + offset
    if ni >= len(trade_dates):
        return None
    return trade_dates[ni]


def _load_close_lookup() -> Tuple[Dict[Tuple[str, pd.Timestamp], float], List[pd.Timestamp]]:
    """加载 daily_merged 的 (ts, date) → close 字典 + 交易日列表."""
    merged_path = Path(settings.daily_merged_all_path) if hasattr(settings, "daily_merged_all_path") else None
    if merged_path is None or not merged_path.exists():
        # fallback: 用默认路径
        merged_path = Path(r"D:/vnpy_data/stock_data/daily_merged_all_new.parquet")
    if not merged_path.exists():
        return {}, []
    try:
        merged = pd.read_parquet(merged_path, columns=["ts_code", "trade_date", "close"])
        merged["trade_date"] = pd.to_datetime(merged["trade_date"])
    except Exception as e:
        logger.warning(f"[ml_backfill] daily_merged read failed: {e}")
        return {}, []
    close_map = merged.set_index(["ts_code", "trade_date"])["close"].to_dict()
    trade_dates = sorted(merged["trade_date"].unique())
    return close_map, trade_dates


def _backfill_one_strategy(
    session: Session,
    strategy_name: str,
    output_root: Path,
    close_map: Dict[Tuple[str, pd.Timestamp], float],
    trade_dates: List[pd.Timestamp],
) -> Dict[str, int]:
    """对单只策略做 backfill, 返 (n_metric_updated, n_pred_updated).

    优先级:
      1. 读 metrics.json (vnpy batch 现已写完整 metrics — 含 IC/PSI/直方图等)
      2. fallback 从 predictions.parquet 算 (兼容旧 batch 产物没 metrics.json)
    """
    base = output_root / strategy_name
    if not base.exists():
        return {"metric": 0, "prediction": 0}

    n_metric = 0
    n_pred = 0
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

        # 1. 优先读 metrics.json (新 batch 模式产物)
        metrics_path = day_dir / "metrics.json"
        metrics_json: Dict[str, Any] = {}
        if metrics_path.exists():
            try:
                metrics_json = json.loads(metrics_path.read_text(encoding="utf-8"))
            except Exception:
                metrics_json = {}

        try:
            pred = pd.read_parquet(pred_path)
        except Exception:
            continue
        if pred.empty:
            continue

        scores = pred["score"] if "score" in pred.columns else pred.iloc[:, 0]
        stats = _compute_pred_stats(scores)
        histogram_json = json.dumps(_compute_score_histogram(scores), ensure_ascii=False)
        # metrics.json 优先 (含 PSI / KS / IC 等 backfill 算不到的)
        psi_mean = metrics_json.get("psi_mean")
        psi_max = metrics_json.get("psi_max")
        psi_n = metrics_json.get("psi_n_over_0_25")
        psi_by_feature_str = json.dumps(metrics_json.get("psi_by_feature") or {}, ensure_ascii=False) if metrics_json.get("psi_by_feature") else None
        ks_by_feature_str = json.dumps(metrics_json.get("ks_by_feature") or {}, ensure_ascii=False) if metrics_json.get("ks_by_feature") else None
        feat_missing_str = json.dumps(metrics_json.get("feat_missing") or {}, ensure_ascii=False) if metrics_json.get("feat_missing") else None
        ic_from_metrics = metrics_json.get("ic")
        rank_ic_from_metrics = metrics_json.get("rank_ic")

        # IC 计算: 优先 metrics.json (vnpy 端用 dataset.label 算的更准),
        # 没有再 fallback 自己算 forward 11d return
        ic_val: Optional[float] = ic_from_metrics
        rank_ic_val: Optional[float] = rank_ic_from_metrics
        if (ic_val is None or rank_ic_val is None) and close_map and trade_dates:
            day_ts = pd.Timestamp(day)
            t1 = _next_trade_day(trade_dates, day_ts, 1)
            t12 = _next_trade_day(trade_dates, day_ts, _FORWARD_DAYS + 1)
            if t1 is not None and t12 is not None:
                # 重置 index 拿 (instrument, score)
                if "datetime" in pred.index.names:
                    pred_today = pred.xs(day_ts, level="datetime", drop_level=True) if day_ts in pred.index.get_level_values("datetime") else pred
                else:
                    pred_today = pred
                records: List[Tuple[float, float]] = []
                for inst in pred_today.index.astype(str):
                    try:
                        c1 = close_map.get((inst, t1))
                        c12 = close_map.get((inst, t12))
                        if c1 and c12 and c1 > 0:
                            fwd = c12 / c1 - 1
                            records.append((float(pred_today.loc[inst, "score"] if "score" in pred_today.columns else pred_today.loc[inst].iloc[0]), fwd))
                    except (KeyError, ValueError):
                        continue
                if len(records) >= 5:
                    df = pd.DataFrame(records, columns=["score", "fwd"])
                    ic = float(df["score"].corr(df["fwd"]))
                    rank_ic = float(df["score"].rank().corr(df["fwd"].rank()))
                    if np.isfinite(ic):
                        ic_val = ic
                    if np.isfinite(rank_ic):
                        rank_ic_val = rank_ic

        # UPDATE ml_metric_snapshots: 仅在原值为 NULL 时填充 (幂等)
        # 含 PSI / KS / feat_missing — metrics.json 提供时一并填
        cur = session.connection().connection.cursor()
        n = cur.execute(
            """UPDATE ml_metric_snapshots SET
                   pred_mean = COALESCE(pred_mean, ?),
                   pred_std = COALESCE(pred_std, ?),
                   pred_zero_ratio = COALESCE(pred_zero_ratio, ?),
                   n_predictions = COALESCE(NULLIF(n_predictions, 0), ?),
                   ic = COALESCE(ic, ?),
                   rank_ic = COALESCE(rank_ic, ?),
                   psi_mean = COALESCE(psi_mean, ?),
                   psi_max = COALESCE(psi_max, ?),
                   psi_n_over_0_25 = COALESCE(psi_n_over_0_25, ?),
                   psi_by_feature_json = CASE
                       WHEN psi_by_feature_json IS NULL OR psi_by_feature_json = '{}' THEN COALESCE(?, psi_by_feature_json)
                       ELSE psi_by_feature_json
                   END,
                   ks_by_feature_json = CASE
                       WHEN ks_by_feature_json IS NULL OR ks_by_feature_json = '{}' THEN COALESCE(?, ks_by_feature_json)
                       ELSE ks_by_feature_json
                   END,
                   feat_missing_json = CASE
                       WHEN feat_missing_json IS NULL OR feat_missing_json = '{}' THEN COALESCE(?, feat_missing_json)
                       ELSE feat_missing_json
                   END
               WHERE strategy_name = ? AND trade_date >= ? AND trade_date < ?""",
            (stats["pred_mean"], stats["pred_std"], stats["pred_zero_ratio"], stats["n_predictions"],
             ic_val, rank_ic_val,
             psi_mean, psi_max, psi_n,
             psi_by_feature_str, ks_by_feature_str, feat_missing_str,
             strategy_name, day_start, day_end),
        ).rowcount
        n_metric += n

        n = cur.execute(
            """UPDATE ml_prediction_daily SET
                   score_histogram_json = CASE
                       WHEN score_histogram_json IS NULL OR score_histogram_json = '[]' THEN ?
                       ELSE score_histogram_json
                   END,
                   pred_mean = COALESCE(pred_mean, ?),
                   pred_std = COALESCE(pred_std, ?),
                   n_symbols = COALESCE(NULLIF(n_symbols, 0), ?)
               WHERE strategy_name = ? AND trade_date >= ? AND trade_date < ?""",
            (histogram_json, stats["pred_mean"], stats["pred_std"], stats["n_predictions"],
             strategy_name, day_start, day_end),
        ).rowcount
        n_pred += n
    return {"metric": n_metric, "prediction": n_pred}


def backfill_all_strategies() -> Dict[str, Any]:
    """扫 D:/ml_output 所有策略目录, 兜底回填缺失字段. 失败返 stats=0 不抛.

    幂等: UPDATE 用 COALESCE/NULLIF 仅在原值缺失时填，不破坏已有真值。
    可能阻塞 IO ~秒级 (取决于策略数 × 日期数), 调用方应在协程或后台 task 用。
    """
    output_root = Path(settings.ml_live_output_root) if settings.ml_live_output_root else None
    if output_root is None or not output_root.exists():
        return {"strategies": 0, "metric_updated": 0, "prediction_updated": 0, "skipped_reason": "ml_live_output_root 未配置或不存在"}

    close_map, trade_dates = _load_close_lookup()

    SessionLocal = sessionmaker(bind=db_engine, autocommit=False, autoflush=False)
    session = SessionLocal()
    total_m = 0
    total_p = 0
    n_strategies = 0
    try:
        for strat_dir in sorted(output_root.iterdir()):
            if not strat_dir.is_dir():
                continue
            r = _backfill_one_strategy(session, strat_dir.name, output_root, close_map, trade_dates)
            total_m += r["metric"]
            total_p += r["prediction"]
            n_strategies += 1
        session.commit()
    except Exception as e:
        logger.exception(f"[ml_backfill] 失败: {e}")
        session.rollback()
    finally:
        session.close()
    return {
        "strategies": n_strategies,
        "metric_updated": total_m,
        "prediction_updated": total_p,
    }
