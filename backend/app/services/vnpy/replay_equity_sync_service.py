"""Replay equity sync service (A1/B2 解耦后的 vnpy → mlearnweb 数据流接力).

背景:
    vnpy 端不再直接写 mlearnweb.db 的 strategy_equity_snapshots
    (跨工程紧耦合,跨机部署阻塞). 改成写 vnpy 本地 replay_history.db,
    通过 vnpy_webtrader endpoint 暴露给 mlearnweb 拉.

本 service:
    每 N 分钟 (默认 5min) fanout 调
        GET /api/v1/ml/strategies/{name}/replay/equity_snapshots?since=&limit=
    用 mlearnweb 本地 ``MAX(inserted_at)`` 作 since 增量拉,
    UPSERT 到 strategy_equity_snapshots(source_label='replay_settle').

为何独立 loop (与 ml_snapshot_loop / historical_metrics_sync_service 并列):
    1. 关注点分离: snapshot_loop 拉实时 wall-clock equity (每 60s),
       本 service 拉历史回放快照 (5min 周期已足够)
    2. 失败域隔离: replay 同步失败不影响实时 snapshot_loop
    3. source_label 区分: 实时 = 'strategy_pnl' / 'account_equity' /
       'position_sum_pnl', 回放 = 'replay_settle'

详见 docs/deployment_a1_p21_plan.md §一.2c (vnpy_strategy_dev 工程).
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy import func
from sqlalchemy.orm import sessionmaker

from app.models.database import StrategyEquitySnapshot, engine as db_engine
from app.services.vnpy.client import VnpyMultiNodeClient, get_vnpy_client


logger = logging.getLogger(__name__)


# 与 ml_monitoring_service / live_trading_service 一致; 旧版 vnpy_webtrader
# (get_health 不带 engine 字段) 的回退值, 也是 run_ml_headless 的引擎名.
ML_ENGINE_NAME = "MlStrategy"
# 60s — 与 ml_snapshot_loop 周期一致. 历史值稳态不变, 但 demo / 实盘冷启动 (策略
# 重新部署 / mlearnweb 重启) 时, 5min 周期会让用户最长等 5 分钟才看到回放权益曲线.
# 60s 周期下稳态每分钟一次空查 (无新数据 → 0 行 UPSERT) 开销 < 50ms HTTP, 可忽略.
SYNC_POLL_INTERVAL_SECONDS = 60
# vnpy 端 endpoint 默认上限 100000, 我们一次最多拉 10000 行已远超 30 天回放 (30 行).
SYNC_LIMIT = 10000
# 'replay_settle' source_label 与 vnpy_ml_strategy.template._persist_replay_equity_snapshot
# 历史固化值一致, 不要改 (前端 / equity_curve_comparison.py 按此 label 过滤).
REPLAY_SOURCE_LABEL = "replay_settle"


SessionLocal = sessionmaker(bind=db_engine, autoflush=False, autocommit=False)


async def _collect_strategies(
    client: VnpyMultiNodeClient,
) -> Dict[str, List[Dict[str, str]]]:
    """{node_id: [{"name": ..., "engine": ...}, ...]} — 从 /api/v1/ml/health 发现策略.

    health 响应里每个策略携带真实 engine 名 (SignalStrategyPlus / MlStrategy / …).
    若 health 响应里没有 engine 字段 (旧版 vnpy_webtrader), 回退到 ML_ENGINE_NAME.
    """
    result: Dict[str, List[Dict[str, str]]] = {}
    fo = await client.get_ml_health_all()
    for item in fo:
        if not item.get("ok"):
            continue
        data = item.get("data") or {}
        strategies = data.get("strategies") or []
        entries = [
            {
                "name": s["name"],
                "engine": s.get("engine") or ML_ENGINE_NAME,
            }
            for s in strategies if s.get("name")
        ]
        if entries:
            result[item["node_id"]] = entries
    return result


def _get_local_max_inserted_at(
    session, *, node_id: str, strategy_name: str, engine: str = ML_ENGINE_NAME,
) -> Optional[str]:
    """本地 strategy_equity_snapshots 中 (node, engine, strategy, source_label=replay_settle)
    的最大 ts (用作 vnpy 端 since 增量边界).
    """
    row = (
        session.query(func.max(StrategyEquitySnapshot.ts))
        .filter(
            StrategyEquitySnapshot.node_id == node_id,
            StrategyEquitySnapshot.engine == engine,
            StrategyEquitySnapshot.strategy_name == strategy_name,
            StrategyEquitySnapshot.source_label == REPLAY_SOURCE_LABEL,
        )
        .scalar()
    )
    if row is None:
        return None
    return row.isoformat() if isinstance(row, datetime) else str(row)


def _upsert_remote_rows(
    session,
    *,
    node_id: str,
    strategy_name: str,
    rows: List[Dict[str, Any]],
    engine: str = ML_ENGINE_NAME,
) -> int:
    """UPSERT 一批远端行到本地 strategy_equity_snapshots. 返回本次写入的行数.

    SQLite 走"先 DELETE 同 (node, engine, strategy, source_label, DATE(ts))
    再 INSERT"幂等模式. 关键: DELETE 后必须 flush 让 SQL 落库, 否则
    session.add 加进去的新对象与待删旧对象在同一 unit-of-work 里, commit
    时执行顺序不保证, 旧行可能没被实际删掉.
    """
    n = 0
    for r in rows:
        ts_raw = r.get("ts")
        if not ts_raw:
            continue
        try:
            ts = datetime.fromisoformat(ts_raw)
        except (TypeError, ValueError):
            logger.warning("[replay_equity_sync] 跳过非法 ts=%r", ts_raw)
            continue

        session.query(StrategyEquitySnapshot).filter(
            StrategyEquitySnapshot.node_id == node_id,
            StrategyEquitySnapshot.engine == engine,
            StrategyEquitySnapshot.strategy_name == strategy_name,
            StrategyEquitySnapshot.source_label == REPLAY_SOURCE_LABEL,
            func.date(StrategyEquitySnapshot.ts) == ts.date(),
        ).delete(synchronize_session=False)
        # 让 DELETE 先于后面的 INSERT 落库 (uow 顺序保证)
        session.flush()

        session.add(StrategyEquitySnapshot(
            node_id=node_id,
            engine=engine,
            strategy_name=strategy_name,
            ts=ts,
            strategy_value=float(r.get("strategy_value") or 0.0),
            account_equity=float(r.get("account_equity") or 0.0),
            source_label=REPLAY_SOURCE_LABEL,
            positions_count=int(r.get("positions_count") or 0),
            raw_variables_json=str(r.get("raw_variables") or {})
                if r.get("raw_variables") is not None else None,
        ))
        session.flush()
        n += 1
    return n


async def sync_one_node_strategy(
    client: VnpyMultiNodeClient,
    *,
    node_id: str,
    strategy_name: str,
    engine: str = ML_ENGINE_NAME,
) -> int:
    """同步单 (node, engine, strategy) 一次. 返回 UPSERT 行数."""
    session = SessionLocal()
    try:
        since = _get_local_max_inserted_at(
            session, node_id=node_id, engine=engine, strategy_name=strategy_name,
        )
    finally:
        session.close()

    rows = await client.get_per_node(node_id).get_ml_replay_equity_snapshots(
        strategy_name, since=since, limit=SYNC_LIMIT,
    )
    if not rows:
        return 0

    session = SessionLocal()
    try:
        n = _upsert_remote_rows(
            session, node_id=node_id, engine=engine,
            strategy_name=strategy_name, rows=rows,
        )
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
    return n


async def sync_all() -> Dict[str, Any]:
    """主入口: discovery → 逐 (node, engine, strategy) 同步. 返回 {scanned, upserted}."""
    client = get_vnpy_client()
    by_node = await _collect_strategies(client)
    if not by_node:
        return {"scanned": 0, "upserted": 0, "changed": [], "ok": True, "msg": "no strategies discovered"}

    total_upserted = 0
    total_scanned = 0
    changed: list[dict[str, str]] = []
    for nid, entries in by_node.items():
        for entry in entries:
            total_scanned += 1
            try:
                n = await sync_one_node_strategy(
                    client,
                    node_id=nid,
                    engine=entry["engine"],
                    strategy_name=entry["name"],
                )
                total_upserted += n
                if n:
                    changed.append({
                        "node_id": nid,
                        "engine": entry["engine"],
                        "strategy_name": entry["name"],
                    })
            except Exception as exc:
                logger.warning(
                    "[replay_equity_sync] node=%s engine=%s strategy=%s 同步失败: %s",
                    nid, entry.get("engine"), entry.get("name"), exc,
                )
    return {
        "scanned": total_scanned,
        "upserted": total_upserted,
        "changed": changed,
        "ok": True,
        "msg": "",
    }


async def replay_equity_sync_loop() -> None:
    """长跑后台 loop, 由 live_main.py lifespan 接入. 失败仅 log warn 不退出."""
    logger.info(
        "[replay_equity_sync] 启动, 每 %ds 同步一次", SYNC_POLL_INTERVAL_SECONDS,
    )
    while True:
        try:
            stats = await sync_all()
            if stats.get("upserted"):
                logger.info(
                    "[replay_equity_sync] 同步完成 scanned=%d upserted=%d",
                    stats.get("scanned", 0), stats.get("upserted", 0),
                )
                from app.services.vnpy.live_trading_events import publish_strategy_event

                for item in stats.get("changed", []) or []:
                    await publish_strategy_event(
                        "strategy.equity.changed",
                        node_id=item["node_id"],
                        engine=item["engine"],
                        strategy_name=item["strategy_name"],
                        reason="replay_equity_sync",
                    )
        except asyncio.CancelledError:
            logger.info("[replay_equity_sync] cancelled, 退出")
            raise
        except Exception as exc:
            logger.warning("[replay_equity_sync] 周期内异常: %s", exc)
        try:
            await asyncio.sleep(SYNC_POLL_INTERVAL_SECONDS)
        except asyncio.CancelledError:
            raise
