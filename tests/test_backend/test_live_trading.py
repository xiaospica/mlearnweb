"""Integration tests for the live trading module.

These tests mount app.live_main via TestClient and replace the underlying
VnpyMultiNodeClient with an in-memory fake. They cover:
  - read endpoints: normal path + warning degradation
  - ops password guard: 503 (unset), 401 (wrong), 200 (correct)
  - write endpoints: routed to fake client and transparently returned
  - _resolve_strategy_value: three-tier fallback (A -> B -> C)
  - snapshot_tick: row insert + retention cleanup
  - registry: yaml load + malformed file
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

MLEARNWEB_DIR = Path(__file__).resolve().parent.parent.parent
BACKEND_DIR = MLEARNWEB_DIR / "backend"
sys.path.insert(0, str(BACKEND_DIR))
os.chdir(str(MLEARNWEB_DIR))


# ---------------------------------------------------------------------------
# Fake vnpy client used by all tests
# ---------------------------------------------------------------------------


class FakeVnpyClient:
    """In-memory stand-in for VnpyMultiNodeClient.

    Exposes the same async methods as the real client but returns canned
    FanoutItem lists, so we can unit-test service + router layers without
    touching the network or the vnpy process.
    """

    def __init__(self):
        self.node_ids = ["nodeA", "nodeB"]
        self.strategies_fanout = [
            {
                "node_id": "nodeA",
                "ok": True,
                "data": [
                    {
                        "engine": "CtaStrategy",
                        "name": "cta1",
                        "class_name": "TestCta",
                        "vt_symbol": "rb2501.SHFE",
                        "author": "",
                        "inited": True,
                        "trading": True,
                        "parameters": {"p1": 1},
                        "variables": {"pos": 5, "total_pnl": 123.45},
                    },
                    {
                        "engine": "CtaStrategy",
                        "name": "cta2",
                        "class_name": "TestCta",
                        "vt_symbol": "ag2501.SHFE",
                        "author": "",
                        "inited": True,
                        "trading": True,
                        "parameters": {},
                        "variables": {"pos": 0},
                    },
                    {
                        "engine": "SignalStrategyPlus",
                        "name": "signal1",
                        "class_name": "MSSP",
                        "vt_symbol": None,
                        "author": "",
                        "inited": True,
                        "trading": False,
                        "parameters": {},
                        "variables": {"last_signal_id": 0},
                    },
                ],
                "error": None,
            },
            {"node_id": "nodeB", "ok": False, "data": [], "error": "connection refused"},
        ]
        self.accounts_fanout = [
            {
                "node_id": "nodeA",
                "ok": True,
                "data": [
                    {"accountid": "A1", "balance": 1_000_000, "vt_accountid": "X.A1"}
                ],
                "error": None,
            },
            {"node_id": "nodeB", "ok": False, "data": [], "error": "connection refused"},
        ]
        self.positions_fanout = [
            {
                "node_id": "nodeA",
                "ok": True,
                "data": [
                    {"vt_symbol": "ag2501.SHFE", "direction": "多", "volume": 10, "price": 5000, "pnl": 250.0},
                    {"vt_symbol": "ag2501.SHFE", "direction": "多", "volume": 5, "price": 5010, "pnl": 150.0},
                    {"vt_symbol": "rb2501.SHFE", "direction": "多", "volume": 3, "price": 3500, "pnl": -10.0},
                ],
                "error": None,
            },
            {"node_id": "nodeB", "ok": False, "data": [], "error": "connection refused"},
        ]
        self.engines_by_node = {
            "nodeA": [
                {
                    "app_name": "CtaStrategy",
                    "display_name": "CTA策略",
                    "event_type": "eCta",
                    "capabilities": ["add", "edit", "init", "remove", "start", "stop"],
                },
                {
                    "app_name": "SignalStrategyPlus",
                    "display_name": "Signal策略Plus",
                    "event_type": "eSignal",
                    "capabilities": ["add", "edit", "init", "remove", "start", "stop"],
                },
            ],
            "nodeB": [],
        }
        self.write_calls = []

    async def get_strategies(self):
        return self.strategies_fanout

    async def get_accounts(self):
        return self.accounts_fanout

    async def get_positions(self):
        return self.positions_fanout

    async def get_engines(self, node_id):
        return self.engines_by_node.get(node_id, [])

    async def get_engine_classes(self, node_id, engine):
        return ["ClassA", "ClassB"]

    async def get_class_params(self, node_id, engine, class_name):
        return {"p1": 1, "p2": "x", "p3": True}

    async def probe_nodes(self):
        return [
            {
                "node_id": "nodeA",
                "base_url": "http://127.0.0.1:18001",
                "enabled": True,
                "online": True,
                "last_probe_ts": 1,
                "last_error": None,
            },
            {
                "node_id": "nodeB",
                "base_url": "http://127.0.0.1:18002",
                "enabled": True,
                "online": False,
                "last_probe_ts": 1,
                "last_error": "offline",
            },
        ]

    async def create_strategy(self, node_id, engine, body):
        self.write_calls.append(("create", node_id, engine, body))
        return {"ok": True, "message": "added", "data": None}

    async def init_strategy(self, node_id, engine, name):
        self.write_calls.append(("init", node_id, engine, name))
        return {"ok": True, "message": "inited", "data": None}

    async def start_strategy(self, node_id, engine, name):
        self.write_calls.append(("start", node_id, engine, name))
        return {"ok": True, "message": "started", "data": None}

    async def stop_strategy(self, node_id, engine, name):
        self.write_calls.append(("stop", node_id, engine, name))
        return {"ok": True, "message": "stopped", "data": None}

    async def edit_strategy(self, node_id, engine, name, setting):
        self.write_calls.append(("edit", node_id, engine, name, setting))
        return {"ok": True, "message": "edited", "data": None}

    async def delete_strategy(self, node_id, engine, name):
        self.write_calls.append(("delete", node_id, engine, name))
        return {"ok": True, "message": "deleted", "data": None}

    async def close(self):
        pass


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def fake_client(monkeypatch):
    fake = FakeVnpyClient()
    from app.services.vnpy import client as client_module
    from app.services.vnpy import live_trading_service as svc_module

    monkeypatch.setattr(client_module, "_instance", fake)
    monkeypatch.setattr(client_module, "get_vnpy_client", lambda: fake)
    monkeypatch.setattr(svc_module, "get_vnpy_client", lambda: fake)
    # routers import `svc` which re-exports; patch in one place is enough since
    # the router calls svc.get_vnpy_client() and svc.list_strategy_summaries().
    return fake


@pytest.fixture
def api_client(fake_client, tmp_path, monkeypatch):
    # redirect the database so tests don't touch the real mlearnweb.db
    db_file = tmp_path / "test_live.db"
    from app.core.config import settings

    monkeypatch.setattr(settings, "database_url", f"sqlite:///{db_file}")
    monkeypatch.setattr(settings, "live_trading_ops_password", None)

    # Re-import fresh engine/Session bound to the test DB.
    import importlib
    from app.models import database as db_module
    importlib.reload(db_module)

    # Re-import service/router so they see the fresh DB engine
    from app.services.vnpy import live_trading_service as svc_module
    importlib.reload(svc_module)
    from app.routers import live_trading as router_module
    importlib.reload(router_module)

    # re-patch after reload so the reloaded modules see the fake client
    monkeypatch.setattr(svc_module, "get_vnpy_client", lambda: fake_client)

    from fastapi import FastAPI
    app = FastAPI()
    app.include_router(router_module.router)
    db_module.init_db()
    return TestClient(app), svc_module, db_module


# ---------------------------------------------------------------------------
# _resolve_strategy_value unit tests
# ---------------------------------------------------------------------------


class TestResolveStrategyValue:
    def test_source_a_variables_pnl(self):
        from app.services.vnpy.live_trading_service import _resolve_strategy_value

        strategy = {"vt_symbol": "rb2501.SHFE", "variables": {"total_pnl": 500}}
        positions = [{"vt_symbol": "rb2501.SHFE", "pnl": 100}]
        accounts = [{"balance": 1_000_000}]
        value, label, equity = _resolve_strategy_value(strategy, positions, accounts)
        assert value == 500
        assert label == "strategy_pnl"
        assert equity == 1_000_000

    def test_source_b_position_sum(self):
        from app.services.vnpy.live_trading_service import _resolve_strategy_value

        strategy = {"vt_symbol": "ag2501.SHFE", "variables": {"pos": 0}}
        positions = [
            {"vt_symbol": "ag2501.SHFE", "pnl": 100},
            {"vt_symbol": "ag2501.SHFE", "pnl": 50},
            {"vt_symbol": "rb2501.SHFE", "pnl": -30},
        ]
        accounts = [{"balance": 1_000_000}]
        value, label, equity = _resolve_strategy_value(strategy, positions, accounts)
        assert value == 150
        assert label == "position_sum_pnl"
        assert equity == 1_000_000

    def test_source_c_account_equity_fallback(self):
        from app.services.vnpy.live_trading_service import _resolve_strategy_value

        strategy = {"vt_symbol": None, "variables": {"last_signal_id": 0}}
        positions = []
        accounts = [{"balance": 7_777_777}]
        value, label, equity = _resolve_strategy_value(strategy, positions, accounts)
        assert value == 7_777_777
        assert label == "account_equity"
        assert equity == 7_777_777

    def test_unavailable_when_nothing(self):
        from app.services.vnpy.live_trading_service import _resolve_strategy_value

        strategy = {"vt_symbol": None, "variables": {}}
        value, label, equity = _resolve_strategy_value(strategy, [], [])
        assert value is None
        assert label == "unavailable"
        assert equity is None

    def test_source_c_includes_position_market_value(self):
        """关键回归：account_equity = cash + 持仓市值 (volume × cost_price + pnl)。

        旧 bug: account_equity 只取 account.balance（cash），买入后 cash 暴跌
        但持仓未计入 → 权益曲线显示从 1M 跌到 149K 是误导。
        """
        from app.services.vnpy.live_trading_service import _resolve_strategy_value

        strategy = {"vt_symbol": None, "variables": {}}
        positions = [
            # 持有 1000 股 @ 11 (cost) + 100 浮盈 → 市值 11100
            {"vt_symbol": "000001.SZSE", "volume": 1000, "price": 11.0, "pnl": 100},
            # 持有 500 股 @ 20 (cost) - 50 浮亏 → 市值 9950
            {"vt_symbol": "600000.SSE", "volume": 500, "price": 20.0, "pnl": -50},
            # volume=0 已平仓位 → 不计入
            {"vt_symbol": "002001.SZSE", "volume": 0, "price": 30.0, "pnl": 0},
        ]
        accounts = [{"balance": 100_000}]  # cash 10w
        value, label, equity = _resolve_strategy_value(strategy, positions, accounts)
        # 总权益 = 100_000 cash + 11100 + 9950 = 121_050
        assert label == "account_equity"
        assert value == 121_050
        assert equity == 121_050

    def test_source_c_filters_by_gateway_name(self):
        """多 gateway 沙盒：accounts/positions 按 gateway_name 过滤。"""
        from app.services.vnpy.live_trading_service import _resolve_strategy_value

        strategy = {"vt_symbol": None, "variables": {}}
        positions = [
            # gateway A: 持仓 11100
            {"vt_symbol": "000001.SZSE", "volume": 1000, "price": 11.0, "pnl": 100, "gateway_name": "QMT_SIM_A"},
            # gateway B: 不算
            {"vt_symbol": "600000.SSE", "volume": 500, "price": 20.0, "pnl": -50, "gateway_name": "QMT_SIM_B"},
        ]
        accounts = [
            {"balance": 100_000, "gateway_name": "QMT_SIM_A"},
            {"balance": 999_999, "gateway_name": "QMT_SIM_B"},  # 不算
        ]
        value, _, _ = _resolve_strategy_value(strategy, positions, accounts, gateway_name="QMT_SIM_A")
        assert value == 100_000 + 11100  # = 111_100


# ---------------------------------------------------------------------------
# Registry tests
# ---------------------------------------------------------------------------


class TestRegistry:
    def test_load_valid_yaml(self, tmp_path, monkeypatch):
        yaml_text = """
