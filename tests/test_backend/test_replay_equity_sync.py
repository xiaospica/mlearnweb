"""A1/B2: replay_equity_sync_service 单元测试.

覆盖 (无需真 vnpy 节点, 用 FakeClient mock fanout):
- _get_local_max_inserted_at: 空表/有数据
- _upsert_remote_rows: 首次插入 + 重复插入幂等
- sync_one_node_strategy: 端到端 since 增量
- sync_all: 多节点 + 多策略遍历
"""
from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

MLEARNWEB_DIR = Path(__file__).resolve().parent.parent.parent
BACKEND_DIR = MLEARNWEB_DIR / "backend"
sys.path.insert(0, str(BACKEND_DIR))


@pytest.fixture
def mem_db_session(monkeypatch):
    """In-memory SQLite + 把 service 模块的 SessionLocal 重指到它."""
    from app.models.database import Base
    from app.services.vnpy import replay_equity_sync_service as svc

    eng = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(eng)
    SessionLocal = sessionmaker(bind=eng, autoflush=False, autocommit=False)
    monkeypatch.setattr(svc, "SessionLocal", SessionLocal)
    return SessionLocal


def test_get_local_max_inserted_at_empty(mem_db_session):
    from app.services.vnpy import replay_equity_sync_service as svc

    s = mem_db_session()
    try:
        max_ts = svc._get_local_max_inserted_at(
            s, node_id="local", strategy_name="csi300_a",
        )
    finally:
        s.close()
    assert max_ts is None


def test_upsert_remote_rows_inserts(mem_db_session):
    from app.models.database import StrategyEquitySnapshot
    from app.services.vnpy import replay_equity_sync_service as svc

    rows = [
        {
            "ts": datetime(2026, 1, 5, 15, 0, 0).isoformat(),
            "strategy_value": 1_000_000.0,
            "account_equity": 1_000_000.0,
            "positions_count": 7,
            "raw_variables": {"replay_status": "running"},
        },
        {
            "ts": datetime(2026, 1, 6, 15, 0, 0).isoformat(),
            "strategy_value": 1_010_000.0,
            "account_equity": 1_010_000.0,
            "positions_count": 7,
            "raw_variables": {},
        },
    ]
    s = mem_db_session()
    try:
        n = svc._upsert_remote_rows(
            s, node_id="local", strategy_name="csi300_a", rows=rows,
        )
        s.commit()
        assert n == 2

        cnt = (
            s.query(StrategyEquitySnapshot)
            .filter(
                StrategyEquitySnapshot.strategy_name == "csi300_a",
                StrategyEquitySnapshot.source_label == "replay_settle",
            )
            .count()
        )
        assert cnt == 2
    finally:
        s.close()


def test_upsert_remote_rows_idempotent(mem_db_session):
    """重复 UPSERT 同 (strategy, ts.date) 应保持行数不变 (DELETE then INSERT 幂等)."""
    from app.models.database import StrategyEquitySnapshot
    from app.services.vnpy import replay_equity_sync_service as svc

    row = {
        "ts": datetime(2026, 1, 5, 15, 0, 0).isoformat(),
        "strategy_value": 1_000_000.0,
        "account_equity": 1_000_000.0,
        "positions_count": 7,
    }
    s = mem_db_session()
    try:
        svc._upsert_remote_rows(s, node_id="local", strategy_name="csi300_a", rows=[row])
        # 第二次写, 数值改了
        row2 = dict(row); row2["strategy_value"] = 1_050_000.0
        svc._upsert_remote_rows(s, node_id="local", strategy_name="csi300_a", rows=[row2])
        s.commit()

        rows_db = (
            s.query(StrategyEquitySnapshot)
            .filter(
                StrategyEquitySnapshot.strategy_name == "csi300_a",
                StrategyEquitySnapshot.source_label == "replay_settle",
            )
            .all()
        )
        assert len(rows_db) == 1, "同 (strategy, date) 应只剩一行 (UPSERT 幂等)"
        assert rows_db[0].strategy_value == 1_050_000.0
    finally:
        s.close()


def test_get_local_max_after_upsert(mem_db_session):
    from app.services.vnpy import replay_equity_sync_service as svc

    rows = [
        {"ts": datetime(2026, 1, 5, 15, 0, 0).isoformat(),
         "strategy_value": 1.0, "account_equity": 1.0, "positions_count": 0},
        {"ts": datetime(2026, 1, 7, 15, 0, 0).isoformat(),
         "strategy_value": 2.0, "account_equity": 2.0, "positions_count": 0},
    ]
    s = mem_db_session()
    try:
        svc._upsert_remote_rows(s, node_id="local", strategy_name="csi300_a", rows=rows)
        s.commit()
        max_ts = svc._get_local_max_inserted_at(
            s, node_id="local", strategy_name="csi300_a",
        )
    finally:
        s.close()
    assert max_ts is not None
    assert "2026-01-07" in max_ts


