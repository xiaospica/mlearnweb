"""历史持仓浏览 service — 重建任意日期 EOD 持仓.

跨机部署支持 (优先 RPC, fallback 同机直读):
  1. 优先调 vnpy webtrader endpoint /api/v1/position/history/{strategy}/{yyyymmdd}
     节点端用本地 sim db 重建。这是跨机部署的正确路径。
  2. fallback 同机直读 sim db 文件 (mlearnweb 与 vnpy 同机时的快路径)。

重建算法 (Phase 3.4 简化后):
  1. 按 datetime 升序遍历 sim_trades 累计 (volume, weighted_avg_cost) 到 target_date EOD
  2. 输出 EOD (volume>0) 持仓 + market_value (vol×cost_avg) + weight (持仓内部 sum=1)

历史: Phase 3.4 之前 fallback 还会读 ``daily_merged_all_new.parquet`` 跑
``cost *= (1 + pct_chg_today/100)`` mark-to-market settle, 重建出与 vnpy_qmt_sim
td.py:settle_end_of_day 等价的"含浮盈"成本. 但那条路径让 mlearnweb 跨机
部署时 fallback 完全不可用 (daily_merged_all 在推理机), 而 RPC 主路径已
精确, fallback 只在"同机但 vnpy 进程暂时不响应"的窄场景生效, 用买入加权
均价近似(精度差 ±1-3% 一个月) 完全够用. 删 settle 让 service 摆脱
``daily_merged_all_path`` config 依赖, 配套 Phase 3.5 删 config 字段.
"""
from __future__ import annotations

import logging
import sqlite3
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from app.core.config import settings
from app.services.vnpy.client import get_vnpy_client, VnpyClientError
from app.services.vnpy.live_trading_service import _resolve_stock_name, get_stock_name_map

logger = logging.getLogger(__name__)


async def get_strategy_positions_on_date_via_rpc(
    node_id: str,
    strategy_name: str,
    target_date_str: str,
    gateway_name: Optional[str] = None,
) -> Tuple[Optional[List[Dict[str, Any]]], Optional[str]]:
    """跨机部署优先路径: 通过 vnpy webtrader endpoint 拉历史持仓.

    Returns (positions_list, warning). None list = RPC 失败/不可用,
    上层应回退到同机直读 sim db 路径。

    Bug 修复: 之前的实现把 ``if per_node is None`` 当成了 RPC 主路径分支
    (倒置), 导致正常情况下直接返 "RPC 不支持" 让上层走 fallback. 现在改为
    无条件用 ``get_per_node`` 拿到 _PerNodeClient 后调 RPC, 抛异常归一为
    None + warning.
    """
    client = get_vnpy_client()
    if node_id not in client.node_ids:
        return None, f"未知节点: {node_id}"
    try:
        per_node = client.get_per_node(node_id)
        rows = await per_node.get_strategy_positions_history(
            strategy_name, target_date_str, gateway_name=gateway_name or "",
        )
    except VnpyClientError as e:
        return None, f"RPC 失败: {e}"
    except Exception as e:
        logger.warning(f"[history_positions] RPC err: {e}")
        return None, f"RPC 异常: {e}"

    if rows is None:
        return None, "RPC 返回空 (节点端可能 sim db 不存在)"
    # 节点端目前不做 stock name enrichment, 这里补上中文名
    name_map = get_stock_name_map()
    for r in rows:
        r.setdefault("name", _resolve_stock_name(r.get("vt_symbol", ""), name_map))
    return rows, None


def _resolve_sim_db_path(strategy_name: str, gateway_name: Optional[str]) -> Optional[Path]:
    """sim db 命名约定: sim_<account_id>.db, account_id 默认 == gateway_name.
    传入 gateway_name 优先；若空则尝试用 strategy_name 兜底（不严谨，但 vnpy 默认
    QMT_SIM_<sandbox_id> 形式 gateway 名也包含 strategy 信息）。
    """
    if not settings.vnpy_sim_db_root:
        return None
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

    # 1. 读 sim_trades (按 strategy reference 过滤 — 当前 sim db 单 account 单策略,
    # 不严格过滤; 多策略沙盒下用 reference startswith '<strategy_name>:' 区分).
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

    # 2. 逐日重放: trade 累计 (买入加权均价 / 卖出减仓). 不做 EOD pct_chg
    # mark-to-market — 那条路径要 daily_merged_all parquet 在本机, Phase 3.4
    # 解耦后用买入均价近似 (精度损失 ±1-3% 一个月, fallback 路径接受).
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

    # 3. 输出 + weight
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
