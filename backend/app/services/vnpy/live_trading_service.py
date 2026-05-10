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

import sqlalchemy as sa
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
# Strategy schedule extraction (cron + last-run health)
# ---------------------------------------------------------------------------


_VALID_LAST_STATUS = ("ok", "failed", "empty")


def _infer_strategy_schedule(s: Dict[str, Any]) -> Dict[str, Any]:
    """从 strategy.parameters / variables 提取 cron 调度元数据 + 上次执行健康度。

    所有字段失败统一退到 None（不抛异常），保证主循环健壮——非 ML 策略 / 老版本 vnpy
    没有这些字段时整片调度信息为 None，前端按此判断是否渲染 cron strip。

    源字段（vnpy_ml_strategy/template.py）：
      parameters.trigger_time         → "21:00"  日频推理 + persist 触发时间
      parameters.buy_sell_time        → "09:26"  T+1 复盘下单时间
      parameters.signal_source_strategy → 双轨影子策略指向的上游名
      variables.last_run_date         → "YYYY-MM-DD" 最近一次成功运行的逻辑日
      variables.last_status           → "ok" | "failed" | "empty"
      variables.last_duration_ms      → int
      variables.last_error            → str
      variables.replay_status         → "idle"|"running"|"completed"|"error"|... ；"idle" 归一为 None
    """
    params = s.get("parameters") or {}
    vars_: Dict[str, Any] = s.get("variables") or {}

    def _str_or_none(x: Any) -> Optional[str]:
        if x is None:
            return None
        if isinstance(x, str):
            x = x.strip()
            return x or None
        # 非字符串类型（int/float/dict 之类）一律 str() 后再判
        x = str(x).strip()
        return x or None

    def _int_or_none(x: Any) -> Optional[int]:
        if x is None or x == "":
            return None
        try:
            return int(x)
        except (TypeError, ValueError):
            return None

    status = _str_or_none(vars_.get("last_status"))
    if status not in _VALID_LAST_STATUS:
        status = None  # 大小写漂移 / 未知值统一退到 None

    replay = _str_or_none(vars_.get("replay_status"))
    if replay == "idle":
        replay = None  # 默认值不发给前端，避免渲染无意义 chip

    return {
        "trigger_time": _str_or_none(params.get("trigger_time")),
        "buy_sell_time": _str_or_none(params.get("buy_sell_time")),
        "signal_source_strategy": _str_or_none(params.get("signal_source_strategy")),
        "last_run_date": _str_or_none(vars_.get("last_run_date")),
        "last_status": status,
        "last_duration_ms": _int_or_none(vars_.get("last_duration_ms")),
        "last_error": _str_or_none(vars_.get("last_error")),
        "replay_status": replay,
    }


_SCHEDULE_NULL_DICT: Dict[str, Any] = {
    "trigger_time": None,
    "buy_sell_time": None,
    "signal_source_strategy": None,
    "last_run_date": None,
    "last_status": None,
    "last_duration_ms": None,
    "last_error": None,
    "replay_status": None,
}


def _schedule_from_raw_variables_json(raw_json: Optional[str]) -> Dict[str, Any]:
    """离线 fallback 路径用：从 StrategyEquitySnapshot.raw_variables_json 反序列化复原调度元数据。

    parameters 端的 trigger_time / buy_sell_time 不在 raw_variables_json 里——只能复原
    variables 子集（last_run_date / last_status / last_duration_ms / last_error / replay_status）。
    parameters 字段保持 None。
    """
    if not raw_json:
        return dict(_SCHEDULE_NULL_DICT)
    try:
        vars_ = json.loads(raw_json) or {}
    except (TypeError, ValueError):
        return dict(_SCHEDULE_NULL_DICT)
    if not isinstance(vars_, dict):
        return dict(_SCHEDULE_NULL_DICT)
    sched = _infer_strategy_schedule({"parameters": {}, "variables": vars_})
    return sched


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


