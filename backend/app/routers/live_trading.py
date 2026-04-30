from __future__ import annotations

import logging
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.models.database import get_db_session
from app.schemas.schemas import (
    LiveTradingListResponse,
    StrategyCreateRequest,
    StrategyEditRequest,
)
from app.services import corp_actions_service
from app.services.vnpy import live_trading_service as svc
from app.services.vnpy.client import VnpyClientError
from app.services.vnpy.deps import require_ops_password

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
    window_days: int = Query(7, ge=1, le=90),
    db: Session = Depends(get_db_session),
) -> LiveTradingListResponse:
    detail, warning = await svc.get_strategy_detail(db, node_id, engine, name, window_days)
    if detail is None:
        return LiveTradingListResponse(success=False, data=None, warning=warning, message=warning or "")
    return _ok(detail, warning=warning)


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
        events = corp_actions_service.detect_corp_actions(
            vt_symbols=symbols,
            lookback_days=days,
            threshold_pct=threshold_pct,
        )
        # 序列化 dataclass → dict
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
