"""SQLite persistence for live-trading events (P3)."""
from __future__ import annotations

import json
import logging
import time
import asyncio
from datetime import datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional, Tuple

from sqlalchemy import and_, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import settings
from app.models.live_trading_events import LiveTradingEventRecord
from app.services.app_settings_service import get_runtime_setting

logger = logging.getLogger(__name__)

RISK_CATEGORIES = {"strategy", "order", "trade", "log", "node", "gateway"}
LOG_CATEGORIES = {"runtime_log"}


def _now_ms() -> int:
    return int(time.time() * 1000)


def _text(value: Any) -> str:
    return "" if value is None else str(value)


def _session_factory():
    from app.models.database import engine

    return sessionmaker(bind=engine, autocommit=False, autoflush=False)


def _dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)


def _load_json(value: Optional[str], default: Any) -> Any:
    if not value:
        return default
    try:
        return json.loads(value)
    except Exception:
        return default


def _event_id_from_payload(payload: Dict[str, Any]) -> str:
    event_id = _text(payload.get("event_id"))
    if event_id:
        return event_id[:160]
    base = ":".join(
        _text(payload.get(key))
        for key in ("node_id", "engine", "strategy_name", "event_type", "category", "reason", "event_ts")
    )
    return (base or f"live-event-{_now_ms()}")[:160]


def _record_to_dict(record: LiveTradingEventRecord) -> Dict[str, Any]:
    return {
        "event_id": record.event_id,
        "event_type": record.event_type,
        "node_id": record.node_id,
        "engine": record.engine,
        "strategy_name": record.strategy_name,
        "severity": record.severity,
        "category": record.category,
        "title": record.title,
        "message": record.message or "",
        "status": record.status,
        "vt_orderid": record.vt_orderid,
        "vt_symbol": record.vt_symbol,
        "reference": record.reference,
        "is_resubmit": bool(record.is_resubmit),
        "event_ts": int(record.event_ts or 0),
        "source": record.source or "",
        "reason": record.reason,
        "query_groups": _load_json(record.query_groups_json, []),
        "ack_at": int(record.ack_at.timestamp() * 1000) if record.ack_at else None,
        "ack_by": record.ack_by,
    }


def _upsert_record(session: Session, payload: Dict[str, Any], *, dedupe_key: Optional[str]) -> LiveTradingEventRecord:
    event_id = _event_id_from_payload(payload)
    lookup = []
    if dedupe_key:
        lookup.append(LiveTradingEventRecord.dedupe_key == dedupe_key)
    lookup.append(LiveTradingEventRecord.event_id == event_id)
    record = session.query(LiveTradingEventRecord).filter(or_(*lookup)).first()
    if record is None:
        record = LiveTradingEventRecord(event_id=event_id, dedupe_key=dedupe_key)
        session.add(record)

    record.event_type = _text(payload.get("event_type") or "strategy.risk.changed")
    record.node_id = payload.get("node_id")
    record.engine = payload.get("engine")
    record.strategy_name = payload.get("strategy_name")
    record.severity = payload.get("severity")
    record.category = payload.get("category")
    record.title = payload.get("title")
    record.message = payload.get("message")
    record.status = payload.get("status")
    record.vt_orderid = payload.get("vt_orderid")
    record.vt_symbol = payload.get("vt_symbol")
    record.reference = payload.get("reference")
    record.is_resubmit = bool(payload.get("is_resubmit") or False)
    record.source = payload.get("source")
    record.reason = payload.get("reason")
    record.query_groups_json = _dump(payload.get("query_groups") or [])
    record.raw_json = _dump(payload.get("raw") or payload)
    record.event_ts = int(payload.get("event_ts") or payload.get("ts") or _now_ms())
    record.updated_at = datetime.now()
    return record


def persist_event_payload(payload: Dict[str, Any], *, dedupe_key: Optional[str] = None) -> Optional[str]:
    """Upsert one event payload and return the stable event id."""
    SessionLocal = _session_factory()
    session = SessionLocal()
    try:
        try:
            record = _upsert_record(session, payload, dedupe_key=dedupe_key)
            session.commit()
            return record.event_id
        except IntegrityError:
            session.rollback()
            record = _upsert_record(session, payload, dedupe_key=dedupe_key)
            session.commit()
            return record.event_id
    except Exception as exc:
        session.rollback()
        logger.warning("[live_event_store] persist failed: %s", exc)
        return None
    finally:
        session.close()


