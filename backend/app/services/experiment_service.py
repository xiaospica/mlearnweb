from typing import Any, Dict, List, Optional

from app.utils.mlflow_reader import mlflow_reader


class ExperimentService:
    @staticmethod
    def list_experiments(search: str = "") -> List[Dict[str, Any]]:
        experiments = mlflow_reader.list_experiments()
        if search:
            search_lower = search.lower()
            experiments = [e for e in experiments if search_lower in e.get("name", "").lower()]
        return experiments

    @staticmethod
    def get_experiment(experiment_id: str) -> Optional[Dict[str, Any]]:
        return mlflow_reader.get_experiment(experiment_id)

    @staticmethod
    def get_experiment_summary(experiment_id: str) -> Dict[str, Any]:
        exp = mlflow_reader.get_experiment(experiment_id)
        if not exp:
            return None
        runs_result = mlflow_reader.list_runs(experiment_id, page_size=1)
        all_runs = mlflow_reader.list_runs(experiment_id, page_size=10000)
        status_counts: Dict[str, int] = {}
        for r in all_runs.get("items", []):
            s = r.get("status", "UNKNOWN")
            status_counts[s] = status_counts.get(s, 0) + 1
        return {
            **exp,
            "status_counts": status_counts,
            "total_runs": runs_result.get("total", 0),
        }
