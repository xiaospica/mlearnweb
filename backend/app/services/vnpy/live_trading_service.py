"""Business logic for the live-trading module.

Responsibilities:
  * Merge fanout reads (strategies/accounts/positions) from VnpyMultiNodeClient
    into StrategySummary / StrategyDetail rows.
  * Resolve per-strategy equity value via three-tier fallback:
      A. strategy.variables contains a PnL field → use directly
      B. strategy has a non-empty vt_symbol → sum matching position pnls
      C. otherwise → use the strategy's gateway account balance
  * Read/write the StrategyEquitySnapshot table for historical curves.
  * Drive the background snapshot_loop (owned by app.live_main lifespan).
  * Expose write helpers that simply forward to VnpyMultiNodeClient.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import delete as sa_delete
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.database import StrategyEquitySnapshot, engine as db_engine
from app.services.vnpy.client import VnpyClientError, get_vnpy_client

logger = logging.getLogger(__name__)

# variables keys that commonly contain strategy-level PnL
_PNL_VARIABLE_KEYS = ("total_pnl", "net_pnl", "strategy_pnl", "pnl")


# ---------------------------------------------------------------------------
# PnL resolution
# ---------------------------------------------------------------------------


def _find_pnl_in_variables(variables: Dict[str, Any]) -> Optional[float]:
    if not isinstance(variables, dict):
        return None
    for key in _PNL_VARIABLE_KEYS:
        if key in variables:
            try:
                return float(variables[key])
            except (TypeError, ValueError):
                continue
    return None


def _sum_position_pnl(vt_symbol: Optional[str], positions: List[Dict[str, Any]]) -> Optional[float]:
    if not vt_symbol:
        return None
    total = 0.0
    hit = False
    for p in positions or []:
        if str(p.get("vt_symbol", "")) == vt_symbol:
            try:
                total += float(p.get("pnl") or 0)
                hit = True
            except (TypeError, ValueError):
                continue
    return total if hit else None


def _first_account_equity(accounts: List[Dict[str, Any]]) -> Optional[float]:
    """Pick the first account's balance as a coarse equity proxy.

    Multi-strategy shared-account attribution is not solvable from vnpy's
    snapshot model; this is Source C in the fallback chain and will be
    labelled as such in the UI.
    """
    if not accounts:
        return None
    for acc in accounts:
        bal = acc.get("balance")
        if bal is not None:
            try:
                return float(bal)
            except (TypeError, ValueError):
                continue
    return None


def _count_positions(vt_symbol: Optional[str], positions: List[Dict[str, Any]]) -> int:
    if not positions:
        return 0
    if vt_symbol:
        return sum(1 for p in positions if str(p.get("vt_symbol", "")) == vt_symbol)
    return len(positions)


def _resolve_strategy_value(
    strategy: Dict[str, Any],
    positions: List[Dict[str, Any]],
    accounts: List[Dict[str, Any]],
) -> Tuple[Optional[float], str, Optional[float]]:
    """Return (strategy_value, source_label, account_equity).

    account_equity is always returned when available so the snapshot row
    can persist it even when source is strategy_pnl / position_sum_pnl.
    """
    account_equity = _first_account_equity(accounts)
    variables = strategy.get("variables") or {}

    # Source A
    pnl = _find_pnl_in_variables(variables)
    if pnl is not None:
        return pnl, "strategy_pnl", account_equity

    # Source B
    vt_symbol = strategy.get("vt_symbol")
    pos_sum = _sum_position_pnl(vt_symbol, positions)
    if pos_sum is not None:
        return pos_sum, "position_sum_pnl", account_equity

    # Source C
    if account_equity is not None:
        return account_equity, "account_equity", account_equity

    return None, "unavailable", None


# ---------------------------------------------------------------------------
# Fanout merging
# ---------------------------------------------------------------------------


def _group_by_node(fanout: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    """Turn FanoutItem[] into {node_id: data_list}, skipping failed nodes."""
    out: Dict[str, List[Dict[str, Any]]] = {}
    for item in fanout:
        if not item.get("ok"):
            continue
        out[item["node_id"]] = item.get("data") or []
    return out


def _first_warning(*fanouts: List[Dict[str, Any]]) -> Optional[str]:
    for fanout in fanouts:
        for item in fanout:
            if not item.get("ok") and item.get("error"):
                return f"节点 {item['node_id']}: {item['error']}"
    return None


async def _fetch_capabilities_per_node(client, node_ids: List[str]) -> Dict[str, Dict[str, List[str]]]:
    """Return {node_id: {engine_name: capabilities}}. Failures → empty dict.

    Used to annotate StrategySummary with the set of allowed write operations
    so the frontend can hide buttons the engine does not support.
    """
    async def _one(nid: str) -> Tuple[str, Dict[str, List[str]]]:
        try:
            engines = await client.get_engines(nid)
            return nid, {
                str(e.get("app_name", "")): list(e.get("capabilities", []) or [])
                for e in engines or []
            }
        except Exception as e:
            logger.warning("[live_trading] get_engines node=%s failed: %s", nid, e)
            return nid, {}

    pairs = await asyncio.gather(*(_one(nid) for nid in node_ids))
    return dict(pairs)


# ---------------------------------------------------------------------------
# Snapshot reads
# ---------------------------------------------------------------------------


def _read_curve(
    db: Session,
    node_id: str,
    engine: str,
    strategy_name: str,
    limit: Optional[int] = None,
    since: Optional[datetime] = None,
) -> List[Dict[str, Any]]:
    q = (
        db.query(StrategyEquitySnapshot)
        .filter(
            StrategyEquitySnapshot.node_id == node_id,
            StrategyEquitySnapshot.engine == engine,
            StrategyEquitySnapshot.strategy_name == strategy_name,
        )
        .order_by(StrategyEquitySnapshot.ts.desc())
    )
    if since is not None:
        q = q.filter(StrategyEquitySnapshot.ts >= since)
    if limit is not None:
        q = q.limit(limit)
    rows = list(q)
    rows.reverse()  # chronological
    return [
        {
            "ts": int(r.ts.timestamp() * 1000),
            "strategy_value": r.strategy_value,
            "account_equity": r.account_equity,
            "source_label": r.source_label,
        }
        for r in rows
    ]


# ---------------------------------------------------------------------------
# List / detail endpoints
# ---------------------------------------------------------------------------


async def list_strategy_summaries(db: Session) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    client = get_vnpy_client()
    if not client.node_ids:
        return [], "未配置 vnpy 节点，请检查 vnpy_nodes.yaml"

    try:
        strategies_fo, accounts_fo, positions_fo = await asyncio.gather(
            client.get_strategies(),
            client.get_accounts(),
            client.get_positions(),
        )
    except VnpyClientError as e:
        return [], f"vnpy 接口不可达: {e}"
    except Exception as e:
        logger.exception("[live_trading] unexpected error in list_strategy_summaries: %s", e)
        return [], f"未知错误: {e}"

    warning = _first_warning(strategies_fo, accounts_fo, positions_fo)

    accounts_by_node = _group_by_node(accounts_fo)
    positions_by_node = _group_by_node(positions_fo)
    capabilities = await _fetch_capabilities_per_node(client, client.node_ids)

    summaries: List[Dict[str, Any]] = []
    now_ms = int(time.time() * 1000)

    for item in strategies_fo:
        if not item.get("ok"):
            continue
        node_id = item["node_id"]
        node_accounts = accounts_by_node.get(node_id, [])
        node_positions = positions_by_node.get(node_id, [])
        for s in item.get("data") or []:
            engine_name = s.get("engine", "")
            name = s.get("name", "")
            value, label, acct_eq = _resolve_strategy_value(s, node_positions, node_accounts)
            curve = _read_curve(db, node_id, engine_name, name, limit=60)
            inited = bool(s.get("inited"))
            trading = bool(s.get("trading"))
            summaries.append({
                "node_id": node_id,
                "engine": engine_name,
                "strategy_name": name,
                "class_name": s.get("class_name"),
                "vt_symbol": s.get("vt_symbol"),
                "author": s.get("author"),
                "inited": inited,
                "trading": trading,
                "running": inited and trading,
                "strategy_value": value,
                "source_label": label,
                "account_equity": acct_eq,
                "positions_count": _count_positions(s.get("vt_symbol"), node_positions),
                "last_update_ts": now_ms,
                "mini_curve": curve,
                "capabilities": capabilities.get(node_id, {}).get(engine_name, []),
            })

    return summaries, warning


async def get_strategy_detail(
    db: Session,
    node_id: str,
    engine: str,
    strategy_name: str,
    window_days: int = 7,
) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    client = get_vnpy_client()
    if node_id not in client.node_ids:
        return None, f"未知节点: {node_id}"

    try:
        strategies_fo, accounts_fo, positions_fo = await asyncio.gather(
            client.get_strategies(),
            client.get_accounts(),
            client.get_positions(),
        )
    except VnpyClientError as e:
        return None, f"vnpy 接口不可达: {e}"
    except Exception as e:
        logger.exception("[live_trading] detail fetch failed: %s", e)
        return None, f"未知错误: {e}"

    warning = _first_warning(strategies_fo, accounts_fo, positions_fo)

    accounts_by_node = _group_by_node(accounts_fo)
    positions_by_node = _group_by_node(positions_fo)

    strategy: Optional[Dict[str, Any]] = None
    for item in strategies_fo:
        if item.get("ok") and item["node_id"] == node_id:
            for s in item.get("data") or []:
                if s.get("engine") == engine and s.get("name") == strategy_name:
                    strategy = s
                    break
    if strategy is None:
        return None, warning or f"策略 {node_id}/{engine}/{strategy_name} 不存在"

    node_positions = positions_by_node.get(node_id, [])
    node_accounts = accounts_by_node.get(node_id, [])
    value, label, acct_eq = _resolve_strategy_value(strategy, node_positions, node_accounts)

    # filter positions to just this strategy's if it has a vt_symbol
    vt_symbol = strategy.get("vt_symbol")
    if vt_symbol:
        positions = [p for p in node_positions if str(p.get("vt_symbol", "")) == vt_symbol]
    else:
        positions = list(node_positions)

    # capabilities (single node → single engine lookup)
    try:
        engines = await client.get_engines(node_id)
    except Exception:
        engines = []
    caps: List[str] = []
    for e in engines or []:
        if str(e.get("app_name", "")) == engine:
            caps = list(e.get("capabilities", []) or [])
            break

    since = datetime.now() - timedelta(days=window_days)
    full_curve = _read_curve(db, node_id, engine, strategy_name, since=since)

    inited = bool(strategy.get("inited"))
    trading = bool(strategy.get("trading"))
    detail = {
        "node_id": node_id,
        "engine": engine,
        "strategy_name": strategy_name,
        "class_name": strategy.get("class_name"),
        "vt_symbol": vt_symbol,
        "author": strategy.get("author"),
        "inited": inited,
        "trading": trading,
        "running": inited and trading,
        "strategy_value": value,
        "source_label": label,
        "account_equity": acct_eq,
        "positions_count": len(positions),
        "last_update_ts": int(time.time() * 1000),
        "mini_curve": [],
        "capabilities": caps,
        "parameters": strategy.get("parameters") or {},
        "variables": strategy.get("variables") or {},
        "curve": full_curve,
        "positions": [
            {
                "vt_symbol": p.get("vt_symbol", ""),
                "direction": str(p.get("direction", "")),
                "volume": float(p.get("volume") or 0),
                "price": p.get("price"),
                "pnl": p.get("pnl"),
                "yd_volume": p.get("yd_volume"),
                "frozen": p.get("frozen"),
            }
            for p in positions
        ],
    }
    return detail, warning


async def list_node_statuses() -> List[Dict[str, Any]]:
    client = get_vnpy_client()
    return await client.probe_nodes()


# ---------------------------------------------------------------------------
# Snapshot writer (background loop)
# ---------------------------------------------------------------------------


async def snapshot_tick() -> None:
    """One iteration of the background snapshot loop.

    Creates its own short-lived SQLAlchemy session so it does not share any
    state with request handlers.
    """
    from sqlalchemy.orm import sessionmaker

    client = get_vnpy_client()
    if not client.node_ids:
        return
    try:
        strategies_fo, accounts_fo, positions_fo = await asyncio.gather(
            client.get_strategies(),
            client.get_accounts(),
            client.get_positions(),
        )
    except Exception as e:
        logger.warning("[live_trading] snapshot_tick fetch failed: %s", e)
        return

    accounts_by_node = _group_by_node(accounts_fo)
    positions_by_node = _group_by_node(positions_fo)

    now = datetime.now()
    SessionLocal = sessionmaker(bind=db_engine, autocommit=False, autoflush=False)
    session = SessionLocal()
    try:
        written = 0
        for item in strategies_fo:
            if not item.get("ok"):
                continue
            node_id = item["node_id"]
            for s in item.get("data") or []:
                # only record while strategy is active (either inited or trading)
                if not (s.get("inited") or s.get("trading")):
                    continue
                engine_name = s.get("engine", "")
                name = s.get("name", "")
                value, label, acct_eq = _resolve_strategy_value(
                    s,
                    positions_by_node.get(node_id, []),
                    accounts_by_node.get(node_id, []),
                )
                row = StrategyEquitySnapshot(
                    node_id=node_id,
                    engine=engine_name,
                    strategy_name=name,
                    ts=now,
                    strategy_value=value,
                    source_label=label,
                    account_equity=acct_eq,
                    positions_count=_count_positions(s.get("vt_symbol"), positions_by_node.get(node_id, [])),
                    raw_variables_json=json.dumps(s.get("variables") or {}, ensure_ascii=False),
                )
                session.add(row)
                written += 1

        # retention cleanup
        cutoff = now - timedelta(days=settings.vnpy_snapshot_retention_days)
        session.execute(
            sa_delete(StrategyEquitySnapshot).where(StrategyEquitySnapshot.ts < cutoff)
        )
        session.commit()
        if written:
            logger.debug("[live_trading] snapshot_tick wrote %d rows", written)
    except Exception as e:
        logger.exception("[live_trading] snapshot_tick write failed: %s", e)
        session.rollback()
    finally:
        session.close()


async def snapshot_loop() -> None:
    logger.info(
        "[live_trading] snapshot_loop started (interval=%ss, retention=%sd)",
        settings.vnpy_poll_interval_seconds,
        settings.vnpy_snapshot_retention_days,
    )
    while True:
        try:
            await snapshot_tick()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.exception("[live_trading] snapshot_loop iteration failed: %s", e)
        try:
            await asyncio.sleep(settings.vnpy_poll_interval_seconds)
        except asyncio.CancelledError:
            raise


# ---------------------------------------------------------------------------
# Write operation helpers (thin wrappers around VnpyMultiNodeClient)
# ---------------------------------------------------------------------------


async def create_strategy(node_id: str, engine: str, body: Dict[str, Any]) -> Dict[str, Any]:
    return await get_vnpy_client().create_strategy(node_id, engine, body)


async def init_strategy(node_id: str, engine: str, name: str) -> Dict[str, Any]:
    return await get_vnpy_client().init_strategy(node_id, engine, name)


async def start_strategy(node_id: str, engine: str, name: str) -> Dict[str, Any]:
    return await get_vnpy_client().start_strategy(node_id, engine, name)


async def stop_strategy(node_id: str, engine: str, name: str) -> Dict[str, Any]:
    return await get_vnpy_client().stop_strategy(node_id, engine, name)


async def edit_strategy(node_id: str, engine: str, name: str, setting: Dict[str, Any]) -> Dict[str, Any]:
    return await get_vnpy_client().edit_strategy(node_id, engine, name, setting)


async def delete_strategy(node_id: str, engine: str, name: str) -> Dict[str, Any]:
    return await get_vnpy_client().delete_strategy(node_id, engine, name)