class _FakePerNodeClient:
    """模拟单节点 client, 内置一份回放快照, 支持 since 过滤."""
    def __init__(self, snapshots: List[Dict[str, Any]]):
        self._snapshots = snapshots
        self.last_since: Optional[str] = None

    async def get_ml_replay_equity_snapshots(
        self, name: str, since: Optional[str] = None, limit: int = 10000,
    ) -> List[Dict[str, Any]]:
        self.last_since = since
        if not since:
            return list(self._snapshots)
        return [s for s in self._snapshots if s["ts"] > since]


class _FakeMultiClient:
    def __init__(self, by_node: Dict[str, _FakePerNodeClient]):
        self._by_node = by_node

    def get_per_node(self, nid: str) -> _FakePerNodeClient:
        return self._by_node[nid]

    async def get_ml_health_all(self):
        return [
            {"node_id": nid, "ok": True,
             "data": {"strategies": [{"name": "csi300_a"}]}, "error": None}
            for nid in self._by_node
        ]


def _patch_get_vnpy_client(monkeypatch, fake):
    from app.services.vnpy import replay_equity_sync_service as svc
    monkeypatch.setattr(svc, "get_vnpy_client", lambda: fake)


def test_sync_one_node_strategy_initial(mem_db_session, monkeypatch):
    from app.services.vnpy import replay_equity_sync_service as svc

    fake_node = _FakePerNodeClient([
        {"ts": datetime(2026, 1, 5, 15, 0, 0).isoformat(),
         "strategy_value": 1.0, "account_equity": 1.0, "positions_count": 0},
        {"ts": datetime(2026, 1, 6, 15, 0, 0).isoformat(),
         "strategy_value": 2.0, "account_equity": 2.0, "positions_count": 0},
    ])
    fake_client = _FakeMultiClient({"local": fake_node})

    n = asyncio.run(svc.sync_one_node_strategy(
        fake_client, node_id="local", strategy_name="csi300_a",
    ))
    assert n == 2
    assert fake_node.last_since is None  # 首次拉, 无 since


def test_sync_one_node_strategy_increment(mem_db_session, monkeypatch):
    """第二次同步应该用 since=本地 max(ts), 仅拉新增行."""
    from app.services.vnpy import replay_equity_sync_service as svc

    snap_a = {"ts": datetime(2026, 1, 5, 15, 0, 0).isoformat(),
              "strategy_value": 1.0, "account_equity": 1.0, "positions_count": 0}
    snap_b = {"ts": datetime(2026, 1, 6, 15, 0, 0).isoformat(),
              "strategy_value": 2.0, "account_equity": 2.0, "positions_count": 0}
    fake_node = _FakePerNodeClient([snap_a, snap_b])
    fake_client = _FakeMultiClient({"local": fake_node})

    # 第一次拉 → 全量 2 行
    n1 = asyncio.run(svc.sync_one_node_strategy(
        fake_client, node_id="local", strategy_name="csi300_a",
    ))
    assert n1 == 2

    # vnpy 端新增第三行
    snap_c = {"ts": datetime(2026, 1, 7, 15, 0, 0).isoformat(),
              "strategy_value": 3.0, "account_equity": 3.0, "positions_count": 0}
    fake_node._snapshots.append(snap_c)

    # 第二次拉 → since=2026-01-06, 仅拉到 1 行
    n2 = asyncio.run(svc.sync_one_node_strategy(
        fake_client, node_id="local", strategy_name="csi300_a",
    ))
    assert fake_node.last_since is not None
    assert "2026-01-06" in fake_node.last_since
    assert n2 == 1


def test_sync_all_multi_node(mem_db_session, monkeypatch):
    from app.services.vnpy import replay_equity_sync_service as svc

    fake_a = _FakePerNodeClient([
        {"ts": datetime(2026, 1, 5, 15, 0, 0).isoformat(),
         "strategy_value": 1.0, "account_equity": 1.0, "positions_count": 0},
    ])
    fake_b = _FakePerNodeClient([
        {"ts": datetime(2026, 1, 5, 15, 0, 0).isoformat(),
         "strategy_value": 2.0, "account_equity": 2.0, "positions_count": 0},
        {"ts": datetime(2026, 1, 6, 15, 0, 0).isoformat(),
         "strategy_value": 3.0, "account_equity": 3.0, "positions_count": 0},
    ])
    fake_client = _FakeMultiClient({"nodeA": fake_a, "nodeB": fake_b})
    _patch_get_vnpy_client(monkeypatch, fake_client)

    stats = asyncio.run(svc.sync_all())
    assert stats["scanned"] == 2  # 两节点 × 1 策略
    assert stats["upserted"] == 3  # nodeA 1 + nodeB 2


def test_sync_all_no_strategies(mem_db_session, monkeypatch):
    """节点没暴露任何策略 → 同步直接 0 行."""
    from app.services.vnpy import replay_equity_sync_service as svc

    class _EmptyClient:
        async def get_ml_health_all(self):
            return [{"node_id": "x", "ok": True, "data": {"strategies": []}, "error": None}]

    _patch_get_vnpy_client(monkeypatch, _EmptyClient())
    stats = asyncio.run(svc.sync_all())
    assert stats["scanned"] == 0
    assert stats["upserted"] == 0