nodes:
  - node_id: n1
    base_url: http://1.2.3.4:8001
    username: u
    password: p
    enabled: true
  - node_id: n2
    base_url: http://1.2.3.4:8002
    username: u
    password: p
    enabled: false
"""
        cfg = tmp_path / "nodes.yaml"
        cfg.write_text(yaml_text, encoding="utf-8")

        from app.core.config import settings
        from app.services.vnpy.registry import load_nodes

        monkeypatch.setattr(settings, "vnpy_nodes_config_path", str(cfg))
        nodes = load_nodes()
        assert [n.node_id for n in nodes] == ["n1"]  # n2 disabled → skipped
        assert nodes[0].base_url == "http://1.2.3.4:8001"

    def test_load_missing_file_returns_empty(self, tmp_path, monkeypatch):
        from app.core.config import settings
        from app.services.vnpy.registry import load_nodes

        monkeypatch.setattr(settings, "vnpy_nodes_config_path", str(tmp_path / "nope.yaml"))
        nodes = load_nodes()
        assert nodes == []

    def test_load_malformed_yaml_returns_empty(self, tmp_path, monkeypatch):
        from app.core.config import settings
        from app.services.vnpy.registry import load_nodes

        cfg = tmp_path / "bad.yaml"
        cfg.write_text("nodes: not-a-list", encoding="utf-8")
        monkeypatch.setattr(settings, "vnpy_nodes_config_path", str(cfg))
        nodes = load_nodes()
        assert nodes == []


# ---------------------------------------------------------------------------
# Read endpoint tests
# ---------------------------------------------------------------------------


class TestReadEndpoints:
    def test_list_nodes_ok(self, api_client):
        client, _, _ = api_client
        resp = client.get("/api/live-trading/nodes")
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True
        assert len(data["data"]) == 2
        assert data["data"][0]["node_id"] == "nodeA"

    def test_list_strategies_merges_fanout(self, api_client):
        client, _, _ = api_client
        resp = client.get("/api/live-trading/strategies")
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True
        # nodeA has 3 strategies, nodeB failed → 3 rows
        assert len(data["data"]) == 3
        # warning should surface nodeB's error
        assert data["warning"] is not None
        assert "nodeB" in data["warning"]
        # source labels for the three strategies
        by_name = {s["strategy_name"]: s for s in data["data"]}
        assert by_name["cta1"]["source_label"] == "strategy_pnl"
        assert by_name["cta1"]["strategy_value"] == 123.45
        assert by_name["cta2"]["source_label"] == "position_sum_pnl"
        assert by_name["cta2"]["strategy_value"] == 400.0  # 250+150 (two ag positions)
        assert by_name["signal1"]["source_label"] == "account_equity"

    def test_get_strategy_detail(self, api_client):
        client, _, _ = api_client
        resp = client.get("/api/live-trading/strategies/nodeA/CtaStrategy/cta1")
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True
        assert data["data"]["vt_symbol"] == "rb2501.SHFE"
        # positions should be filtered by vt_symbol
        positions = data["data"]["positions"]
        assert all(p["vt_symbol"] == "rb2501.SHFE" for p in positions)

    def test_get_strategy_detail_not_found(self, api_client):
        client, _, _ = api_client
        resp = client.get("/api/live-trading/strategies/nodeA/CtaStrategy/ghost")
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is False

    def test_list_engines(self, api_client):
        client, _, _ = api_client
        resp = client.get("/api/live-trading/nodes/nodeA/engines")
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True
        assert len(data["data"]) == 2
        assert data["data"][0]["app_name"] == "CtaStrategy"

    def test_warning_degradation_on_client_failure(self, api_client):
        """Simulate the fake client raising → endpoint returns warning, not 500."""
        client, svc_module, _ = api_client

        class FailingClient(FakeVnpyClient):
            async def get_strategies(self):
                from app.services.vnpy.client import VnpyClientError
                raise VnpyClientError("upstream blew up")

        # Re-patch the module the reloaded router actually binds to
        failing = FailingClient()
        import app.services.vnpy.client as cm
        cm.get_vnpy_client = lambda: failing
        svc_module.get_vnpy_client = lambda: failing

        resp = client.get("/api/live-trading/strategies")
        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True
        assert data["data"] == []
        assert "upstream blew up" in (data["warning"] or "")


# ---------------------------------------------------------------------------
# Write endpoint / ops password tests
# ---------------------------------------------------------------------------


class TestWriteGuard:
    def test_write_without_password_config_returns_503(self, api_client):
        client, _, _ = api_client
        resp = client.post("/api/live-trading/strategies/nodeA/CtaStrategy/cta1/start")
        assert resp.status_code == 503

    def test_write_with_password_header_ok(self, api_client, fake_client, monkeypatch):
        client, _, _ = api_client
        from app.core.config import settings

        monkeypatch.setattr(settings, "live_trading_ops_password", "s3cret")
        resp = client.post(
            "/api/live-trading/strategies/nodeA/CtaStrategy/cta1/start",
            headers={"X-Ops-Password": "s3cret"},
        )
        assert resp.status_code == 200
        assert resp.json()["data"]["ok"] is True
        # fake client received the call
        assert any(c[0] == "start" for c in fake_client.write_calls)

    def test_write_with_wrong_password_401(self, api_client, monkeypatch):
        client, _, _ = api_client
        from app.core.config import settings

        monkeypatch.setattr(settings, "live_trading_ops_password", "s3cret")
        resp = client.post(
            "/api/live-trading/strategies/nodeA/CtaStrategy/cta1/stop",
            headers={"X-Ops-Password": "wrong"},
        )
        assert resp.status_code == 401

    def test_create_strategy_routes_to_client(self, api_client, fake_client, monkeypatch):
        client, _, _ = api_client
        from app.core.config import settings

        monkeypatch.setattr(settings, "live_trading_ops_password", "pw")
        resp = client.post(
            "/api/live-trading/strategies/nodeA",
            json={
                "engine": "CtaStrategy",
                "class_name": "TestCta",
                "strategy_name": "new1",
                "vt_symbol": "rb2501.SHFE",
                "setting": {"p1": 2},
            },
            headers={"X-Ops-Password": "pw"},
        )
        assert resp.status_code == 200
        # fake client saw it
        create_calls = [c for c in fake_client.write_calls if c[0] == "create"]
        assert len(create_calls) == 1
        _, node_id, engine, body = create_calls[0]
        assert node_id == "nodeA"
        assert engine == "CtaStrategy"
        assert body["strategy_name"] == "new1"


# ---------------------------------------------------------------------------
# Snapshot loop write/retention
# ---------------------------------------------------------------------------


class TestSnapshot:
    def test_snapshot_tick_writes_rows_and_prunes(self, api_client, fake_client, monkeypatch):
        import asyncio
        _, svc_module, db_module = api_client
        from app.core.config import settings
        from sqlalchemy.orm import sessionmaker

        monkeypatch.setattr(settings, "vnpy_snapshot_retention_days", 1)

        # insert a stale row that should be pruned
        SessionLocal = sessionmaker(bind=db_module.engine, autocommit=False, autoflush=False)
        with SessionLocal() as s:
            s.add(
                db_module.StrategyEquitySnapshot(
                    node_id="nodeA",
                    engine="CtaStrategy",
                    strategy_name="old",
                    ts=datetime.utcnow() - timedelta(days=10),
                    strategy_value=1.0,
                    source_label="strategy_pnl",
                    account_equity=1.0,
                    positions_count=0,
                    raw_variables_json="{}",
                )
            )
            s.commit()

        asyncio.run(svc_module.snapshot_tick())

        with SessionLocal() as s:
            all_rows = s.query(db_module.StrategyEquitySnapshot).all()
            names = {r.strategy_name for r in all_rows}
            # stale row gone, active strategies written
            assert "old" not in names
            # cta1 and cta2 are trading=True; signal1 is inited only -> still captured
            assert "cta1" in names
            assert "cta2" in names
            assert "signal1" in names


# ---------------------------------------------------------------------------
# Phase 3A: _infer_strategy_mode (live vs sim classification)
# ---------------------------------------------------------------------------


class TestInferStrategyMode:
    """Verify strategy mode inference per naming convention.

    Rules (priority desc):
      1. parameters.gateway startswith "QMT_SIM" -> "sim" (overrides node mode)
      2. parameters.gateway equals "QMT" -> "live" (overrides)
      3. parameters.gateway empty / unknown -> fallback to node mode
    """

    def test_sim_gateway_overrides_live_node(self) -> None:
        from app.services.vnpy.live_trading_service import _infer_strategy_mode
        s = {"parameters": {"gateway": "QMT_SIM_csi300"}}
        mode, gw = _infer_strategy_mode(s, node_mode="live")
        assert mode == "sim"
        assert gw == "QMT_SIM_csi300"

    def test_live_gateway_overrides_sim_node(self) -> None:
        from app.services.vnpy.live_trading_service import _infer_strategy_mode
        s = {"parameters": {"gateway": "QMT"}}
        mode, gw = _infer_strategy_mode(s, node_mode="sim")
        assert mode == "live"
        assert gw == "QMT"

    def test_unknown_gateway_falls_back_to_node_mode(self) -> None:
        from app.services.vnpy.live_trading_service import _infer_strategy_mode
        s = {"parameters": {"gateway": "weird_gw"}}
        mode_a, _ = _infer_strategy_mode(s, node_mode="sim")
        mode_b, _ = _infer_strategy_mode(s, node_mode="live")
        assert mode_a == "sim"
        assert mode_b == "live"

    def test_missing_gateway_falls_back_to_node_mode(self) -> None:
        from app.services.vnpy.live_trading_service import _infer_strategy_mode
        for s in [{"parameters": {}}, {}, {"parameters": None}]:
            mode_sim, _ = _infer_strategy_mode(s, node_mode="sim")
            mode_live, _ = _infer_strategy_mode(s, node_mode="live")
            assert mode_sim == "sim"
            assert mode_live == "live"

    def test_qmt_sim_bare_classified_as_sim(self) -> None:
        from app.services.vnpy.live_trading_service import _infer_strategy_mode
        mode, gw = _infer_strategy_mode({"parameters": {"gateway": "QMT_SIM"}}, "live")
        assert mode == "sim"
        assert gw == "QMT_SIM"