async def _single_node_read(client: Any, node_id: str, method_name: str) -> Dict[str, Any]:
    """Read one endpoint from the requested node and return a FanoutItem shape."""
    try:
        per_node = client.get_per_node(node_id)
        data = await getattr(per_node, method_name)()
        return {"node_id": node_id, "ok": True, "data": data or [], "error": None}
    except Exception as e:
        logger.warning(
            "[live_trading] node=%s %s failed in detail read: %s",
            node_id,
            method_name,
            e,
        )
        return {"node_id": node_id, "ok": False, "data": [], "error": str(e)}


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
    dedupe_per_day: bool = True,
) -> List[Dict[str, Any]]:
    """读策略权益曲线。dedupe_per_day=True (默认) 时,按 (DATE(ts), source_label)
    去重保留每日最新一行 — 这样曲线既保留 replay_settle 历史 (1/天) 又把高频
    account_equity 快照 (snapshot_loop ~10s/次) 压成日线。否则原始 limit/since
    截断会让 list mini_curve 全是当日 account_equity 的平直线,看不到回放历史。
    """
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
    rows = list(q)

    if dedupe_per_day:
        seen: set[Tuple[Any, str]] = set()
        kept: List[StrategyEquitySnapshot] = []
        for r in rows:  # 已是 ts desc, 第一次见 (date, source_label) 即最新
            key = (r.ts.date(), r.source_label or "")
            if key in seen:
                continue
            seen.add(key)
            kept.append(r)
        rows = kept

    if limit is not None:
        rows = rows[:limit]
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


def _finite_float(value: Any) -> Optional[float]:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    if v != v or v in (float("inf"), float("-inf")):
        return None
    return v


def _equity_value_from_point(point: Dict[str, Any]) -> Optional[float]:
    """Return the total-equity-like value from an equity curve point.

    ``strategy_value`` may be pure PnL for strategy_pnl / position_sum_pnl
    sources, so performance ratios prefer account_equity unless the snapshot
    source is already a total-equity series.
    """
    label = str(point.get("source_label") or "")
    strategy_value = _finite_float(point.get("strategy_value"))
    account_equity = _finite_float(point.get("account_equity"))
    if label in ("account_equity", "replay_settle"):
        return strategy_value if strategy_value is not None else account_equity
    return account_equity


def _build_equity_series(curve: List[Dict[str, Any]]) -> List[Tuple[int, float]]:
    series: List[Tuple[int, float]] = []
    for point in curve or []:
        value = _equity_value_from_point(point)
        ts = _finite_float(point.get("ts"))
        if value is None or value <= 0 or ts is None:
            continue
        series.append((int(ts), value))
    return series


def _max_drawdown(values: List[float]) -> Optional[float]:
    if not values:
        return None
    peak = values[0]
    max_dd = 0.0
    for value in values:
        if value > peak:
            peak = value
        if peak > 0:
            max_dd = max(max_dd, (peak - value) / peak)
    return max_dd


def _annualized_return(total_return: Optional[float], trading_days: int) -> Optional[float]:
    if total_return is None or trading_days < 2:
        return None
    base = 1.0 + total_return
    if base <= 0:
        return None
    return base ** (252.0 / max(trading_days - 1, 1)) - 1.0


def _extract_available_cash(
    accounts: List[Dict[str, Any]],
    gateway_name: Optional[str],
) -> Optional[float]:
    total = 0.0
    hit = False
    for account in accounts or []:
        if gateway_name and str(account.get("gateway_name", "")) != gateway_name:
            continue
        for key in ("available", "available_cash", "cash", "balance"):
            value = _finite_float(account.get(key))
            if value is None:
                continue
            total += value
            hit = True
            break
    return total if hit else None


async def _read_available_cash(
    node_id: str,
    gateway_name: Optional[str],
) -> Tuple[Optional[float], Optional[str]]:
    client = get_vnpy_client()
    if node_id not in client.node_ids:
        return None, f"unknown node: {node_id}"
    try:
        accounts_fo = await client.get_accounts()
    except Exception as exc:
        return None, f"accounts fetch failed: {exc}"
    accounts_by_node = _group_by_node(accounts_fo)
    cash = _extract_available_cash(accounts_by_node.get(node_id, []), gateway_name)
    if cash is None:
        return None, "available cash is not exposed by the vnpy node"
    return cash, None


