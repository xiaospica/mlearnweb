"""Unit tests for corp_actions_service: detect 除权 events from daily_merged parquet."""
from __future__ import annotations

import os
import sys
from datetime import date
from pathlib import Path

import pandas as pd
import pytest

MLEARNWEB_DIR = Path(__file__).resolve().parent.parent.parent
BACKEND_DIR = MLEARNWEB_DIR / "backend"
sys.path.insert(0, str(BACKEND_DIR))


def _row(ts_code: str, trade_date: str, close: float, pre_close: float, name: str = "TEST") -> dict:
    pct = (close / pre_close - 1.0) * 100.0 if pre_close else 0.0
    return {
        "ts_code": ts_code,
        "trade_date": pd.Timestamp(trade_date),
        "name": name,
        "close": close,
        "pre_close": pre_close,
        "pct_chg": pct,
    }


def _make_snapshot(tmp_path: Path, snapshot_date: str, rows: list[dict]) -> Path:
    df = pd.DataFrame(rows)
    out = tmp_path / f"daily_merged_{snapshot_date}.parquet"
    df.to_parquet(out)
    return out


def test_detect_normal_days_no_event(tmp_path: Path) -> None:
    """正常交易日 pct_chg = (close - pre_close)/pre_close = (close - prev_close)/prev_close
    （没有除权时 prev_close == pre_close），不应触发事件。"""
    from app.services import corp_actions_service as svc

    _make_snapshot(tmp_path, "20260422", [
        _row("000001.SZ", "2026-04-20", close=11.06, pre_close=11.01),
        _row("000001.SZ", "2026-04-21", close=11.08, pre_close=11.06),
        _row("000001.SZ", "2026-04-22", close=10.98, pre_close=11.08),
    ])
    events = svc.detect_corp_actions(
        vt_symbols=["000001.SZSE"],
        as_of=date(2026, 4, 22),
        lookback_days=10,
        threshold_pct=0.1,
        merged_root=tmp_path,
    )
    assert events == []


def test_detect_ex_dividend_event(tmp_path: Path) -> None:
    """模拟除权日：pre_close[T] = close[T-1] - 0.5（每股分红 0.5 元），
    pct_chg 反映除权后的涨跌，与 raw_change 差距大于阈值。"""
    from app.services import corp_actions_service as svc

    # 2026-04-21 收盘 12.0；2026-04-22 除权日，pre_close=11.5（除息），close=11.7
    _make_snapshot(tmp_path, "20260422", [
        _row("000001.SZ", "2026-04-21", close=12.0, pre_close=11.95),
        _row("000001.SZ", "2026-04-22", close=11.7, pre_close=11.5),  # 除权
    ])
    events = svc.detect_corp_actions(
        vt_symbols=["000001.SZSE"],
        as_of=date(2026, 4, 22),
        lookback_days=10,
        threshold_pct=0.5,
        merged_root=tmp_path,
    )
    assert len(events) == 1
    e = events[0]
    assert e.trade_date == "2026-04-22"
    assert e.vt_symbol == "000001.SZSE"
    # pct_chg ≈ (11.7-11.5)/11.5 = 1.74%, raw = (11.7-12.0)/12.0 = -2.5%
    # magnitude ≈ |1.74 - (-2.5)| = 4.24%
    assert e.magnitude_pct > 4.0
    assert e.pre_close == 11.5
    assert e.close == 11.7


def test_threshold_filters_small_noise(tmp_path: Path) -> None:
    """微小的 pct_chg vs raw_change 浮点差异（< threshold）不应被识别为事件。"""
    from app.services import corp_actions_service as svc

    # 制造 pct_chg 与 raw_change 仅差 0.05% 的情况（浮点级别）
    _make_snapshot(tmp_path, "20260422", [
        _row("000001.SZ", "2026-04-21", close=12.0, pre_close=11.99),
        # 手工设置一行：pre_close=11.999, close=11.7 → pct_chg ≈ -2.49, raw=(11.7-12)/12 = -2.5%
        # 差仅 0.01%，应被阈值 0.5 过滤
        _row("000001.SZ", "2026-04-22", close=11.7, pre_close=11.999),
    ])
    events = svc.detect_corp_actions(
        vt_symbols=["000001.SZSE"],
        as_of=date(2026, 4, 22),
        lookback_days=10,
        threshold_pct=0.5,
        merged_root=tmp_path,
    )
    assert events == []


def test_unknown_symbol_silently_skipped(tmp_path: Path) -> None:
    from app.services import corp_actions_service as svc

    _make_snapshot(tmp_path, "20260422", [
        _row("000001.SZ", "2026-04-22", close=11.0, pre_close=10.9),
    ])
    events = svc.detect_corp_actions(
        vt_symbols=["999999.SZSE"],
        as_of=date(2026, 4, 22),
        lookback_days=10,
        merged_root=tmp_path,
    )
    assert events == []


def test_invalid_vt_symbol_silently_skipped(tmp_path: Path) -> None:
    """非法 vt_symbol（无后缀 / 未知后缀）跳过，不抛异常。"""
    from app.services import corp_actions_service as svc

    _make_snapshot(tmp_path, "20260422", [
        _row("000001.SZ", "2026-04-22", close=11.0, pre_close=10.9),
    ])
    events = svc.detect_corp_actions(
        vt_symbols=["bad_symbol", "000001"],  # 无 dot / 无 exchange
        as_of=date(2026, 4, 22),
        lookback_days=10,
        merged_root=tmp_path,
    )
    assert events == []


def test_no_snapshot_within_window_returns_empty(tmp_path: Path) -> None:
    from app.services import corp_actions_service as svc

    events = svc.detect_corp_actions(
        vt_symbols=["000001.SZSE"],
        as_of=date(2026, 4, 22),
        lookback_days=10,
        merged_root=tmp_path,  # 空目录
    )
    assert events == []


def test_events_sorted_by_date_desc(tmp_path: Path) -> None:
    """两个除权日 + 中间几天正常交易日，检测出 2 个事件且按日期倒序。

    fixture 关键：除权日外，每行 pre_close 必须等于前一日 close（避免假阳性）。
    """
    from app.services import corp_actions_service as svc

    _make_snapshot(tmp_path, "20260422", [
        _row("000001.SZ", "2026-04-14", close=11.95, pre_close=11.90),
        _row("000001.SZ", "2026-04-15", close=11.7, pre_close=11.5),   # 除权 1（pre_close ≠ 11.95）
        _row("000001.SZ", "2026-04-16", close=11.6, pre_close=11.7),   # 正常
        _row("000001.SZ", "2026-04-17", close=11.65, pre_close=11.6),  # 正常
        _row("000001.SZ", "2026-04-20", close=11.7, pre_close=11.65),  # 正常（跨周末）
        _row("000001.SZ", "2026-04-21", close=12.0, pre_close=11.7),   # 正常
        _row("000001.SZ", "2026-04-22", close=11.7, pre_close=11.5),   # 除权 2（pre_close ≠ 12.0）
    ])
    events = svc.detect_corp_actions(
        vt_symbols=["000001.SZSE"],
        as_of=date(2026, 4, 22),
        lookback_days=30,
        threshold_pct=0.5,
        merged_root=tmp_path,
    )
    assert len(events) == 2, f"expected 2 events, got {events}"
    # 倒序：最新事件在前
    assert events[0].trade_date == "2026-04-22"
    assert events[1].trade_date == "2026-04-15"
