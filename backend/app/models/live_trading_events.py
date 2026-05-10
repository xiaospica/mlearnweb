"""Persistent live-trading event records.

P0/P1 keeps risk events realtime-only. P3 adds this small append/dedupe table so
WS/order/log/node events can be queried after reconnects and acknowledged by an
operator without changing the frontend-facing risk event contract.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, Boolean, Column, DateTime, Index, Integer, String, Text

from .database import Base


class LiveTradingEventRecord(Base):
    __tablename__ = "live_trading_events"

    id = Column(Integer, primary_key=True, autoincrement=True)
    event_id = Column(String(160), nullable=False, unique=True, index=True)
    dedupe_key = Column(String(255), nullable=True, unique=True, index=True)

    event_type = Column(String(64), nullable=False, index=True)
    node_id = Column(String(64), nullable=True, index=True)
    engine = Column(String(64), nullable=True, index=True)
    strategy_name = Column(String(128), nullable=True, index=True)

    severity = Column(String(16), nullable=True, index=True)
    category = Column(String(32), nullable=True, index=True)
    title = Column(String(255), nullable=True)
    message = Column(Text, nullable=True)
    status = Column(String(64), nullable=True)
    vt_orderid = Column(String(128), nullable=True, index=True)
    vt_symbol = Column(String(64), nullable=True)
    reference = Column(String(160), nullable=True, index=True)
    is_resubmit = Column(Boolean, default=False, nullable=False)
    source = Column(String(64), nullable=True, index=True)
    reason = Column(String(128), nullable=True)

    query_groups_json = Column(Text, nullable=True)
    raw_json = Column(Text, nullable=True)
    event_ts = Column(BigInteger, nullable=False, index=True)
    ack_at = Column(DateTime, nullable=True)
    ack_by = Column(String(64), nullable=True)
    created_at = Column(DateTime, default=datetime.now, nullable=False)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now, nullable=False)

    __table_args__ = (
        Index("ix_lte_identity_ts", "node_id", "engine", "strategy_name", "event_ts"),
        Index("ix_lte_risk_ts", "severity", "category", "event_ts"),
    )
