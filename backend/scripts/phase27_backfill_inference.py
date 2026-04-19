"""Backfill orchestrator — 把过去 N 个交易日的推理"压缩到一次跑完".

## 这个脚本测什么

**目的**:让 mlearnweb UI 的跨天时序图 / ICIR / IC 衰减告警 / PSI 连续告警
立刻有 30+ 天真实数据可看,不用等生产每天真跑一次累积一个月.

**代码路径**:
  for each 交易日 t in [START_DATE, END_DATE]:
    1. subprocess 调 `qlib_strategy_core.cli.run_inference --live-end t`
       (和生产每天 09:15 cron 触发的**完全一样的代码路径**)
    2. 读该天 metrics.json + pred summary
    3. 直接 UPSERT 到 mlearnweb SQLite 的 ml_metric_snapshots / ml_prediction_daily

**和生产的差异**:
  - 生产:每日 09:15 cron 触发一次 subprocess → 写 MetricsCache → ml_snapshot_loop
    每 60s 轮询 webtrader HTTP 端点 → UPSERT SQLite
  - 本脚本:绕过 MetricsCache 和 ml_snapshot_loop,**直接**从 metrics.json → SQLite
    (因为 ml_snapshot_loop 每 60s 只看到 MetricsCache.latest 一条,多次
    subprocess 会相互覆盖, 要等 60s+100s 才能入库一行, 30 天要 80 分钟)
  - 真实 subprocess 调用链路完全相同, 单元测试价值等同

## 需要的前置

**不需要**起任何 vnpy 进程 (trader / webtrader uvicorn):
  - subprocess 的 Python 3.11 env 会被脚本自动启动
  - SQLite 直接通过 SQLAlchemy 写

**需要**:
  - `F:/Quant/code/qlib_strategy_dev/qs_exports/rolling_exp/ab27.../` 完整 bundle
  - `F:/Quant/code/qlib_strategy_dev/factor_factory/qlib_data_bin` qlib provider
  - `E:/ssd_backup/Pycharm_project/python-3.11.0-amd64/python.exe` 研究机 Python
  - `mlearnweb/backend/mlearnweb.db` 存在 (可以是空的, 会 INSERT)

## trade_date 使用真实推理日期 (无映射)

每行 SQLite 的 `trade_date` = subprocess `--live-end` 的真实日期. 不做偏移.
前端 `MlMonitorPanel` 的默认 history 窗口已放大到 180 天覆盖 backfill 区间
(real dates 2025-11-24 ~ 2026-01-09).

## 运行

```
cd /f/Quant/code/qlib_strategy_dev
E:/ssd_backup/Pycharm_project/python-3.11.0-amd64/python.exe -u \
  mlearnweb/backend/scripts/phase27_backfill_inference.py
```

~30 天 × 100s/天 ≈ 50 分钟. 断线可 resume (skip diagnostics.ok 的日期).

跑完接着跑 `mlearnweb/backend/scripts/phase27_backfill_topk.py` 把 topk_json
从 predictions.parquet 里补出来.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time as time_mod
from datetime import date, datetime, time as time_t, timedelta
from pathlib import Path
from typing import Any, Dict, List

import pandas as pd


# Path setup: script is at mlearnweb/backend/scripts/, so:
#   HERE             = .../mlearnweb/backend/scripts/
#   BACKEND_DIR      = .../mlearnweb/backend/
#   REPO_ROOT        = .../qlib_strategy_dev/
HERE = Path(__file__).resolve().parent
BACKEND_DIR = HERE.parent
REPO_ROOT = BACKEND_DIR.parent.parent
# Prefer in-repo vendor/qlib_strategy_core (ensures IC fix is picked up)
CORE_PATH = REPO_ROOT / "vendor" / "qlib_strategy_core"
if CORE_PATH.exists():
    sys.path.insert(0, str(CORE_PATH))
# Backend dir for `from app.models... import ...`
sys.path.insert(0, str(BACKEND_DIR))

# Config
INFERENCE_PYTHON = r"E:\ssd_backup\Pycharm_project\python-3.11.0-amd64\python.exe"
BUNDLE_DIR = r"F:\Quant\code\qlib_strategy_dev\qs_exports\rolling_exp\ab2711178313491f9900b5695b47fa98"
PROVIDER_URI = r"F:\Quant\code\qlib_strategy_dev\factor_factory\qlib_data_bin"
OUT_ROOT = Path(r"D:\ml_output\phase27_backfill")
STRATEGY_NAME = "phase27_test"
NODE_ID = "local"
LOOKBACK = 60
START_DATE = date(2025, 11, 24)
END_DATE = date(2026, 1, 9)


def get_trading_days(start: date, end: date) -> List[date]:
    """Pull qlib calendar in [start, end]. Requires qlib initialized."""
    import qlib
    qlib.init(provider_uri=PROVIDER_URI)
    from qlib.data import D
    cal = D.calendar(start_time=pd.Timestamp(start), end_time=pd.Timestamp(end))
    return [pd.Timestamp(c).date() for c in cal]


def run_inference_subprocess(live_end: date, out_dir: Path) -> int:
    """Invoke CLI subprocess. Returns exit code."""
    out_dir.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    existing = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = str(CORE_PATH) + (os.pathsep + existing if existing else "")
    env["PYTHONIOENCODING"] = "utf-8"
    cmd = [
        INFERENCE_PYTHON, "-m", "qlib_strategy_core.cli.run_inference",
        "--bundle-dir", BUNDLE_DIR,
        "--live-end", live_end.strftime("%Y-%m-%d"),
        "--lookback", str(LOOKBACK),
        "--out-dir", str(out_dir),
        "--strategy", STRATEGY_NAME,
        "--provider-uri", PROVIDER_URI,
        "--install-legacy-path",
    ]
    result = subprocess.run(
        cmd, env=env, capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=300,
    )
    if result.returncode != 0:
        print(f"    stderr tail: {result.stderr[-500:]}", flush=True)
    return result.returncode


def build_prediction_summary(metrics: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "strategy": STRATEGY_NAME,
        "trade_date": metrics.get("trade_date"),
        "model_run_id": metrics.get("model_run_id"),
        "n_symbols": metrics.get("n_predictions", 0),
        "score_histogram": metrics.get("score_histogram", []),
        "pred_mean": metrics.get("pred_mean"),
        "pred_std": metrics.get("pred_std"),
    }


def upsert(metrics: Dict[str, Any], shifted_td: datetime) -> None:
    from sqlalchemy.orm import sessionmaker
    from app.models.database import engine as db_engine
    from app.services.vnpy.ml_monitoring_service import _upsert_metric, _upsert_prediction

    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=db_engine)
    session = SessionLocal()
    try:
        _upsert_metric(
            session,
            node_id=NODE_ID,
            strategy_name=STRATEGY_NAME,
            trade_date=shifted_td,
            metrics=metrics,
            status="ok",
        )
        _upsert_prediction(
            session,
            node_id=NODE_ID,
            strategy_name=STRATEGY_NAME,
            trade_date=shifted_td,
            summary=build_prediction_summary(metrics),
            status="ok",
        )
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def main() -> int:
    print(f"[backfill] qlib calendar [{START_DATE}, {END_DATE}]...", flush=True)
    trading_days = get_trading_days(START_DATE, END_DATE)
    print(f"[backfill] got {len(trading_days)} trading days: {trading_days[0]} ... {trading_days[-1]}", flush=True)

    t_start = time_mod.time()
    for i, trade_day in enumerate(trading_days, 1):
        out_dir = OUT_ROOT / STRATEGY_NAME / trade_day.strftime("%Y%m%d")
        diag_path = out_dir / "diagnostics.json"

        if diag_path.exists():
            existing = json.loads(diag_path.read_text(encoding="utf-8"))
            if existing.get("status") == "ok":
                print(f"[{i}/{len(trading_days)}] {trade_day}: has diagnostics.ok, skipping subprocess", flush=True)
            else:
                print(f"[{i}/{len(trading_days)}] {trade_day}: diagnostics.status={existing.get('status')}, rerunning", flush=True)
                t0 = time_mod.time()
                rc = run_inference_subprocess(trade_day, out_dir)
                print(f"    subprocess rc={rc} elapsed={time_mod.time()-t0:.1f}s", flush=True)
                if rc != 0:
                    continue
        else:
            print(f"[{i}/{len(trading_days)}] {trade_day}: inference...", flush=True)
            t0 = time_mod.time()
            rc = run_inference_subprocess(trade_day, out_dir)
            print(f"    subprocess rc={rc} elapsed={time_mod.time()-t0:.1f}s", flush=True)
            if rc != 0:
                continue

        metrics_path = out_dir / "metrics.json"
        if not metrics_path.exists():
            print(f"    WARN: no metrics.json, skipping upsert", flush=True)
            continue
        metrics = json.loads(metrics_path.read_text(encoding="utf-8"))

        # 写真实 trade_date, 不做偏移
        real_td = datetime.combine(trade_day, time_t(0))
        upsert(metrics, real_td)
        print(
            f"    UPSERT trade_date={real_td.date()} "
            f"ic={metrics.get('ic'):.4f} "
            f"rank_ic={metrics.get('rank_ic'):.4f} "
            f"psi_mean={metrics.get('psi_mean'):.4f} "
            f"n_pred={metrics.get('n_predictions')}",
            flush=True,
        )

    elapsed_total = time_mod.time() - t_start
    print(f"\n[backfill] DONE. total elapsed={elapsed_total/60:.1f}min", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