def _empty_performance_summary(warnings: Optional[List[str]] = None) -> Dict[str, Any]:
    return {
        "cumulative_return": None,
        "annualized_return": None,
        "total_asset": None,
        "available_cash": None,
        "position_ratio": None,
        "beta": None,
        "max_drawdown": None,
        "start_ts": None,
        "end_ts": None,
        "sample_count": 0,
        "source_label": "unavailable",
        "warnings": warnings or [],
    }


async def get_strategy_performance_summary(
    db: Session,
    node_id: str,
    engine: str,
    strategy_name: str,
    window_days: int = 365,
) -> Tuple[Dict[str, Any], Optional[str]]:
    """Compute the strategy-detail KPI strip from canonical backend data."""
    detail, warning = await get_strategy_detail(
        db, node_id, engine, strategy_name, window_days=window_days,
    )
    warnings: List[str] = []
    if warning:
        warnings.append(warning)
    if detail is None:
        warnings.append("strategy detail is unavailable")
        return _empty_performance_summary(warnings), warning

    curve = detail.get("curve") or []
    series = _build_equity_series(curve)
    values = [value for _, value in series]

    cumulative_return: Optional[float] = None
    annualized: Optional[float] = None
    max_dd = _max_drawdown(values)
    start_ts: Optional[int] = None
    end_ts: Optional[int] = None
    if len(series) >= 2 and values[0] > 0:
        start_ts = series[0][0]
        end_ts = series[-1][0]
        cumulative_return = values[-1] / values[0] - 1.0
        unique_days = {
            datetime.fromtimestamp(ts / 1000).date()
            for ts, _ in series
        }
        annualized = _annualized_return(cumulative_return, len(unique_days))
    elif len(series) == 1:
        start_ts = end_ts = series[0][0]
        warnings.append("equity curve has only one valid point")
    else:
        warnings.append("equity curve has no valid total-equity points")

    latest_curve_value = values[-1] if values else None
    total_asset = _finite_float(detail.get("account_equity")) or latest_curve_value

    positions = detail.get("positions") or []
    position_mv = 0.0
    position_hit = False
    for p in positions:
        if _finite_float(p.get("volume")) is not None and float(p.get("volume") or 0) <= 0:
            continue
        mv = _finite_float(p.get("market_value"))
        if mv is None or mv <= 0:
            continue
        position_mv += mv
        position_hit = True
    position_ratio = (
        position_mv / total_asset
        if position_hit and total_asset is not None and total_asset > 0
        else None
    )

    available_cash: Optional[float] = None
    cash_warning: Optional[str] = None
    if not detail.get("node_offline"):
        available_cash, cash_warning = await _read_available_cash(
            node_id, detail.get("gateway_name") or None,
        )
    else:
        cash_warning = "available cash is unavailable while the node is offline"
    if cash_warning:
        warnings.append(cash_warning)

    source_label = (
        (curve[-1].get("source_label") if curve else None)
        or detail.get("source_label")
        or "unavailable"
    )

    return {
        "cumulative_return": cumulative_return,
        "annualized_return": annualized,
        "total_asset": total_asset,
        "available_cash": available_cash,
        "position_ratio": position_ratio,
        "beta": None,
        "max_drawdown": max_dd,
        "start_ts": start_ts,
        "end_ts": end_ts,
        "sample_count": len(series),
        "source_label": source_label,
        "warnings": warnings,
    }, warning


def _normalize_date_string(value: Any) -> Optional[str]:
    raw = str(value or "").strip()
    if not raw:
        return None
    if len(raw) == 8 and raw.isdigit():
        raw = f"{raw[:4]}-{raw[4:6]}-{raw[6:8]}"
    try:
        return datetime.fromisoformat(raw[:10]).date().isoformat()
    except ValueError:
        return None


