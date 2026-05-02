"""历史持仓浏览 service — 从 vnpy_qmt_sim sim db 重建任意日期 EOD 持仓.

输入:
  - strategy_name (映射到 sim_<account_id>.db, account_id 通常 == gateway_name)
  - target_date (YYYYMMDD)
输出:
  - List[{vt_symbol, name, volume, cost_price, market_value, weight}]

重建算法 (与 vnpy_qmt_sim settle 模型同源, 见 td.py:602 settle_end_of_day):
  1. 按 datetime 升序遍历 sim_trades 累计 (volume, cost) 到 target_date EOD
     - LONG: vol += v, cost = (old_v×old_c + v×p) / new_v
     - SHORT: vol -= v (cost 不变, 平仓不影响成本)
  2. 每个交易日结束 cost *= (1 + pct_chg_today/100), 模拟 settle mark-to-market
  3. 输出 EOD (volume>0) 持仓 + market_value (vol×cost) + weight (持仓内部 sum=1)

跨机部署不可用 — 需 vnpy_webtrader 暴露 /history endpoint 后 fanout, 当前
单机直读 sim db 文件; 不存在 sim db 时返空 + warning.
"""
from __future__ import annotations

import logging
import sqlite3
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd

from app.core.config import settings
from app.services.vnpy.live_trading_service import _resolve_stock_name, get_stock_name_map

logger = logging.getLogger(__name__)


def _vt_to_ts(vt: str) -> str:
    if vt.endswith(".SZSE"): return vt[:-5] + ".SZ"
    if vt.endswith(".SSE"):  return vt[:-4] + ".SH"
    if vt.endswith(".BSE"):  return vt[:-4] + ".BJ"
    return vt


def _resolve_sim_db_path(strategy_name: str, gateway_name: Optional[str]) -> Optional[Path]:
    """sim db 命名约定: sim_<account_id>.db, account_id 默认 == gateway_name.
    传入 gateway_name 优先；若空则尝试用 strategy_name 兜底（不严谨，但 vnpy 默认
    QMT_SIM_<sandbox_id> 形式 gateway 名也包含 strategy 信息）。
    """
    root = Path(settings.vnpy_sim_db_root)
    if not root.exists():
        return None
    if gateway_name:
        p = root / f"sim_{gateway_name}.db"
        if p.exists():
            return p
    # fallback: 任何 sim_*.db
    for p in root.glob("sim_*.db"):
        return p
    return None


def get_strategy_positions_on_date(
    strategy_name: str,
    target_date_str: str,
    gateway_name: Optional[str] = None,
) -> Tuple[Optional[List[Dict[str, Any]]], Optional[str]]:
    """重建 strategy 在 target_date EOD 的持仓.

    Returns (positions_list, warning) — positions_list None 时 warning 含原因.
    """
    try:
        target_d = datetime.strptime(target_date_str, "%Y%m%d").date()
    except ValueError:
        return None, f"invalid date format: {target_date_str}"

    db_path = _resolve_sim_db_path(strategy_name, gateway_name)
    if db_path is None:
        return None, (
            f"sim db 不可达 (root={settings.vnpy_sim_db_root}, gateway={gateway_name}). "
            "检查 mlearnweb 与 vnpy 是否同机 + VNPY_SIM_DB_ROOT 配置"
        )

    # 1. 加载 daily_merged_all_new.parquet 拿 (ts, date) → pct_chg / close
    merged_path = Path(settings.daily_merged_all_path)
    if not merged_path.exists():
        return None, f"daily_merged_all_new.parquet 不存在: {merged_path}"
    try:
        merged = pd.read_parquet(merged_path)
        merged["trade_date"] = pd.to_datetime(merged["trade_date"])
    except Exception as e:
        return None, f"读 daily_merged 失败: {e}"
    pct_lookup: Dict[Tuple[str, pd.Timestamp], float] = (
        merged.set_index(["ts_code", "trade_date"])["pct_chg"].to_dict()
    )

    # 2. 读 sim_trades (按 strategy reference 过滤 — 当前 sim db 单 account 单策略,
    # 不严格过滤; 多策略沙盒下可加 reference LIKE '<strategy_name>:%')
    try:
        conn = sqlite3.connect(str(db_path))
        cur = conn.cursor()
        cur.execute(
            "SELECT vt_symbol, direction, volume, price, datetime, reference "
            "FROM sim_trades ORDER BY datetime ASC"
        )
        rows = cur.fetchall()
        conn.close()
    except Exception as e:
        return None, f"读 sim db 失败: {e}"

    # 仅取属于本 strategy 的 trade (reference 含 strategy_name)
    by_day: Dict[date, List[Tuple[str, str, float, float]]] = defaultdict(list)
    for vt, direction, volume, price, dt_str, reference in rows:
        if reference and strategy_name and not str(reference).startswith(f"{strategy_name}:"):
            continue
        try:
            dt = datetime.fromisoformat(dt_str) if isinstance(dt_str, str) else dt_str
        except Exception:
            continue
        d = dt.date() if hasattr(dt, "date") else dt
        if d > target_d:
            break  # 排序的, 后面不用看了
        by_day[d].append((vt, direction, float(volume), float(price)))

    # 3. 逐日重放: trade 累计 + EOD settle (cost *= 1 + pct_chg/100)
    pos: Dict[str, Dict[str, float]] = {}
    for d in sorted(by_day):
        for vt, direction, vol, price in by_day[d]:
            if direction in ("LONG", "多", "Direction.LONG"):
                old = pos.get(vt, {"vol": 0.0, "cost": 0.0})
                new_v = old["vol"] + vol
                pos[vt] = {
                    "vol": new_v,
                    "cost": (old["vol"] * old["cost"] + vol * price) / new_v if new_v > 0 else 0,
                }
            else:
                old_v = pos.get(vt, {"vol": 0.0})["vol"]
                if old_v > 0:
                    pos[vt]["vol"] = old_v - vol
                    if pos[vt]["vol"] <= 0:
                        del pos[vt]
        # settle: cost *= (1 + pct_chg/100)
        for vt in list(pos.keys()):
            ts = _vt_to_ts(vt)
            pct = pct_lookup.get((ts, pd.Timestamp(d)))
            if pct is not None and pd.notna(pct):
                pos[vt]["cost"] *= (1.0 + float(pct) / 100.0)

    # 4. 输出 + weight
    name_map = get_stock_name_map()
    holdings = [(vt, p) for vt, p in pos.items() if p["vol"] > 0]
    total_mv = sum(p["vol"] * p["cost"] for _, p in holdings)
    out: List[Dict[str, Any]] = []
    for vt, p in holdings:
        mv = p["vol"] * p["cost"]
        out.append({
            "vt_symbol": vt,
            "name": _resolve_stock_name(vt, name_map),
            "volume": p["vol"],
            "cost_price": round(p["cost"], 4),
            "market_value": round(mv, 2),
            "weight": (mv / total_mv) if total_mv > 0 else 0.0,
        })
    out.sort(key=lambda r: r["market_value"], reverse=True)
    return out, None
