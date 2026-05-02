"""ML monitoring routes: ``/api/live-trading/ml/*``.

前端 Tab2 通过这些端点拿:
  - 单日监控指标 (从 MLMetricSnapshot)
  - 跨天滚动聚合 (ICIR / PSI 告警)
  - 按日预测 summary (topk + histogram)
  - 实时 latest / prediction (直接穿透到 vnpy /api/v1/ml/*)

历史数据都读本地 SQLite, latest 数据用 client.get_ml_* 直接穿透到 vnpy 节点
(仅当 ml_snapshot_loop 可能未跑一轮时需要, 一般走 SQLite).
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.models.database import get_db_session
from app.schemas.schemas import LiveTradingListResponse
from app.services import ml_aggregation_service as agg_svc
from app.services.vnpy.client import VnpyClientError, get_vnpy_client

logger = logging.getLogger(__name__)


router = APIRouter(prefix="/api/live-trading/ml", tags=["live-trading-ml"])


def _ok(data: Any, warning: str | None = None) -> LiveTradingListResponse:
    return LiveTradingListResponse(success=True, data=data, warning=warning)


def _fail(message: str, status: int = 502) -> HTTPException:
    return HTTPException(status_code=status, detail=message)


# ---------------------------------------------------------------------------
# Historical reads (backed by SQLite ml_metric_snapshots / ml_prediction_daily)
# ---------------------------------------------------------------------------


@router.get(
    "/{node_id}/{strategy_name}/metrics/history",
    response_model=LiveTradingListResponse,
)
def metrics_history(
    node_id: str,
    strategy_name: str,
    days: int = Query(30, ge=1, le=365),
    db: Session = Depends(get_db_session),
) -> LiveTradingListResponse:
    """最近 N 日每日指标列表 (按 trade_date 升序)."""
    try:
        rows = agg_svc.get_metrics_history(db, node_id, strategy_name, days=days)
        return _ok(rows)
    except Exception as e:
        logger.exception("[ml-monitoring] metrics_history failed: %s", e)
        return LiveTradingListResponse(
            success=False, data=[], warning=f"查询失败: {e}", message=str(e)
        )


@router.get(
    "/{node_id}/{strategy_name}/metrics/rolling",
    response_model=LiveTradingListResponse,
)
def metrics_rolling(
    node_id: str,
    strategy_name: str,
    window: int = Query(30, ge=7, le=120),
    db: Session = Depends(get_db_session),
) -> LiveTradingListResponse:
    """ICIR + PSI 趋势告警等跨天聚合 (前端 Tab2 的主要调用)."""
    try:
        summary = agg_svc.compute_rolling_summary(db, node_id, strategy_name, window=window)
        return _ok(summary)
    except Exception as e:
        logger.exception("[ml-monitoring] metrics_rolling failed: %s", e)
        return LiveTradingListResponse(
            success=False, data=None, warning=f"聚合失败: {e}", message=str(e)
        )


@router.get(
    "/{node_id}/{strategy_name}/prediction/summary/{yyyymmdd}",
    response_model=LiveTradingListResponse,
)
def prediction_by_date(
    node_id: str,
    strategy_name: str,
    yyyymmdd: str,
    db: Session = Depends(get_db_session),
) -> LiveTradingListResponse:
    """按日期 YYYYMMDD 查询预测 summary (topk + histogram)."""
    summary = agg_svc.get_prediction_by_date(db, node_id, strategy_name, yyyymmdd)
    if summary is None:
        return LiveTradingListResponse(
            success=False, data=None, warning=f"{strategy_name}@{yyyymmdd} 无记录",
            message="not found",
        )
    return _ok(summary)


@router.get(
    "/{node_id}/{strategy_name}/prediction/all/{yyyymmdd}",
    response_model=LiveTradingListResponse,
)
def prediction_all_by_date(
    node_id: str,
    strategy_name: str,
    yyyymmdd: str,
) -> LiveTradingListResponse:
    """按日期 YYYYMMDD 返回**全量**预测列表 (股票池所有股票的 score).

    与 ``/prediction/summary/{yyyymmdd}`` 的区别: summary 只返回 topK + 直方图,
    本端点返回全部股票的 (rank, instrument, name, score), 供前端"历史预测回溯
    > 全部预测" 子 Tab 展示 + 按 pred 排序.

    数据源: ``{ml_live_output_root}/{strategy_name}/{yyyymmdd}/predictions.parquet``
    (qlib subprocess 落盘), 读时通过 tushare ``stock_list.parquet`` 做股票名 enrichment.
    """
    from app.core.config import settings
    # ml_live_output_root 是部署绑定的本地挂载点（指向策略服务器输出），
    # 不暴露给 web UI 修改；通过 .env 的 ML_LIVE_OUTPUT_ROOT 配置后重启 app.main。
    root = settings.ml_live_output_root
    if not root:
        return LiveTradingListResponse(
            success=False, data=None,
            warning="需在 .env 设置 ML_LIVE_OUTPUT_ROOT 后重启 app.main",
            message="missing ml_live_output_root",
        )
    try:
        rows = agg_svc.get_all_predictions_by_date(strategy_name, yyyymmdd, root)
    except Exception as e:  # noqa: BLE001
        logger.exception("[ml-monitoring] prediction_all_by_date failed: %s", e)
        return LiveTradingListResponse(
            success=False, data=[], warning=f"读取失败: {e}", message=str(e),
        )
    if not rows:
        return LiveTradingListResponse(
            success=False, data=[], warning=f"{strategy_name}@{yyyymmdd} 无预测记录",
            message="not found",
        )
    return _ok(rows)


# ---------------------------------------------------------------------------
# Backtest vs live predictions diff (解读 A — MLflow artifacts 对齐)
# ---------------------------------------------------------------------------


@router.get(
    "/{node_id}/{strategy_name}/backtest-diff",
    response_model=LiveTradingListResponse,
)
def backtest_diff(
    node_id: str,
    strategy_name: str,
    mlflow_run_dir: str = Query(..., description="训练侧 MLflow run artifacts dir, 含 pred.pkl"),
    live_output_root: str | None = Query(None, description="live 推理 predictions 根目录, 默认 settings.ml_live_output_root"),
    recent_days: int = Query(30, ge=1, le=365),
    db: Session = Depends(get_db_session),
) -> LiveTradingListResponse:
    """对比训练侧 backtest pred.pkl 与 live predictions per date."""
    from app.core.config import settings
    # ml_live_output_root：部署绑定的本地挂载点，仅 .env 可改 + 重启生效
    root = live_output_root or settings.ml_live_output_root
    if not root:
        return LiveTradingListResponse(
            success=False, data=None,
            warning="需提供 live_output_root 参数，或在 .env 设置 ML_LIVE_OUTPUT_ROOT 后重启 app.main",
            message="missing live_output_root",
        )
    try:
        data = agg_svc.backtest_vs_live_diff(
            db, node_id, strategy_name,
            mlflow_artifacts_dir=mlflow_run_dir,
            live_output_root=root,
            recent_days=recent_days,
        )
        return _ok(data)
    except Exception as e:
        logger.exception("[ml-monitoring] backtest_diff failed: %s", e)
        return LiveTradingListResponse(
            success=False, data=None, warning=f"对比失败: {e}", message=str(e),
        )


# ---------------------------------------------------------------------------
# Pass-through to vnpy node /api/v1/ml/* (realtime latest, bypasses cache)
# ---------------------------------------------------------------------------


@router.get(
    "/{node_id}/{strategy_name}/metrics/latest",
    response_model=LiveTradingListResponse,
)
async def metrics_latest(
    node_id: str,
    strategy_name: str,
    db: Session = Depends(get_db_session),
) -> LiveTradingListResponse:
    """直读 vnpy 节点最新指标; RPC 失败退化到 SQLite 最新缓存.

    vnpy 主线程在 tushare 日更 pandas 处理期可能阻塞 100s+, 触发 webtrader
    30s RPC 超时. 此时返回 SQLite 最新 snapshot + warning, 前端能保留显示.
    """
    client = get_vnpy_client()
    try:
        data = await client.get_ml_metrics_latest(node_id, strategy_name)
        return _ok(data)
    except VnpyClientError as e:
        cached = agg_svc.get_latest_metric_snapshot(db, node_id, strategy_name)
        if cached is not None:
            return _ok(cached, warning=f"vnpy 穿透失败({e}), 已退化到 SQLite 最新缓存")
        raise _fail(str(e))


@router.get(
    "/{node_id}/{strategy_name}/prediction/latest/summary",
    response_model=LiveTradingListResponse,
)
async def prediction_latest_summary(
    node_id: str,
    strategy_name: str,
    db: Session = Depends(get_db_session),
) -> LiveTradingListResponse:
    """优先穿透到 vnpy 节点拿实时; 失败则退化用 SQLite 最新缓存.

    字段级 merge: vnpy MetricsCache 的 score_histogram 在 batch 回放模式下
    是空 [] (vendor batch 不写 metrics.json), 但 mlearnweb db 已通过自动
    backfill 补齐 (ml_metrics_backfill_service)。这里 vnpy 字段为空时从
    db 兜底补, 保证前端"预测分数直方图（最新）"等卡片有数据。
    """
    client = get_vnpy_client()
    cached = agg_svc.get_latest_prediction(db, node_id, strategy_name)
    try:
        data = await client.get_ml_prediction_summary(node_id, strategy_name)
    except VnpyClientError as e:
        if cached is not None:
            return _ok(cached, warning=f"vnpy 穿透失败({e}), 已退化到 SQLite 最新记录")
        raise _fail(str(e))

    # 字段级 fallback: vnpy data 字段空 → 用 db cached 同名字段补
    if cached and isinstance(data, dict):
        for field in ("score_histogram", "topk", "pred_mean", "pred_std", "n_symbols", "model_run_id"):
            v = data.get(field)
            empty = v is None or v == [] or v == "" or (field == "n_symbols" and v == 0)
            if empty and cached.get(field):
                data[field] = cached[field]
    return _ok(data)


# ---------------------------------------------------------------------------
# Global health (across all nodes)
# ---------------------------------------------------------------------------


@router.get("/health", response_model=LiveTradingListResponse)
async def global_health() -> LiveTradingListResponse:
    """汇总所有 vnpy 节点的 /api/v1/ml/health."""
    client = get_vnpy_client()
    fo = await client.get_ml_health_all()
    # reshape to flat list: [{node_id, ok, strategies: [...]}]
    out = []
    for item in fo:
        out.append({
            "node_id": item.get("node_id"),
            "ok": item.get("ok"),
            "error": item.get("error"),
            "strategies": (item.get("data") or {}).get("strategies") if item.get("ok") else [],
        })
    return _ok(out)
