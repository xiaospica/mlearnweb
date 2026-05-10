from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.models.database import get_db_session
from app.schemas.schemas import (
    LiveTradingListResponse,
    StrategyCreateRequest,
    StrategyEditRequest,
)
from app.services import corp_actions_service
from app.services.vnpy import live_trading_service as svc
from app.services.vnpy import risk_event_service
from app.services.vnpy import live_trading_event_store
from app.services.vnpy.client import VnpyClientError
from app.services.vnpy.deps import require_ops_password
from app.services.vnpy.live_trading_events import (
    HEARTBEAT_SECONDS,
    event_to_sse,
    get_event_bus,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/live-trading", tags=["live-trading"])


def _ok(data: Any, warning: str | None = None) -> LiveTradingListResponse:
    return LiveTradingListResponse(success=True, data=data, warning=warning)


def _client_error_to_http(e: VnpyClientError) -> HTTPException:
    msg = str(e)
    lower = msg.lower()
    if "404" in lower:
        return HTTPException(status_code=404, detail=msg)
    if "409" in lower:
        return HTTPException(status_code=409, detail=msg)
    if "501" in lower:
        return HTTPException(status_code=501, detail=msg)
    return HTTPException(status_code=502, detail=f"vnpy 上游错误: {msg}")


# ---------------------------------------------------------------------------
# Read endpoints (no ops-password requirement)
# ---------------------------------------------------------------------------


@router.get("/events", include_in_schema=False)
async def live_trading_events(request: Request) -> StreamingResponse:
    """SSE stream for semantic live-trading query invalidation events."""
    bus = get_event_bus()
    queue = bus.subscribe()

    async def event_stream():
        try:
            yield event_to_sse("hello", {"ts": int(time.time() * 1000)})
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=HEARTBEAT_SECONDS)
                except asyncio.TimeoutError:
                    yield event_to_sse("heartbeat", {"ts": int(time.time() * 1000)})
                    continue
                yield event_to_sse(event.event_type, event.as_payload())
        finally:
            bus.unsubscribe(queue)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/nodes", response_model=LiveTradingListResponse)
async def list_nodes() -> LiveTradingListResponse:
    try:
        statuses = await svc.list_node_statuses()
        return _ok(statuses)
    except Exception as e:  # registry / probe errors degrade gracefully
        logger.exception("[live_trading] list_nodes failed: %s", e)
        return _ok([], warning=f"节点状态查询失败: {e}")


@router.get("/strategies", response_model=LiveTradingListResponse)
async def list_strategies(db: Session = Depends(get_db_session)) -> LiveTradingListResponse:
    summaries, warning = await svc.list_strategy_summaries(db)
    return _ok(summaries, warning=warning)


@router.get(
    "/strategies/{node_id}/{engine}/{name}",
    response_model=LiveTradingListResponse,
)
async def get_strategy(
    node_id: str,
    engine: str,
    name: str,
    window_days: int = Query(365, ge=1, le=3650),
    db: Session = Depends(get_db_session),
) -> LiveTradingListResponse:
    detail, warning = await svc.get_strategy_detail(db, node_id, engine, name, window_days)
    if detail is None:
        return LiveTradingListResponse(success=False, data=None, warning=warning, message=warning or "")
    return _ok(detail, warning=warning)


@router.get(
    "/strategies/{node_id}/{engine}/{name}/performance-summary",
    response_model=LiveTradingListResponse,
)
async def get_strategy_performance_summary(
    node_id: str,
    engine: str,
    name: str,
    window_days: int = Query(365, ge=1, le=3650),
    db: Session = Depends(get_db_session),
) -> LiveTradingListResponse:
    summary, warning = await svc.get_strategy_performance_summary(
        db, node_id, engine, name, window_days=window_days,
    )
    return _ok(summary, warning=warning)


@router.get(
    "/strategies/{node_id}/{engine}/{name}/trades",
    response_model=LiveTradingListResponse,
)
async def list_strategy_trades(
    node_id: str,
    engine: str,
    name: str,
) -> LiveTradingListResponse:
    """指定策略的成交记录（当前会话内，按 datetime 倒序）。"""
    rows, warning = await svc.list_strategy_trades(node_id, engine, name)
    return _ok(rows, warning=warning)


