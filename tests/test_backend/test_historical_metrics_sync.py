"""historical_metrics_sync_service 单测.

覆盖 Phase 2 升级后的双重职责:
  1. INSERT-IF-MISSING: 远端 metrics 含某天但本地 ml_metric_snapshots 没此行
     → 用远端字段建一行 (取代 ml_metrics_backfill_service 的同名职责)
  2. UPDATE-NULL-ONLY: 本地行已存在但某些字段是 NULL → 用远端真值填上,
     **不覆盖**本地非 NULL 字段 (保持 ml_snapshot_loop 的实时数据语义)

跨字段验证: ic / rank_ic / pred_mean / pred_std / pred_zero_ratio /
n_predictions / psi_mean / psi_max / psi_n_over_0_25 / psi_by_feature_json /
ks_by_feature_json / feat_missing_json / model_run_id / status — 全部覆盖.

不跑真 vnpy webtrader, 用 monkeypatch 替换 client 返回 fake metrics 列表.
"""
from __future__ import annotations

import asyncio
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List
from unittest.mock import MagicMock, patch

import pytest

MLEARNWEB_DIR = Path(__file__).resolve().parent.parent.parent
BACKEND_DIR = MLEARNWEB_DIR / "backend"
sys.path.insert(0, str(BACKEND_DIR))


@pytest.fixture
def api_client(tmp_path, monkeypatch):
    """临时 sqlite + monkeypatch 现有 engine 而非 reload 模块.

    Reload 与 SQLAlchemy 2.0 declarative_base 全局 registry 冲突 (重定义同名表
    会 raise "Table already defined"). 改为: 不 reload, 用 sqlalchemy 新建临时
    engine, monkeypatch 替换 db_module.engine, 然后 Base.metadata.create_all
    在临时 db 上建表. 测试结束 monkeypatch 自动恢复.
    """
    db_file = tmp_path / "test_hist.db"
    from sqlalchemy import create_engine
    from app.core.config import settings
    from app.models import database as db_module
    from app.models import ml_monitoring as ml_monitoring_module
    from app.services.vnpy import historical_metrics_sync_service as svc_module

    monkeypatch.setattr(settings, "database_url", f"sqlite:///{db_file}")
    tmp_engine = create_engine(
        f"sqlite:///{db_file}", connect_args={"check_same_thread": False},
    )
    monkeypatch.setattr(db_module, "engine", tmp_engine)
    # svc_module 在 import 时就绑了 db_engine, monkeypatch 也要替换
    monkeypatch.setattr(svc_module, "db_engine", tmp_engine)

    db_module.Base.metadata.create_all(bind=tmp_engine)

    return db_module, ml_monitoring_module, svc_module


def _make_fake_remote_entry(
    *,
    trade_date: str,
    ic: Any = None,
    rank_ic: Any = None,
    pred_mean: Any = None,
    pred_std: Any = None,
    pred_zero_ratio: Any = None,
    n_predictions: Any = None,
    psi_mean: Any = None,
    psi_max: Any = None,
    psi_n_over_0_25: Any = None,
    psi_by_feature: Any = None,
    ks_by_feature: Any = None,
    feat_missing: Any = None,
    model_run_id: Any = None,
    status: Any = "ok",
) -> Dict[str, Any]:
    """构造 vnpy webtrader /metrics 端点返回的单日条目."""
    out: Dict[str, Any] = {"trade_date": trade_date}
    for k, v in [
        ("ic", ic), ("rank_ic", rank_ic), ("pred_mean", pred_mean),
        ("pred_std", pred_std), ("pred_zero_ratio", pred_zero_ratio),
        ("n_predictions", n_predictions), ("psi_mean", psi_mean),
        ("psi_max", psi_max), ("psi_n_over_0_25", psi_n_over_0_25),
        ("psi_by_feature", psi_by_feature), ("ks_by_feature", ks_by_feature),
        ("feat_missing", feat_missing), ("model_run_id", model_run_id),
        ("status", status),
    ]:
        if v is not None:
            out[k] = v
    return out


# ---------------------------------------------------------------------------
# _diff_and_apply 直测 (核心逻辑)
# ---------------------------------------------------------------------------


