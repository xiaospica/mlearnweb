"""Historical predictions sync — 拉 vnpy 端历史预测 summary 落 mlearnweb.db.

Phase 3.2 — 配套 vnpy webtrader 新增的:
  - ``GET /api/v1/ml/strategies/{name}/prediction/dates``
  - ``GET /api/v1/ml/strategies/{name}/prediction/{yyyymmdd}/summary``

之前 ``ml_prediction_daily`` 仅由 ``ml_snapshot_loop`` 每 60s 拉 ``latest``
UPSERT 一行 — 历史天永远不入库, 前端 "历史预测回溯 > TopK" tab 选老日期空白.
本 service 周期 (5min) 通过 dates 端点列出所有可用日期, 与 SQLite 比对,
INSERT 缺失天的 summary. metrics_history 那边 update-null-only 思路同源.

幂等性: ``(node_id, engine, strategy, trade_date)`` UNIQUE — 缺失才 INSERT,
重复扫描不会写脏. 不做 UPDATE — 历史预测一旦 metrics.json + selections.parquet
落盘就是 immutable, 与 IC 后期回填的延迟字段语义不同.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.orm import sessionmaker

from app.models.database import engine as db_engine
from app.models.ml_monitoring import MLPredictionDaily
from app.services.vnpy.client import VnpyMultiNodeClient, get_vnpy_client

logger = logging.getLogger(__name__)


ML_ENGINE_NAME = "MlStrategy"
SYNC_POLL_INTERVAL_SECONDS = 300  # 5 min — 历史预测变化频率 = 1 天 1 次, 高频拉无意义
# 与 historical_metrics_sync 一致 — 跨日 sync 的窗口由 vnpy 端 dates 端点控制,
# 它列的就是磁盘上全部 YYYYMMDD 目录.


def _truncate_json_field(value: Any, max_chars: int = 50_000) -> Optional[str]:
    """dict / list → JSON str. 超长截断兜底 (大 topk / histogram 防御)."""
    if value is None:
        return None
    if isinstance(value, str):
        return value[:max_chars] if len(value) > max_chars else value
    try:
        s = json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        return None
    return s[:max_chars] if len(s) > max_chars else s


def _date_str_to_datetime(date_str: str) -> Optional[datetime]:
    """'YYYY-MM-DD' → datetime(midnight). 与 ml_prediction_daily.trade_date 列一致."""
    try:
        return datetime.strptime(date_str, "%Y-%m-%d")
    except (TypeError, ValueError):
        return None


def _yyyymmdd_from_date_str(date_str: str) -> str:
    """'YYYY-MM-DD' → 'YYYYMMDD' for vnpy endpoint path param."""
    return date_str.replace("-", "")


async def _collect_strategy_names(client: VnpyMultiNodeClient) -> Dict[str, List[str]]:
    """{node_id: [strategy_name...]} — 与其他 sync service 共用 discovery 风格."""
    result: Dict[str, List[str]] = {}
    fo = await client.get_ml_health_all()
    for item in fo:
        if not item.get("ok"):
            continue
        data = item.get("data") or {}
        strategies = data.get("strategies") or []
        names = [s.get("name") for s in strategies if s.get("name")]
        if names:
            result[item["node_id"]] = names
    return result


def _existing_dates_for(
    session,
    *,
    node_id: str,
    strategy_name: str,
) -> set:
    """SQLite 已存的 trade_date 集合 (datetime, midnight)."""
    rows = (
        session.query(MLPredictionDaily.trade_date)
        .filter(
            MLPredictionDaily.node_id == node_id,
            MLPredictionDaily.engine == ML_ENGINE_NAME,
            MLPredictionDaily.strategy_name == strategy_name,
        )
        .all()
    )
    return {r[0] for r in rows}


def _insert_prediction_row(
    session,
    *,
    node_id: str,
    strategy_name: str,
    trade_date: datetime,
    summary: Dict[str, Any],
) -> None:
    """INSERT 一行 — 调用方已保证此 (node, strategy, trade_date) 不存在."""
    row = MLPredictionDaily(
        node_id=node_id,
        engine=ML_ENGINE_NAME,
        strategy_name=strategy_name,
        trade_date=trade_date,
        topk_json=_truncate_json_field(summary.get("topk")),
        score_histogram_json=_truncate_json_field(summary.get("score_histogram")),
        n_symbols=summary.get("n_symbols"),
        # coverage_ratio 在 vnpy summary 里没出, 留 None
        pred_mean=summary.get("pred_mean"),
        pred_std=summary.get("pred_std"),
        model_run_id=summary.get("model_run_id"),
        status="ok",
    )
    session.add(row)


async def _fetch_missing_summaries(
    client: VnpyMultiNodeClient,
    node_id: str,
    strategy_name: str,
    missing_dates: List[str],
) -> List[Tuple[str, Dict[str, Any]]]:
    """并发 fanout 拉每个 missing date 的 summary, 返回 [(date_str, summary), ...].

    单天失败不影响其他天 — 仅 log warn 后该天本次 tick skip.
    """
    async def _one(date_str: str) -> Optional[Tuple[str, Dict[str, Any]]]:
        try:
            yyyymmdd = _yyyymmdd_from_date_str(date_str)
            summary = await client.get_ml_prediction_summary_by_date(
                node_id, strategy_name, yyyymmdd,
            )
        except Exception as e:
            logger.warning(
                "[hist_pred_sync] fetch summary %s/%s/%s failed: %s",
                node_id, strategy_name, date_str, e,
            )
            return None
        if not isinstance(summary, dict) or not summary:
            return None
        return (date_str, summary)

    results = await asyncio.gather(*(_one(d) for d in missing_dates))
    return [r for r in results if r is not None]


async def historical_predictions_sync_tick() -> None:
    """One iteration — 列出 vnpy dates → 比对 SQLite → 拉缺失天 summary → INSERT."""
    client = get_vnpy_client()
    if not client.node_ids:
        return

    try:
        name_by_node = await _collect_strategy_names(client)
    except Exception as e:
        logger.warning("[hist_pred_sync] discovery failed: %s", e)
        return
    if not any(names for names in name_by_node.values()):
        return

    # 1. 拉每只策略的 dates 列表 (vnpy 端 list_prediction_dates)
    dates_by_node: Dict[str, Dict[str, List[str]]] = {nid: {} for nid in name_by_node}

    async def _fetch_dates(nid: str, name: str):
        try:
            dates = await client.get_ml_prediction_dates(nid, name)
        except Exception as e:
            logger.warning(
                "[hist_pred_sync] get_dates(%s,%s) failed: %s", nid, name, e,
            )
            dates = []
        return (nid, name, dates or [])

    tasks = [
        _fetch_dates(nid, name)
        for nid, names in name_by_node.items()
        for name in names
    ]
    for nid, name, dates in await asyncio.gather(*tasks):
        dates_by_node[nid][name] = dates

    # 2. 对每只策略: SQLite existing 取差集 → fetch missing summaries → INSERT
    SessionLocal = sessionmaker(bind=db_engine, autocommit=False, autoflush=False)
    session = SessionLocal()
    total_inserted = 0
    changed: set[tuple[str, str]] = set()
    try:
        for nid, by_strategy in dates_by_node.items():
            for name, dates in by_strategy.items():
                if not dates:
                    continue
                existing = _existing_dates_for(session, node_id=nid, strategy_name=name)
                # vnpy 端 dates 是 'YYYY-MM-DD' string, SQLite 是 datetime midnight
                missing = []
                for d_str in dates:
                    td = _date_str_to_datetime(d_str)
                    if td is None or td in existing:
                        continue
                    missing.append(d_str)
                if not missing:
                    continue

                summaries = await _fetch_missing_summaries(client, nid, name, missing)
                for d_str, summary in summaries:
                    td = _date_str_to_datetime(d_str)
                    if td is None:
                        continue
                    _insert_prediction_row(
                        session,
                        node_id=nid,
                        strategy_name=name,
                        trade_date=td,
                        summary=summary,
                    )
                    total_inserted += 1
                    changed.add((nid, name))
        session.commit()
        if total_inserted > 0:
            logger.info(
                "[hist_pred_sync] inserted=%d historical prediction rows",
                total_inserted,
            )
            from app.services.vnpy.live_trading_events import publish_strategy_event

            for nid, name in changed:
                await publish_strategy_event(
                    "strategy.history.changed",
                    node_id=nid,
                    engine=ML_ENGINE_NAME,
                    strategy_name=name,
                    reason="historical_predictions_sync",
                )
    except Exception as e:
        logger.exception("[hist_pred_sync] write failed: %s", e)
        session.rollback()
    finally:
        session.close()


async def historical_predictions_sync_loop() -> None:
    logger.info(
        "[hist_pred_sync] historical_predictions_sync_loop started (interval=%ss)",
        SYNC_POLL_INTERVAL_SECONDS,
    )
    while True:
        try:
            await historical_predictions_sync_tick()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.exception("[hist_pred_sync] loop iteration failed: %s", e)
        try:
            await asyncio.sleep(SYNC_POLL_INTERVAL_SECONDS)
        except asyncio.CancelledError:
            raise