@router.get(
    "/strategies/{node_id}/{engine}/{name}/orders",
    response_model=LiveTradingListResponse,
)
async def list_strategy_orders(
    node_id: str,
    engine: str,
    name: str,
) -> LiveTradingListResponse:
    """指定策略订单记录（当前会话内，按 datetime 倒序）。"""
    rows, warning = await risk_event_service.list_strategy_orders(node_id, engine, name)
    return _ok(rows, warning=warning)


@router.get(
    "/strategies/{node_id}/{engine}/{name}/risk-events",
    response_model=LiveTradingListResponse,
)
async def list_strategy_risk_events(
    node_id: str,
    engine: str,
    name: str,
    severity: Optional[str] = Query(None, description="按 severity 过滤"),
    category: Optional[str] = Query(None, description="按 category 过滤"),
    since_ts: Optional[int] = Query(None, ge=0, description="毫秒级时间戳下限"),
    include_ack: bool = Query(False, description="是否包含已确认事件"),
    limit: int = Query(200, ge=1, le=1000),
) -> LiveTradingListResponse:
    """指定策略风险事件（P3: 事件表 + 当前状态补偿）。"""
    rows, warning = await risk_event_service.list_strategy_risk_events(
        node_id,
        engine,
        name,
        severity=severity,
        category=category,
        since_ts=since_ts,
        include_ack=include_ack,
        limit=limit,
    )
    return _ok(rows, warning=warning)


@router.get(
    "/strategies/{node_id}/{engine}/{name}/logs",
    response_model=LiveTradingListResponse,
)
async def list_strategy_logs(
    node_id: str,
    engine: str,
    name: str,
    severity: Optional[str] = Query(None, description="按 severity 过滤"),
    since_ts: Optional[int] = Query(None, ge=0, description="毫秒级时间戳下限"),
    limit: int = Query(500, ge=1, le=2000),
) -> LiveTradingListResponse:
    """指定策略的 vnpy 运行日志；SSE 只负责触发刷新，日志正文通过 REST 读取。"""
    return _ok(
        live_trading_event_store.list_strategy_logs(
            node_id=node_id,
            engine=engine,
            strategy_name=name,
            severity=severity,
            since_ts=since_ts,
            limit=limit,
        )
    )


@router.get("/risk-events", response_model=LiveTradingListResponse)
async def list_live_trading_risk_events(
    node_id: Optional[str] = Query(None),
    engine: Optional[str] = Query(None),
    strategy_name: Optional[str] = Query(None),
    severity: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    since_ts: Optional[int] = Query(None, ge=0),
    include_ack: bool = Query(False),
    limit: int = Query(200, ge=1, le=1000),
) -> LiveTradingListResponse:
    """跨策略查询已持久化风险事件（P3 历史/过滤入口）。"""
    return _ok(
        live_trading_event_store.list_risk_events(
            node_id=node_id,
            engine=engine,
            strategy_name=strategy_name,
            severity=severity,
            category=category,
            since_ts=since_ts,
            include_ack=include_ack,
            limit=limit,
        )
    )


@router.get(
    "/strategies/{node_id}/{engine}/{name}/positions/dates",
    response_model=LiveTradingListResponse,
)
async def get_strategy_position_dates(
    node_id: str,
    engine: str,
    name: str,
    gateway_name: Optional[str] = Query(None, description="澶?gateway 娌欑洅涓嬫寚瀹?gateway"),
    db: Session = Depends(get_db_session),
) -> LiveTradingListResponse:
    data = await svc.get_strategy_position_dates(
        db, node_id, engine, name, gateway_name=gateway_name,
    )
    return _ok(data, warning=data.get("warning"))


