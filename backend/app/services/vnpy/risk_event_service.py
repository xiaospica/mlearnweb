"""Realtime live-trading order and risk-event normalization.

P0/P1 computes risk events on demand from current vnpy REST state and strategy
variables. It intentionally does not persist events; P3 can replace this with
an event table while keeping the frontend contract stable.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple

from app.services.ml_aggregation_service import get_stock_name_map
from app.services.vnpy.client import get_vnpy_client

logger = logging.getLogger(__name__)

Severity = str

SEVERITY_RANK: Dict[str, int] = {
    "info": 0,
    "warning": 1,
    "error": 2,
    "critical": 3,
}
TERMINAL_ORDER_STATUSES = {
    "ALLTRADED",
    "CANCELLED",
    "REJECTED",
    "ORDER_JUNK",
}
PARTTRADED_STALE_SECONDS = 5 * 60


def _now_ms() -> int:
    return int(time.time() * 1000)


def _text(value: Any) -> str:
    return "" if value is None else str(value)


def _status(value: Any) -> str:
    raw = _text(value).strip()
    if "." in raw:
        raw = raw.rsplit(".", 1)[-1]
    return raw.upper()


def _event_id(*parts: Any) -> str:
    raw = ":".join(_text(p) for p in parts if p is not None)
    cleaned = re.sub(r"[^A-Za-z0-9_.:-]+", "_", raw).strip("_")
    return cleaned or f"risk-{_now_ms()}"


def _vt_symbol_to_ts_code(vt: str) -> Optional[str]:
    if not vt or "." not in vt:
        return None
    sym, ex = vt.rsplit(".", 1)
    suffix = {"SSE": "SH", "SZSE": "SZ", "BSE": "BJ"}.get(ex.upper())
    if suffix is None:
        return None
    return f"{sym}.{suffix}"


def _resolve_stock_name(vt_symbol: str) -> str:
    ts_code = _vt_symbol_to_ts_code(vt_symbol)
    if ts_code is None:
        return ""
    return get_stock_name_map().get(ts_code, "")


def belongs_to_strategy(reference: str, strategy_name: str) -> bool:
    return reference == strategy_name or reference.startswith(f"{strategy_name}:")


def strategy_from_reference(reference: str) -> Optional[str]:
    if ":" not in reference:
        return None
    name = reference.split(":", 1)[0].strip()
    return name or None


def is_resubmit_reference(reference: str, strategy_name: str) -> bool:
    if not belongs_to_strategy(reference, strategy_name):
        return False
    tail = reference[len(strategy_name):].lstrip(":").upper()
    return tail.endswith("R") or ":R" in tail or tail.endswith("_R")


def _parse_order_dt(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        ts = float(value)
        if ts > 10_000_000_000:
            ts /= 1000.0
        return datetime.fromtimestamp(ts, tz=timezone.utc).replace(tzinfo=None)
    raw = str(value).strip()
    if not raw:
        return None
    normalized = raw.replace("Z", "+00:00")
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%Y%m%d %H:%M:%S"):
        try:
            return datetime.strptime(raw, fmt)
        except ValueError:
            pass
    try:
        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo is not None:
            parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
        return parsed
    except ValueError:
        return None


def _event_ts(value: Any) -> int:
    parsed = _parse_order_dt(value)
    if parsed is None:
        return _now_ms()
    return int(parsed.timestamp() * 1000)


def normalize_strategy_order(order: Dict[str, Any]) -> Dict[str, Any]:
    vt_symbol = _text(order.get("vt_symbol") or order.get("symbol"))
    return {
        "vt_orderid": _text(order.get("vt_orderid") or order.get("orderid")),
        "orderid": _text(order.get("orderid") or order.get("vt_orderid")),
        "vt_symbol": vt_symbol,
        "name": _resolve_stock_name(vt_symbol),
        "direction": _text(order.get("direction")),
        "offset": _text(order.get("offset")),
        "price": float(order.get("price") or 0),
        "volume": float(order.get("volume") or 0),
        "traded": float(order.get("traded") or 0),
        "status": _text(order.get("status")),
        "status_msg": _text(order.get("status_msg") or order.get("msg") or order.get("message")),
        "reference": _text(order.get("reference")),
        "datetime": _text(order.get("datetime") or order.get("time") or order.get("insert_time")),
    }


def _risk_title(status: str, is_resubmit: bool) -> str:
    if status in {"REJECTED", "ORDER_JUNK"}:
        return "订单被拒"
    if status == "CANCELLED" and is_resubmit:
        return "撤单再报"
    if status == "CANCELLED":
        return "订单已撤"
    if status == "PARTTRADED":
        return "部分成交未终态"
    return "订单异常"


def risk_event_from_order(
    order: Dict[str, Any],
    *,
    node_id: str,
    engine: str,
    strategy_name: str,
) -> Optional[Dict[str, Any]]:
    normalized = normalize_strategy_order(order)
    reference = normalized["reference"]
    if not belongs_to_strategy(reference, strategy_name):
        return None

    status = _status(normalized["status"])
    msg = normalized["status_msg"]
    msg_lower = msg.lower()
    is_resubmit = is_resubmit_reference(reference, strategy_name)
    severity: Optional[Severity] = None
    reason = ""

    if status in {"REJECTED", "ORDER_JUNK"} or "拒单" in msg or "order_junk" in msg_lower:
        severity = "error"
        reason = "order_rejected"
    elif status == "CANCELLED" and is_resubmit:
        severity = "warning"
        reason = "cancel_resubmit"
    elif status == "CANCELLED":
        severity = "info"
        reason = "order_cancelled"
    elif status == "PARTTRADED":
        order_dt = _parse_order_dt(normalized["datetime"])
        if order_dt is not None and (datetime.now() - order_dt).total_seconds() >= PARTTRADED_STALE_SECONDS:
            severity = "warning"
            reason = "parttraded_stale"

    if severity is None:
        return None

    vt_orderid = normalized["vt_orderid"]
    vt_symbol = normalized["vt_symbol"]
    traded = normalized["traded"]
    volume = normalized["volume"]
    message_parts = [status or normalized["status"] or "unknown"]
    if msg:
        message_parts.append(msg)
    if volume:
        message_parts.append(f"traded={traded:g}/{volume:g}")
    return {
        "event_id": _event_id(node_id, engine, strategy_name, "order", vt_orderid, status, reference),
        "node_id": node_id,
        "engine": engine,
        "strategy_name": strategy_name,
        "severity": severity,
        "category": "order",
        "title": _risk_title(status, is_resubmit),
        "message": " | ".join(message_parts),
        "status": status or normalized["status"],
        "vt_orderid": vt_orderid,
        "vt_symbol": vt_symbol,
        "reference": reference,
        "is_resubmit": is_resubmit,
        "event_ts": _event_ts(normalized["datetime"]),
        "source": "rest_fingerprint",
        "reason": reason,
    }


def risk_events_from_strategy_variables(
    strategy: Dict[str, Any],
    *,
    node_id: str,
    engine: str,
    strategy_name: str,
) -> List[Dict[str, Any]]:
    variables = strategy.get("variables") or {}
    events: List[Dict[str, Any]] = []
    last_status = _text(variables.get("last_status")).lower()
    last_error = _text(variables.get("last_error"))
    replay_status = _text(variables.get("replay_status")).lower()
    if last_status == "failed":
        events.append({
            "event_id": _event_id(node_id, engine, strategy_name, "strategy", "last_status_failed"),
            "node_id": node_id,
            "engine": engine,
            "strategy_name": strategy_name,
            "severity": "error",
            "category": "strategy",
            "title": "策略运行失败",
            "message": last_error or "last_status=failed",
            "status": "failed",
            "vt_orderid": None,
            "vt_symbol": strategy.get("vt_symbol"),
            "reference": None,
            "is_resubmit": False,
            "event_ts": _now_ms(),
            "source": "strategy_variables",
            "reason": "last_status_failed",
        })
    if replay_status == "error":
        events.append({
            "event_id": _event_id(node_id, engine, strategy_name, "strategy", "replay_error"),
            "node_id": node_id,
            "engine": engine,
            "strategy_name": strategy_name,
            "severity": "error",
            "category": "strategy",
            "title": "回放失败",
            "message": last_error or "replay_status=error",
            "status": "error",
            "vt_orderid": None,
            "vt_symbol": strategy.get("vt_symbol"),
            "reference": None,
            "is_resubmit": False,
            "event_ts": _now_ms(),
            "source": "strategy_variables",
            "reason": "replay_error",
        })
    return events


def _gateway_events_from_health(
    health: Any,
    *,
    node_id: str,
    engine: Optional[str],
    strategy_name: Optional[str],
) -> List[Dict[str, Any]]:
    if not isinstance(health, dict):
        return []
    gateway_items: List[Tuple[str, Any]] = []
    raw_gateways = (
        health.get("gateways")
        or health.get("gateway_status")
        or health.get("gateway_statuses")
        or health.get("gateways_status")
    )
    if isinstance(raw_gateways, dict):
        gateway_items.extend(raw_gateways.items())
    elif isinstance(raw_gateways, list):
        for item in raw_gateways:
            if isinstance(item, dict):
                name = _text(item.get("name") or item.get("gateway_name") or item.get("gateway"))
                gateway_items.append((name or "gateway", item))

    events: List[Dict[str, Any]] = []
    for name, item in gateway_items:
        connected = None
        message = ""
        if isinstance(item, dict):
            connected = item.get("connected")
            message = _text(item.get("last_error") or item.get("error") or item.get("status"))
        elif isinstance(item, bool):
            connected = item
        elif isinstance(item, str):
            message = item
            connected = "connect" in item.lower() and "disconnect" not in item.lower()
        if connected is False or "disconnect" in message.lower() or "断开" in message:
            events.append({
                "event_id": _event_id(node_id, engine, strategy_name, "gateway", name, "disconnected"),
                "node_id": node_id,
                "engine": engine,
                "strategy_name": strategy_name,
                "severity": "critical",
                "category": "gateway",
                "title": "网关断开",
                "message": f"{name}: {message or 'disconnected'}",
                "status": "disconnected",
                "vt_orderid": None,
                "vt_symbol": None,
                "reference": None,
                "is_resubmit": False,
                "event_ts": _now_ms(),
                "source": "watchdog",
                "reason": "gateway_disconnected",
            })
    return events


def node_offline_event(
    *,
    node_id: str,
    engine: Optional[str],
    strategy_name: Optional[str],
    message: str,
) -> Dict[str, Any]:
    return {
        "event_id": _event_id(node_id, engine, strategy_name, "node", "offline"),
        "node_id": node_id,
        "engine": engine,
        "strategy_name": strategy_name,
        "severity": "critical",
        "category": "node",
        "title": "节点不可达",
        "message": message,
        "status": "offline",
        "vt_orderid": None,
        "vt_symbol": None,
        "reference": None,
        "is_resubmit": False,
        "event_ts": _now_ms(),
        "source": "watchdog",
        "reason": "node_offline",
    }


async def _fetch_target_node(node_id: str) -> Tuple[Dict[str, Any], Dict[str, Any], Dict[str, Any], Dict[str, Any]]:
    client = get_vnpy_client()
    if node_id not in client.node_ids:
        err = {"ok": False, "data": [], "error": f"未知节点: {node_id}"}
        return err, err, err, err
    per_node = client.get_per_node(node_id)

    async def _safe(method_name: str) -> Dict[str, Any]:
        try:
            data = await getattr(per_node, method_name)()
            return {"ok": True, "data": data or [], "error": None}
        except Exception as exc:
            logger.warning("[risk_event] node=%s %s failed: %s", node_id, method_name, exc)
            return {"ok": False, "data": [], "error": str(exc)}

    strategies, orders, trades, health = await asyncio.gather(
        _safe("get_strategies"),
        _safe("get_orders"),
        _safe("get_trades"),
        _safe("get_node_health"),
    )
    return strategies, orders, trades, health


async def list_strategy_orders(
    node_id: str,
    engine: str,
    strategy_name: str,
) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    strategies, orders, _trades, _health = await _fetch_target_node(node_id)
    warnings = [f"orders: {orders['error']}"] if not orders.get("ok") else []
    if not strategies.get("ok"):
        warnings.append(f"strategies: {strategies['error']}")
    rows = [
        normalize_strategy_order(order)
        for order in orders.get("data") or []
        if belongs_to_strategy(_text(order.get("reference")), strategy_name)
    ]
    rows.sort(key=lambda row: row.get("datetime") or "", reverse=True)
    return rows, "; ".join(warnings) if warnings else None


async def list_strategy_risk_events(
    node_id: str,
    engine: str,
    strategy_name: str,
    *,
    severity: Optional[str] = None,
    category: Optional[str] = None,
    since_ts: Optional[int] = None,
    include_ack: bool = False,
    limit: int = 200,
) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    strategies, orders, _trades, health = await _fetch_target_node(node_id)
    warnings: List[str] = []
    events: List[Dict[str, Any]] = []

    if not health.get("ok"):
        events.append(
            node_offline_event(
                node_id=node_id,
                engine=engine,
                strategy_name=strategy_name,
                message=f"vnpy 节点不可达: {health.get('error')}",
            )
        )
        warnings.append(f"health: {health.get('error')}")
    else:
        events.extend(
            _gateway_events_from_health(
                health.get("data"),
                node_id=node_id,
                engine=engine,
                strategy_name=strategy_name,
            )
        )

    target_strategy: Optional[Dict[str, Any]] = None
    if strategies.get("ok"):
        for strategy in strategies.get("data") or []:
            if strategy.get("engine") == engine and strategy.get("name") == strategy_name:
                target_strategy = strategy
                break
    else:
        warnings.append(f"strategies: {strategies.get('error')}")

    if target_strategy is not None:
        events.extend(
            risk_events_from_strategy_variables(
                target_strategy,
                node_id=node_id,
                engine=engine,
                strategy_name=strategy_name,
            )
        )

    if orders.get("ok"):
        for order in orders.get("data") or []:
            event = risk_event_from_order(
                order,
                node_id=node_id,
                engine=engine,
                strategy_name=strategy_name,
            )
            if event is not None:
                events.append(event)
    else:
        warnings.append(f"orders: {orders.get('error')}")

    events.sort(key=lambda event: (SEVERITY_RANK.get(event.get("severity"), 0), event.get("event_ts") or 0), reverse=True)
    if severity:
        events = [event for event in events if event.get("severity") == severity]
    if category:
        events = [event for event in events if event.get("category") == category]
    if since_ts is not None:
        events = [event for event in events if int(event.get("event_ts") or 0) >= int(since_ts)]

    try:
        from app.services.vnpy.live_trading_event_store import (
            acked_event_ids,
            list_risk_events,
            merge_risk_events,
            persist_many_risk_events,
        )

        persist_many_risk_events(events)
        if not include_ack:
            acked_ids = acked_event_ids(event.get("event_id") for event in events)
            events = [event for event in events if event.get("event_id") not in acked_ids]
        stored = list_risk_events(
            node_id=node_id,
            engine=engine,
            strategy_name=strategy_name,
            severity=severity,
            category=category,
            since_ts=since_ts,
            include_ack=include_ack,
            limit=limit,
        )
        events = merge_risk_events(events, stored)
    except Exception as exc:
        logger.warning("[risk_event] event store unavailable: %s", exc)

    return events[: max(1, min(int(limit), 1000))], "; ".join(warnings) if warnings else None


def highest_severity(events: Iterable[Dict[str, Any]]) -> Optional[str]:
    best: Optional[str] = None
    best_rank = -1
    for event in events:
        severity = _text(event.get("severity"))
        rank = SEVERITY_RANK.get(severity, -1)
        if rank > best_rank:
            best = severity
            best_rank = rank
    return best


def summarize_risks_from_fanout(
    strategies_fo: List[Dict[str, Any]],
    orders_fo: List[Dict[str, Any]],
) -> Dict[Tuple[str, str, str], Dict[str, Any]]:
    """Return risk count/highest severity by ``(node_id, engine, strategy_name)``."""
    summary: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
    engine_by_node_name: Dict[Tuple[str, str], str] = {}
    for item in strategies_fo:
        node_id = item.get("node_id")
        if not item.get("ok"):
            continue
        for strategy in item.get("data") or []:
            engine = _text(strategy.get("engine"))
            name = _text(strategy.get("name"))
            if not node_id or not engine or not name:
                continue
            key = (node_id, engine, name)
            engine_by_node_name[(node_id, name)] = engine
            events = risk_events_from_strategy_variables(
                strategy,
                node_id=node_id,
                engine=engine,
                strategy_name=name,
            )
            summary[key] = {
                "risk_event_count": len(events),
                "highest_risk_severity": highest_severity(events),
            }

    def _add_event(key: Tuple[str, str, str], event: Dict[str, Any]) -> None:
        row = summary.setdefault(key, {"risk_event_count": 0, "highest_risk_severity": None})
        row["risk_event_count"] += 1
        current = row.get("highest_risk_severity")
        if SEVERITY_RANK.get(event["severity"], 0) > SEVERITY_RANK.get(current or "", -1):
            row["highest_risk_severity"] = event["severity"]

    for item in orders_fo:
        node_id = item.get("node_id")
        if not item.get("ok"):
            continue
        for order in item.get("data") or []:
            reference = _text(order.get("reference"))
            strategy_name = strategy_from_reference(reference)
            if not node_id or not strategy_name:
                continue
            engine = engine_by_node_name.get((node_id, strategy_name))
            if not engine:
                continue
            event = risk_event_from_order(
                order,
                node_id=node_id,
                engine=engine,
                strategy_name=strategy_name,
            )
            if event is not None:
                _add_event((node_id, engine, strategy_name), event)
    return summary
