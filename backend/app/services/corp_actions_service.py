"""企业行为 (除权除息) 检测 — Phase 3.3 解耦后退化为 HTTP 客户端.

之前 mlearnweb 直读 ``{settings.daily_merged_root}/daily_merged_{T}.parquet``
本地跑 detect_corp_actions 算法; 跨机部署时 mlearnweb 拿不到推理机的本地
parquet (违反"mlearnweb 跨机部署不假设能访问 vnpy 推理机文件系统"原则).

算法已搬到 vnpy 侧 ``vnpy_webtrader/_corp_actions.py``, 通过
``GET /api/v1/reference/corp_actions?vt_symbols=...&days=...&threshold_pct=...``
暴露. mlearnweb 这一层只做:
  1. fanout 拉首个成功节点 (任意节点 daily_merged 都是同一份 tushare 数据)
  2. dict → CorpActionEvent dataclass 转换 (router 序列化复用)
  3. HTTP 全部失败兜底返空列表 (前端"暂无事件" UX)

输出契约保持不变 — `live_trading.py` router 和前端组件无需改动.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import date
from typing import Iterable, List, Optional

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class CorpActionEvent:
    """与原本地实现完全相同的字段集 — router 已用 ``e.__dict__`` 序列化, 保持兼容."""
    vt_symbol: str
    name: str
    trade_date: str  # ISO yyyy-mm-dd
    pct_chg: float
    raw_change_pct: float
    magnitude_pct: float
    pre_close: float
    close: float


def _to_event(d: dict) -> Optional[CorpActionEvent]:
    """vnpy ``/reference/corp_actions`` 单条 event dict → dataclass.
    缺字段或类型不对返 None — 防 vnpy 端响应结构变动击穿调用栈.
    """
    try:
        return CorpActionEvent(
            vt_symbol=str(d["vt_symbol"]),
            name=str(d.get("name") or ""),
            trade_date=str(d["trade_date"]),
            pct_chg=float(d["pct_chg"]),
            raw_change_pct=float(d["raw_change_pct"]),
            magnitude_pct=float(d["magnitude_pct"]),
            pre_close=float(d["pre_close"]),
            close=float(d["close"]),
        )
    except (KeyError, TypeError, ValueError):
        return None


async def detect_corp_actions_async(
    vt_symbols: Iterable[str],
    *,
    lookback_days: int = 30,
    threshold_pct: float = 0.5,
    as_of: Optional[date] = None,  # 保留参数, 但 vnpy 端按当天算 — 跨日 caller 极少
) -> List[CorpActionEvent]:
    """异步主路径 — fanout 调 vnpy webtrader 取首个成功节点.

    ``as_of`` 当前 vnpy 端固定按"今天"判定 (snapshot fallback 内 10 天).
    若 caller 真要历史日 as_of, 后续可在 vnpy 端加 ?as_of= 参数; 目前
    所有上游 (live_trading 路由) 只传当天用例, YAGNI.
    """
    from app.services.vnpy.client import get_vnpy_client

    symbols = [s.strip() for s in vt_symbols if s and s.strip()]
    if not symbols:
        return []
    client = get_vnpy_client()
    try:
        resp = await client.get_reference_corp_actions_first_ok(
            symbols, days=lookback_days, threshold_pct=threshold_pct,
        )
    except Exception as e:
        logger.warning("[corp_actions] HTTP fanout failed: %s", e)
        return []
    raw_events = (resp or {}).get("events") or []
    out = [_to_event(d) for d in raw_events]
    return [e for e in out if e is not None]


def detect_corp_actions(
    vt_symbols: Iterable[str],
    *,
    lookback_days: int = 30,
    threshold_pct: float = 0.5,
    as_of: Optional[date] = None,
    merged_root: Optional[str] = None,  # 历史 kwarg, Phase 3.3 后忽略
) -> List[CorpActionEvent]:
    """同步包装 — router 当前 ``async def`` 不直接 await 我们, 但保留同步入口
    给可能的命令行 / 单测 caller.

    ``merged_root`` kwarg 保留是签名兼容 (老 caller 传了不会报), Phase 3.3
    后**不再使用** — 数据源由 vnpy 侧决定. 不发 deprecation warning,
    走 ``feedback_no_legacy_compat`` 风格: 下个 sprint 直接清掉这个 kwarg.
    """
    if merged_root is not None:
        logger.debug(
            "[corp_actions] merged_root kwarg 已忽略 (Phase 3.3 HTTP 化, 数据由 vnpy 侧决定)",
        )
    return asyncio.run(detect_corp_actions_async(
        vt_symbols,
        lookback_days=lookback_days,
        threshold_pct=threshold_pct,
        as_of=as_of,
    ))