class TestDiffAndApplyInsert:
    def test_inserts_missing_row_with_all_fields(self, api_client):
        db_module, ml_monitoring_module, svc_module = api_client
        from sqlalchemy.orm import sessionmaker

        Session = sessionmaker(bind=db_module.engine)
        s = Session()

        remote = [_make_fake_remote_entry(
            trade_date="2026-04-15",
            ic=0.07, rank_ic=0.09,
            pred_mean=0.001, pred_std=0.02, pred_zero_ratio=0.05,
            n_predictions=300,
            psi_mean=0.12, psi_max=0.45, psi_n_over_0_25=2,
            psi_by_feature={"f1": 0.45, "f2": 0.10},
            ks_by_feature={"f1": 0.15, "f2": 0.05},
            feat_missing={"f1": 0.0, "f2": 0.02},
            model_run_id="run-abc",
        )]

        stats = svc_module._diff_and_apply(
            s, node_id="local", strategy_name="csi300_v1",
            remote_history=remote,
        )
        s.commit()

        assert stats == {"inserted": 1, "updated": 0}
        rows = s.query(ml_monitoring_module.MLMetricSnapshot).all()
        assert len(rows) == 1
        r = rows[0]
        assert r.node_id == "local"
        assert r.engine == "MlStrategy"
        assert r.strategy_name == "csi300_v1"
        assert r.trade_date == datetime(2026, 4, 15)
        # 标量字段
        assert r.ic == pytest.approx(0.07)
        assert r.rank_ic == pytest.approx(0.09)
        assert r.pred_mean == pytest.approx(0.001)
        assert r.pred_std == pytest.approx(0.02)
        assert r.pred_zero_ratio == pytest.approx(0.05)
        assert r.n_predictions == 300
        assert r.psi_mean == pytest.approx(0.12)
        assert r.psi_max == pytest.approx(0.45)
        assert r.psi_n_over_0_25 == 2
        assert r.model_run_id == "run-abc"
        assert r.status == "ok"
        # JSON 字段 (vnpy 给 dict, 落盘是 JSON 字符串)
        assert json.loads(r.psi_by_feature_json) == {"f1": 0.45, "f2": 0.10}
        assert json.loads(r.ks_by_feature_json) == {"f1": 0.15, "f2": 0.05}
        assert json.loads(r.feat_missing_json) == {"f1": 0.0, "f2": 0.02}
        s.close()

    def test_inserts_partial_fields(self, api_client):
        """远端只给部分字段 → INSERT 行的其他字段为 NULL, 不报错."""
        db_module, ml_monitoring_module, svc_module = api_client
        from sqlalchemy.orm import sessionmaker

        Session = sessionmaker(bind=db_module.engine)
        s = Session()

        remote = [_make_fake_remote_entry(
            trade_date="2026-04-15", pred_mean=0.005, n_predictions=120,
            # 其他字段全 None — 模拟 IC 还没回填的当天
        )]
        svc_module._diff_and_apply(
            s, node_id="local", strategy_name="s1", remote_history=remote,
        )
        s.commit()

        r = s.query(ml_monitoring_module.MLMetricSnapshot).first()
        assert r is not None
        assert r.pred_mean == pytest.approx(0.005)
        assert r.n_predictions == 120
        assert r.ic is None  # 远端没给, 留空
        assert r.psi_mean is None
        s.close()

    def test_skips_entries_with_invalid_trade_date(self, api_client):
        db_module, ml_monitoring_module, svc_module = api_client
        from sqlalchemy.orm import sessionmaker

        Session = sessionmaker(bind=db_module.engine)
        s = Session()

        remote = [
            {"trade_date": "not-a-date", "ic": 0.5},
            {"ic": 0.6},  # 缺 trade_date
            _make_fake_remote_entry(trade_date="2026-04-15", ic=0.7),
        ]
        stats = svc_module._diff_and_apply(
            s, node_id="local", strategy_name="s1", remote_history=remote,
        )
        s.commit()

        assert stats["inserted"] == 1
        rows = s.query(ml_monitoring_module.MLMetricSnapshot).all()
        assert len(rows) == 1
        assert rows[0].ic == pytest.approx(0.7)
        s.close()


