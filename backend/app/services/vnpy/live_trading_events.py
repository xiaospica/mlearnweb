"""In-memory event bus for live-trading query invalidation.

The bus lives inside the ``app.live_main`` process. It deliberately sends only
semantic invalidation events to the browser; REST endpoints remain the
authoritative data source.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple


Severity = Optional[str]

HEARTBEAT_SECONDS = 15
COALESCE_SECONDS = 0.75
QUEUE_MAXSIZE = 256

QUERY_GROUPS_BY_EVENT_TYPE: Dict[str, List[str]] = {
    "node.changed": ["nodes", "strategy_list"],
    "strategy.state.changed": [
        "strategy_detail",
        "performance_summary",
        "strategy_list",
        "risk_events",
    ],
    "strategy.position.changed": [
        "strategy_detail",
        "performance_summary",
        "corp_actions",
    ],
    "strategy.equity.changed": [
        "strategy_detail",
        "performance_summary",
        "strategy_list",
    ],
    "strategy.order_trade.changed": [
        "trades",
        "risk_events",
        "strategy_detail",
        "performance_summary",
    ],
    "strategy.risk.changed": [
        "risk_events",
        "strategy_detail",
        "strategy_list",
    ],
    "strategy.ml.changed": [
        "ml_latest",
        "ml_metrics",
        "strategy_detail",
    ],
    "strategy.history.changed": [
        "history_dates",
        "ml_metrics",
        "ml_latest",
    ],
}


@dataclass
class LiveTradingEvent:
    event_type: str
    node_id: Optional[str] = None
    engine: Optional[str] = None
    strategy_name: Optional[str] = None
    severity: Severity = None
    reason: Optional[str] = None
    query_groups: List[str] = field(default_factory=list)
    ts: int = field(default_factory=lambda: int(time.time() * 1000))
    event_id: str = field(default_factory=lambda: uuid.uuid4().hex)

    def as_payload(self) -> Dict[str, Any]:
        payload = asdict(self)
        payload["query_groups"] = sorted(set(self.query_groups))
        return payload

    @property
    def high_priority(self) -> bool:
        return self.severity in {"error", "critical"}


class LiveTradingEventBus:
    """Small async pub/sub bus with per-client bounded queues."""

    def __init__(self, *, coalesce_seconds: float = COALESCE_SECONDS) -> None:
        self._subscribers: Set[asyncio.Queue[LiveTradingEvent]] = set()
        self._pending: Dict[Tuple[str, str, str], LiveTradingEvent] = {}
        self._flush_tasks: Dict[Tuple[str, str, str], asyncio.Task[None]] = {}
        self._lock = asyncio.Lock()
        self._coalesce_seconds = coalesce_seconds

    def subscribe(self) -> asyncio.Queue[LiveTradingEvent]:
        queue: asyncio.Queue[LiveTradingEvent] = asyncio.Queue(maxsize=QUEUE_MAXSIZE)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[LiveTradingEvent]) -> None:
        self._subscribers.discard(queue)

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)

    async def publish(self, event: LiveTradingEvent) -> None:
        if not event.query_groups:
            event.query_groups = list(QUERY_GROUPS_BY_EVENT_TYPE.get(event.event_type, []))
        if event.high_priority:
            await self._fanout(event)
            return

        key = (
            event.node_id or "",
            event.engine or "",
            event.strategy_name or "",
        )
        async with self._lock:
            pending = self._pending.get(key)
            if pending is None:
                self._pending[key] = event
                self._flush_tasks[key] = asyncio.create_task(self._flush_later(key))
            else:
                pending.query_groups = sorted(set(pending.query_groups) | set(event.query_groups))
                pending.event_type = event.event_type or pending.event_type
                pending.reason = event.reason or pending.reason
                pending.severity = event.severity or pending.severity
                pending.ts = event.ts

    async def _flush_later(self, key: Tuple[str, str, str]) -> None:
        try:
            await asyncio.sleep(self._coalesce_seconds)
            async with self._lock:
                event = self._pending.pop(key, None)
                self._flush_tasks.pop(key, None)
            if event is not None:
                await self._fanout(event)
        except asyncio.CancelledError:
            raise

    async def _fanout(self, event: LiveTradingEvent) -> None:
        stale: List[asyncio.Queue[LiveTradingEvent]] = []
        for queue in list(self._subscribers):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                with contextlib.suppress(asyncio.QueueEmpty):
                    queue.get_nowait()
                try:
                    queue.put_nowait(event)
                except asyncio.QueueFull:
                    stale.append(queue)
        for queue in stale:
            self.unsubscribe(queue)


_BUS = LiveTradingEventBus()


def get_event_bus() -> LiveTradingEventBus:
    return _BUS


def event_to_sse(event: str, data: Dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def make_event(
    event_type: str,
    *,
    node_id: Optional[str] = None,
    engine: Optional[str] = None,
    strategy_name: Optional[str] = None,
    severity: Severity = None,
    reason: Optional[str] = None,
    query_groups: Optional[Iterable[str]] = None,
) -> LiveTradingEvent:
    groups = list(query_groups or QUERY_GROUPS_BY_EVENT_TYPE.get(event_type, []))
    identity = "-".join(
        str(part or "all").replace("/", "_")
        for part in (node_id, engine, strategy_name, event_type)
    )
    ts = int(time.time() * 1000)
    return LiveTradingEvent(
        event_id=f"{identity}-{ts}-{uuid.uuid4().hex[:6]}",
        event_type=event_type,
        node_id=node_id,
        engine=engine,
        strategy_name=strategy_name,
        severity=severity,
        reason=reason,
        query_groups=groups,
        ts=ts,
    )


async def publish_event(event: LiveTradingEvent) -> None:
    with contextlib.suppress(Exception):
        from app.services.vnpy.live_trading_event_store import persist_live_event

        persist_live_event(event)
    await get_event_bus().publish(event)


async def publish_strategy_event(
    event_type: str,
    *,
    node_id: str,
    engine: str,
    strategy_name: str,
    severity: Severity = None,
    reason: Optional[str] = None,
    query_groups: Optional[Iterable[str]] = None,
) -> None:
    await publish_event(
        make_event(
            event_type,
            node_id=node_id,
            engine=engine,
            strategy_name=strategy_name,
            severity=severity,
            reason=reason,
            query_groups=query_groups,
        )
    )