def _position_dates_from_snapshots(
    db: Session,
    node_id: str,
    engine: str,
    strategy_name: str,
    limit: int = 500,
) -> List[str]:
    date_expr = sa.func.date(StrategyEquitySnapshot.ts)
    rows = (
        db.query(date_expr)
        .filter(
            StrategyEquitySnapshot.node_id == node_id,
            StrategyEquitySnapshot.engine == engine,
            StrategyEquitySnapshot.strategy_name == strategy_name,
        )
        .distinct()
        .order_by(date_expr.desc())
        .limit(limit)
        .all()
    )
    dates = {
        normalized
        for (raw,) in rows
        if (normalized := _normalize_date_string(raw))
    }
    return sorted(dates)


async def _position_dates_via_rpc(
    node_id: str,
    strategy_name: str,
    gateway_name: Optional[str],
) -> Tuple[Optional[List[str]], Optional[str]]:
    client = get_vnpy_client()
    if node_id not in client.node_ids:
        return None, f"unknown node: {node_id}"
    if not hasattr(client, "get_strategy_positions_history_dates"):
        return None, "vnpy client does not expose position history dates"
    try:
        raw_dates = await client.get_strategy_positions_history_dates(
            node_id, strategy_name, gateway_name=gateway_name or "",
        )
    except Exception as exc:
        return None, f"RPC position dates unavailable: {exc}"
    dates = {
        normalized
        for raw in raw_dates or []
        if (normalized := _normalize_date_string(raw))
    }
    return sorted(dates), None


async def get_strategy_position_dates(
    db: Session,
    node_id: str,
    engine: str,
    strategy_name: str,
    gateway_name: Optional[str] = None,
) -> Dict[str, Any]:
    rpc_dates, rpc_warning = await _position_dates_via_rpc(
        node_id, strategy_name, gateway_name,
    )
    if rpc_dates:
        return {"items": rpc_dates, "source": "vnpy_rpc", "warning": None}

    snapshot_dates = _position_dates_from_snapshots(db, node_id, engine, strategy_name)
    if snapshot_dates:
        return {
            "items": snapshot_dates,
            "source": "equity_snapshots",
            "warning": rpc_warning,
        }
    return {
        "items": [],
        "source": "none",
        "warning": rpc_warning or "no local equity snapshot dates found",
    }


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
    try:
        from app.services.vnpy import risk_event_service

        orders_fo = await client.get_orders()
        risk_summaries = risk_event_service.summarize_risks_from_fanout(strategies_fo, orders_fo)
    except Exception as exc:
        logger.warning("[live_trading] risk summary fanout failed: %s", exc)
        risk_summaries = {}

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
            schedule = _infer_strategy_schedule(s)
            value, label, acct_eq = _resolve_strategy_value(
                s, node_positions, node_accounts, gateway_name=gateway_name or None,
            )
            curve = _read_curve(db, node_id, engine_name, name)
            inited = bool(s.get("inited"))
            trading = bool(s.get("trading"))
            risk_summary = risk_summaries.get((node_id, engine_name, name), {})
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
                "risk_event_count": int(risk_summary.get("risk_event_count") or 0),
                "highest_risk_severity": risk_summary.get("highest_risk_severity"),
                **schedule,
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
        curve = _read_curve(db, node_id, engine_name, strategy_name)
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
            "risk_event_count": 1,
            "highest_risk_severity": "critical",
            **_schedule_from_raw_variables_json(last.raw_variables_json),
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
        curve = _read_curve(db, node_id, engine_name, strategy_name)
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
            "risk_event_count": 1,
            "highest_risk_severity": "critical",
            **_schedule_from_raw_variables_json(last.raw_variables_json),
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
    # 拿最新一行的 raw_variables_json 复原调度元数据
    last_row = (
        db.query(StrategyEquitySnapshot)
        .filter(
            StrategyEquitySnapshot.node_id == node_id,
            StrategyEquitySnapshot.engine == engine,
            StrategyEquitySnapshot.strategy_name == strategy_name,
        )
        .order_by(StrategyEquitySnapshot.ts.desc())
        .first()
    )
    schedule = _schedule_from_raw_variables_json(
        last_row.raw_variables_json if last_row else None
    )
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
        "risk_event_count": 1,
        "highest_risk_severity": "critical",
        **schedule,
    }


