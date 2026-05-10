"""vnpy WebSocket collector for live-trading events (P2).

The browser never connects to vnpy directly. ``app.live_main`` owns the node
WS connections, translates topics into internal invalidation/risk events, and
falls back to REST fingerprinting when a node WS is down.
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import re
import time
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from app.core.config import settings
from app.services.app_settings_service import get_runtime_setting
from app.services.vnpy.client import get_vnpy_client
from app.services.vnpy.live_trading_event_store import persist_event_payload, persist_risk_event, prune_old_events
from app.services.vnpy.live_trading_events import make_event, publish_event, publish_strategy_event
from app.services.vnpy.risk_event_service import (
    belongs_to_strategy,
    risk_event_from_order,
    risk_events_from_strategy_variables,
    strategy_from_reference,
)

logger = logging.getLogger(__name__)

_WS_CONNECTED: Set[str] = set()
_ENGINE_BY_NODE_STRATEGY: Dict[Tuple[str, str], str] = {}
_STRATEGIES_BY_NODE: Dict[str, List[Dict[str, Any]]] = {}
_ORDER_REF_BY_NODE_ORDERID: Dict[Tuple[str, str], str] = {}

LOG_STRATEGY_RE = re.compile(r"\[([A-Za-z0-9_.:-]+)\]")
ERROR_MARKERS = ("error", "exception", "failed", "traceback", "拒单", "报错", "错误", "异常", "失败")
WARN_MARKERS = ("warning", "warn", "cancel", "撤单", "超时")


def ws_connected_node_ids() -> Set[str]:
    return set(_WS_CONNECTED)


def reset_ws_state_for_tests() -> None:
    _WS_CONNECTED.clear()
    _ENGINE_BY_NODE_STRATEGY.clear()
    _STRATEGIES_BY_NODE.clear()
    _ORDER_REF_BY_NODE_ORDERID.clear()


def _now_ms() -> int:
    return int(time.time() * 1000)


def _event_ts(raw: Any) -> int:
    if isinstance(raw, (int, float)):
        ts = float(raw)
        if ts < 10_000_000_000:
            ts *= 1000.0
        return int(ts)
    return _now_ms()


def _text(value: Any) -> str:
    return "" if value is None else str(value)


def _stable_hash(value: Any) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]


def _strategy_name(data: Dict[str, Any]) -> str:
    return _text(data.get("strategy_name") or data.get("name"))


def _reference(data: Dict[str, Any]) -> str:
    return _text(data.get("reference"))


def _engine_for(node_id: str, strategy_name: str, fallback: str = "") -> str:
    return _ENGINE_BY_NODE_STRATEGY.get((node_id, strategy_name), fallback)


def _remember_strategy(node_id: str, engine: str, strategy: Dict[str, Any]) -> None:
    name = _strategy_name(strategy)
    if not name:
        return
    if engine:
        _ENGINE_BY_NODE_STRATEGY[(node_id, name)] = engine
    rows = [row for row in _STRATEGIES_BY_NODE.get(node_id, []) if _strategy_name(row) != name]
    enriched = dict(strategy)
    if engine and not enriched.get("engine"):
        enriched["engine"] = engine
    rows.append(enriched)
    _STRATEGIES_BY_NODE[node_id] = rows


async def refresh_strategy_index(node_id: Optional[str] = None) -> None:
    client = get_vnpy_client()
    try:
        fanout = await client.get_strategies()
    except Exception as exc:
        logger.debug("[vnpy_ws] refresh strategy index failed: %s", exc)
        return
    for item in fanout:
        nid = _text(item.get("node_id"))
        if node_id and nid != node_id:
            continue
        if not item.get("ok"):
            continue
        _STRATEGIES_BY_NODE[nid] = []
        for strategy in item.get("data") or []:
            engine = _text(strategy.get("engine"))
            _remember_strategy(nid, engine, strategy)


def _strategies_for_position(node_id: str, data: Dict[str, Any]) -> List[Tuple[str, str]]:
    vt_symbol = _text(data.get("vt_symbol"))
    gateway = _text(data.get("gateway_name") or data.get("gateway"))
    matches: List[Tuple[str, str]] = []
    for strategy in _STRATEGIES_BY_NODE.get(node_id, []):
        name = _strategy_name(strategy)
        engine = _text(strategy.get("engine")) or _engine_for(node_id, name)
        if not name or not engine:
            continue
        strategy_vt = _text(strategy.get("vt_symbol"))
        params = strategy.get("parameters") or {}
        strategy_gateway = _text(params.get("gateway"))
        if strategy_vt and vt_symbol and strategy_vt == vt_symbol:
            matches.append((engine, name))
        elif not strategy_vt and gateway and strategy_gateway == gateway:
            matches.append((engine, name))
    return matches


def _all_strategies(node_id: str) -> List[Tuple[str, str]]:
    rows: List[Tuple[str, str]] = []
    for strategy in _STRATEGIES_BY_NODE.get(node_id, []):
        name = _strategy_name(strategy)
        engine = _text(strategy.get("engine")) or _engine_for(node_id, name)
        if name and engine:
            rows.append((engine, name))
    return rows


async def _publish_for_identities(
    event_type: str,
    node_id: str,
    identities: Iterable[Tuple[str, str]],
    *,
    reason: str,
) -> int:
    count = 0
    for engine, name in identities:
        await publish_strategy_event(
            event_type,
            node_id=node_id,
            engine=engine,
            strategy_name=name,
            reason=reason,
        )
        count += 1
    return count


def _persist_topic_event(
    *,
    topic: str,
    node_id: str,
    engine: Optional[str],
    strategy_name: Optional[str],
    data: Dict[str, Any],
    ts: int,
) -> None:
    category = topic if topic in {"order", "trade", "log", "strategy", "node"} else "event"
    persist_event_payload(
        {
            "event_id": f"{node_id}:{engine or ''}:{strategy_name or ''}:{topic}:{ts}:{_stable_hash(data)}",
            "event_type": f"vnpy.{topic}",
            "node_id": node_id,
            "engine": engine,
            "strategy_name": strategy_name,
            "severity": None,
            "category": category,
            "title": f"vnpy {topic}",
            "message": _text(data.get("msg") or data.get("status") or ""),
            "status": data.get("status"),
            "vt_orderid": data.get("vt_orderid") or data.get("orderid"),
            "vt_symbol": data.get("vt_symbol"),
            "reference": data.get("reference"),
            "source": "vnpy_ws",
            "reason": topic,
            "event_ts": ts,
            "raw": data,
        },
        dedupe_key=f"{node_id}:{topic}:{data.get('vt_orderid') or data.get('orderid') or _stable_hash(data)}:{data.get('status') or ts}",
    )


async def _handle_strategy(node_id: str, engine: str, data: Dict[str, Any], ts: int) -> int:
    name = _strategy_name(data)
    if not name:
        return 0
    if not data.get("name"):
        data = {**data, "name": name}
    if engine and not data.get("engine"):
        data["engine"] = engine
    _remember_strategy(node_id, engine, data)
    _persist_topic_event(topic="strategy", node_id=node_id, engine=engine, strategy_name=name, data=data, ts=ts)
    await publish_strategy_event(
        "strategy.state.changed",
        node_id=node_id,
        engine=engine,
        strategy_name=name,
        severity="error" if (data.get("variables") or {}).get("last_status") == "failed" else None,
        reason="vnpy_ws_strategy",
    )
    risks = risk_events_from_strategy_variables(data, node_id=node_id, engine=engine, strategy_name=name)
    for risk in risks:
        risk["source"] = "vnpy_ws"
        persist_risk_event(risk, source="vnpy_ws")
        await publish_strategy_event(
            "strategy.risk.changed",
            node_id=node_id,
            engine=engine,
            strategy_name=name,
            severity=risk.get("severity"),
            reason=risk.get("reason") or "vnpy_ws_strategy_risk",
        )
    return 1 + len(risks)


async def _handle_order(node_id: str, engine: str, data: Dict[str, Any], ts: int) -> int:
    reference = _reference(data)
    name = _text(data.get("strategy_name")) or strategy_from_reference(reference) or ""
    engine = _engine_for(node_id, name, engine)
    vt_orderid = _text(data.get("vt_orderid") or data.get("orderid"))
    if vt_orderid and reference:
        _ORDER_REF_BY_NODE_ORDERID[(node_id, vt_orderid)] = reference
    _persist_topic_event(topic="order", node_id=node_id, engine=engine or None, strategy_name=name or None, data=data, ts=ts)
    if not name or not engine:
        await publish_event(
            make_event("node.changed", node_id=node_id, reason="vnpy_ws_order_unattributed")
        )
        return 1

    risk = risk_event_from_order(data, node_id=node_id, engine=engine, strategy_name=name)
    await publish_strategy_event(
        "strategy.order_trade.changed",
        node_id=node_id,
        engine=engine,
        strategy_name=name,
        severity=risk.get("severity") if risk and risk.get("severity") in {"error", "critical"} else None,
        reason="vnpy_ws_order",
    )
    if risk:
        risk["source"] = "vnpy_ws"
        persist_risk_event(risk, source="vnpy_ws")
        await publish_strategy_event(
            "strategy.risk.changed",
            node_id=node_id,
            engine=engine,
            strategy_name=name,
            severity=risk.get("severity"),
            reason=risk.get("reason") or "vnpy_ws_order_risk",
        )
        return 2
    return 1


async def _handle_trade(node_id: str, engine: str, data: Dict[str, Any], ts: int) -> int:
    vt_orderid = _text(data.get("vt_orderid") or data.get("orderid"))
    reference = _reference(data) or _ORDER_REF_BY_NODE_ORDERID.get((node_id, vt_orderid), "")
    name = _text(data.get("strategy_name")) or strategy_from_reference(reference) or ""
    engine = _engine_for(node_id, name, engine)
    _persist_topic_event(topic="trade", node_id=node_id, engine=engine or None, strategy_name=name or None, data=data, ts=ts)
    if not name or not engine:
        await publish_event(make_event("node.changed", node_id=node_id, reason="vnpy_ws_trade_unattributed"))
        return 1
    await publish_strategy_event(
        "strategy.order_trade.changed",
        node_id=node_id,
        engine=engine,
        strategy_name=name,
        reason="vnpy_ws_trade",
    )
    await publish_strategy_event(
        "strategy.position.changed",
        node_id=node_id,
        engine=engine,
        strategy_name=name,
        reason="vnpy_ws_trade",
    )
    return 2


async def _handle_position(node_id: str, data: Dict[str, Any]) -> int:
    matches = _strategies_for_position(node_id, data)
    if not matches:
        await publish_event(make_event("node.changed", node_id=node_id, reason="vnpy_ws_position_unattributed"))
        return 1
    return await _publish_for_identities("strategy.position.changed", node_id, matches, reason="vnpy_ws_position")


async def _handle_account(node_id: str) -> int:
    matches = _all_strategies(node_id)
    if not matches:
        await publish_event(make_event("node.changed", node_id=node_id, reason="vnpy_ws_account_unattributed"))
        return 1
    return await _publish_for_identities("strategy.equity.changed", node_id, matches, reason="vnpy_ws_account")


def _log_severity(message: str, level: str) -> Optional[str]:
    lower = f"{level} {message}".lower()
    if any(marker in lower for marker in ERROR_MARKERS):
        return "error"
    if any(marker in lower for marker in WARN_MARKERS):
        return "warning"
    return None


async def _handle_log(node_id: str, engine: str, data: Dict[str, Any], ts: int) -> int:
    message = _text(data.get("msg") or data.get("message"))
    level = _text(data.get("level"))
    severity = _log_severity(message, level)
    if not severity:
        return 0
    match = LOG_STRATEGY_RE.search(message)
    name = _text(data.get("strategy_name")) or (match.group(1) if match else "")
    engine = _engine_for(node_id, name, engine)
    event = {
        "event_id": f"{node_id}:{engine}:{name}:log:{ts}:{_stable_hash(data)}",
        "event_type": "strategy.risk.changed" if name and engine else "node.changed",
        "node_id": node_id,
        "engine": engine or None,
        "strategy_name": name or None,
        "severity": severity,
        "category": "log",
        "title": "策略日志异常" if name else "节点日志异常",
        "message": message or level or "vnpy log event",
        "status": level or severity,
        "vt_orderid": None,
        "vt_symbol": None,
        "reference": None,
        "is_resubmit": False,
        "source": "vnpy_ws",
        "reason": "vnpy_ws_log",
        "event_ts": ts,
        "raw": data,
    }
    persist_risk_event(event, source="vnpy_ws")
    if name and engine:
        await publish_strategy_event(
            "strategy.risk.changed",
            node_id=node_id,
            engine=engine,
            strategy_name=name,
            severity=severity,
            reason="vnpy_ws_log",
        )
    else:
        await publish_event(make_event("node.changed", node_id=node_id, severity=severity, reason="vnpy_ws_log"))
    return 1


async def handle_ws_message(node_id: str, message: str | bytes | Dict[str, Any]) -> int:
    if isinstance(message, bytes):
        message = message.decode("utf-8", errors="replace")
    payload = json.loads(message) if isinstance(message, str) else dict(message)
    topic = _text(payload.get("topic")).lower()
    engine = _text(payload.get("engine"))
    event_node_id = _text(payload.get("node_id")) or node_id
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    ts = _event_ts(payload.get("ts"))
    if topic == "strategy":
        return await _handle_strategy(event_node_id, engine, data, ts)
    if topic == "order":
        return await _handle_order(event_node_id, engine, data, ts)
    if topic == "trade":
        return await _handle_trade(event_node_id, engine, data, ts)
    if topic == "position":
        return await _handle_position(event_node_id, data)
    if topic == "account":
        return await _handle_account(event_node_id)
    if topic == "log":
        return await _handle_log(event_node_id, engine, data, ts)
    return 0


async def _node_ws_loop(node_id: str) -> None:
    delay = max(1, int(settings.live_trading_ws_reconnect_initial_seconds))
    max_delay = max(delay, int(settings.live_trading_ws_reconnect_max_seconds))
    while True:
        try:
            import websockets

            await refresh_strategy_index(node_id)
            url = await get_vnpy_client().get_ws_url(node_id)
            logger.info("[vnpy_ws] connecting node=%s", node_id)
            async with websockets.connect(url, ping_interval=20, ping_timeout=20, close_timeout=5) as ws:
                _WS_CONNECTED.add(node_id)
                delay = max(1, int(settings.live_trading_ws_reconnect_initial_seconds))
                await publish_event(make_event("node.changed", node_id=node_id, reason="vnpy_ws_connected"))
                async for message in ws:
                    with contextlib.suppress(Exception):
                        prune_old_events()
                    await handle_ws_message(node_id, message)
        except asyncio.CancelledError:
            raise
        except ImportError:
            logger.warning("[vnpy_ws] websockets package not installed; WS collector disabled")
            await asyncio.sleep(max_delay)
        except Exception as exc:
            logger.warning("[vnpy_ws] node=%s disconnected/error: %s", node_id, exc)
        finally:
            if node_id in _WS_CONNECTED:
                _WS_CONNECTED.discard(node_id)
                with contextlib.suppress(Exception):
                    await publish_event(
                        make_event("node.changed", node_id=node_id, severity="warning", reason="vnpy_ws_disconnected")
                    )
        await asyncio.sleep(delay)
        delay = min(max_delay, delay * 2)


async def ws_collector_loop() -> None:
    if not bool(
        get_runtime_setting(
            "live_trading_ws_enabled",
            default=settings.live_trading_ws_enabled,
        )
    ):
        logger.info("[vnpy_ws] collector disabled")
        return
    try:
        from app.services.vnpy.rest_fingerprint_service import rest_fingerprint_tick

        await rest_fingerprint_tick(publish_initial=True)
    except Exception as exc:
        logger.debug("[vnpy_ws] startup REST baseline failed: %s", exc)

    client = get_vnpy_client()
    tasks = [asyncio.create_task(_node_ws_loop(node_id)) for node_id in client.node_ids]
    if not tasks:
        return
    try:
        await asyncio.gather(*tasks)
    finally:
        for task in tasks:
            task.cancel()
        for task in tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await task
