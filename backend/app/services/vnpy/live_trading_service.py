"""Business logic for the live-trading module.

Responsibilities:
  * Merge fanout reads (strategies/accounts/positions) from VnpyMultiNodeClient
    into StrategySummary / StrategyDetail rows.
  * Resolve per-strategy equity value via three-tier fallback:
      A. strategy.variables contains a PnL field → use directly
      B. strategy has a non-empty vt_symbol → sum matching position pnls
      C. otherwise → use the strategy's gateway account balance
  * Read/write the StrategyEquitySnapshot table for historical curves.
  * Drive the background snapshot_loop (owned by app.live_main lifespan).
  * Expose write helpers that simply forward to VnpyMultiNodeClient.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import delete as sa_delete
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.database import StrategyEquitySnapshot, engine as db_engine
from app.models.ml_monitoring import MLMetricSnapshot
from app.services.ml_aggregation_service import get_stock_name_map


def _vt_symbol_to_ts_code(vt: str) -> Optional[str]:
    """vt_symbol (000001.SZSE) → tushare ts_code (000001.SZ)。与 corp_actions_service 同源。"""
    if not vt or "." not in vt:
        return None
    sym, ex = vt.rsplit(".", 1)
    suffix = {"SSE": "SH", "SZSE": "SZ", "BSE": "BJ"}.get(ex.upper())
    if suffix is None:
        return None
    return f"{sym}.{suffix}"


def _resolve_stock_name(vt_symbol: str, name_map: Dict[str, str]) -> str:
    """vt_symbol → 中文简称；查不到返空字符串（前端 fallback 显示 ts_code）。"""
    ts = _vt_symbol_to_ts_code(vt_symbol)
    if ts is None:
        return ""
    return name_map.get(ts, "")
from app.services.vnpy.client import VnpyClientError, get_vnpy_client
from app.services.vnpy.naming import classify_gateway

logger = logging.getLogger(__name__)

# variables keys that commonly contain strategy-level PnL
_PNL_VARIABLE_KEYS = ("total_pnl", "net_pnl", "strategy_pnl", "pnl")


# ---------------------------------------------------------------------------
# Strategy mode (live vs sim) inference
# ---------------------------------------------------------------------------


def _infer_strategy_mode(strategy_dict: Dict[str, Any], node_mode: str) -> Tuple[str, str]:
    """根据策略 parameters.gateway + 节点 mode 推断策略 mode。

    返回 ``(mode, gateway_name)``，其中 ``mode`` ∈ {"live", "sim"}。

    判定规则（优先级递减）：
      1. 策略 ``parameters.gateway`` 以 ``"QMT_SIM"`` 开头 → ``"sim"``（强制覆盖节点默认）
      2. 策略 ``parameters.gateway`` 等于 ``"QMT"`` → ``"live"``（强制覆盖）
      3. 否则（``parameters.gateway`` 缺失或非标准命名）→ fallback 到 ``node_mode``

    详见 vnpy_common/naming.py 模块 docstring 的命名约定章节。
    Lenient 行为：分类为 unknown 时不抛异常，仅 fallback；调用方决定要不要 log warn。

    示例
    ----
    >>> _infer_strategy_mode({"parameters": {"gateway": "QMT_SIM_csi300"}}, "live")
    ('sim', 'QMT_SIM_csi300')
    >>> _infer_strategy_mode({"parameters": {"gateway": "QMT"}}, "sim")
    ('live', 'QMT')
    >>> _infer_strategy_mode({"parameters": {}}, "sim")
    ('sim', '')
    >>> _infer_strategy_mode({"parameters": {"gateway": "weird"}}, "live")
    ('live', 'weird')
    """
    params = strategy_dict.get("parameters") or {}
    gw = params.get("gateway", "") or ""
    if not isinstance(gw, str):
        gw = str(gw) if gw else ""

    cls = classify_gateway(gw)
    if cls in ("sim", "live"):
        return cls, gw
    return node_mode, gw


# ---------------------------------------------------------------------------
# PnL resolution
# ---------------------------------------------------------------------------


def _find_pnl_in_variables(variables: Dict[str, Any]) -> Optional[float]:
    if not isinstance(variables, dict):
        return None
    for key in _PNL_VARIABLE_KEYS:
        if key in variables:
            try:
                return float(variables[key])
            except (TypeError, ValueError):
                continue
    return None


def _sum_position_pnl(vt_symbol: Optional[str], positions: List[Dict[str, Any]]) -> Optional[float]:
    if not vt_symbol:
        return None
    total = 0.0
    hit = False
    for p in positions or []:
        if str(p.get("vt_symbol", "")) == vt_symbol:
            try:
                total += float(p.get("pnl") or 0)
                hit = True
            except (TypeError, ValueError):
                continue
    return total if hit else None


def _first_account_equity(accounts: List[Dict[str, Any]]) -> Optional[float]:
    """Pick the first account's balance as a coarse equity proxy.

    Multi-strategy shared-account attribution is not solvable from vnpy's
    snapshot model; this is Source C in the fallback chain and will be
    labelled as such in the UI.
    """
    if not accounts:
        return None
    for acc in accounts:
        bal = acc.get("balance")
        if bal is not None:
            try:
                return float(bal)
            except (TypeError, ValueError):
                continue
    return None


def _total_account_equity(
    accounts: List[Dict[str, Any]],
    positions: List[Dict[str, Any]],
    gateway_name: Optional[str] = None,
) -> Optional[float]:
    """计算账户**总权益** = 现金 + 持仓市值（用 cost_price + pnl 反推 current_price）。

    旧实现 _first_account_equity 只取 account.balance（cash 余额），买入后大幅下跌
    但实际有持仓市值未反映 → 权益曲线显示从 1M 跌到 149k 是误导。

    新实现对齐"组合总价值"语义：
        total = cash + sum_over_positions(volume × cost_price + pnl)
              = cash + sum_over_positions(volume × current_price)

    若提供 gateway_name，按 gateway 过滤账户和持仓（多 gateway 沙盒隔离）。
    """
    if not accounts and not positions:
        return None

    # 1. 累加 cash (按 gateway 过滤)
    cash = 0.0
    cash_hit = False
    for acc in accounts or []:
        if gateway_name and str(acc.get("gateway_name", "")) != gateway_name:
            continue
        bal = acc.get("balance")
        if bal is None:
            continue
        try:
            cash += float(bal)
            cash_hit = True
        except (TypeError, ValueError):
            continue

    # 2. 累加持仓市值（仅 volume > 0 的持仓；vnpy OMS 会保留 volume=0 的已平仓位）
    market_value = 0.0
    pos_hit = False
    for p in positions or []:
        if gateway_name and str(p.get("gateway_name", "")) != gateway_name:
            continue
        try:
            volume = float(p.get("volume") or 0)
            if volume <= 0:
                continue
            cost_price = float(p.get("price") or 0)
            pnl = float(p.get("pnl") or 0)
            market_value += volume * cost_price + pnl
            pos_hit = True
        except (TypeError, ValueError):
            continue

    if not cash_hit and not pos_hit:
        return None
    return cash + market_value


def _count_positions(vt_symbol: Optional[str], positions: List[Dict[str, Any]]) -> int:
    if not positions:
        return 0
    if vt_symbol:
        return sum(1 for p in positions if str(p.get("vt_symbol", "")) == vt_symbol)
    return len(positions)


def _resolve_strategy_value(
    strategy: Dict[str, Any],
    positions: List[Dict[str, Any]],
    accounts: List[Dict[str, Any]],
    gateway_name: Optional[str] = None,
) -> Tuple[Optional[float], str, Optional[float]]:
    """Return (strategy_value, source_label, account_equity).

    account_equity is**总权益**= cash + sum(volume × cost_price + pnl)（按 gateway 过滤），
    含持仓市值。旧实现只取 account.balance（cash），买入后大跌但持仓未计 → 曲线失真。

    gateway_name : 若提供，按 gateway 过滤 accounts/positions（多 gateway 沙盒）。
    """
    account_equity = _total_account_equity(accounts, positions, gateway_name=gateway_name)
    variables = strategy.get("variables") or {}

    # Source A
    pnl = _find_pnl_in_variables(variables)
    if pnl is not None:
        return pnl, "strategy_pnl", account_equity

    # Source B
    vt_symbol = strategy.get("vt_symbol")
    pos_sum = _sum_position_pnl(vt_symbol, positions)
    if pos_sum is not None:
        return pos_sum, "position_sum_pnl", account_equity

    # Source C
    if account_equity is not None:
        return account_equity, "account_equity", account_equity

    return None, "unavailable", None


# ---------------------------------------------------------------------------
# Fanout merging
# ---------------------------------------------------------------------------


def _group_by_node(fanout: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    """Turn FanoutItem[] into {node_id: data_list}, skipping failed nodes."""
    out: Dict[str, List[Dict[str, Any]]] = {}
    for item in fanout:
        if not item.get("ok"):
            continue
        out[item["node_id"]] = item.get("data") or []
    return out


def _first_warning(*fanouts: List[Dict[str, Any]]) -> Optional[str]:
    for fanout in fanouts:
        for item in fanout:
            if not item.get("ok") and item.get("error"):
                return f"节点 {item['node_id']}: {item['error']}"
    return None


async def _fetch_capabilities_per_node(client, node_ids: List[str]) -> Dict[str, Dict[str, List[str]]]:
    """Return {node_id: {engine_name: capabilities}}. Failures → empty dict.

    Used to annotate StrategySummary with the set of allowed write operations
    so the frontend can hide buttons the engine does not support.
    """
    async def _one(nid: str) -> Tuple[str, Dict[str, List[str]]]:
        try:
            engines = await client.get_engines(nid)
            return nid, {
                str(e.get("app_name", "")): list(e.get("capabilities", []) or [])
                for e in engines or []
            }
        except Exception as e:
            logger.warning("[live_trading] get_engines node=%s failed: %s", nid, e)
            return nid, {}

    pairs = await asyncio.gather(*(_one(nid) for nid in node_ids))
    return dict(pairs)


# ---------------------------------------------------------------------------
# Snapshot reads
# ---------------------------------------------------------------------------


def _read_curve(
    db: Session,
    node_id: str,
    engine: str,
    strategy_name: str,
    limit: Optional[int] = None,
    since: Optional[datetime] = None,
) -> List[Dict[str, Any]]:
    q = (
        db.query(StrategyEquitySnapshot)
        .filter(
            StrategyEquitySnapshot.node_id == node_id,
            StrategyEquitySnapshot.engine == engine,
            StrategyEquitySnapshot.strategy_name == strategy_name,
        )
        .order_by(StrategyEquitySnapshot.ts.desc())
    )
    if since is not None:
        q = q.filter(StrategyEquitySnapshot.ts >= since)
    if limit is not None:
        q = q.limit(limit)
    rows = list(q)
    rows.reverse()  # chronological
    return [
        {
            "ts": int(r.ts.timestamp() * 1000),
            "strategy_value": r.strategy_value,
            "account_equity": r.account_equity,
            "source_label": r.source_label,
        }
        for r in rows
    ]


# ---------------------------------------------------------------------------
# List / detail endpoints
# ---------------------------------------------------------------------------


async def list_strategy_summaries(db: Session) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    client = get_vnpy_client()
    if not client.node_ids:
        # 无 vnpy 节点配置：从 db 历史快照查曾跑过的策略 → 离线展示
        # 避免 mlearnweb 启动时 yaml 缺失 / 用户删了 yaml 后丢失全部历史视图
        offline: List[Dict[str, Any]] = []
        all_node_ids = (
            db.query(StrategyEquitySnapshot.node_id)
            .distinct()
            .all()
        )
        for (node_id,) in all_node_ids:
            offline.extend(_list_offline_strategies_for_node(
                db, node_id, "未配置 vnpy 节点（请检查 vnpy_nodes.yaml）"
            ))
        if offline:
            return offline, "未配置 vnpy 节点，展示历史快照（请检查 vnpy_nodes.yaml）"
        return [], "未配置 vnpy 节点，请检查 vnpy_nodes.yaml"

    try:
        strategies_fo, accounts_fo, positions_fo = await asyncio.gather(
            client.get_strategies(),
            client.get_accounts(),
            client.get_positions(),
        )
    except VnpyClientError as e:
        # 全部节点不可达：从 db 历史快照查曾经存在过的策略，离线展示
        offline_summaries: List[Dict[str, Any]] = []
        for nid in client.node_ids:
            offline_summaries.extend(
                _list_offline_strategies_for_node(db, nid, f"vnpy 接口不可达: {e}")
            )
        if offline_summaries:
            return offline_summaries, "节点全部离线，展示历史快照"
        return [], f"vnpy 接口不可达: {e}"
    except Exception as e:
        logger.exception("[live_trading] unexpected error in list_strategy_summaries: %s", e)
        return [], f"未知错误: {e}"

    warning = _first_warning(strategies_fo, accounts_fo, positions_fo)

    accounts_by_node = _group_by_node(accounts_fo)
    positions_by_node = _group_by_node(positions_fo)
    capabilities = await _fetch_capabilities_per_node(client, client.node_ids)
    # 测试用 FakeVnpyClient 可能没有 nodes 属性，兜底为空
    node_modes = {n.node_id: getattr(n, "mode", "sim") for n in getattr(client, "nodes", [])}

    summaries: List[Dict[str, Any]] = []
    now_ms = int(time.time() * 1000)

    # 收集 fanout 中失败的节点 → 这些节点的策略走离线 fallback
    failed_nodes_with_reason: Dict[str, str] = {}
    for item in strategies_fo:
        if not item.get("ok"):
            failed_nodes_with_reason[item["node_id"]] = (
                f"vnpy 接口不可达: {item.get('error', '未知错误')}"
            )

    for item in strategies_fo:
        if not item.get("ok"):
            continue
        node_id = item["node_id"]
        node_accounts = accounts_by_node.get(node_id, [])
        node_positions = positions_by_node.get(node_id, [])
        node_mode = node_modes.get(node_id, "sim")
        for s in item.get("data") or []:
            engine_name = s.get("engine", "")
            name = s.get("name", "")
            mode, gateway_name = _infer_strategy_mode(s, node_mode)
            value, label, acct_eq = _resolve_strategy_value(
                s, node_positions, node_accounts, gateway_name=gateway_name or None,
            )
            curve = _read_curve(db, node_id, engine_name, name, limit=60)
            inited = bool(s.get("inited"))
            trading = bool(s.get("trading"))
            summaries.append({
                "node_id": node_id,
                "engine": engine_name,
                "strategy_name": name,
                "class_name": s.get("class_name"),
                "vt_symbol": s.get("vt_symbol"),
                "author": s.get("author"),
                "inited": inited,
                "trading": trading,
                "running": inited and trading,
                "strategy_value": value,
                "source_label": label,
                "account_equity": acct_eq,
                "positions_count": (
                    _count_positions(s.get("vt_symbol"), node_positions)
                    if s.get("vt_symbol")
                    else sum(
                        1 for p in node_positions
                        if (not gateway_name or str(p.get("gateway_name", "")) == gateway_name)
                        and float(p.get("volume") or 0) > 0
                    )
                ),
                "last_update_ts": now_ms,
                "mini_curve": curve,
                "capabilities": capabilities.get(node_id, {}).get(engine_name, []),
                "mode": mode,
                "gateway_name": gateway_name,
            })

    # 离线节点的策略：从 db 历史快照拼出 summary
    for failed_node_id, reason in failed_nodes_with_reason.items():
        offline_rows = _list_offline_strategies_for_node(db, failed_node_id, reason)
        summaries.extend(offline_rows)

    # **历史曾在线但当前 fanout 没返回**的策略也补进来（即使节点本身是 ok）
    # 场景：
    #   - 用户曾在 vnpy 节点上跑过 strategyA，停掉/移除了，但 mlearnweb.db 里仍有
    #     历史快照
    #   - 列表页应展示所有"曾经存在过"的策略，方便用户查历史/删记录
    online_keys = {(s["node_id"], s["engine"], s["strategy_name"]) for s in summaries}
    db_strategies = (
        db.query(
            StrategyEquitySnapshot.node_id,
            StrategyEquitySnapshot.engine,
            StrategyEquitySnapshot.strategy_name,
        )
        .distinct()
        .all()
    )
    for (node_id, engine_name, strategy_name) in db_strategies:
        if (node_id, engine_name, strategy_name) in online_keys:
            continue
        # 复用 _list_offline_strategies_for_node 单条拼装逻辑：取 last 行
        last = (
            db.query(StrategyEquitySnapshot)
            .filter(
                StrategyEquitySnapshot.node_id == node_id,
                StrategyEquitySnapshot.engine == engine_name,
                StrategyEquitySnapshot.strategy_name == strategy_name,
            )
            .order_by(StrategyEquitySnapshot.ts.desc())
            .first()
        )
        if last is None:
            continue
        curve = _read_curve(db, node_id, engine_name, strategy_name, limit=60)
        summaries.append({
            "node_id": node_id,
            "engine": engine_name,
            "strategy_name": strategy_name,
            "class_name": None, "vt_symbol": None, "author": None,
            "inited": False, "trading": False, "running": False,
            "strategy_value": last.strategy_value,
            "source_label": last.source_label or "unavailable",
            "account_equity": last.account_equity,
            "positions_count": int(last.positions_count or 0),
            "last_update_ts": int(last.ts.timestamp() * 1000),
            "mini_curve": curve,
            "capabilities": [],
            "mode": None,
            "gateway_name": None,
            "node_offline": True,
            "offline_reason": "策略当前未在节点上运行（仅展示历史）",
        })

    return summaries, warning


def _list_offline_strategies_for_node(
    db: Session, node_id: str, offline_reason: str,
) -> List[Dict[str, Any]]:
    """节点 fanout 失败时，从 mlearnweb.db 历史快照查曾在该节点跑过的策略。

    每条策略拼成离线版 summary（带 node_offline=true），让用户在列表页仍能看到，
    并通过策略卡片进入详情查历史 / 删除记录。
    """
    rows = (
        db.query(
            StrategyEquitySnapshot.engine,
            StrategyEquitySnapshot.strategy_name,
        )
        .filter(StrategyEquitySnapshot.node_id == node_id)
        .distinct()
        .all()
    )
    out: List[Dict[str, Any]] = []
    for engine_name, strategy_name in rows:
        last = (
            db.query(StrategyEquitySnapshot)
            .filter(
                StrategyEquitySnapshot.node_id == node_id,
                StrategyEquitySnapshot.engine == engine_name,
                StrategyEquitySnapshot.strategy_name == strategy_name,
            )
            .order_by(StrategyEquitySnapshot.ts.desc())
            .first()
        )
        if last is None:
            continue
        curve = _read_curve(db, node_id, engine_name, strategy_name, limit=60)
        out.append({
            "node_id": node_id,
            "engine": engine_name,
            "strategy_name": strategy_name,
            "class_name": None,
            "vt_symbol": None,
            "author": None,
            "inited": False,
            "trading": False,
            "running": False,
            "strategy_value": last.strategy_value,
            "source_label": last.source_label or "unavailable",
            "account_equity": last.account_equity,
            "positions_count": int(last.positions_count or 0),
            "last_update_ts": int(last.ts.timestamp() * 1000),
            "mini_curve": curve,
            "capabilities": [],
            "mode": None,
            "gateway_name": None,
            "node_offline": True,
            "offline_reason": offline_reason,
        })
    return out


def _offline_detail_from_history(
    db: Session,
    node_id: str,
    engine: str,
    strategy_name: str,
    window_days: int,
    offline_reason: str,
) -> Optional[Dict[str, Any]]:
    """节点离线 / 策略已停运时，从 mlearnweb.db 历史快照拼出 detail 视图。

    用途：让前端策略详情页**离线时仍展示历史权益曲线**（而不是空白），
    用户可以看历史回放结果 + 决定是否清理记录。
    """
    since = datetime.now() - timedelta(days=window_days)
    full_curve = _read_curve(db, node_id, engine, strategy_name, since=since)
    if not full_curve:
        return None  # 历史也没有 → 真的什么都没有，让上游报错

    last = full_curve[-1]
    return {
        "node_id": node_id,
        "engine": engine,
        "strategy_name": strategy_name,
        "class_name": None,
        "vt_symbol": None,
        "author": None,
        "inited": False,
        "trading": False,
        "running": False,
        "strategy_value": last.get("strategy_value"),
        "source_label": last.get("source_label") or "unavailable",
        "account_equity": last.get("account_equity"),
        "positions_count": 0,
        "last_update_ts": last.get("ts"),
        "mini_curve": [],
        "capabilities": [],
        "parameters": {},
        "variables": {},
        "curve": full_curve,
        "mode": None,
        "gateway_name": None,
        "positions": [],
        # 标记给前端的离线提示（前端按此显示 "节点离线" 角标）
        "node_offline": True,
        "offline_reason": offline_reason,
    }


async def get_strategy_detail(
    db: Session,
    node_id: str,
    engine: str,
    strategy_name: str,
    window_days: int = 7,
) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    client = get_vnpy_client()
    if node_id not in client.node_ids:
        # 未知节点（vnpy_nodes.yaml 没配过）— 仍尝试从历史快照拼出离线视图
        offline = _offline_detail_from_history(
            db, node_id, engine, strategy_name, window_days,
            offline_reason="未知节点（已从 vnpy_nodes.yaml 移除？）",
        )
        if offline is not None:
            return offline, "节点离线，展示历史快照"
        return None, f"未知节点: {node_id}"

    try:
        strategies_fo, accounts_fo, positions_fo = await asyncio.gather(
            client.get_strategies(),
            client.get_accounts(),
            client.get_positions(),
        )
    except VnpyClientError as e:
        offline = _offline_detail_from_history(
            db, node_id, engine, strategy_name, window_days,
            offline_reason=f"vnpy 接口不可达: {e}",
        )
        if offline is not None:
            return offline, "节点离线，展示历史快照"
        return None, f"vnpy 接口不可达: {e}"
    except Exception as e:
        logger.exception("[live_trading] detail fetch failed: %s", e)
        return None, f"未知错误: {e}"

    warning = _first_warning(strategies_fo, accounts_fo, positions_fo)

    accounts_by_node = _group_by_node(accounts_fo)
    positions_by_node = _group_by_node(positions_fo)

    strategy: Optional[Dict[str, Any]] = None
    for item in strategies_fo:
        if item.get("ok") and item["node_id"] == node_id:
            for s in item.get("data") or []:
                if s.get("engine") == engine and s.get("name") == strategy_name:
                    strategy = s
                    break
    if strategy is None:
        # 节点本身可达但本策略已不在（停运 / 移除）— fallback 到历史
        offline = _offline_detail_from_history(
            db, node_id, engine, strategy_name, window_days,
            offline_reason="策略当前未运行（节点上找不到）",
        )
        if offline is not None:
            return offline, "策略已停运，展示历史快照"
        return None, warning or f"策略 {node_id}/{engine}/{strategy_name} 不存在"

    node_positions = positions_by_node.get(node_id, [])
    node_accounts = accounts_by_node.get(node_id, [])
    node_mode = next((getattr(n, "mode", "sim") for n in getattr(client, "nodes", []) if n.node_id == node_id), "sim")
    mode, gateway_name = _infer_strategy_mode(strategy, node_mode)
    value, label, acct_eq = _resolve_strategy_value(
        strategy, node_positions, node_accounts, gateway_name=gateway_name or None,
    )

    # filter positions to just this strategy's if it has a vt_symbol
    vt_symbol = strategy.get("vt_symbol")
    if vt_symbol:
        positions = [p for p in node_positions if str(p.get("vt_symbol", "")) == vt_symbol]
    else:
        # 多 symbol 策略：按 gateway_name 过滤（多 gateway 沙盒隔离）
        if gateway_name:
            positions = [p for p in node_positions if str(p.get("gateway_name", "")) == gateway_name]
        else:
            positions = list(node_positions)

    # capabilities (single node → single engine lookup)
    try:
        engines = await client.get_engines(node_id)
    except Exception:
        engines = []
    caps: List[str] = []
    for e in engines or []:
        if str(e.get("app_name", "")) == engine:
            caps = list(e.get("capabilities", []) or [])
            break

    since = datetime.now() - timedelta(days=window_days)
    full_curve = _read_curve(db, node_id, engine, strategy_name, since=since)

    inited = bool(strategy.get("inited"))
    trading = bool(strategy.get("trading"))
    detail = {
        "node_id": node_id,
        "engine": engine,
        "strategy_name": strategy_name,
        "class_name": strategy.get("class_name"),
        "vt_symbol": vt_symbol,
        "author": strategy.get("author"),
        "inited": inited,
        "trading": trading,
        "running": inited and trading,
        "strategy_value": value,
        "source_label": label,
        "account_equity": acct_eq,
        "positions_count": len(positions),
        "last_update_ts": int(time.time() * 1000),
        "mini_curve": [],
        "capabilities": caps,
        "parameters": strategy.get("parameters") or {},
        "variables": strategy.get("variables") or {},
        "curve": full_curve,
        "mode": mode,
        "gateway_name": gateway_name,
        "positions": _render_positions(positions),
    }
    return detail, warning


def _render_positions(positions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """渲染 positions 列表，自动 enrich 股票中文简称。"""
    name_map = get_stock_name_map()
    return [
        {
            "vt_symbol": p.get("vt_symbol", ""),
            "name": _resolve_stock_name(p.get("vt_symbol", ""), name_map),
            "direction": str(p.get("direction", "")),
            "volume": float(p.get("volume") or 0),
            "price": p.get("price"),
            "pnl": p.get("pnl"),
            "yd_volume": p.get("yd_volume"),
            "frozen": p.get("frozen"),
        }
        for p in positions
    ]


async def list_node_statuses() -> List[Dict[str, Any]]:
    client = get_vnpy_client()
    return await client.probe_nodes()


def delete_strategy_records(
    db: Session,
    node_id: str,
    engine: str,
    strategy_name: str,
) -> Dict[str, int]:
    """删除指定策略在 mlearnweb 端积累的所有记录。

    清理的表：
      - strategy_equity_snapshots: 权益曲线快照
      - ml_metric_snapshots: ML 监控指标快照（IC/PSI/直方图等）

    不动 vnpy 侧（vnpy_qmt_sim 持仓 / 账户 / sim_*.db）— 那由 reset_sim_state.py 管。
    不动训练记录（training_records 等）— 与策略运行无关。

    返回各表删除行数 dict（前端展示）。
    """
    n_equity = (
        db.query(StrategyEquitySnapshot)
        .filter(
            StrategyEquitySnapshot.node_id == node_id,
            StrategyEquitySnapshot.engine == engine,
            StrategyEquitySnapshot.strategy_name == strategy_name,
        )
        .delete(synchronize_session=False)
    )
    # ml_metric_snapshots 没有 engine 字段，按 node_id + strategy_name 过滤即可
    try:
        n_ml = (
            db.query(MLMetricSnapshot)
            .filter(
                MLMetricSnapshot.node_id == node_id,
                MLMetricSnapshot.strategy_name == strategy_name,
            )
            .delete(synchronize_session=False)
        )
    except Exception as exc:
        logger.warning("[delete_strategy_records] ml_metric_snapshots 删除失败: %s", exc)
        n_ml = 0
    db.commit()
    return {"equity_snapshots": n_equity, "ml_metric_snapshots": n_ml}


async def list_strategy_trades(
    node_id: str,
    engine: str,
    strategy_name: str,
) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    """拉取指定策略的历史成交，按日期倒序返回。

    数据源：vnpy_webtrader ``/api/v1/trade`` + ``/api/v1/order``（当前会话内）。

    过滤思路：vnpy ``TradeData`` **不带 reference 字段**（dataclass 无此 field），
    但 ``OrderData`` 有 reference 且 vnpy_qmt_sim 在 send_order 写入
    ``{strategy_name}:{seq}`` 格式。所以同时拉 orders + trades，按 orderid 关联，
    再用 order.reference 过滤本策略成交。
    """
    client = get_vnpy_client()
    if node_id not in client.node_ids:
        return [], f"未知节点: {node_id}"

    try:
        trades_fo, orders_fo = await asyncio.gather(
            client.get_trades(),
            client.get_orders(),
        )
    except Exception as e:
        logger.warning("[live_trading] list_strategy_trades fetch failed: %s", e)
        return [], f"拉取 trades/orders 失败: {e}"

    # 构造 orderid → reference map（节点本地视图）
    orderid_ref: Dict[str, str] = {}
    warning: Optional[str] = None
    for item in orders_fo:
        if item.get("node_id") != node_id:
            continue
        if not item.get("ok"):
            warning = f"节点 {node_id} orders: {item.get('error')}"
            break
        for o in item.get("data") or []:
            oid = str(o.get("orderid") or "")
            ref = str(o.get("reference") or "")
            if oid:
                orderid_ref[oid] = ref

    rows: List[Dict[str, Any]] = []
    prefix = f"{strategy_name}:"
    name_map = get_stock_name_map()
    for item in trades_fo:
        if item.get("node_id") != node_id:
            continue
        if not item.get("ok"):
            warning = warning or f"节点 {node_id} trades: {item.get('error')}"
            break
        for t in item.get("data") or []:
            oid = str(t.get("orderid") or "")
            ref = orderid_ref.get(oid, "")
            if not ref.startswith(prefix):
                continue
            vt = t.get("vt_symbol") or ""
            rows.append({
                "vt_symbol": vt,
                "name": _resolve_stock_name(vt, name_map),
                "tradeid": t.get("tradeid") or "",
                "orderid": oid,
                "direction": t.get("direction") or "",
                "offset": t.get("offset") or "",
                "price": float(t.get("price") or 0),
                "volume": float(t.get("volume") or 0),
                "datetime": t.get("datetime") or "",
                "reference": ref,
            })

    # 按 datetime 倒序，最新在前
    rows.sort(key=lambda r: str(r["datetime"]), reverse=True)
    return rows, warning


# ---------------------------------------------------------------------------
# Snapshot writer (background loop)
# ---------------------------------------------------------------------------


async def snapshot_tick() -> None:
    """One iteration of the background snapshot loop.

    Creates its own short-lived SQLAlchemy session so it does not share any
    state with request handlers.
    """
    from sqlalchemy.orm import sessionmaker

    client = get_vnpy_client()
    if not client.node_ids:
        return
    try:
        strategies_fo, accounts_fo, positions_fo = await asyncio.gather(
            client.get_strategies(),
            client.get_accounts(),
            client.get_positions(),
        )
    except Exception as e:
        logger.warning("[live_trading] snapshot_tick fetch failed: %s", e)
        return

    accounts_by_node = _group_by_node(accounts_fo)
    positions_by_node = _group_by_node(positions_fo)
    node_modes = {n.node_id: getattr(n, "mode", "sim") for n in getattr(client, "nodes", [])}

    now = datetime.now()
    SessionLocal = sessionmaker(bind=db_engine, autocommit=False, autoflush=False)
    session = SessionLocal()
    try:
        written = 0
        for item in strategies_fo:
            if not item.get("ok"):
                continue
            node_id = item["node_id"]
            node_mode = node_modes.get(node_id, "sim")
            for s in item.get("data") or []:
                # only record while strategy is active (either inited or trading)
                if not (s.get("inited") or s.get("trading")):
                    continue
                engine_name = s.get("engine", "")
                name = s.get("name", "")
                _, gateway_name = _infer_strategy_mode(s, node_mode)
                node_pos = positions_by_node.get(node_id, [])
                value, label, acct_eq = _resolve_strategy_value(
                    s,
                    node_pos,
                    accounts_by_node.get(node_id, []),
                    gateway_name=gateway_name or None,
                )
                # 持仓数：过滤 volume=0 + 按 gateway（避免多 gateway 时计入别家持仓）
                if s.get("vt_symbol"):
                    pos_count = _count_positions(s.get("vt_symbol"), node_pos)
                else:
                    pos_count = sum(
                        1 for p in node_pos
                        if (not gateway_name or str(p.get("gateway_name", "")) == gateway_name)
                        and float(p.get("volume") or 0) > 0
                    )
                row = StrategyEquitySnapshot(
                    node_id=node_id,
                    engine=engine_name,
                    strategy_name=name,
                    ts=now,
                    strategy_value=value,
                    source_label=label,
                    account_equity=acct_eq,
                    positions_count=pos_count,
                    raw_variables_json=json.dumps(s.get("variables") or {}, ensure_ascii=False),
                )
                session.add(row)
                written += 1

        # retention cleanup
        from app.services.app_settings_service import get_runtime_setting
        retention_days = int(
            get_runtime_setting(
                "vnpy_snapshot_retention_days",
                default=settings.vnpy_snapshot_retention_days,
            )
        )
        cutoff = now - timedelta(days=retention_days)
        session.execute(
            sa_delete(StrategyEquitySnapshot).where(StrategyEquitySnapshot.ts < cutoff)
        )
        session.commit()
        if written:
            logger.debug("[live_trading] snapshot_tick wrote %d rows", written)
    except Exception as e:
        logger.exception("[live_trading] snapshot_tick write failed: %s", e)
        session.rollback()
    finally:
        session.close()


async def snapshot_loop() -> None:
    from app.services.app_settings_service import get_runtime_setting
    logger.info(
        "[live_trading] snapshot_loop started (interval=%ss, retention=%sd, hot-reloadable)",
        settings.vnpy_poll_interval_seconds,
        settings.vnpy_snapshot_retention_days,
    )
    while True:
        try:
            await snapshot_tick()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.exception("[live_trading] snapshot_loop iteration failed: %s", e)
        try:
            interval = int(
                get_runtime_setting(
                    "vnpy_poll_interval_seconds",
                    default=settings.vnpy_poll_interval_seconds,
                )
            )
            await asyncio.sleep(max(1, interval))
        except asyncio.CancelledError:
            raise


# ---------------------------------------------------------------------------
# Write operation helpers (thin wrappers around VnpyMultiNodeClient)
# ---------------------------------------------------------------------------


async def create_strategy(node_id: str, engine: str, body: Dict[str, Any]) -> Dict[str, Any]:
    return await get_vnpy_client().create_strategy(node_id, engine, body)


async def init_strategy(node_id: str, engine: str, name: str) -> Dict[str, Any]:
    return await get_vnpy_client().init_strategy(node_id, engine, name)


async def start_strategy(node_id: str, engine: str, name: str) -> Dict[str, Any]:
    return await get_vnpy_client().start_strategy(node_id, engine, name)


async def stop_strategy(node_id: str, engine: str, name: str) -> Dict[str, Any]:
    return await get_vnpy_client().stop_strategy(node_id, engine, name)


async def edit_strategy(node_id: str, engine: str, name: str, setting: Dict[str, Any]) -> Dict[str, Any]:
    return await get_vnpy_client().edit_strategy(node_id, engine, name, setting)


async def delete_strategy(node_id: str, engine: str, name: str) -> Dict[str, Any]:
    return await get_vnpy_client().delete_strategy(node_id, engine, name)
