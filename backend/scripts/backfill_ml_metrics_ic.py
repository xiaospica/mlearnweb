"""一次性脚本：扫 D:/ml_output/{strategy}/{day}/predictions.parquet + daily_merged
forward return 算 IC / RankIC，UPDATE ml_metric_snapshots 行。

为什么需要：
  vnpy run_inference 子进程**当时**只有 pred 没有 forward label (11d 后才能算 IC),
  metrics.json 不写 IC 字段 → ml_metric_snapshots.ic / rank_ic 全 None →
  策略监控 tab 的 IC/RankIC 时间序列图全空。

回填逻辑：
  - 读 predictions.parquet 拿 (instrument, score)
  - 用 daily_merged_all_new.parquet 算 forward 11d return:
    return = close[T+11] / close[T+1] - 1  (与训练时 label 公式同源)
  - IC = pearson(score, forward_return)
  - RankIC = spearman(score, forward_return)
  - UPDATE ml_metric_snapshots SET ic=?, rank_ic=?, pred_mean=?, pred_std=?
"""
from __future__ import annotations

import sqlite3
import sys
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

OUTPUT_ROOT = Path(r"D:/ml_output")
DAILY_MERGED = Path(r"D:/vnpy_data/stock_data/daily_merged_all_new.parquet")
MLEARNWEB_DB = Path(r"f:/Quant/code/qlib_strategy_dev/mlearnweb/backend/mlearnweb.db")
FORWARD_DAYS = 11   # 与训练 label "Ref($close, -11) / Ref($close, -1) - 1" 一致


def _vt_to_ts(vt: str) -> str:
    if vt.endswith(".SZSE"): return vt[:-5] + ".SZ"
    if vt.endswith(".SSE"):  return vt[:-4] + ".SH"
    return vt


def backfill_strategy(strategy_name: str) -> int:
    base = OUTPUT_ROOT / strategy_name
    if not base.exists():
        print(f"  no dir: {base}")
        return 0

    # 加载所有 trade_date 的 close
    if not DAILY_MERGED.exists():
        print(f"  daily_merged 不存在: {DAILY_MERGED}")
        return 0
    merged = pd.read_parquet(DAILY_MERGED, columns=["ts_code", "trade_date", "close"])
    merged["trade_date"] = pd.to_datetime(merged["trade_date"])
    # (ts, date) -> close
    close_df = merged.set_index(["ts_code", "trade_date"])["close"]
    # trade_calendar (升序日期)
    trade_dates = sorted(merged["trade_date"].unique())

    def _next_trade_day(d: pd.Timestamp, offset: int) -> pd.Timestamp | None:
        """从 trade_dates 中 d 的位置往后 offset 个交易日。越界返 None."""
        try:
            i = trade_dates.index(d)
        except ValueError:
            # d 非交易日，找下一个交易日
            for i, td in enumerate(trade_dates):
                if td >= d:
                    break
            else:
                return None
        ni = i + offset
        if ni >= len(trade_dates):
            return None
        return trade_dates[ni]

    conn = sqlite3.connect(str(MLEARNWEB_DB))
    cur = conn.cursor()

    n_updated = 0
    n_skipped_no_forward = 0
    for day_dir in sorted(base.iterdir()):
        if not day_dir.is_dir() or not day_dir.name.isdigit():
            continue
        pred_path = day_dir / "predictions.parquet"
        if not pred_path.exists():
            continue
        try:
            day = datetime.strptime(day_dir.name, "%Y%m%d").date()
            day_ts = pd.Timestamp(day)
        except Exception:
            continue

        # forward label 需要 close[T+1] 和 close[T+1+11]
        t1 = _next_trade_day(day_ts, 1)
        t12 = _next_trade_day(day_ts, FORWARD_DAYS + 1)
        if t1 is None or t12 is None:
            n_skipped_no_forward += 1
            continue

        try:
            pred = pd.read_parquet(pred_path)
            if "datetime" in pred.index.names:
                pred = pred.xs(day_ts, level="datetime", drop_level=True)
        except Exception as e:
            print(f"  [skip] {day} pred read err: {e}")
            continue
        if pred.empty:
            continue

        # 算 forward return: close[t12] / close[t1] - 1, 按 instrument
        records = []
        for inst in pred.index.astype(str):
            try:
                c1 = float(close_df.loc[(inst, t1)])
                c12 = float(close_df.loc[(inst, t12)])
                if c1 > 0:
                    fwd = c12 / c1 - 1
                    records.append((inst, float(pred.loc[inst, "score"]), fwd))
            except (KeyError, ValueError):
                continue

        if len(records) < 5:
            continue

        df = pd.DataFrame(records, columns=["inst", "score", "fwd"])
        ic = float(df["score"].corr(df["fwd"]))
        rank_ic = float(df["score"].rank().corr(df["fwd"].rank()))
        pred_mean = float(df["score"].mean())
        pred_std = float(df["score"].std())

        if not (np.isfinite(ic) and np.isfinite(rank_ic)):
            continue

        # UPDATE row(s) for this trade_date (任何时刻, 比如 15:00 / 00:00)
        trade_date_target = datetime.combine(day, datetime.min.time())
        td_next = trade_date_target + timedelta(days=1)
        n = cur.execute(
            """UPDATE ml_metric_snapshots SET
                   ic = ?, rank_ic = ?,
                   pred_mean = COALESCE(pred_mean, ?),
                   pred_std = COALESCE(pred_std, ?)
               WHERE strategy_name = ? AND trade_date >= ? AND trade_date < ?""",
            (ic, rank_ic, pred_mean, pred_std, strategy_name, trade_date_target, td_next),
        ).rowcount
        n_updated += n
    conn.commit()
    conn.close()
    print(f"  updated {n_updated} rows; skipped {n_skipped_no_forward} days (forward window 不全)")
    return n_updated


if __name__ == "__main__":
    strategies = sys.argv[1:] or ["csi300_lgb_headless"]
    for s in strategies:
        print(f"=== {s} ===")
        backfill_strategy(s)