@router.get(
    "/strategies/{node_id}/{engine}/{name}/positions/{yyyymmdd}",
    response_model=LiveTradingListResponse,
)
async def get_strategy_positions_on_date(
    node_id: str,
    engine: str,
    name: str,
    yyyymmdd: str,
    gateway_name: Optional[str] = Query(None, description="多 gateway 沙盒下指定 gateway"),
    db: Session = Depends(get_db_session),
) -> LiveTradingListResponse:
    """重建指定策略在 ``yyyymmdd`` 日 EOD 的持仓快照（含 amount/金额/仓位占比）。

    路径优先级:
      1. vnpy webtrader RPC endpoint (跨机部署正确路径)
      2. fallback 同机直读 sim db (mlearnweb 与 vnpy 同机时的快路径)
    """
    from app.services.vnpy.historical_positions_service import (
        get_strategy_positions_on_date as svc_fn,
        get_strategy_positions_on_date_from_snapshots,
        get_strategy_positions_on_date_via_rpc,
    )
    # 1. 优先 RPC (跨机部署正确路径)
    rows, warning = await get_strategy_positions_on_date_via_rpc(
        node_id, name, yyyymmdd, gateway_name=gateway_name,
    )
    if rows:
        return _ok(rows, warning=warning)

    # 2. fallback 同机直读
    rows, warning2 = svc_fn(name, yyyymmdd, gateway_name=gateway_name)
    if rows:
        return _ok(rows, warning=warning2 or warning)

    # 3. fallback to mlearnweb live snapshots. This only covers dates captured
    # after positions_json was introduced; older equity-only rows cannot be
    # reconstructed without vnpy sim trades.
    snapshot_rows, snapshot_warning = get_strategy_positions_on_date_from_snapshots(
        db, node_id, engine, name, yyyymmdd,
    )
    if snapshot_rows:
        return _ok(
            snapshot_rows,
            warning=snapshot_warning or warning2 or warning,
        )
    combined_warning = " / ".join(
        part for part in (warning, warning2, snapshot_warning) if part
    ) or None
    return _ok([], warning=combined_warning)


@router.get("/corp-actions", response_model=LiveTradingListResponse)
async def list_corp_actions(
    vt_symbols: str = Query(..., description="逗号分隔的 vt_symbol 列表，如 000001.SZSE,600519.SSE"),
    days: int = Query(30, ge=1, le=180, description="向前回溯天数"),
    threshold_pct: float = Query(0.5, ge=0.0, le=20.0, description="pct_chg 与原始 close 涨跌幅差异阈值（%）"),
) -> LiveTradingListResponse:
    """检测最近 N 日内持仓股票发生的除权除息事件。

    用途：mlearnweb 前端策略详情页 CorpActionsCard 展示，让用户理解
    持仓股票当日单价跳变的原因（除权日 pre_close ≠ 上一交易日 close）。
    """
    symbols = [s.strip() for s in vt_symbols.split(",") if s.strip()]
    if not symbols:
        return _ok([])
    try:
        # Phase 3.3 — service 退化为 vnpy webtrader 的 HTTP 客户端,
        # 走 async 主路径避免在已运行 event loop 里 asyncio.run.
        events = await corp_actions_service.detect_corp_actions_async(
            symbols,
            lookback_days=days,
            threshold_pct=threshold_pct,
        )
        # 序列化 dataclass → dict (前端契约不变)
        payload = [e.__dict__ for e in events]
        return _ok(payload)
    except Exception as exc:
        logger.exception("[live_trading] corp_actions detection failed: %s", exc)
        return _ok([], warning=f"corp action 检测失败: {exc}")


@router.get("/nodes/{node_id}/engines", response_model=LiveTradingListResponse)
async def list_engines(node_id: str) -> LiveTradingListResponse:
    try:
        engines = await svc.get_vnpy_client().get_engines(node_id)
        return _ok(engines)
    except VnpyClientError as e:
        return _ok([], warning=str(e))


@router.get(
    "/nodes/{node_id}/engines/{engine}/classes",
    response_model=LiveTradingListResponse,
)
async def list_engine_classes(node_id: str, engine: str) -> LiveTradingListResponse:
    try:
        classes = await svc.get_vnpy_client().get_engine_classes(node_id, engine)
        return _ok(classes)
    except VnpyClientError as e:
        return _ok([], warning=str(e))


@router.get(
    "/nodes/{node_id}/engines/{engine}/classes/{class_name}/params",
    response_model=LiveTradingListResponse,
)
async def get_class_params(
    node_id: str, engine: str, class_name: str
) -> LiveTradingListResponse:
    try:
        params = await svc.get_vnpy_client().get_class_params(node_id, engine, class_name)
        return _ok(params)
    except VnpyClientError as e:
        return _ok({}, warning=str(e))


# ---------------------------------------------------------------------------
# Write endpoints (all behind X-Ops-Password)
# ---------------------------------------------------------------------------