async def get_strategy_detail(
    db: Session,
    node_id: str,
    engine: str,
    strategy_name: str,
    window_days: int = 365,
) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    client = get_vnpy_client()
    start_perf = time.perf_counter()

    def _log_detail_latency(outcome: str) -> None:
        elapsed_ms = (time.perf_counter() - start_perf) * 1000
        if elapsed_ms >= 2000:
            logger.warning(
                "[live_trading] slow strategy detail node=%s engine=%s strategy=%s outcome=%s elapsed_ms=%.1f",
                node_id,
                engine,
                strategy_name,
                outcome,
                elapsed_ms,
            )

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
        strategies_item, accounts_item, positions_item = await asyncio.gather(
            _single_node_read(client, node_id, "get_strategies"),
            _single_node_read(client, node_id, "get_accounts"),
            _single_node_read(client, node_id, "get_positions"),
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
        _log_detail_latency("unexpected_error")
        return None, f"未知错误: {e}"

    strategies_fo = [strategies_item]
    accounts_fo = [accounts_item]
    positions_fo = [positions_item]
    if not strategies_item.get("ok"):
        offline = _offline_detail_from_history(
            db, node_id, engine, strategy_name, window_days,
            offline_reason=f"vnpy strategy endpoint unavailable: {strategies_item.get('error')}",
        )
        if offline is not None:
            _log_detail_latency("strategy_endpoint_error_offline_snapshot")
            return offline, "vnpy strategy endpoint unavailable, showing local snapshot"
        _log_detail_latency("strategy_endpoint_error")
        return None, f"vnpy strategy endpoint unavailable: {strategies_item.get('error')}"

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
    schedule = _infer_strategy_schedule(strategy)
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
        "risk_event_count": 0,
        "highest_risk_severity": None,
        **schedule,
    }
    _log_detail_latency("ok")
    return detail, warning