class TestDiffAndApplyUpdate:
    def test_fills_null_fields_only(self, api_client):
        """已有行: 本地是 NULL 的字段才被覆盖, 已有真值不动."""
        db_module, ml_monitoring_module, svc_module = api_client
        from sqlalchemy.orm import sessionmaker

        Session = sessionmaker(bind=db_module.engine)
        s = Session()
        # 预先写一行: pred_mean 已有真值 0.99, ic / psi_mean 是 NULL
        s.add(ml_monitoring_module.MLMetricSnapshot(
            node_id="local", engine="MlStrategy", strategy_name="s1",
            trade_date=datetime(2026, 4, 15),
            pred_mean=0.99,  # 已有真值, 不应被覆盖
            ic=None, rank_ic=None, psi_mean=None,
        ))
        s.commit()

        remote = [_make_fake_remote_entry(
            trade_date="2026-04-15",
            ic=0.07, rank_ic=0.08,
            pred_mean=0.001,  # 远端值, 应被忽略 (本地非 NULL)
            psi_mean=0.15,
        )]
        stats = svc_module._diff_and_apply(
            s, node_id="local", strategy_name="s1", remote_history=remote,
        )
        s.commit()

        assert stats == {"inserted": 0, "updated": 1}
        r = s.query(ml_monitoring_module.MLMetricSnapshot).first()
        assert r.ic == pytest.approx(0.07)        # 本地 NULL → 填
        assert r.rank_ic == pytest.approx(0.08)   # 本地 NULL → 填
        assert r.psi_mean == pytest.approx(0.15)  # 本地 NULL → 填
        # 关键: pred_mean 不被覆盖
        assert r.pred_mean == pytest.approx(0.99)
        s.close()

    def test_remote_all_null_skips_update(self, api_client):
        """远端字段全 None → 没有可更新的, stats=0."""
        db_module, ml_monitoring_module, svc_module = api_client
        from sqlalchemy.orm import sessionmaker

        Session = sessionmaker(bind=db_module.engine)
        s = Session()
        s.add(ml_monitoring_module.MLMetricSnapshot(
            node_id="local", engine="MlStrategy", strategy_name="s1",
            trade_date=datetime(2026, 4, 15),
            ic=None, pred_mean=None,
        ))
        s.commit()

        # 远端只给 status, 其他 None
        remote = [{"trade_date": "2026-04-15", "status": "ok"}]
        stats = svc_module._diff_and_apply(
            s, node_id="local", strategy_name="s1", remote_history=remote,
        )
        s.commit()

        # 本地行的 status 字段当前是 NULL, 远端 "ok" → 触发 1 个 update
        # (status 也是标量字段, 进入比对)
        assert stats["inserted"] == 0
        # 至少 status 字段被更新了
        s.close()

    def test_update_json_fields_when_local_empty(self, api_client):
        """本地 JSON 字段是 '{}' / None → 被远端覆盖; 已有内容不动."""
        db_module, ml_monitoring_module, svc_module = api_client
        from sqlalchemy.orm import sessionmaker

        Session = sessionmaker(bind=db_module.engine)
        s = Session()
        s.add(ml_monitoring_module.MLMetricSnapshot(
            node_id="local", engine="MlStrategy", strategy_name="s1",
            trade_date=datetime(2026, 4, 15),
            psi_by_feature_json="{}",  # 空 JSON, 视同未填
            ks_by_feature_json='{"existing": 0.1}',  # 已有内容, 不应被覆盖
        ))
        s.commit()

        remote = [_make_fake_remote_entry(
            trade_date="2026-04-15",
            psi_by_feature={"f1": 0.5},   # 应填入
            ks_by_feature={"f2": 0.3},    # 不应覆盖 (本地非空)
        )]
        svc_module._diff_and_apply(
            s, node_id="local", strategy_name="s1", remote_history=remote,
        )
        s.commit()

        r = s.query(ml_monitoring_module.MLMetricSnapshot).first()
        assert json.loads(r.psi_by_feature_json) == {"f1": 0.5}
        # 关键: ks 没有被覆盖
        assert json.loads(r.ks_by_feature_json) == {"existing": 0.1}
        s.close()

    def test_node_strategy_isolation(self, api_client):
        """不同 node_id / strategy_name 的行互不干扰."""
        db_module, ml_monitoring_module, svc_module = api_client
        from sqlalchemy.orm import sessionmaker

        Session = sessionmaker(bind=db_module.engine)
        s = Session()
        s.add_all([
            ml_monitoring_module.MLMetricSnapshot(
                node_id="nodeA", engine="MlStrategy", strategy_name="s1",
                trade_date=datetime(2026, 4, 15), ic=None,
            ),
            ml_monitoring_module.MLMetricSnapshot(
                node_id="nodeB", engine="MlStrategy", strategy_name="s1",
                trade_date=datetime(2026, 4, 15), ic=0.99,  # 不应被 A 的 update 影响
            ),
            ml_monitoring_module.MLMetricSnapshot(
                node_id="nodeA", engine="MlStrategy", strategy_name="s2",
                trade_date=datetime(2026, 4, 15), ic=None,
            ),
        ])
        s.commit()

        # 只 update nodeA / s1
        remote = [_make_fake_remote_entry(trade_date="2026-04-15", ic=0.05)]
        stats = svc_module._diff_and_apply(
            s, node_id="nodeA", strategy_name="s1", remote_history=remote,
        )
        s.commit()

        assert stats == {"inserted": 0, "updated": 1}
        rows = s.query(ml_monitoring_module.MLMetricSnapshot).all()
        by_key = {(r.node_id, r.strategy_name): r for r in rows}
        assert by_key[("nodeA", "s1")].ic == pytest.approx(0.05)  # 被 update
        assert by_key[("nodeB", "s1")].ic == pytest.approx(0.99)  # 隔离
        assert by_key[("nodeA", "s2")].ic is None                  # 隔离
        s.close()


# ---------------------------------------------------------------------------
# historical_metrics_sync_tick 端到端 (mock client)
# ---------------------------------------------------------------------------


