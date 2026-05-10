"""REST fingerprint producer for live-trading invalidation events.

This is the P1 bridge before vnpy WS is wired in. It polls existing REST state,
publishes semantic events only when fingerprints change, and lets the frontend
refresh authoritative REST queries through React Query.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Dict, List, Tuple

from app.core.config import settings
from app.services.app_settings_service import get_runtime_setting
from app.services.vnpy.client import get_vnpy_client
from app.services.vnpy.live_trading_events import publish_event, publish_strategy_event, make_event
from app.services.vnpy.risk_event_service import (
    belongs_to_strategy,
    highest_severity,
    risk_event_from_order,
    risk_events_from_strategy_variables,
)

logger = logging.getLogger(__name__)

Fingerprint = Dict[str, Any]

_LAST_FINGERPRINTS: Dict[Tuple[str, str, str], Fingerprint] = {}
_LAST_NODE_STATUS: Dict[str, bool] = {}


def _stable(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)


def _position_fingerprint(strategy: Dict[str, Any], positions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    vt_symbol = strategy.get("vt_symbol")
    params = strategy.get("parameters") or {}
    gateway = str(params.get("gateway") or "")
    out = []
    for pos in positions:
        if vt_symbol and str(pos.get("vt_symbol") or "") != str(vt_symbol):
            continue
        if not vt_symbol and gateway and str(pos.get("gateway_name") or "") != gateway:
            continue
        out.append({
            "vt_symbol": pos.get("vt_symbol"),
            "volume": pos.get("volume"),
            "market_value": pos.get("market_value"),
            "pnl": pos.get("pnl"),
        })
    return sorted(out, key=lambda row: str(row.get("vt_symbol") or ""))


def _orders_for_strategy(strategy_name: str, orders: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    rows = []
    for order in orders:
        ref = str(order.get("reference") or "")
        if not belongs_to_strategy(ref, strategy_name):
            continue
        rows.append({
            "vt_orderid": order.get("vt_orderid") or order.get("orderid"),
            "status": order.get("status"),
            "traded": order.get("traded"),
            "status_msg": order.get("status_msg") or order.get("msg") or order.get("message"),
            "reference": ref,
        })
    return sorted(rows, key=lambda row: str(row.get("vt_orderid") or ""))


def _fingerprint(
    *,
    node_id: str,
    strategy: Dict[str, Any],
    positions: List[Dict[str, Any]],
    orders: List[Dict[str, Any]],
) -> Fingerprint:
    name = str(strategy.get("name") or "")
    engine = str(strategy.get("engine") or "")
    variables = strategy.get("variables") or {}
    order_rows = _orders_for_strategy(name, orders)
    risk_events = risk_events_from_strategy_variables(
        strategy,
        node_id=node_id,
        engine=engine,
        strategy_name=name,
    )
    for order in orders:
        event = risk_event_from_order(order, node_id=node_id, engine=engine, strategy_name=name)
        if event is not None:
            risk_events.append(event)
    return {
        "state": {
            "inited": bool(strategy.get("inited")),
            "trading": bool(strategy.get("trading")),
            "last_status": variables.get("last_status"),
            "last_error": variables.get("last_error"),
            "replay_status": variables.get("replay_status"),
        },
        "positions": _position_fingerprint(strategy, positions),
        "orders": order_rows,
        "risk": {
            "count": len(risk_events),
            "highest": highest_severity(risk_events),
        },
    }


async def rest_fingerprint_tick(*, publish_initial: bool = False) -> Dict[str, int]:
    client = get_vnpy_client()
    if not client.node_ids:
        return {"scanned": 0, "published": 0}
    try:
        strategies_fo, positions_fo, orders_fo = await asyncio.gather(
            client.get_strategies(),
            client.get_positions(),
            client.get_orders(),
        )
    except Exception as exc:
        logger.warning("[rest_fingerprint] fanout failed: %s", exc)
        return {"scanned": 0, "published": 0}

    positions_by_node = {
        item.get("node_id"): item.get("data") or []
        for item in positions_fo
        if item.get("ok")
    }
    orders_by_node = {
        item.get("node_id"): item.get("data") or []
        for item in orders_fo
        if item.get("ok")
    }

    scanned = 0
    published = 0
    for item in strategies_fo:
        node_id = str(item.get("node_id") or "")
        node_ok = bool(item.get("ok"))
        previous_ok = _LAST_NODE_STATUS.get(node_id)
        _LAST_NODE_STATUS[node_id] = node_ok
        if previous_ok is not None and previous_ok != node_ok:
            await publish_event(
                make_event(
                    "node.changed",
                    node_id=node_id,
                    severity=None if node_ok else "critical",
                    reason="node_recovered" if node_ok else "node_offline",
                )
            )
            published += 1
        if not node_ok:
            continue

        for strategy in item.get("data") or []:
            node_positions = positions_by_node.get(node_id, [])
            node_orders = orders_by_node.get(node_id, [])
            engine = str(strategy.get("engine") or "")
            name = str(strategy.get("name") or "")
            if not engine or not name:
                continue
            scanned += 1
            key = (node_id, engine, name)
            current = _fingerprint(
                node_id=node_id,
                strategy=strategy,
                positions=node_positions,
                orders=node_orders,
            )
            previous = _LAST_FINGERPRINTS.get(key)
            _LAST_FINGERPRINTS[key] = current
            if previous is None:
                if not publish_initial:
                    continue
                previous = {}
            if _stable(previous.get("state")) != _stable(current.get("state")):
                await publish_strategy_event(
                    "strategy.state.changed",
                    node_id=node_id,
                    engine=engine,
                    strategy_name=name,
                    severity="error" if current["state"].get("last_status") == "failed" else None,
                    reason="rest_fingerprint_state",
                )
                published += 1
            if _stable(previous.get("positions")) != _stable(current.get("positions")):
                await publish_strategy_event(
                    "strategy.position.changed",
                    node_id=node_id,
                    engine=engine,
                    strategy_name=name,
                    reason="rest_fingerprint_position",
                )
                published += 1
            if _stable(previous.get("orders")) != _stable(current.get("orders")):
                severity = current["risk"].get("highest")
                await publish_strategy_event(
                    "strategy.order_trade.changed",
                    node_id=node_id,
                    engine=engine,
                    strategy_name=name,
                    severity=severity if severity in {"error", "critical"} else None,
                    reason="rest_fingerprint_order",
                )
                published += 1
            if _stable(previous.get("risk")) != _stable(current.get("risk")):
                severity = current["risk"].get("highest")
                await publish_strategy_event(
                    "strategy.risk.changed",
                    node_id=node_id,
                    engine=engine,
                    strategy_name=name,
                    severity=severity,
                    reason="rest_fingerprint_risk",
                )
                published += 1
    return {"scanned": scanned, "published": published}


async def rest_fingerprint_loop() -> None:
    logger.info("[rest_fingerprint] loop started (default interval=%ss)", settings.live_trading_event_fingerprint_interval_seconds)
    while True:
        try:
            stats = await rest_fingerprint_tick()
            if stats.get("published"):
                logger.debug("[rest_fingerprint] %s", stats)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.exception("[rest_fingerprint] iteration failed: %s", exc)
        try:
            interval = int(
                get_runtime_setting(
                    "live_trading_event_fingerprint_interval_seconds",
                    default=settings.live_trading_event_fingerprint_interval_seconds,
                )
            )
            await asyncio.sleep(max(1, interval))
        except asyncio.CancelledError:
            raise

