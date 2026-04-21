"""Historical metrics sync (方案 §2.4.5).

现状: ``ml_snapshot_loop`` 每 60s 只拉 ``/metrics/latest`` (拿当日), 不会回头去
更新历史记录. 但 IC 回填发生在历史日期 (T 日 metrics.json 的 ic 字段从 null
被回填成实数), SQLite 里 T 日记录的 ic 字段不会自动更新.

本 service 解决: 每 N 分钟 (默认 5min) 调 ``/api/v1/ml/strategies/{name}/metrics?days=30``
拿历史列表, 与 SQLite 比对, 仅 ``UPDATE`` 那些"本地 ic IS NULL 但远端 ic 非 None"
的行的 ``ic / rank_ic`` 两列 — 不动其他字段, 不 UPSERT (避免覆盖).

为什么独立 loop:
1. ml_snapshot_loop 60s 节奏太频繁, 历史回填不需要这么快
2. 失败域隔离: 同步失败不影响 latest 快照
3. 语义清晰: 一个补"延迟可见", 一个补"实时落地"
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from sqlalchemy import update as sa_update
from sqlalchemy.orm import sessionmaker

from app.models.database import engine as db_engine
from app.models.ml_monitoring import MLMetricSnapshot
from app.services.vnpy.client import VnpyMultiNodeClient, get_vnpy_client

logger = logging.getLogger(__name__)


# 与 ml_monitoring_service.ML_ENGINE_NAME 保持一致
ML_ENGINE_NAME = "MlStrategy"
# 5 分钟 — IC 回填本身要等 forward window (≥1 个交易日), 高频轮询无意义
SYNC_POLL_INTERVAL_SECONDS = 300
# 每次同步回看天数, 跟 ic_backfill 默认 scan_days 对齐
SYNC_LOOKBACK_DAYS = 30


def _parse_trade_date(metrics: Dict[str, Any]) -> Optional[datetime]:
    """metrics.json 里 trade_date 是 YYYY-MM-DD 字符串."""
    raw = metrics.get("trade_date")
    if not raw:
        return None
    try:
        return datetime.strptime(raw, "%Y-%m-%d")
    except (TypeError, ValueError):
        return None


async def _collect_strategy_names(client: VnpyMultiNodeClient) -> Dict[str, List[str]]:
    """{node_id: [strategy_name...]} — 跟 ml_snapshot_loop 用同一个 discovery."""
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


def _diff_and_update(
    session,
    *,
    node_id: str,
    strategy_name: str,
    remote_history: List[Dict[str, Any]],
) -> int:
    """对 remote_history 的每条记录, 若本地行 ic IS NULL 但远端 ic 非 None, 就 UPDATE 本地两列.

    返回本次实际 UPDATE 的行数. 完全不做 INSERT — 那是 ml_snapshot_loop 的职责.
    """
    updated = 0
    for entry in remote_history:
        if not isinstance(entry, dict):
            continue
        trade_date = _parse_trade_date(entry)
        if trade_date is None:
            continue
        remote_ic = entry.get("ic")
        remote_rank_ic = entry.get("rank_ic")
        # 远端两个字段都为空就没必要 UPDATE
        if remote_ic is None and remote_rank_ic is None:
            continue

        local = (
            session.query(MLMetricSnapshot)
            .filter(
                MLMetricSnapshot.node_id == node_id,
                MLMetricSnapshot.engine == ML_ENGINE_NAME,
                MLMetricSnapshot.strategy_name == strategy_name,
                MLMetricSnapshot.trade_date == trade_date,
            )
            .first()
        )
        if local is None:
            # 行不存在 — 留给 ml_snapshot_loop 创建, 这里跳过
            continue

        # 仅在本地是 null 时才覆盖, 避免破坏 inference 当日已算出的真值
        changes: Dict[str, Any] = {}
        if local.ic is None and remote_ic is not None:
            changes["ic"] = remote_ic
        if local.rank_ic is None and remote_rank_ic is not None:
            changes["rank_ic"] = remote_rank_ic
        if not changes:
            continue

        session.execute(
            sa_update(MLMetricSnapshot)
            .where(MLMetricSnapshot.id == local.id)
            .values(**changes)
        )
        updated += 1
    return updated


async def historical_metrics_sync_tick() -> None:
    """One iteration — 拉历史 metrics 列表, 比对 SQLite, UPDATE ic/rank_ic."""
    client = get_vnpy_client()
    if not client.node_ids:
        return

    try:
        name_by_node = await _collect_strategy_names(client)
    except Exception as e:
        logger.warning("[hist_metrics_sync] discovery failed: %s", e)
        return

    if not any(names for names in name_by_node.values()):
        return

    # 拉每只策略最近 SYNC_LOOKBACK_DAYS 天的 metrics 列表
    histories: Dict[str, Dict[str, List[Dict[str, Any]]]] = {nid: {} for nid in name_by_node}
    tasks = []

    async def _fetch_one(nid: str, name: str):
        try:
            hist = await client.get_ml_metrics_history(nid, name, SYNC_LOOKBACK_DAYS)
        except Exception as e:
            logger.warning(
                "[hist_metrics_sync] get_ml_metrics_history(%s,%s) failed: %s",
                nid, name, e,
            )
            hist = []
        return (nid, name, hist)

    for nid, names in name_by_node.items():
        for name in names:
            tasks.append(_fetch_one(nid, name))

    for result in await asyncio.gather(*tasks, return_exceptions=True):
        if isinstance(result, Exception):
            continue
        nid, name, hist = result
        histories[nid][name] = hist or []

    SessionLocal = sessionmaker(bind=db_engine, autocommit=False, autoflush=False)
    session = SessionLocal()
    total_updated = 0
    try:
        for nid, by_strategy in histories.items():
            for name, remote_hist in by_strategy.items():
                if not remote_hist:
                    continue
                total_updated += _diff_and_update(
                    session,
                    node_id=nid,
                    strategy_name=name,
                    remote_history=remote_hist,
                )
        session.commit()
        if total_updated:
            logger.info(
                "[hist_metrics_sync] backfilled %d rows (ic/rank_ic)", total_updated
            )
    except Exception as e:
        logger.exception("[hist_metrics_sync] write failed: %s", e)
        session.rollback()
    finally:
        session.close()


async def historical_metrics_sync_loop() -> None:
    logger.info(
        "[hist_metrics_sync] historical_metrics_sync_loop started "
        "(interval=%ss, lookback_days=%s)",
        SYNC_POLL_INTERVAL_SECONDS,
        SYNC_LOOKBACK_DAYS,
    )
    while True:
        try:
            await historical_metrics_sync_tick()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.exception("[hist_metrics_sync] loop iteration failed: %s", e)
        try:
            await asyncio.sleep(SYNC_POLL_INTERVAL_SECONDS)
        except asyncio.CancelledError:
            raise