def persist_live_event(event: Any) -> Optional[str]:
    payload = event.as_payload() if hasattr(event, "as_payload") else dict(event)
    event_type = _text(payload.get("event_type"))
    if event_type == "node.changed" and payload.get("severity") in {"warning", "error", "critical"}:
        payload.setdefault("category", "node")
        payload.setdefault("title", "节点状态变化")
    else:
        payload.setdefault("category", "event")
        payload.setdefault("title", payload.get("event_type"))
    payload.setdefault("message", payload.get("reason") or "")
    payload.setdefault("event_ts", payload.get("ts"))
    payload.setdefault("source", payload.get("source") or "event_bus")
    dedupe_key = ":".join(
        _text(payload.get(key))
        for key in ("node_id", "engine", "strategy_name", "event_type", "reason")
    )
    return persist_event_payload(payload, dedupe_key=dedupe_key or None)


def persist_risk_event(event: Dict[str, Any], *, source: Optional[str] = None) -> Optional[str]:
    payload = dict(event)
    payload.setdefault("event_type", "strategy.risk.changed")
    if source:
        payload["source"] = source
    dedupe_key = _text(payload.get("event_id")) or None
    return persist_event_payload(payload, dedupe_key=dedupe_key)


def persist_many_risk_events(events: Iterable[Dict[str, Any]], *, source: Optional[str] = None) -> None:
    for event in events:
        persist_risk_event(event, source=source)


def list_risk_events(
    *,
    node_id: Optional[str] = None,
    engine: Optional[str] = None,
    strategy_name: Optional[str] = None,
    severity: Optional[str] = None,
    category: Optional[str] = None,
    since_ts: Optional[int] = None,
    include_ack: bool = False,
    limit: int = 200,
) -> List[Dict[str, Any]]:
    SessionLocal = _session_factory()
    session = SessionLocal()
    try:
        q = session.query(LiveTradingEventRecord).filter(
            LiveTradingEventRecord.category.in_(RISK_CATEGORIES)
        )
        if node_id:
            q = q.filter(LiveTradingEventRecord.node_id == node_id)
        if engine:
            q = q.filter(LiveTradingEventRecord.engine == engine)
        if strategy_name:
            q = q.filter(LiveTradingEventRecord.strategy_name == strategy_name)
        if severity:
            q = q.filter(LiveTradingEventRecord.severity == severity)
        if category:
            q = q.filter(LiveTradingEventRecord.category == category)
        if since_ts is not None:
            q = q.filter(LiveTradingEventRecord.event_ts >= int(since_ts))
        if not include_ack:
            q = q.filter(LiveTradingEventRecord.ack_at.is_(None))
        rows = (
            q.order_by(LiveTradingEventRecord.event_ts.desc(), LiveTradingEventRecord.id.desc())
            .limit(max(1, min(int(limit), 1000)))
            .all()
        )
        return [_record_to_dict(row) for row in rows]
    finally:
        session.close()


def list_strategy_logs(
    *,
    node_id: str,
    engine: str,
    strategy_name: str,
    severity: Optional[str] = None,
    since_ts: Optional[int] = None,
    limit: int = 500,
) -> List[Dict[str, Any]]:
    """List persisted per-strategy runtime logs from the vnpy WS collector."""
    SessionLocal = _session_factory()
    session = SessionLocal()
    try:
        node_ids = [node_id]
        if node_id and node_id != "unnamed":
            node_ids.append("unnamed")
        q = session.query(LiveTradingEventRecord).filter(
            LiveTradingEventRecord.category.in_(LOG_CATEGORIES),
            LiveTradingEventRecord.node_id.in_(node_ids),
            LiveTradingEventRecord.engine == engine,
            LiveTradingEventRecord.strategy_name == strategy_name,
        )
        if severity:
            q = q.filter(LiveTradingEventRecord.severity == severity)
        if since_ts is not None:
            q = q.filter(LiveTradingEventRecord.event_ts >= int(since_ts))
        rows = (
            q.order_by(LiveTradingEventRecord.event_ts.desc(), LiveTradingEventRecord.id.desc())
            .limit(max(1, min(int(limit), 2000)))
            .all()
        )
        return [_record_to_dict(row) for row in rows]
    finally:
        session.close()