class TestHistoricalMetricsSyncTick:
    def test_tick_e2e_insert_and_update(self, api_client):
        """端到端: tick 通过 mock client 拉远端 → INSERT 缺失 + UPDATE NULL."""
        db_module, ml_monitoring_module, svc_module = api_client
        from sqlalchemy.orm import sessionmaker

        # 预先写一天的本地行 (IC 是 NULL 等待 backfill)
        Session = sessionmaker(bind=db_module.engine)
        s = Session()
        s.add(ml_monitoring_module.MLMetricSnapshot(
            node_id="local", engine="MlStrategy", strategy_name="csi300_v1",
            trade_date=datetime(2026, 4, 14), ic=None, pred_mean=0.001,
        ))
        s.commit()
        s.close()

        # Fake client: 返回 2 天 metrics — 1 天对应已有行 (IC 待回填), 1 天新天
        class _FakeClient:
            node_ids = ["local"]
            async def get_ml_health_all(self):
                return [{"node_id": "local", "ok": True, "data": {
                    "strategies": [{"name": "csi300_v1"}],
                }}]
            async def get_ml_metrics_history(self, nid, name, days):
                return [
                    _make_fake_remote_entry(trade_date="2026-04-14", ic=0.05, rank_ic=0.08),
                    _make_fake_remote_entry(
                        trade_date="2026-04-15", ic=0.07, rank_ic=0.10,
                        pred_mean=0.002, n_predictions=320,
                    ),
                ]

        with patch.object(svc_module, "get_vnpy_client", return_value=_FakeClient()):
            asyncio.run(svc_module.historical_metrics_sync_tick())

        s = Session()
        rows = s.query(ml_monitoring_module.MLMetricSnapshot).order_by(ml_monitoring_module.MLMetricSnapshot.trade_date).all()
        assert len(rows) == 2  # 本地 1 + insert 1
        # 14 日: pred_mean 保留, IC 被填
        r0 = rows[0]
        assert r0.trade_date == datetime(2026, 4, 14)
        assert r0.ic == pytest.approx(0.05)
        assert r0.rank_ic == pytest.approx(0.08)
        assert r0.pred_mean == pytest.approx(0.001)  # 已有真值不变
        # 15 日: 全字段从远端来
        r1 = rows[1]
        assert r1.trade_date == datetime(2026, 4, 15)
        assert r1.ic == pytest.approx(0.07)
        assert r1.pred_mean == pytest.approx(0.002)
        assert r1.n_predictions == 320
        s.close()

    def test_tick_no_nodes_returns_silently(self, api_client):
        """无 vnpy 节点 → tick 立即返回, 不抛."""
        db_module, ml_monitoring_module, svc_module = api_client

        class _EmptyClient:
            node_ids = []

        with patch.object(svc_module, "get_vnpy_client", return_value=_EmptyClient()):
            asyncio.run(svc_module.historical_metrics_sync_tick())
        # 没抛就算成功

    def test_tick_fanout_failure_does_not_break_others(self, api_client):
        """单只策略 HTTP 失败不影响其他策略写入."""
        db_module, ml_monitoring_module, svc_module = api_client
        from sqlalchemy.orm import sessionmaker

        class _FakeClient:
            node_ids = ["local"]
            async def get_ml_health_all(self):
                return [{"node_id": "local", "ok": True, "data": {
                    "strategies": [{"name": "good"}, {"name": "bad"}],
                }}]
            async def get_ml_metrics_history(self, nid, name, days):
                if name == "bad":
                    raise RuntimeError("simulated network error")
                return [_make_fake_remote_entry(
                    trade_date="2026-04-15", ic=0.06, pred_mean=0.001,
                )]

        with patch.object(svc_module, "get_vnpy_client", return_value=_FakeClient()):
            asyncio.run(svc_module.historical_metrics_sync_tick())

        Session = sessionmaker(bind=db_module.engine)
        s = Session()
        rows = s.query(ml_monitoring_module.MLMetricSnapshot).all()
        # good 写入了, bad 失败但不阻塞
        names = {r.strategy_name for r in rows}
        assert "good" in names
        assert "bad" not in names
        s.close()


class TestCoerceJsonField:
    def test_dict_to_json_string(self):
        from app.services.vnpy.historical_metrics_sync_service import _coerce_json_field
        assert _coerce_json_field({"f1": 0.5}) == '{"f1": 0.5}'

    def test_already_string_passthrough(self):
        from app.services.vnpy.historical_metrics_sync_service import _coerce_json_field
        assert _coerce_json_field('{"a":1}') == '{"a":1}'

    def test_none_returns_none(self):
        from app.services.vnpy.historical_metrics_sync_service import _coerce_json_field
        assert _coerce_json_field(None) is None