@router.post(
    "/strategies/{node_id}",
    response_model=LiveTradingListResponse,
    dependencies=[Depends(require_ops_password)],
)
async def create_strategy(
    node_id: str, body: StrategyCreateRequest
) -> LiveTradingListResponse:
    try:
        op = await svc.create_strategy(
            node_id,
            body.engine,
            {
                "class_name": body.class_name,
                "strategy_name": body.strategy_name,
                "vt_symbol": body.vt_symbol,
                "setting": body.setting or {},
            },
        )
        return _ok(op)
    except VnpyClientError as e:
        raise _client_error_to_http(e) from e


@router.post(
    "/strategies/{node_id}/{engine}/{name}/init",
    response_model=LiveTradingListResponse,
    dependencies=[Depends(require_ops_password)],
)
async def init_strategy(node_id: str, engine: str, name: str) -> LiveTradingListResponse:
    try:
        return _ok(await svc.init_strategy(node_id, engine, name))
    except VnpyClientError as e:
        raise _client_error_to_http(e) from e


@router.post(
    "/strategies/{node_id}/{engine}/{name}/start",
    response_model=LiveTradingListResponse,
    dependencies=[Depends(require_ops_password)],
)
async def start_strategy(node_id: str, engine: str, name: str) -> LiveTradingListResponse:
    try:
        return _ok(await svc.start_strategy(node_id, engine, name))
    except VnpyClientError as e:
        raise _client_error_to_http(e) from e


@router.post(
    "/strategies/{node_id}/{engine}/{name}/stop",
    response_model=LiveTradingListResponse,
    dependencies=[Depends(require_ops_password)],
)
async def stop_strategy(node_id: str, engine: str, name: str) -> LiveTradingListResponse:
    try:
        return _ok(await svc.stop_strategy(node_id, engine, name))
    except VnpyClientError as e:
        raise _client_error_to_http(e) from e


@router.patch(
    "/strategies/{node_id}/{engine}/{name}",
    response_model=LiveTradingListResponse,
    dependencies=[Depends(require_ops_password)],
)
async def edit_strategy(
    node_id: str, engine: str, name: str, body: StrategyEditRequest
) -> LiveTradingListResponse:
    try:
        return _ok(await svc.edit_strategy(node_id, engine, name, body.setting or {}))
    except VnpyClientError as e:
        raise _client_error_to_http(e) from e


@router.delete(
    "/strategies/{node_id}/{engine}/{name}",
    response_model=LiveTradingListResponse,
    dependencies=[Depends(require_ops_password)],
)
async def delete_strategy(node_id: str, engine: str, name: str) -> LiveTradingListResponse:
    try:
        return _ok(await svc.delete_strategy(node_id, engine, name))
    except VnpyClientError as e:
        raise _client_error_to_http(e) from e


@router.delete(
    "/strategies/{node_id}/{engine}/{name}/records",
    response_model=LiveTradingListResponse,
    dependencies=[Depends(require_ops_password)],
)
async def delete_strategy_records(
    node_id: str,
    engine: str,
    name: str,
    db: Session = Depends(get_db_session),
) -> LiveTradingListResponse:
    """彻底删除策略: vnpy 节点 stop+delete 实例 + mlearnweb 端清三张快照表.

    一键清空: 策略卡片从列表彻底消失, 历史权益曲线 / ML 指标 / 每日预测全清.
    不影响 vnpy_qmt_sim 持仓/账户 (那由 vnpy_strategy_dev/scripts/reset_sim_state.py 管).
    vnpy 端失败 (策略已不存在 / 节点离线) 不阻塞 db 清理.
    """
    stats = await svc.delete_strategy_records(db, node_id, engine, name)
    return _ok(stats)


@router.post(
    "/risk-events/{event_id}/ack",
    response_model=LiveTradingListResponse,
    dependencies=[Depends(require_ops_password)],
)
async def ack_live_trading_risk_event(
    event_id: str,
    ack_by: str = Query("operator", min_length=1, max_length=64),
) -> LiveTradingListResponse:
    """确认一条持久化风险事件。"""
    ok = live_trading_event_store.ack_event(event_id, ack_by=ack_by)
    if not ok:
        raise HTTPException(status_code=404, detail=f"risk event not found: {event_id}")
    return _ok({"event_id": event_id, "ack_by": ack_by})