def acked_event_ids(event_ids: Iterable[str]) -> set[str]:
    ids = [event_id for event_id in event_ids if event_id]
    if not ids:
        return set()
    SessionLocal = _session_factory()
    session = SessionLocal()
    try:
        rows = (
            session.query(LiveTradingEventRecord.event_id)
            .filter(LiveTradingEventRecord.event_id.in_(ids))
            .filter(LiveTradingEventRecord.ack_at.is_not(None))
            .all()
        )
        return {row[0] for row in rows}
    finally:
        session.close()


def merge_risk_events(current_events: Iterable[Dict[str, Any]], stored_events: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    merged: Dict[str, Dict[str, Any]] = {}
    for event in stored_events:
        merged[_text(event.get("event_id"))] = dict(event)
    for event in current_events:
        event_id = _text(event.get("event_id"))
        row = dict(event)
        if event_id in merged:
            row.setdefault("ack_at", merged[event_id].get("ack_at"))
            row.setdefault("ack_by", merged[event_id].get("ack_by"))
            if row.get("ack_at") is None:
                row["ack_at"] = merged[event_id].get("ack_at")
            if row.get("ack_by") is None:
                row["ack_by"] = merged[event_id].get("ack_by")
        merged[event_id] = row
    return sorted(
        merged.values(),
        key=lambda event: (
            {"info": 0, "warning": 1, "error": 2, "critical": 3}.get(_text(event.get("severity")), -1),
            int(event.get("event_ts") or 0),
        ),
        reverse=True,
    )


def ack_event(event_id: str, *, ack_by: str = "operator") -> bool:
    SessionLocal = _session_factory()
    session = SessionLocal()
    try:
        record = session.query(LiveTradingEventRecord).filter(
            LiveTradingEventRecord.event_id == event_id
        ).first()
        if record is None:
            return False
        record.ack_at = datetime.now()
        record.ack_by = ack_by[:64] if ack_by else "operator"
        session.commit()
        return True
    finally:
        session.close()


def ack_node_offline_events(node_id: str, *, ack_by: str = "watchdog_recovery") -> int:
    """Acknowledge stale node-offline risk rows once the node is online again."""
    node_id = _text(node_id)
    if not node_id:
        return 0
    SessionLocal = _session_factory()
    session = SessionLocal()
    try:
        rows = (
            session.query(LiveTradingEventRecord)
            .filter(
                LiveTradingEventRecord.node_id == node_id,
                LiveTradingEventRecord.category == "node",
                LiveTradingEventRecord.reason == "node_offline",
                LiveTradingEventRecord.status == "offline",
                LiveTradingEventRecord.ack_at.is_(None),
            )
            .all()
        )
        now = datetime.now()
        for row in rows:
            row.ack_at = now
            row.ack_by = ack_by[:64] if ack_by else "watchdog_recovery"
            row.updated_at = now
        session.commit()
        return len(rows)
    except Exception:
        session.rollback()
        logger.exception("failed to ack node offline events for node_id=%s", node_id)
        return 0
    finally:
        session.close()


def prune_old_events() -> int:
    days = int(
        get_runtime_setting(
            "live_trading_event_retention_days",
            default=settings.live_trading_event_retention_days,
        )
    )
    if days <= 0:
        return 0
    cutoff_ms = int((datetime.now() - timedelta(days=days)).timestamp() * 1000)
    SessionLocal = _session_factory()
    session = SessionLocal()
    try:
        count = (
            session.query(LiveTradingEventRecord)
            .filter(LiveTradingEventRecord.event_ts < cutoff_ms)
            .delete(synchronize_session=False)
        )
        session.commit()
        return int(count or 0)
    finally:
        session.close()


async def event_retention_loop() -> None:
    while True:
        try:
            deleted = prune_old_events()
            if deleted:
                logger.info("[live_event_store] pruned %d old events", deleted)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("[live_event_store] prune failed: %s", exc)
        await asyncio.sleep(3600)
