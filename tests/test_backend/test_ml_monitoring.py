"""Phase 3 — ML monitoring backend pack."""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy.orm import sessionmaker

# Make backend app importable
BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


@pytest.fixture
def temp_db(tmp_path):
    """Use a fully independent SQLite engine — not through app.models.database
    globals. Avoids cross-test contamination when app.live_main etc. caches
    the production engine elsewhere.

    NOTE: test_live_trading.py's api_client fixture does
    ``importlib.reload(db_module)``, which rebinds ``Base = declarative_base()``.
    Any ML/Equity model classes imported BEFORE the reload stay bound to the
    old Base (stale) and won't appear on the new Base's metadata. To survive
    ordering, we reload both modules here and re-import models fresh.
    """
    import importlib
    from sqlalchemy import create_engine

    from app.models import database as db_module
    importlib.reload(db_module)
    from app.models import ml_monitoring as ml_module
    importlib.reload(ml_module)

    db_path = tmp_path / "phase3.db"
    new_engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
    )

    db_module.Base.metadata.create_all(bind=new_engine)

    yield new_engine


def test_ml_tables_created(temp_db):
    """init_db creates ml_metric_snapshots + ml_prediction_daily."""
    import sqlite3
    db_path = str(temp_db.url).replace("sqlite:///", "")
    con = sqlite3.connect(db_path)
    cur = con.cursor()
    cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
    tables = {r[0] for r in cur.fetchall()}
    assert "ml_metric_snapshots" in tables
    assert "ml_prediction_daily" in tables
    con.close()


def test_icir_computation():
    from app.services.ml_aggregation_service import compute_icir

    series = [
        {"trade_date": "2026-01-10", "ic": 0.05},
        {"trade_date": "2026-01-11", "ic": 0.08},
        {"trade_date": "2026-01-12", "ic": 0.03},
        {"trade_date": "2026-01-13", "ic": 0.06},
        {"trade_date": "2026-01-14", "ic": 0.07},
    ]
    r = compute_icir(series, window=5)
    assert r["window"] == 5
    assert r["n_samples"] == 5
    assert abs(r["ic_mean"] - 0.058) < 1e-6
    assert r["icir"] is not None and r["icir"] > 0  # positive mean, positive ICIR


def test_icir_empty_handles_gracefully():
    from app.services.ml_aggregation_service import compute_icir
    r = compute_icir([], window=30)
    assert r["n_samples"] == 0
    assert r["icir"] is None


def test_psi_alert_triggers_on_3_consecutive():
    from app.services.ml_aggregation_service import psi_trend_alerts

    series = [
        {"trade_date": "2026-01-10", "psi_mean": 0.10},
        {"trade_date": "2026-01-11", "psi_mean": 0.30},  # streak 1
        {"trade_date": "2026-01-12", "psi_mean": 0.35},  # streak 2
        {"trade_date": "2026-01-13", "psi_mean": 0.40},  # streak 3 -> alert
    ]
    r = psi_trend_alerts(series, threshold=0.25, consecutive_days=3)
    assert r["triggered"] is True
    assert r["first_alert_date"] == "2026-01-13"
    assert r["max_streak_days"] == 3


def test_psi_alert_resets_on_normal_day():
    from app.services.ml_aggregation_service import psi_trend_alerts

    series = [
        {"trade_date": "2026-01-10", "psi_mean": 0.30},  # streak 1
        {"trade_date": "2026-01-11", "psi_mean": 0.32},  # streak 2
        {"trade_date": "2026-01-12", "psi_mean": 0.10},  # reset
        {"trade_date": "2026-01-13", "psi_mean": 0.30},  # streak 1
    ]
    r = psi_trend_alerts(series, threshold=0.25, consecutive_days=3)
    assert r["triggered"] is False
    assert r["max_streak_days"] == 2


def test_upsert_metric_idempotent(temp_db):
    """Same (node, engine, name, date) → single row, fields updated."""
    # Reload ml_monitoring_service too so it uses the reloaded database.engine
    import importlib
    from app.services.vnpy import ml_monitoring_service as mms
    importlib.reload(mms)
    from app.models.ml_monitoring import MLMetricSnapshot

    SessionLocal = sessionmaker(bind=temp_db)
    session = SessionLocal()

    td = datetime(2026, 1, 20)
    mms._upsert_metric(
        session,
        node_id="local",
        strategy_name="demo",
        trade_date=td,
        metrics={"ic": 0.05, "psi_mean": 0.10, "model_run_id": "first"},
        status="ok",
    )
    session.commit()

    mms._upsert_metric(
        session,
        node_id="local",
        strategy_name="demo",
        trade_date=td,
        metrics={"ic": 0.07, "psi_mean": 0.15, "model_run_id": "second"},
        status="ok",
    )
    session.commit()

    rows = session.query(MLMetricSnapshot).all()
    assert len(rows) == 1
    assert rows[0].ic == 0.07
    assert rows[0].model_run_id == "second"
    session.close()


def test_get_metrics_history_order(temp_db):
    import importlib
    from app.services import ml_aggregation_service as agg
    importlib.reload(agg)
    from app.models.ml_monitoring import MLMetricSnapshot

    SessionLocal = sessionmaker(bind=temp_db)
    session = SessionLocal()

    for i, ic in enumerate([0.01, 0.02, 0.03]):
        session.add(
            MLMetricSnapshot(
                node_id="local",
                engine=agg.ML_ENGINE_NAME,
                strategy_name="demo",
                trade_date=datetime.now() - timedelta(days=2 - i),
                ic=ic,
                status="ok",
            )
        )
    session.commit()

    rows = agg.get_metrics_history(session, "local", "demo", days=10)
    assert [r["ic"] for r in rows] == [0.01, 0.02, 0.03]  # ascending by trade_date
    session.close()


def test_ml_routes_registered():
    """live_main includes the ml_monitoring router."""
    from app.live_main import app

    paths = [r.path for r in app.routes if getattr(r, "path", "").startswith("/api/live-trading/ml")]
    assert any("metrics/history" in p for p in paths)
    assert any("metrics/rolling" in p for p in paths)
    assert "/api/live-trading/ml/health" in paths
