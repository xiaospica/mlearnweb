"""Post-backfill topk populator — 跟 _phase27_backfill.py 配对, 跑完它再跑这个.

## 这个脚本做什么

主 backfill 把 metrics (IC / PSI / histogram 等) UPSERT 到 SQLite, 但不
写 topk_json (因为 metrics.json 不含 topk). 本脚本:
  1. 对每天 predictions.parquet on disk → 按 score 取 top-N
  2. 写 selections.parquet 到同一天目录 (和 MLStrategyTemplate.persist_selections
     生产侧落盘契约一致, 适配器读这个文件返 topk)
  3. UPDATE mlearnweb SQLite ml_prediction_daily.topk_json

## 生产侧对比

生产:strategy.persist_selections (每日) → selections.parquet on disk →
     adapter.get_prediction_summary 读 selections.parquet → 包 topk →
     ml_snapshot_loop 拉过去 UPSERT topk_json

本脚本直接从 predictions.parquet 推导 topk,然后写入对齐的两处 (disk +
SQLite),等价于"事后回填一次 persist_selections + 一次 ml_snapshot_loop tick".

## 前置

  - 主 backfill 已跑完, D:/ml_output/phase27_backfill/phase27_test/{YYYYMMDD}/
    每天都有 predictions.parquet
  - SQLite 里已有对应 trade_date_trade_date 的 ml_prediction_daily 行

## 运行

```
cd /f/Quant/code/qlib_strategy_dev
E:/ssd_backup/Pycharm_project/python-3.11.0-amd64/python.exe -u \
  mlearnweb/backend/scripts/phase27_backfill_topk.py
```

秒级完成. 输出每天的 top1 股票作为 sanity check.
"""

from __future__ import annotations

import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

import pandas as pd

# Script is at mlearnweb/backend/scripts/
HERE = Path(__file__).resolve().parent
BACKEND_DIR = HERE.parent
sys.path.insert(0, str(BACKEND_DIR))

OUT_ROOT = Path(r"D:\ml_output\phase27_backfill")
STRATEGY_NAME = "phase27_test"
TOPK = 7


def main() -> int:
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy import update
    from app.models.database import engine as db_engine
    from app.models.ml_monitoring import MLPredictionDaily

    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=db_engine)
    session = SessionLocal()

    strat_dir = OUT_ROOT / STRATEGY_NAME
    if not strat_dir.exists():
        print(f"strategy dir not found: {strat_dir}")
        return 1

    day_dirs = sorted(
        d for d in strat_dir.iterdir()
        if d.is_dir() and d.name.isdigit() and len(d.name) == 8
    )
    print(f"found {len(day_dirs)} day dirs (writing real trade_date, no shift)")

    updated = 0
    for dir_path in day_dirs:
        pred_path = dir_path / "predictions.parquet"
        if not pred_path.exists():
            continue
        try:
            df = pd.read_parquet(pred_path)
        except Exception as e:
            print(f"  {dir_path.name}: read fail {e}")
            continue

        real_date = datetime.strptime(dir_path.name, "%Y%m%d").date()
        real_td = datetime.combine(real_date, datetime.min.time())

        # Top-N by score on latest pred date within this bundle
        last_dt = df.index.get_level_values("datetime").max()
        slice_df = df.xs(last_dt, level="datetime").sort_values("score", ascending=False).head(TOPK)
        topk = [
            {
                "rank": i + 1,
                "instrument": str(inst),
                "score": float(row["score"]),
                "weight": round(1.0 / TOPK, 6),
            }
            for i, (inst, row) in enumerate(slice_df.iterrows())
        ]

        # Write selections.parquet beside predictions.parquet (prod parity)
        sel_df = pd.DataFrame([
            {
                "trade_date": real_date.strftime("%Y-%m-%d"),
                "instrument": e["instrument"],
                "rank": e["rank"],
                "score": e["score"],
                "weight": e["weight"],
                "target_price": float("nan"),
                "side": "long",
                "model_run_id": "ab2711178313491f9900b5695b47fa98",
            }
            for e in topk
        ])
        sel_path = dir_path / "selections.parquet"
        sel_tmp = sel_path.with_suffix(sel_path.suffix + ".tmp")
        sel_df.to_parquet(sel_tmp, index=False)
        import os as _os
        _os.replace(sel_tmp, sel_path)

        topk_json = json.dumps(topk, ensure_ascii=False)
        q = session.query(MLPredictionDaily).filter(
            MLPredictionDaily.node_id == "local",
            MLPredictionDaily.engine == "MlStrategy",
            MLPredictionDaily.strategy_name == STRATEGY_NAME,
            MLPredictionDaily.trade_date == real_td,
        )
        row = q.first()
        if row is None:
            print(f"  {dir_path.name} → trade_date {real_td.date()}: no SQLite row, skipping")
            continue
        row.topk_json = topk_json
        updated += 1
        print(f"  {dir_path.name} → trade_date {real_td.date()}: topk top1={topk[0]['instrument']}({topk[0]['score']:.4f}) + selections.parquet")

    session.commit()
    session.close()
    print(f"\nupdated {updated} rows with topk_json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