def _render_positions(positions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """渲染 positions 列表，自动 enrich 股票中文简称 + 持仓市值占比。

    持仓市值占比 weight = market_value(单只) / total_market_value
      market_value(单只) = volume × cost_price + pnl
      (cost_price 含 vnpy_qmt_sim settle 阶段的 pct_chg 累乘调整，等价于 hfq；
       pnl 由 vnpy_qmt_sim 用当日 mark price 算出 → cost+pnl ≈ 当日实际市值)

    与 qlib backtest 的 positions_normal_1day.pkl 中 weight 字段同义：
      qlib weight = amount × hfq_close / now_account_value
    数学上两边都是"占总市值比"，只在 raw_open vs hfq_close 撮合价差 +
    整百取整误差范围内有偏差（典型 1-5%）。
    """
    name_map = get_stock_name_map()
    rendered: List[Dict[str, Any]] = []
    market_values: List[float] = []
    for p in positions:
        vol = float(p.get("volume") or 0)
        cost = float(p.get("price") or 0)
        pnl = float(p.get("pnl") or 0)
        mv = vol * cost + pnl if vol > 0 else 0.0
        rendered.append({
            "vt_symbol": p.get("vt_symbol", ""),
            "name": _resolve_stock_name(p.get("vt_symbol", ""), name_map),
            "direction": str(p.get("direction", "")),
            "volume": vol,
            "price": p.get("price"),
            "pnl": p.get("pnl"),
            "yd_volume": p.get("yd_volume"),
            "frozen": p.get("frozen"),
            "market_value": mv,
        })
        market_values.append(mv)
    total_mv = sum(mv for mv in market_values if mv > 0)
    for row, mv in zip(rendered, market_values):
        row["weight"] = (mv / total_mv) if (total_mv > 0 and mv > 0) else 0.0
    return rendered


async def list_node_statuses() -> List[Dict[str, Any]]:
    client = get_vnpy_client()
    return await client.probe_nodes()


async def delete_strategy_records(
    db: Session,
    node_id: str,
    engine: str,
    strategy_name: str,
) -> Dict[str, Any]:
    """彻底删除策略：vnpy 节点端 stop + delete 实例 + mlearnweb 端清三张表.

    清理范围:
      - vnpy 节点端: stop_strategy + delete_strategy (从 fanout 列表彻底消失)
      - mlearnweb.db.strategy_equity_snapshots: 权益曲线快照
      - mlearnweb.db.ml_metric_snapshots: ML 监控指标快照 (IC/PSI/直方图等)
      - mlearnweb.db.ml_prediction_daily: 每日预测 summary (topk + score_histogram)

    不动 vnpy_qmt_sim 持仓 / 账户 / sim_*.db — 那由 reset_sim_state.py 管.
    不动训练记录 (training_records 等) — 与策略运行实例无关.

    顺序: 先 stop + delete vnpy 端 (避免清 db 后, ml_snapshot_loop / replay_equity_sync_loop
    在 60s 内又把数据写回来), 再清 db. vnpy 端失败 (策略已不存在 / 节点离线)
    log warn 后继续清 db, 满足用户"一键彻底清理"的语义.

    返回 stats dict 含每个清理动作的结果.
    """
    vnpy_stop: Dict[str, Any] = {"ok": False, "skipped": True}
    vnpy_delete: Dict[str, Any] = {"ok": False, "skipped": True}
    client = get_vnpy_client()
    if node_id in client.node_ids:
        try:
            vnpy_stop = await client.stop_strategy(node_id, engine, strategy_name)
        except Exception as exc:
            logger.warning(
                "[delete_strategy_records] vnpy stop_strategy(%s,%s,%s) 失败 (continuing): %s",
                node_id, engine, strategy_name, exc,
            )
            vnpy_stop = {"ok": False, "error": str(exc)}
        try:
            vnpy_delete = await client.delete_strategy(node_id, engine, strategy_name)
        except Exception as exc:
            logger.warning(
                "[delete_strategy_records] vnpy delete_strategy(%s,%s,%s) 失败 (continuing): %s",
                node_id, engine, strategy_name, exc,
            )
            vnpy_delete = {"ok": False, "error": str(exc)}

    n_equity = (
        db.query(StrategyEquitySnapshot)
        .filter(
            StrategyEquitySnapshot.node_id == node_id,
            StrategyEquitySnapshot.engine == engine,
            StrategyEquitySnapshot.strategy_name == strategy_name,
        )
        .delete(synchronize_session=False)
    )
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
    try:
        from app.models.ml_monitoring import MLPredictionDaily
        n_pred = (
            db.query(MLPredictionDaily)
            .filter(
                MLPredictionDaily.node_id == node_id,
                MLPredictionDaily.strategy_name == strategy_name,
            )
            .delete(synchronize_session=False)
        )
    except Exception as exc:
        logger.warning("[delete_strategy_records] ml_prediction_daily 删除失败: %s", exc)
        n_pred = 0
    db.commit()
    from app.services.vnpy.live_trading_events import publish_strategy_event

    await publish_strategy_event(
        "strategy.history.changed",
        node_id=node_id,
        engine=engine,
        strategy_name=strategy_name,
        reason="delete_strategy_records",
    )
    await publish_strategy_event(
        "strategy.equity.changed",
        node_id=node_id,
        engine=engine,
        strategy_name=strategy_name,
        reason="delete_strategy_records",
    )
    return {
        "equity_snapshots": n_equity,
        "ml_metric_snapshots": n_ml,
        "ml_prediction_daily": n_pred,
        "vnpy_stop": vnpy_stop,
        "vnpy_delete": vnpy_delete,
    }


async def list_strategy_trades(
    node_id: str,
    engine: str,
    strategy_name: str,
) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    """拉取指定策略的历史成交，按日期倒序返回。

    数据源：vnpy_webtrader ``/api/v1/trade`` + ``/api/v1/order``（当前会话内）。

    过滤思路：vnpy ``TradeData`` **不带 reference 字段**（dataclass 无此 field），
    但 ``OrderData`` 有 reference 且 vnpy_qmt_sim 在 send_order 写入
    ``{strategy_name}:{seq}`` 格式。所以同时拉 orders + trades，按 ``vt_orderid``
    (gateway 前缀 + orderid，跨 gateway 唯一) 关联，再用 order.reference 过滤本策略成交。

    **关键 bug 修复**: 多 gateway 沙盒下不同 gateway 的 orderid 序列各自从 1 开始
    (e.g. ``QMT_SIM_csi300.1`` 与 ``QMT_SIM_csi300_2.1`` 同 orderid='1'),
    若用 ``orderid`` 作 dict key 会被后写覆盖前写,trades 全部归到一个策略,
    另一策略页面显示 0 trades. 必须用 ``vt_orderid`` (含 gateway 前缀) 作 key.
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

    # 构造 vt_orderid → reference map (节点本地视图; vt_orderid 跨 gateway 唯一,
    # 不能用 orderid — 多 gateway 下 orderid 重复会被后写覆盖)
    vt_orderid_ref: Dict[str, str] = {}
    warning: Optional[str] = None
    for item in orders_fo:
        if item.get("node_id") != node_id:
            continue
        if not item.get("ok"):
            warning = f"节点 {node_id} orders: {item.get('error')}"
            break
        for o in item.get("data") or []:
            vt_oid = str(o.get("vt_orderid") or "")
            ref = str(o.get("reference") or "")
            if vt_oid:
                vt_orderid_ref[vt_oid] = ref

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
            vt_oid = str(t.get("vt_orderid") or "")
            oid = str(t.get("orderid") or "")
            ref = vt_orderid_ref.get(vt_oid, "")
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
    written_identities: set[Tuple[str, str, str]] = set()
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
                # 回放进行中跳过 wall-clock 心跳写入 — 避免污染曲线:
                # vnpy 启动后 OmsEngine 状态从 init_cash 1M 异步演化到回放完成的真实值，
                # 这段过渡期 mlearnweb 写入 db 会让前端曲线在切换点出现 1M→真实值的跳变。
                # 只在 replay_status="completed" (或 strategy 没有该字段, 即非 ML 策略)
                # 时才记录 account_equity 心跳, 历史曲线由 vnpy 端 replay_settle 直写。
                _vars = s.get("variables") or {}
                _replay_status = _vars.get("replay_status")
                if _replay_status is not None and _replay_status != "completed":
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
                # Session-boundary 检测: vnpy 重启后, 前一次 session 的 account_equity
                # 与本次新 state 不连续 (持仓 / equity 跳变), 前端按 ts 排序画线会出现
                # 锯齿. 检测"距上次 wall-clock heartbeat > GAP_THRESHOLD_SEC"作为新
                # session 触发, 删本 strategy 旧 wall-clock 快照 (replay_settle 保留 — 那是
                # 逻辑日, 不受 wall-clock session 影响).
                GAP_THRESHOLD_SEC = 300  # 5 分钟无心跳 = 新 session
                last_wall_ts = session.execute(
                    sa.select(sa.func.max(StrategyEquitySnapshot.ts))
                    .where(StrategyEquitySnapshot.strategy_name == name)
                    .where(StrategyEquitySnapshot.node_id == node_id)
                    .where(StrategyEquitySnapshot.engine == engine_name)
                    .where(StrategyEquitySnapshot.source_label != "replay_settle")
                ).scalar()
                if last_wall_ts is not None:
                    gap = (now - last_wall_ts).total_seconds()
                    if gap > GAP_THRESHOLD_SEC:
                        deleted = session.execute(
                            sa_delete(StrategyEquitySnapshot)
                            .where(StrategyEquitySnapshot.strategy_name == name)
                            .where(StrategyEquitySnapshot.node_id == node_id)
                            .where(StrategyEquitySnapshot.engine == engine_name)
                            .where(StrategyEquitySnapshot.source_label != "replay_settle")
                        ).rowcount
                        logger.info(
                            "[snapshot_tick] new session for %s/%s/%s after gap=%.0fs, "
                            "cleared %d stale wall-clock snapshots",
                            node_id, engine_name, name, gap, deleted,
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
                written_identities.add((node_id, engine_name, name))

        # retention cleanup — 注意排除 source_label='replay_settle'，
        # 那是 vnpy 端写入的"按回放逻辑日"历史快照，不该被实时 retention 误删。
        # 实时 wall-clock 心跳点 (account_equity / strategy_pnl / position_sum_pnl)
        # 仍保留 retention_days 滚动窗口。
        from app.services.app_settings_service import get_runtime_setting
        retention_days = int(
            get_runtime_setting(
                "vnpy_snapshot_retention_days",
                default=settings.vnpy_snapshot_retention_days,
            )
        )
        cutoff = now - timedelta(days=retention_days)
        session.execute(
            sa_delete(StrategyEquitySnapshot)
            .where(StrategyEquitySnapshot.ts < cutoff)
            .where(StrategyEquitySnapshot.source_label != "replay_settle")
        )
        session.commit()
        if written:
            logger.debug("[live_trading] snapshot_tick wrote %d rows", written)
            from app.services.vnpy.live_trading_events import publish_strategy_event

            for node_id, engine_name, name in written_identities:
                await publish_strategy_event(
                    "strategy.equity.changed",
                    node_id=node_id,
                    engine=engine_name,
                    strategy_name=name,
                    reason="snapshot_tick",
                )
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
    result = await get_vnpy_client().create_strategy(node_id, engine, body)
    from app.services.vnpy.live_trading_events import publish_strategy_event

    await publish_strategy_event(
        "strategy.state.changed",
        node_id=node_id,
        engine=engine,
        strategy_name=str(body.get("strategy_name") or ""),
        reason="create_strategy",
    )
    return result


async def init_strategy(node_id: str, engine: str, name: str) -> Dict[str, Any]:
    result = await get_vnpy_client().init_strategy(node_id, engine, name)
    from app.services.vnpy.live_trading_events import publish_strategy_event

    await publish_strategy_event(
        "strategy.state.changed",
        node_id=node_id,
        engine=engine,
        strategy_name=name,
        reason="init_strategy",
    )
    return result


async def start_strategy(node_id: str, engine: str, name: str) -> Dict[str, Any]:
    result = await get_vnpy_client().start_strategy(node_id, engine, name)
    from app.services.vnpy.live_trading_events import publish_strategy_event

    await publish_strategy_event(
        "strategy.state.changed",
        node_id=node_id,
        engine=engine,
        strategy_name=name,
        reason="start_strategy",
    )
    return result


async def stop_strategy(node_id: str, engine: str, name: str) -> Dict[str, Any]:
    result = await get_vnpy_client().stop_strategy(node_id, engine, name)
    from app.services.vnpy.live_trading_events import publish_strategy_event

    await publish_strategy_event(
        "strategy.state.changed",
        node_id=node_id,
        engine=engine,
        strategy_name=name,
        reason="stop_strategy",
    )
    return result


async def edit_strategy(node_id: str, engine: str, name: str, setting: Dict[str, Any]) -> Dict[str, Any]:
    result = await get_vnpy_client().edit_strategy(node_id, engine, name, setting)
    from app.services.vnpy.live_trading_events import publish_strategy_event

    await publish_strategy_event(
        "strategy.state.changed",
        node_id=node_id,
        engine=engine,
        strategy_name=name,
        reason="edit_strategy",
    )
    return result


async def delete_strategy(node_id: str, engine: str, name: str) -> Dict[str, Any]:
    result = await get_vnpy_client().delete_strategy(node_id, engine, name)
    from app.services.vnpy.live_trading_events import publish_strategy_event

    await publish_strategy_event(
        "strategy.state.changed",
        node_id=node_id,
        engine=engine,
        strategy_name=name,
        reason="delete_strategy",
    )
    return result
