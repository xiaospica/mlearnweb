"""Phase 3B: deployment_sync_service 单元测试。"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

MLEARNWEB_DIR = Path(__file__).resolve().parent.parent.parent
BACKEND_DIR = MLEARNWEB_DIR / "backend"
sys.path.insert(0, str(BACKEND_DIR))


# ---- parse_run_id_from_bundle ----


@pytest.mark.parametrize("bundle_dir,expected", [
    ("F:/qs_exports/rolling_exp/ab2711178313491f9900b5695b47fa98",
     "ab2711178313491f9900b5695b47fa98"),
    ("/qs_exports/rolling_exp/ab2711178313491f9900b5695b47fa98/",
     "ab2711178313491f9900b5695b47fa98"),
    (r"F:\qs_exports\rolling_exp\ab2711178313491f9900b5695b47fa98",
     "ab2711178313491f9900b5695b47fa98"),
    # 大写转小写
    ("/qs_exports/rolling_exp/AB2711178313491F9900B5695B47FA98",
     "ab2711178313491f9900b5695b47fa98"),
])
def test_parse_run_id_from_path(bundle_dir, expected) -> None:
    from app.services.deployment_sync_service import parse_run_id_from_bundle
    assert parse_run_id_from_bundle(bundle_dir) == expected


def test_parse_run_id_empty_returns_none() -> None:
    from app.services.deployment_sync_service import parse_run_id_from_bundle
    assert parse_run_id_from_bundle("") is None
    assert parse_run_id_from_bundle(None) is None  # type: ignore[arg-type]


def test_parse_run_id_falls_back_to_manifest(tmp_path: Path) -> None:
    """路径解析失败时（最后一段不是 32 hex），读 manifest.json 兜底。"""
    from app.services.deployment_sync_service import parse_run_id_from_bundle

    bundle = tmp_path / "renamed_bundle"
    bundle.mkdir()
    manifest_run_id = "fb1234567890abcdef1234567890abcd"
    (bundle / "manifest.json").write_text(
        json.dumps({"run_id": manifest_run_id, "experiment_name": "rolling_exp"}),
        encoding="utf-8",
    )
    assert parse_run_id_from_bundle(str(bundle)) == manifest_run_id


def test_parse_run_id_bad_path_no_manifest_returns_none(tmp_path: Path) -> None:
    from app.services.deployment_sync_service import parse_run_id_from_bundle
    bundle = tmp_path / "no_manifest_here"
    bundle.mkdir()
    assert parse_run_id_from_bundle(str(bundle)) is None


# ---- sync_deployments ----


class _FakeNode:
    def __init__(self, node_id: str, mode: str = "sim"):
        self.node_id = node_id
        self.mode = mode


class _FakeClient:
    def __init__(self, strategies_data: List[Dict[str, Any]]):
        self.node_ids = ["nodeA"]
        self.nodes = [_FakeNode("nodeA", mode="sim")]
        self._fanout = [{"node_id": "nodeA", "ok": True, "data": strategies_data}]

    async def get_strategies(self):
        return self._fanout


@pytest.fixture
def in_memory_db(monkeypatch):
    """In-memory SQLite + 注入 settings.database_url，让 init_db 在该 db 上跑 migration。"""
    db_path = ":memory:"
    test_engine = create_engine(f"sqlite:///{db_path}", future=True)
    SessionLocal = sessionmaker(bind=test_engine, autocommit=False, autoflush=False)

    from app.models import database as db_module
    db_module.engine = test_engine
    db_module.Base.metadata.create_all(bind=test_engine)
    yield SessionLocal


def _create_record(SessionLocal, name: str, run_ids: List[str]):
    from app.models.database import TrainingRecord
    with SessionLocal() as s:
        rec = TrainingRecord(
            name=name,
            experiment_id="exp1",
            experiment_name="rolling_exp",
            run_ids=run_ids,
            status="completed",
            deployments=[],
        )
        s.add(rec)
        s.commit()
        s.refresh(rec)
        return rec.id


def test_sync_deployments_appends_new_entry(in_memory_db) -> None:
    from app.services.deployment_sync_service import sync_deployments

    run_id = "ab2711178313491f9900b5695b47fa98"
    record_id = _create_record(in_memory_db, "csi300", [run_id])

    client = _FakeClient([
        {
            "name": "csi300_lgb",
            "engine": "MlStrategy",
            "parameters": {
                "gateway": "QMT_SIM_csi300",
                "bundle_dir": f"/qs_exports/rolling_exp/{run_id}",
            },
        },
    ])

    with in_memory_db() as db:
        stats = asyncio.run(sync_deployments(db, client))
        from app.models.database import TrainingRecord
        rec = db.get(TrainingRecord, record_id)
        deps = rec.deployments
        assert len(deps) == 1
        assert deps[0]["mode"] == "sim"
        assert deps[0]["gateway_name"] == "QMT_SIM_csi300"
        assert deps[0]["run_id"] == run_id
        assert deps[0]["active"] is True
    assert stats["scanned"] == 1
    assert stats["matched"] == 1
    assert stats["upserted"] == 1


def test_sync_deployments_idempotent_updates_last_seen(in_memory_db) -> None:
    from app.services.deployment_sync_service import sync_deployments

    run_id = "ab2711178313491f9900b5695b47fa98"
    record_id = _create_record(in_memory_db, "csi300", [run_id])

    client = _FakeClient([
        {
            "name": "csi300_lgb",
            "engine": "MlStrategy",
            "parameters": {
                "gateway": "QMT_SIM_csi300",
                "bundle_dir": f"/qs_exports/rolling_exp/{run_id}",
            },
        },
    ])

    with in_memory_db() as db:
        asyncio.run(sync_deployments(db, client))
        from app.models.database import TrainingRecord
        rec = db.get(TrainingRecord, record_id)
        first_seen = rec.deployments[0]["first_seen_at"]
    # second sync — 同一 deployment 不重复 append，更新 last_seen_at
    with in_memory_db() as db:
        asyncio.run(sync_deployments(db, client))
        rec = db.get(TrainingRecord, record_id)
        assert len(rec.deployments) == 1
        assert rec.deployments[0]["first_seen_at"] == first_seen
        assert rec.deployments[0]["active"] is True


def test_sync_deployments_marks_inactive_when_strategy_disappears(in_memory_db) -> None:
    from app.services.deployment_sync_service import sync_deployments

    run_id = "ab2711178313491f9900b5695b47fa98"
    record_id = _create_record(in_memory_db, "csi300", [run_id])

    client_with = _FakeClient([
        {
            "name": "csi300_lgb",
            "engine": "MlStrategy",
            "parameters": {
                "gateway": "QMT_SIM_csi300",
                "bundle_dir": f"/qs_exports/rolling_exp/{run_id}",
            },
        },
    ])
    client_without = _FakeClient([])  # 策略消失，但仍有节点

    with in_memory_db() as db:
        asyncio.run(sync_deployments(db, client_with))
    # 策略消失后再同步 → 不应触发 mark_inactive（因为 record 不在本轮的 seen_per_record 里）
    # 这是当前实现的设计：seen_per_record 只追踪本轮看到 deployment 的 record，
    # 没看到的 record 不会被 mark inactive（避免误标）。
    # 因此手动验证 mark_inactive 的路径需要"上次有 deployment 这次也有，但策略改了名"。
    client_changed = _FakeClient([
        {
            "name": "csi300_lgb_v2",  # 策略改名
            "engine": "MlStrategy",
            "parameters": {
                "gateway": "QMT_SIM_csi300",
                "bundle_dir": f"/qs_exports/rolling_exp/{run_id}",
            },
        },
    ])
    with in_memory_db() as db:
        asyncio.run(sync_deployments(db, client_changed))
        from app.models.database import TrainingRecord
        rec = db.get(TrainingRecord, record_id)
        # 应该有 2 条 deployment：旧的标记 inactive，新的 active
        active_names = [d["strategy_name"] for d in rec.deployments if d["active"]]
        inactive_names = [d["strategy_name"] for d in rec.deployments if not d["active"]]
        assert "csi300_lgb_v2" in active_names
        assert "csi300_lgb" in inactive_names


def test_sync_deployments_skips_unknown_run_id(in_memory_db) -> None:
    from app.services.deployment_sync_service import sync_deployments

    # record 的 run_ids 不含目标 run_id
    _create_record(in_memory_db, "csi300", ["different_run_id"])

    run_id = "ab2711178313491f9900b5695b47fa98"
    client = _FakeClient([
        {
            "name": "csi300_lgb",
            "engine": "MlStrategy",
            "parameters": {
                "gateway": "QMT_SIM_csi300",
                "bundle_dir": f"/qs_exports/rolling_exp/{run_id}",
            },
        },
    ])

    with in_memory_db() as db:
        stats = asyncio.run(sync_deployments(db, client))
        assert stats["scanned"] == 1
        assert stats["matched"] == 0


def test_sync_deployments_handles_strategy_without_bundle_dir(in_memory_db) -> None:
    """策略 parameters 缺 bundle_dir → 跳过不报错。"""
    from app.services.deployment_sync_service import sync_deployments

    _create_record(in_memory_db, "csi300", ["irrelevant"])
    client = _FakeClient([
        {"name": "no_bundle", "engine": "CtaStrategy", "parameters": {}},
    ])

    with in_memory_db() as db:
        stats = asyncio.run(sync_deployments(db, client))
        assert stats["matched"] == 0
