from typing import Any, Dict, List, Optional

from app.utils.mlflow_reader import mlflow_reader


class RunService:
    @staticmethod
    def list_runs(
        experiment_id: str,
        page: int = 1,
        page_size: int = 50,
        status_filter: Optional[str] = None,
        sort_by: str = "start_time",
        order: str = "desc",
    ) -> Dict[str, Any]:
        return mlflow_reader.list_runs(
            experiment_id=experiment_id,
            status_filter=status_filter,
            sort_by=sort_by,
            order=order,
            page=page,
            page_size=page_size,
        )

    @staticmethod
    def get_run_detail(experiment_id: str, run_id: str) -> Optional[Dict[str, Any]]:
        return mlflow_reader.get_run_detail(experiment_id, run_id)

    @staticmethod
    def get_run_params(experiment_id: str, run_id: str) -> Dict[str, Any]:
        params = mlflow_reader.load_run_params(experiment_id, run_id)
        structured_params = _structure_params(params)
        return {"raw": params, "structured": structured_params}

    @staticmethod
    def get_run_metrics(experiment_id: str, run_id: str) -> Dict[str, Any]:
        return mlflow_reader.load_run_metrics(experiment_id, run_id)

    @staticmethod
    def get_run_artifacts(experiment_id: str, run_id: str) -> List[Dict[str, Any]]:
        return mlflow_reader.list_artifacts(experiment_id, run_id)

    @staticmethod
    def get_run_tags(experiment_id: str, run_id: str) -> Dict[str, str]:
        return mlflow_reader.load_run_tags(experiment_id, run_id)


def _structure_params(params: Dict[str, Any]) -> Dict[str, Any]:
    result: Dict[str, Any] = {}
    model_info = {}
    dataset_info = {}
    handler_info = {}
    segments_info = {}

    if "model" in params:
        model_info["class"] = params["model"].get("class", "")
        model_info["module_path"] = params["model"].get("module_path", "")
        kwargs = params["model"].get("kwargs", {})
        model_info["kwargs"] = {k: v for k, v in kwargs.items()}

    if "dataset" in params:
        dataset_info["class"] = params["dataset"].get("class", "")
        dataset_info["module_path"] = params["dataset"].get("module_path", "")

    if "handler" in params or ("kwargs" in params and "handler" in params):
        handler_data = params.get("handler", {}) or params.get("kwargs", {}).get("handler", {}).get("kwargs", {})
        handler_info.update(handler_data)

    segments_keys = ["train", "valid", "test"]
    for seg_key in segments_keys:
        seg_full_key = f"segments.{seg_key}"
        if seg_full_key in params:
            val = params[seg_full_key]
            if isinstance(val, (list, tuple)) and len(val) >= 2:
                segments_info[seg_key] = {"start": str(val[0]), "end": str(val[1])}
            else:
                segments_info[seg_key] = str(val)

    if model_info:
        result["model"] = model_info
    if dataset_info:
        result["dataset"] = dataset_info
    if handler_info:
        result["handler"] = handler_info
    if segments_info:
        result["segments"] = segments_info

    record_val = params.get("record")
    if record_val:
        result["record_config"] = record_val

    return result
