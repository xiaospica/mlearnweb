"""ML monitoring snapshot service (Phase 3.2).

``ml_snapshot_loop`` 每 60s 遍历所有 vnpy 节点 × ML 策略,拉 metrics + prediction
summary, UPSERT 到 ``ml_metric_snapshots`` + ``ml_prediction_daily``. 按
``vnpy_snapshot_retention_days`` 裁剪老数据.

为什么走自己的协程而不复用 ``snapshot_loop``:
1. snapshot_loop 10s 轮询 — 对 ML 日频指标过于频繁
2. ML 路由 ``/api/v1/ml/health`` 作为 discovery 入口, 结构与现有
   ``/api/v1/strategy`` 不同, 独立一个 tick 更清晰
3. 失败域隔离: ML 拉取失败不应影响现有 live-trading 的 equity 快照
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from sqlalchemy import delete as sa_delete
from sqlalchemy.orm import sessionmaker

from app.core.config import settings
from app.models.database import engine as db_engine
from app.models.ml_monitoring import MLMetricSnapshot, MLPredictionDaily
from app.services.vnpy.client import VnpyMultiNodeClient, get_vnpy_client

logger = logging.getLogger(__name__)


ML_ENGINE_NAME = "MlStrategy"   # 与 vnpy_ml_strategy.APP_NAME 对齐
ML_POLL_INTERVAL_SECONDS = 60   # ML 日频指标, 每分钟拉一次足够


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _parse_trade_date(metrics: Dict[str, Any]) -> Optional[datetime]:
    """metrics.json 里 trade_date 是 YYYY-MM-DD 字符串."""
    raw = metrics.get("trade_date")
    if not raw:
        return None
    try:
        return datetime.strptime(raw, "%Y-%m-%d")
    except (TypeError, ValueError):
        return None


def _truncate_json_field(data: Any, max_len: int = 16000) -> Optional[str]:
    """Serialize + cap to avoid bloating SQLite rows. None on empty/error."""
    if not data:
        return None
    try:
        s = json.dumps(data, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return None
    if len(s) > max_len:
        return s[:max_len]
    return s


def _upsert_metric(
    session,
    *,
    node_id: str,
    strategy_name: str,
    trade_date: datetime,
    metrics: Dict[str, Any],
    status: str,
) -> None:
    """UPSERT on (node_id, engine, strategy_name, trade_date)."""
    q = session.query(MLMetricSnapshot).filter(
        MLMetricSnapshot.node_id == node_id,
        MLMetricSnapshot.engine == ML_ENGINE_NAME,
        MLMetricSnapshot.strategy_name == strategy_name,
        MLMetricSnapshot.trade_date == trade_date,
    )
    row = q.first()
    if row is None:
        row = MLMetricSnapshot(
            node_id=node_id,
            engine=ML_ENGINE_NAME,
            strategy_name=strategy_name,
            trade_date=trade_date,
        )
        session.add(row)

    # 关键：仅在 metrics 实际带值时才覆盖 ic / rank_ic / psi 等"延迟回填型"字段。
    # vnpy MetricsCache 在推理时不算 IC (forward 11d label 还不知道), metrics dict
    # 里这些字段是 None。如果无脑 row.ic = metrics.get("ic") 会把 None 写回，覆盖
    # 了 backfill_ml_metrics_ic.py / historical_metrics_sync 之前补的真值。
    # historical_metrics_sync_service.py:106 的 "仅本地 null 时才覆盖" 是同一思路。
    def _set_if_not_none(attr: str, value: Any) -> None:
        if value is not None:
            setattr(row, attr, value)

    _set_if_not_none("ic", metrics.get("ic"))
    _set_if_not_none("rank_ic", metrics.get("rank_ic"))
    _set_if_not_none("psi_mean", metrics.get("psi_mean"))
    _set_if_not_none("psi_max", metrics.get("psi_max"))
    _set_if_not_none("psi_n_over_0_25", metrics.get("psi_n_over_0_25"))
    if metrics.get("psi_by_feature"):
        row.psi_by_feature_json = _truncate_json_field(metrics.get("psi_by_feature"))
    if metrics.get("ks_by_feature"):
        row.ks_by_feature_json = _truncate_json_field(metrics.get("ks_by_feature"))
    _set_if_not_none("pred_mean", metrics.get("pred_mean"))
    _set_if_not_none("pred_std", metrics.get("pred_std"))
    _set_if_not_none("pred_zero_ratio", metrics.get("pred_zero_ratio"))
    _set_if_not_none("n_predictions", metrics.get("n_predictions"))
    if metrics.get("feat_missing"):
        row.feat_missing_json = _truncate_json_field(metrics.get("feat_missing"))
    _set_if_not_none("model_run_id", metrics.get("model_run_id"))
    _set_if_not_none("core_version", metrics.get("core_version"))
    row.status = status


def _upsert_prediction(
    session,
    *,
    node_id: str,
    strategy_name: str,
    trade_date: datetime,
    summary: Dict[str, Any],
    status: str,
) -> None:
    q = session.query(MLPredictionDaily).filter(
        MLPredictionDaily.node_id == node_id,
        MLPredictionDaily.engine == ML_ENGINE_NAME,
        MLPredictionDaily.strategy_name == strategy_name,
        MLPredictionDaily.trade_date == trade_date,
    )
    row = q.first()
    if row is None:
        row = MLPredictionDaily(
            node_id=node_id,
            engine=ML_ENGINE_NAME,
            strategy_name=strategy_name,
            trade_date=trade_date,
        )
        session.add(row)

    row.topk_json = _truncate_json_field(summary.get("topk"))
    row.score_histogram_json = _truncate_json_field(summary.get("score_histogram"))
    row.n_symbols = summary.get("n_symbols")
    row.coverage_ratio = summary.get("coverage_ratio")
    row.pred_mean = summary.get("pred_mean")
    row.pred_std = summary.get("pred_std")
    row.model_run_id = summary.get("model_run_id")
    row.status = status


# ---------------------------------------------------------------------------
# snapshot_tick + snapshot_loop
# ---------------------------------------------------------------------------


async def _collect_strategy_names(client: VnpyMultiNodeClient) -> Dict[str, List[str]]:
    """{node_id: [strategy_name...]} — via /api/v1/ml/health fanout."""
    result: Dict[str, List[str]] = {}
    fo = await client.get_ml_health_all()
    for item in fo:
        if not item.get("ok"):
            continue
        data = item.get("data") or {}
        strategies = data.get("strategies") or []
        names = [s.get("name") for s in strategies if s.get("name")]
        result[item["node_id"]] = names
    return result


async def _collect_per_strategy(
    client: VnpyMultiNodeClient,
    name_by_node: Dict[str, List[str]],
) -> Dict[str, Dict[str, Dict[str, Any]]]:
    """Fetch latest metrics + prediction summary for each (node, strategy).

    Returns {node_id: {strategy_name: {"metrics": ..., "prediction": ...}}}.
    """
    out: Dict[str, Dict[str, Dict[str, Any]]] = {nid: {} for nid in name_by_node}
    tasks = []

    async def _fetch_one(node_id: str, name: str) -> tuple:
        try:
            metrics = await client.get_ml_metrics_latest(node_id, name)
        except Exception as e:
            logger.warning(
                "[ml_snapshot] get_ml_metrics_latest(%s,%s) failed: %s",
                node_id, name, e,
            )
            metrics = {}
        try:
            prediction = await client.get_ml_prediction_summary(node_id, name)
        except Exception as e:
            logger.warning(
                "[ml_snapshot] get_ml_prediction_summary(%s,%s) failed: %s",
                node_id, name, e,
            )
            prediction = {}
        return (node_id, name, metrics, prediction)

    for nid, names in name_by_node.items():
        for name in names:
            tasks.append(_fetch_one(nid, name))

    for result in await asyncio.gather(*tasks, return_exceptions=True):
        if isinstance(result, Exception):
            continue
        node_id, name, metrics, prediction = result
        out[node_id][name] = {"metrics": metrics, "prediction": prediction}

    return out


async def ml_snapshot_tick() -> None:
    """One iteration — discover ML strategies, fetch metrics, UPSERT."""
    client = get_vnpy_client()
    if not client.node_ids:
        return

    try:
        name_by_node = await _collect_strategy_names(client)
    except Exception as e:
        logger.warning("[ml_snapshot] discovery failed: %s", e)
        return

    has_any = any(names for names in name_by_node.values())
    if not has_any:
        return  # no ML strategy on any node — nothing to snapshot

    data_by_node = await _collect_per_strategy(client, name_by_node)

    now = datetime.now()
    SessionLocal = sessionmaker(bind=db_engine, autocommit=False, autoflush=False)
    session = SessionLocal()

    written = 0
    try:
        for node_id, strategies in data_by_node.items():
            for strategy_name, payload in strategies.items():
                metrics = payload.get("metrics") or {}
                prediction = payload.get("prediction") or {}

                trade_date = (
                    _parse_trade_date(metrics)
                    or _parse_trade_date(prediction)
                    or now  # fallback: log under current wall-clock day
                )
                status = metrics.get("status", "ok") if metrics else "empty"

                if metrics:
                    _upsert_metric(
                        session,
                        node_id=node_id,
                        strategy_name=strategy_name,
                        trade_date=trade_date,
                        metrics=metrics,
                        status=status,
                    )
                    written += 1

                if prediction:
                    _upsert_prediction(
                        session,
                        node_id=node_id,
                        strategy_name=strategy_name,
                        trade_date=trade_date,
                        summary=prediction,
                        status=status,
                    )

        # ml_metric_snapshots / ml_prediction_daily 不做 retention：
        # 这两张表每个 (策略, trade_date) 一行，回放/历史档案体量小（10 年 ~8K 行），
        # 但语义上是"按交易日的历史记录"，按 trade_date < cutoff 裁剪会把回放写入
        # 的 2026-01-01 ~ today-1 的历史曲线点立刻删光（trade_date 是逻辑日，不是
        # wall-clock 时间）→ 前端 Tab2 策略监控/历史预测回溯只剩近 30 天可见。
        session.commit()
        if written:
            logger.debug("[ml_snapshot] ml_snapshot_tick wrote %d rows", written)
    except Exception as e:
        logger.exception("[ml_snapshot] write failed: %s", e)
        session.rollback()
    finally:
        session.close()

    # 注: 早期此处调 ml_metrics_backfill_service.backfill_all_strategies 在
    # mlearnweb 端扫 D:\ml_output / daily_merged 自己算 IC, 违反"推理端算单日,
    # 监控端跨天聚合"原则 + 跨机部署不可行. 已删 (vnpy commit bc28425 后 vendor
    # IcBackfillService 端到端闭环, IC 完全由推理端 metrics.json 提供). 监控端
    # 拉取走 historical_metrics_sync_loop 5min 一次, 在独立 service 里.


async def ml_snapshot_loop() -> None:
    logger.info(
        "[ml_snapshot] ml_snapshot_loop started (interval=%ss, retention=%sd)",
        ML_POLL_INTERVAL_SECONDS,
        settings.vnpy_snapshot_retention_days,
    )
    while True:
        try:
            await ml_snapshot_tick()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.exception("[ml_snapshot] loop iteration failed: %s", e)
        try:
            await asyncio.sleep(ML_POLL_INTERVAL_SECONDS)
        except asyncio.CancelledError:
            raise
