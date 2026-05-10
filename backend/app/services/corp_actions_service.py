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
from datetime import date, timedelta
from pathlib import Path
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


def _vt_symbol_to_ts_code(vt_symbol: str) -> Optional[str]:
    if "." not in vt_symbol:
        return None
    code, exchange = vt_symbol.rsplit(".", 1)
    suffix = {"SZSE": "SZ", "SSE": "SH", "SZ": "SZ", "SH": "SH"}.get(exchange.upper())
    if not code or suffix is None:
        return None
    return f"{code}.{suffix}"


def _latest_snapshot_path(merged_root: Path, as_of: Optional[date]) -> Optional[Path]:
    candidates = sorted(merged_root.glob("daily_merged_*.parquet"))
    if not candidates:
        return None
    if as_of is None:
        return candidates[-1]
    as_of_key = as_of.strftime("%Y%m%d")
    eligible = [p for p in candidates if p.stem.replace("daily_merged_", "") <= as_of_key]
    return eligible[-1] if eligible else None


def _detect_corp_actions_from_snapshot(
    vt_symbols: Iterable[str],
    *,
    lookback_days: int,
    threshold_pct: float,
    as_of: Optional[date],
    merged_root: str | Path,
) -> List[CorpActionEvent]:
    """Explicit local parquet path used by tests and same-host diagnostics.

    Production callers use the HTTP fanout path. This branch only runs when a
    caller supplies merged_root, so normal deployment remains decoupled from
    vnpy_strategy_dev local files.
    """
    import pandas as pd

    root = Path(merged_root)
    snap = _latest_snapshot_path(root, as_of)
    if snap is None:
        return []
    try:
        df = pd.read_parquet(snap)
    except Exception as exc:  # noqa: BLE001
        logger.warning("[corp_actions] failed to read %s: %s", snap, exc)
        return []

    required = {"ts_code", "trade_date", "close", "pre_close", "pct_chg"}
    if not required.issubset(df.columns):
        return []

    df = df.copy()
    df["trade_date"] = pd.to_datetime(df["trade_date"]).dt.date
    if as_of is None and not df.empty:
        as_of = max(df["trade_date"])
    start_date = as_of - timedelta(days=lookback_days) if as_of else None

    events: List[CorpActionEvent] = []
    for vt_symbol in vt_symbols:
        ts_code = _vt_symbol_to_ts_code(vt_symbol.strip()) if vt_symbol else None
        if not ts_code:
            continue
        sdf = df[df["ts_code"] == ts_code].sort_values("trade_date")
        if sdf.empty:
            continue
        prev_close: Optional[float] = None
        for _, row in sdf.iterrows():
            trade_date = row["trade_date"]
            close = float(row["close"])
            pre_close = float(row["pre_close"])
            pct_chg = float(row["pct_chg"])
            if prev_close and prev_close > 0:
                if start_date is not None and trade_date < start_date:
                    prev_close = close
                    continue
                if as_of is not None and trade_date > as_of:
                    prev_close = close
                    continue
                raw_change_pct = (close / prev_close - 1.0) * 100.0
                magnitude_pct = abs(pct_chg - raw_change_pct)
                if magnitude_pct >= threshold_pct:
                    events.append(CorpActionEvent(
                        vt_symbol=vt_symbol,
                        name=str(row.get("name") or ""),
                        trade_date=trade_date.isoformat(),
                        pct_chg=pct_chg,
                        raw_change_pct=raw_change_pct,
                        magnitude_pct=magnitude_pct,
                        pre_close=pre_close,
                        close=close,
                    ))
            prev_close = close

    return sorted(events, key=lambda e: e.trade_date, reverse=True)


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

    ``merged_root`` kwarg 保留是签名兼容. 默认生产路径不使用它；只有显式传入
    时才走本地 parquet 检测，用于单测与同机诊断。
    """
    if merged_root is not None:
        return _detect_corp_actions_from_snapshot(
            vt_symbols,
            lookback_days=lookback_days,
            threshold_pct=threshold_pct,
            as_of=as_of,
            merged_root=merged_root,
        )
    return asyncio.run(detect_corp_actions_async(
        vt_symbols,
        lookback_days=lookback_days,
        threshold_pct=threshold_pct,
        as_of=as_of,
    ))
