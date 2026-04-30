"""企业行为（corp action）检测：识别最近 N 日的除权除息事件。

设计要点：
- 输入：vt_symbols + 当前日期 + lookback_days
- 数据源：vnpy_tushare_pro 每日 20:00 落盘的 daily_merged_YYYYMMDD.parquet
  （路径由 settings.daily_merged_root 决定，单机部署与 vnpy_qmt_sim 共用同一目录）
- 检测逻辑：tushare 的 pct_chg 含除权调整，与 raw_change=close[T]/close[T-1]-1
  对比，差异超过阈值即判定为除权日
- 性能：lru_cache 按文件 mtime 缓存当日 snapshot，O(1) 查询持仓股票

模块只依赖 pandas / pyarrow，无 vnpy 依赖。"""
from __future__ import annotations

import logging
import time
from collections import OrderedDict
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Iterable, Optional

import pandas as pd

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class CorpActionEvent:
    vt_symbol: str
    name: str
    trade_date: str  # ISO yyyy-mm-dd
    pct_chg: float          # tushare 复权涨跌幅 (%)
    raw_change_pct: float   # 不含除权的原始 close 涨跌幅 (%)
    magnitude_pct: float    # 二者绝对差，绝对值 (%)
    pre_close: float
    close: float


def _vt_to_ts(vt: str) -> Optional[str]:
    """vt_symbol (000001.SZSE) → tushare ts_code (000001.SZ)。"""
    if "." not in vt:
        return None
    sym, ex = vt.rsplit(".", 1)
    suffix = {"SSE": "SH", "SZSE": "SZ", "BSE": "BJ"}.get(ex.upper())
    if suffix is None:
        return None
    return f"{sym}.{suffix}"


# 模块级缓存：snapshot 文件名 → (mtime, DataFrame)
_FILE_CACHE: "OrderedDict[str, tuple[float, pd.DataFrame]]" = OrderedDict()
_CACHE_MAX = 3
_READ_COLS = ["ts_code", "trade_date", "name", "close", "pre_close", "pct_chg"]


def _resolve_snapshot(merged_root: Path, as_of: date, fallback_days: int = 10) -> Optional[Path]:
    for offset in range(0, fallback_days):
        candidate = merged_root / f"daily_merged_{(as_of - timedelta(days=offset)):%Y%m%d}.parquet"
        if candidate.exists():
            return candidate
    return None


def _load_snapshot(path: Path) -> pd.DataFrame:
    key = path.name
    mtime = path.stat().st_mtime
    cached = _FILE_CACHE.get(key)
    if cached is not None and cached[0] == mtime:
        _FILE_CACHE.move_to_end(key)
        return cached[1]
    df = pd.read_parquet(path, columns=_READ_COLS)
    df = df.set_index(["ts_code", "trade_date"]).sort_index()
    _FILE_CACHE[key] = (mtime, df)
    while len(_FILE_CACHE) > _CACHE_MAX:
        _FILE_CACHE.popitem(last=False)
    return df


def detect_corp_actions(
    vt_symbols: Iterable[str],
    as_of: Optional[date] = None,
    lookback_days: int = 30,
    threshold_pct: float = 0.5,
    merged_root: Optional[str | Path] = None,
) -> list[CorpActionEvent]:
    """检测最近 lookback_days 内的除权事件。

    threshold_pct: pct_chg 与 raw_change 的绝对差超过此值（单位 %）判定为除权日。
                   默认 0.5%，过滤掉浮点误差和小幅修正。
    """
    from app.core.config import settings  # 避免循环依赖

    # daily_merged_root 是部署绑定的本地挂载点（指向策略服务器输出），
    # 不暴露给 web UI 修改；只能改 .env 后重启 app.main。
    root = Path(merged_root) if merged_root else Path(settings.daily_merged_root)
    if not root.exists():
        logger.warning("daily_merged_root 不存在: %s", root)
        return []

    end = as_of or datetime.now().date()
    snapshot = _resolve_snapshot(root, end)
    if snapshot is None:
        logger.warning("未找到 %s 之前 10 日内的 daily_merged 文件", end)
        return []

    df = _load_snapshot(snapshot)
    start = end - timedelta(days=lookback_days)

    events: list[CorpActionEvent] = []
    for vt in set(vt_symbols):
        ts_code = _vt_to_ts(vt)
        if ts_code is None:
            continue
        try:
            rows = df.loc[ts_code]
        except KeyError:
            continue
        if isinstance(rows, pd.Series):
            rows = rows.to_frame().T

        # 过滤窗口
        mask = (rows.index >= pd.Timestamp(start)) & (rows.index <= pd.Timestamp(end))
        sub = rows.loc[mask].sort_index()
        if len(sub) < 2:
            continue

        closes = sub["close"].values
        for i in range(1, len(sub)):
            prev_close = float(closes[i - 1])
            today_close = float(closes[i])
            today_pre_close = float(sub["pre_close"].iloc[i])
            pct_chg = float(sub["pct_chg"].iloc[i])
            if prev_close <= 0 or pd.isna(today_pre_close):
                continue

            raw_change_pct = (today_close / prev_close - 1.0) * 100.0
            magnitude = abs(pct_chg - raw_change_pct)
            if magnitude < threshold_pct:
                continue

            ts_dt: pd.Timestamp = sub.index[i]  # type: ignore[assignment]
            events.append(CorpActionEvent(
                vt_symbol=vt,
                name=str(sub["name"].iloc[i]) if pd.notna(sub["name"].iloc[i]) else "",
                trade_date=ts_dt.date().isoformat(),
                pct_chg=round(pct_chg, 4),
                raw_change_pct=round(raw_change_pct, 4),
                magnitude_pct=round(magnitude, 4),
                pre_close=round(today_pre_close, 4),
                close=round(today_close, 4),
            ))

    events.sort(key=lambda e: (e.trade_date, e.vt_symbol), reverse=True)
    return events
