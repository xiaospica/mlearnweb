import os
import sys
import pytest
from pathlib import Path
from fastapi.testclient import TestClient

MLEARNWEB_DIR = Path(__file__).resolve().parent.parent.parent
BACKEND_DIR = MLEARNWEB_DIR / "backend"
os.chdir(str(MLEARNWEB_DIR))
sys.path.insert(0, str(BACKEND_DIR))

from app.main import app

client = TestClient(app)


class TestExperimentAPI:

    def test_root_endpoint(self):
        response = client.get("/")
        assert response.status_code == 200
        data = response.json()
        assert data["service"] == "QLib Backtest Dashboard API"

    def test_health_check(self):
        response = client.get("/health")
        assert response.status_code == 200
        assert response.json()["status"] == "ok"

    def test_list_experiments(self):
        response = client.get("/api/experiments")
        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        assert "data" in data
        assert "items" in data["data"]

    def test_get_experiment_detail(self):
        list_resp = client.get("/api/experiments").json()
        experiments = list_resp["data"]["items"]
        if experiments:
            exp_id = experiments[0]["experiment_id"]
            response = client.get(f"/api/experiments/{exp_id}")
            assert response.status_code == 200
            data = response.json()
            assert data["data"]["experiment_id"] == exp_id


class TestRunAPI:

    @pytest.fixture
    def experiment_id(self):
        resp = client.get("/api/experiments").json()
        experiments = resp["data"]["items"]
        if not experiments:
            pytest.skip("没有实验数据")
        return experiments[0]["experiment_id"]

    @pytest.fixture
    def run_id(self, experiment_id):
        resp = client.get(f"/api/runs?exp_id={experiment_id}&page_size=5").json()
        runs = resp["data"].get("items", [])
        if not runs:
            pytest.skip(f"实验 {experiment_id} 没有运行记录")
        return runs[0]["run_id"]

    def test_list_runs(self, experiment_id):
        response = client.get(f"/api/runs?exp_id={experiment_id}")
        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        assert "total" in data["data"]

    def test_get_run_detail(self, experiment_id, run_id):
        response = client.get(f"/api/runs/{run_id}?exp_id={experiment_id}")
        assert response.status_code == 200
        data = response.json()
        assert data["data"]["run_id"] == run_id
        assert "params" in data["data"]
        assert "metrics" in data["data"]

    def test_get_run_params(self, experiment_id, run_id):
        response = client.get(f"/api/runs/{run_id}/params?exp_id={experiment_id}")
        assert response.status_code == 200
        data = response.json()
        assert "raw" in data["data"]

    def test_get_run_artifacts(self, experiment_id, run_id):
        response = client.get(f"/api/runs/{run_id}/artifacts?exp_id={experiment_id}")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data["data"], list)


class TestReportAPI:

    @pytest.fixture
    def experiment_id(self):
        resp = client.get("/api/experiments").json()
        experiments = resp["data"]["items"]
        if not experiments:
            pytest.skip("没有实验数据")
        return experiments[0]["experiment_id"]

    @pytest.fixture
    def run_with_portfolio(self, experiment_id):
        resp = client.get(f"/api/runs?exp_id={experiment_id}&page_size=50").json()
        for run in resp["data"].get("items", []):
            artifacts_resp = client.get(f"/api/runs/{run['run_id']}/artifacts?exp_id={experiment_id}").json()
            paths = [a["path"] for a in artifacts_resp["data"]]
            if any("report_normal" in p for p in paths):
                return run["run_id"]
        pytest.skip("没有包含portfolio报告的运行记录")

    def test_get_full_report(self, experiment_id, run_with_portfolio):
        response = client.get(f"/api/runs/{run_with_portfolio}/report?exp_id={experiment_id}")
        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
        report_data = data["data"]
        assert "run_info" in report_data
        assert "key_metrics" in report_data
        assert "portfolio_data" in report_data

    def test_get_portfolio_chart(self, experiment_id, run_with_portfolio):
        response = client.get(f"/api/runs/{run_with_portfolio}/charts/portfolio?exp_id={experiment_id}")
        assert response.status_code == 200

    def test_get_ic_chart(self, experiment_id, run_with_portfolio):
        response = client.get(f"/api/runs/{run_with_portfolio}/charts/ic?exp_id={experiment_id}")
        assert response.status_code == 200

    def test_get_risk_chart(self, experiment_id, run_with_portfolio):
        response = client.get(f"/api/runs/{run_with_portfolio}/charts/risk?exp_id={experiment_id}")
        assert response.status_code == 200

    def test_get_prediction_chart(self, experiment_id, run_with_portfolio):
        response = client.get(f"/api/runs/{run_with_portfolio}/charts/prediction?exp_id={experiment_id}")
        assert response.status_code == 200


class TestTrainingRecordAPI:

    def test_create_and_delete_training_record(self):
        from app.models.database import init_db
        init_db()
        create_resp = client.post("/api/training-records", json={
            "name": "test_crud_training",
            "experiment_id": "test_exp_002",
            "command_line": "python test_crud.py",
            "category": "rolling",
        })
        assert create_resp.status_code == 200
        record_id = create_resp.json()["data"]["id"]
        delete_resp = client.delete(f"/api/training-records/{record_id}")
        assert delete_resp.status_code == 200

    def test_add_run_mapping(self):
        from app.models.database import init_db
        init_db()
        create_resp = client.post("/api/training-records", json={
            "name": "test_mapping_training",
            "experiment_id": "test_exp_003",
            "category": "rolling",
        })
        assert create_resp.status_code == 200
        record_id = create_resp.json()["data"]["id"]
        mapping_resp = client.post(f"/api/training-records/{record_id}/runs", json={
            "run_id": "test_run_001",
            "rolling_index": 0,
            "segment_label": "Roll #1",
            "train_start": "2020-01-01",
            "train_end": "2024-12-31",
            "valid_start": "2025-01-01",
            "valid_end": "2025-06-30",
            "test_start": "2025-07-01",
            "test_end": "2026-01-23",
        })
        assert mapping_resp.status_code == 200
        get_resp = client.get(f"/api/training-records/{record_id}")
        data = get_resp.json()["data"]
        assert len(data["run_mappings"]) >= 1
        client.delete(f"/api/training-records/{record_id}")

    def test_update_training_record(self):
        from app.models.database import init_db
        init_db()
        create_resp = client.post("/api/training-records", json={
            "name": "test_update_training",
            "experiment_id": "test_exp_004",
        })
        record_id = create_resp.json()["data"]["id"]
        update_resp = client.put(f"/api/training-records/{record_id}", json={
            "status": "completed",
            "duration_seconds": 3600.5,
            "summary_metrics": {"annualized_return": 0.25},
        })
        assert update_resp.status_code == 200
        assert update_resp.json()["data"]["status"] == "completed"
        client.delete(f"/api/training-records/{record_id}")

    def test_delete_nonexistent(self):
        response = client.delete("/api/training-records/999999")
        assert response.json()["success"] is False
