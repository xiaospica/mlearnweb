import os
import sys
import pytest
from pathlib import Path

MLEARNWEB_DIR = Path(__file__).resolve().parent.parent.parent
BACKEND_DIR = MLEARNWEB_DIR / "backend"
assert BACKEND_DIR.exists(), f"Backend dir not found: {BACKEND_DIR}"
sys.path.insert(0, str(BACKEND_DIR))

from app.utils.mlflow_reader import MLFlowReader


class TestMLFlowReader:

    @pytest.fixture(scope="class")
    def reader(self):
        mlruns_dir = Path(r"F:\Quant\code\qlib_strategy_dev\mlruns")
        if not mlruns_dir.exists():
            pytest.skip("mlruns目录不存在")
        return MLFlowReader(mlruns_dir=str(mlruns_dir))

    @pytest.fixture(scope="class")
    def experiment_id(self, reader):
        experiments = reader.list_experiments()
        if not experiments:
            pytest.skip("没有找到任何实验")
        return experiments[0]["experiment_id"]

    @pytest.fixture(scope="class")
    def run_id(self, reader, experiment_id):
        runs_result = reader.list_runs(experiment_id, page_size=5)
        items = runs_result.get("items", [])
        if not items:
            pytest.skip(f"实验 {experiment_id} 下没有运行记录")
        return items[0]["run_id"]

    def test_list_experiments(self, reader):
        experiments = reader.list_experiments()
        assert isinstance(experiments, list)
        assert len(experiments) > 0
        exp = experiments[0]
        assert "experiment_id" in exp
        assert "name" in exp
        assert "run_count" in exp

    def test_get_experiment(self, reader, experiment_id):
        exp = reader.get_experiment(experiment_id)
        assert exp is not None
        assert exp["experiment_id"] == experiment_id

    def test_get_experiment_not_found(self, reader):
        result = reader.get_experiment("nonexistent_exp_12345")
        assert result is None

    def test_list_runs(self, reader, experiment_id):
        result = reader.list_runs(experiment_id, page_size=10)
        assert "total" in result
        assert "items" in result
        assert isinstance(result["items"], list)

    def test_list_runs_with_pagination(self, reader, experiment_id):
        page1 = reader.list_runs(experiment_id, page=1, page_size=3)
        page2 = reader.list_runs(experiment_id, page=2, page_size=3)
        if page1["total"] > 3:
            assert len(page1["items"]) <= 3
            assert len(page2["items"]) <= 3

    def test_list_runs_with_status_filter(self, reader, experiment_id):
        finished = reader.list_runs(experiment_id, status_filter="FINISHED", page_size=100)
        for run in finished["items"]:
            assert run["status"] == "FINISHED"

    def test_get_run_detail(self, reader, experiment_id, run_id):
        detail = reader.get_run_detail(experiment_id, run_id)
        assert detail is not None
        assert detail["run_id"] == run_id
        assert "status" in detail
        assert "params" in detail
        assert "metrics" in detail
        assert "tags" in detail
        assert "artifacts" in detail

    def test_load_run_params(self, reader, experiment_id, run_id):
        params = reader.load_run_params(experiment_id, run_id)
        assert isinstance(params, dict)

    def test_load_run_metrics(self, reader, experiment_id, run_id):
        metrics = reader.load_run_metrics(experiment_id, run_id)
        assert isinstance(metrics, dict)

    def test_load_run_tags(self, reader, experiment_id, run_id):
        tags = reader.load_run_tags(experiment_id, run_id)
        assert isinstance(tags, dict)

    def test_list_artifacts(self, reader, experiment_id, run_id):
        artifacts = reader.list_artifacts(experiment_id, run_id)
        assert isinstance(artifacts, list)


class TestMLFlowReaderEdgeCases:

    def test_nonexistent_mlruns_dir(self, tmp_path):
        from app.utils.mlflow_reader import MLFlowReader as MLR
        reader = MLR(str(tmp_path / "nonexistent"))
        assert reader.list_experiments() == []

    def test_nonexistent_experiment(self):
        from app.utils.mlflow_reader import MLFlowReader as MLR
        result = MLR().list_runs("nonexistent_exp")
        assert result["total"] == 0

    def test_nonexistent_run(self):
        from app.utils.mlflow_reader import MLFlowReader as MLR
        assert MLR().get_run_detail("some_exp", "fake_run") is None
