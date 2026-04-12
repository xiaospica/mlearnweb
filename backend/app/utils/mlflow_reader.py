import os
import yaml
import pickle
from pathlib import Path
from typing import Any, Dict, List, Optional
from datetime import datetime

import pandas as pd
import numpy as np

from app.core.config import settings


class MLFlowReader:
    """MLFlow mlruns 目录数据读取器，直接解析YAML和PKL文件，不依赖mlflow库"""

    STATUS_MAP = {0: "RUNNING", 1: "SCHEDULED", 2: "FINISHED", 3: "FAILED", 4: "KILLED"}

    def __init__(self, mlruns_dir: Optional[str] = None):
        self.mlruns_dir = Path(mlruns_dir or settings.mlruns_dir)

    def _determine_status(self, status_code: int, metrics: Dict[str, Any], tags: Dict[str, str]) -> str:
        if status_code == 2:
            return "FINISHED"
        train_status = tags.get("train_status", "")
        if train_status == "finished":
            return "FINISHED"
        has_valid_metrics = any(
            v is not None and isinstance(v, (int, float)) and v != 0
            for k, v in metrics.items()
            if k in ["IC", "ic", "annualized_return", "1day.excess_return_without_cost.annualized_return", "1day.excess_return_with_cost.annualized_return"]
        )
        if has_valid_metrics:
            return "FINISHED"
        return self.STATUS_MAP.get(status_code, "UNKNOWN")

    def _load_yaml(self, filepath: Path) -> Dict[str, Any]:
        with open(filepath, "r", encoding="utf-8") as f:
            return yaml.safe_load(f) or {}

    def _load_pickle(self, filepath: Path) -> Any:
        print(f"[MLFlowReader] _load_pickle: {filepath}, exists={filepath.exists()}", file=__import__('sys').stderr)
        if not filepath.exists():
            print(f"[MLFlowReader] File not found: {filepath}", file=__import__('sys').stderr)
            return None
        try:
            import io
            with open(filepath, "rb") as f:
                content = f.read()
            
            class NumpyUnpickler(pickle.Unpickler):
                def find_class(self, module, name):
                    if module == 'numpy.core.multiarray' or module == 'numpy._core.multiarray':
                        if name == '_reconstruct':
                            return np.ndarray.__new__
                        if name == 'scalar':
                            return np.core.multiarray.scalar
                    if module == 'numpy' and name == 'dtype':
                        return np.dtype
                    if module == 'numpy.core.numeric' or module == 'numpy._core.numeric':
                        return getattr(np.core.numeric, name, getattr(np, name, None))
                    return super().find_class(module, name)
            
            try:
                data = NumpyUnpickler(io.BytesIO(content)).load()
            except Exception as inner_e:
                print(f"[MLFlowReader] NumpyUnpickler failed, trying default: {inner_e}", file=__import__('sys').stderr)
                with open(filepath, "rb") as f:
                    data = pickle.load(f)
            
            print(f"[MLFlowReader] Loaded pickle: type={type(data)}, shape={getattr(data, 'shape', 'N/A')}", file=__import__('sys').stderr)
            return data
        except Exception as e:
            print(f"[MLFlowReader] Error loading pickle {filepath}: {e}", file=__import__('sys').stderr)
            import traceback
            traceback.print_exc()
            return None

    def _read_text_file(self, filepath: Path) -> str:
        if not filepath.exists():
            return ""
        with open(filepath, "r", encoding="utf-8") as f:
            return f.read().strip()

    def list_experiments(self) -> List[Dict[str, Any]]:
        experiments = []
        if not self.mlruns_dir.exists():
            return experiments
        for item in self.mlruns_dir.iterdir():
            meta_path = item / "meta.yaml"
            if item.is_dir() and meta_path.exists():
                meta = self._load_yaml(meta_path)
                run_count = len([d for d in item.iterdir() if d.is_dir() and (d / "meta.yaml").exists()])
                experiments.append({
                    "experiment_id": meta.get("experiment_id", item.name),
                    "name": meta.get("name", item.name),
                    "artifact_location": meta.get("artifact_location", ""),
                    "creation_time": meta.get("creation_time"),
                    "last_update_time": meta.get("last_update_time"),
                    "lifecycle_stage": meta.get("lifecycle_stage", "active"),
                    "run_count": run_count,
                })
        return sorted(experiments, key=lambda x: x.get("creation_time", 0), reverse=True)

    def get_experiment(self, experiment_id: str) -> Optional[Dict[str, Any]]:
        exp_dir = self.mlruns_dir / experiment_id
        meta_path = exp_dir / "meta.yaml"
        if not meta_path.exists():
            return None
        meta = self._load_yaml(meta_path)
        run_count = len([d for d in exp_dir.iterdir() if d.is_dir() and (d / "meta.yaml").exists()])
        return {
            **meta,
            "experiment_id": experiment_id,
            "run_count": run_count,
        }

    def list_runs(
        self,
        experiment_id: str,
        status_filter: Optional[str] = None,
        sort_by: str = "start_time",
        order: str = "desc",
        page: int = 1,
        page_size: int = 50,
    ) -> Dict[str, Any]:
        exp_dir = self.mlruns_dir / experiment_id
        if not exp_dir.exists():
            return {"total": 0, "items": []}
        runs = []
        for item in exp_dir.iterdir():
            run_meta_path = item / "meta.yaml"
            if item.is_dir() and run_meta_path.exists():
                try:
                    meta = self._load_yaml(run_meta_path)
                    status_code = meta.get("status", -1)
                    metrics = self.load_run_metrics(experiment_id, item.name)
                    tags = self.load_run_tags(experiment_id, item.name)
                    status_str = self._determine_status(status_code, metrics, tags)
                    if status_filter and status_str != status_filter.upper():
                        continue
                    runs.append({
                        "run_id": meta.get("run_id", item.name),
                        "run_name": meta.get("run_name", ""),
                        "status": status_str,
                        "status_code": status_code,
                        "start_time": meta.get("start_time"),
                        "end_time": meta.get("end_time"),
                        "lifecycle_stage": meta.get("lifecycle_stage", "active"),
                        "artifact_uri": meta.get("artifact_uri", ""),
                        "_sort_key": meta.get(sort_by, 0) or 0,
                    })
                except Exception:
                    continue
        reverse_order = order.lower() == "desc"
        runs.sort(key=lambda x: x.get("_sort_key", 0) or 0, reverse=reverse_order)
        for r in runs:
            r.pop("_sort_key", None)
        total = len(runs)
        start_idx = (page - 1) * page_size
        end_idx = start_idx + page_size
        return {"total": total, "items": runs[start_idx:end_idx]}

    def get_run_detail(self, experiment_id: str, run_id: str) -> Optional[Dict[str, Any]]:
        run_dir = self.mlruns_dir / experiment_id / run_id
        meta_path = run_dir / "meta.yaml"
        if not meta_path.exists():
            return None
        meta = self._load_yaml(meta_path)
        status_code = meta.get("status", -1)
        params = self.load_run_params(experiment_id, run_id)
        metrics = self.load_run_metrics(experiment_id, run_id)
        tags = self.load_run_tags(experiment_id, run_id)
        artifacts = self.list_artifacts(experiment_id, run_id)
        status_str = self._determine_status(status_code, metrics, tags)
        duration = None
        if meta.get("start_time") and meta.get("end_time"):
            duration = (meta["end_time"] - meta["start_time"]) / 1000.0
        return {
            "run_id": run_id,
            "run_name": meta.get("run_name", tags.get("mlflow.runName", "")),
            "status": status_str,
            "status_code": status_code,
            "start_time": meta.get("start_time"),
            "end_time": meta.get("end_time"),
            "duration_seconds": round(duration, 2) if duration else None,
            "lifecycle_stage": meta.get("lifecycle_stage", "active"),
            "params": params,
            "metrics": metrics,
            "tags": tags,
            "artifacts": artifacts,
        }

    def load_run_params(self, experiment_id: str, run_id: str) -> Dict[str, Any]:
        params_dir = self.mlruns_dir / experiment_id / run_id / "params"
        if not params_dir.exists():
            return {}
        params: Dict[str, Any] = {}
        for param_file in params_dir.iterdir():
            if param_file.is_file():
                key = param_file.name
                value = self._read_text_file(param_file)
                parts = key.split(".")
                current = params
                for part in parts[:-1]:
                    if part not in current:
                        current[part] = {}
                    current = current[part]
                current[parts[-1]] = value
        return params

    def load_run_metrics(self, experiment_id: str, run_id: str) -> Dict[str, Any]:
        metrics_dir = self.mlruns_dir / experiment_id / run_id / "metrics"
        if not metrics_dir.exists():
            return {}
        metrics: Dict[str, Any] = {}
        for metric_file in metrics_dir.iterdir():
            if metric_file.is_file():
                lines = metric_file.read_text(encoding="utf-8").strip().split("\n")
                values = []
                for line in lines:
                    line = line.strip()
                    if line:
                        try:
                            parts = line.split()
                            if len(parts) >= 2:
                                values.append(float(parts[1]))
                        except (ValueError, IndexError):
                            pass
                metrics[metric_file.name] = values[-1] if values else None
        return metrics

    def load_run_tags(self, experiment_id: str, run_id: str) -> Dict[str, str]:
        tags_dir = self.mlruns_dir / experiment_id / run_id / "tags"
        if not tags_dir.exists():
            return {}
        tags: Dict[str, str] = {}
        for tag_file in tags_dir.iterdir():
            if tag_file.is_file():
                tags[tag_file.name] = self._read_text_file(tag_file)
        return tags

    def list_artifacts(self, experiment_id: str, run_id: str) -> List[Dict[str, Any]]:
        artifacts_dir = self.mlruns_dir / experiment_id / run_id / "artifacts"
        if not artifacts_dir.exists():
            return []
        artifacts = []
        for root, dirs, files in os.walk(artifacts_dir):
            rel_root = os.path.relpath(root, artifacts_dir)
            for f in files:
                file_path = Path(root) / f
                relative_path = os.path.join(rel_root, f) if rel_root != "." else f
                size_kb = file_path.stat().st_size / 1024.0 if file_path.exists() else 0
                artifacts.append({
                    "path": relative_path.replace("\\", "/"),
                    "size_kb": round(size_kb, 2),
                    "type": "file" if file_path.is_file() else "directory",
                })
        return sorted(artifacts, key=lambda x: x["path"])

    def load_portfolio_report(self, experiment_id: str, run_id: str) -> Optional[pd.DataFrame]:
        pkl_path = (
            self.mlruns_dir / experiment_id / run_id /
            "artifacts/portfolio_analysis/report_normal_1day.pkl"
        )
        print(f"[MLFlowReader] load_portfolio_report: {pkl_path}", file=__import__('sys').stderr)
        if not pkl_path.exists():
            print(f"[MLFlowReader] Portfolio report not found: {pkl_path}", file=__import__('sys').stderr)
            return None
        return self._load_pickle(pkl_path)

    def load_positions(self, experiment_id: str, run_id: str) -> Optional[pd.DataFrame]:
        pkl_path = (
            self.mlruns_dir / experiment_id / run_id /
            "artifacts/portfolio_analysis/positions_normal_1day.pkl"
        )
        if not pkl_path.exists():
            return None
        return self._load_pickle(pkl_path)

    def load_port_analysis(self, experiment_id: str, run_id: str) -> Optional[Dict[str, float]]:
        pkl_path = (
            self.mlruns_dir / experiment_id / run_id /
            "artifacts/portfolio_analysis/port_analysis_1day.pkl"
        )
        print(f"[MLFlowReader] load_port_analysis: {pkl_path}", file=__import__('sys').stderr)
        if not pkl_path.exists():
            print(f"[MLFlowReader] Port analysis not found: {pkl_path}", file=__import__('sys').stderr)
            return None
        data = self._load_pickle(pkl_path)
        if data is None:
            return None
        
        # 处理 DataFrame 格式（多级索引：excess_return_with_cost/excess_return_without_cost, 指标名）
        if isinstance(data, pd.DataFrame):
            result = {}
            # 遍历 DataFrame 的行索引
            if isinstance(data.index, pd.MultiIndex):
                for idx in data.index:
                    if len(idx) == 2:
                        group, metric = idx
                        key = f"1day.{group}.{metric}"
                        value = data.loc[idx, data.columns[0]] if len(data.columns) > 0 else data.loc[idx]
                        if pd.notna(value):
                            result[key] = float(value)
            else:
                # 单级索引
                for idx in data.index:
                    metric = str(idx)
                    value = data.loc[idx, data.columns[0]] if len(data.columns) > 0 else data.loc[idx]
                    if pd.notna(value):
                        result[f"1day.{metric}"] = float(value)
            return result
        
        # 处理 dict 格式
        if isinstance(data, dict):
            return {k: float(v) for k, v in data.items() if v is not None}
        
        return None

    def load_port_analysis_df(self, experiment_id: str, run_id: str) -> Optional[pd.DataFrame]:
        pkl_path = (
            self.mlruns_dir / experiment_id / run_id /
            "artifacts/portfolio_analysis/port_analysis_1day.pkl"
        )
        print(f"[MLFlowReader] load_port_analysis_df: {pkl_path}", file=__import__('sys').stderr)
        if not pkl_path.exists():
            print(f"[MLFlowReader] Port analysis df not found: {pkl_path}", file=__import__('sys').stderr)
            return None
        data = self._load_pickle(pkl_path)
        if data is None:
            return None
        
        if isinstance(data, pd.DataFrame):
            return data
        
        return None

    def load_prediction_data(self, experiment_id: str, run_id: str) -> Optional[pd.DataFrame]:
        pred_path = self.mlruns_dir / experiment_id / run_id / "artifacts/pred.pkl"
        label_path = self.mlruns_dir / experiment_id / run_id / "artifacts/label.pkl"
        print(f"[MLFlowReader] load_prediction_data: pred={pred_path}, label={label_path}", file=__import__('sys').stderr)
        pred_df = self._load_pickle(pred_path) if pred_path.exists() else None
        label_df = self._load_pickle(label_path) if label_path.exists() else None
        print(f"[MLFlowReader] pred_df={pred_df is not None}, label_df={label_df is not None}", file=__import__('sys').stderr)
        if pred_df is None:
            return None
        if label_df is not None:
            combined = pd.concat([label_df, pred_df], axis=1, sort=True).reindex(label_df.index)
            combined.columns = ["label", "score"]
            return combined
        return pred_df

    def load_ic_analysis(self, experiment_id: str, run_id: str) -> Dict[str, Optional[pd.DataFrame]]:
        result = {"ic": None, "ric": None}
        ic_path = self.mlruns_dir / experiment_id / run_id / "artifacts/sig_analysis/ic.pkl"
        ric_path = self.mlruns_dir / experiment_id / run_id / "artifacts/sig_analysis/ric.pkl"
        if ic_path.exists():
            result["ic"] = self._load_pickle(ic_path)
        if ric_path.exists():
            result["ric"] = self._load_pickle(ric_path)
        return result

    def load_indicator_analysis(self, experiment_id: str, run_id: str) -> Optional[Dict[str, float]]:
        """加载 indicator_analysis_1day.pkl 文件"""
        pkl_path = (
            self.mlruns_dir / experiment_id / run_id /
            "artifacts/portfolio_analysis/indicator_analysis_1day.pkl"
        )
        if not pkl_path.exists():
            return None
        data = self._load_pickle(pkl_path)
        if data is None:
            return None
        
        # 处理 DataFrame 格式
        if isinstance(data, pd.DataFrame):
            result = {}
            if hasattr(data, 'index'):
                for idx in data.index:
                    metric_name = str(idx)
                    value = data.loc[idx, data.columns[0]] if len(data.columns) > 0 else data.loc[idx]
                    if pd.notna(value):
                        # 使用 1day.xxx 格式，与 PortAnaRecord 的 log_metrics 格式一致
                        result[f"1day.{metric_name}"] = float(value)
            return result
        
        # 处理 dict 格式
        if isinstance(data, dict):
            return {f"1day.{k}": float(v) for k, v in data.items() if v is not None}
        
        return None

    def load_model_params_pkl(self, experiment_id: str, run_id: str) -> Optional[Dict[str, Any]]:
        pkl_path = self.mlruns_dir / experiment_id / run_id / "artifacts/params.pkl"
        if not pkl_path.exists():
            return None
        return self._load_pickle(pkl_path)

    def load_qlib_analysis_data(self, experiment_id: str, run_id: str) -> Dict[str, Any]:
        result = {"available": False}
        report_df = self.load_portfolio_report(experiment_id, run_id)
        analysis_dict = self.load_port_analysis(experiment_id, run_id)
        pred_label = self.load_prediction_data(experiment_id, run_id)

        if report_df is not None and not report_df.empty:
            result["available"] = True
            result["report_data"] = self._process_report_data(report_df)
            # 提取日收益率分布
            result["daily_return_distribution"] = self._process_daily_return_distribution(report_df)

        if analysis_dict is not None:
            result["analysis_metrics"] = analysis_dict

        if pred_label is not None and not pred_label.empty:
            result["pred_label_data"] = self._process_pred_label_for_analysis(pred_label)
            result["ic_analysis"] = self._process_ic_analysis(pred_label)
            result["score_distribution"] = self._process_score_distribution(pred_label)
            # 计算模型性能指标
            result["model_performance"] = self._calculate_model_performance(pred_label)

        return result

    def _process_ic_analysis(self, df: pd.DataFrame) -> Dict[str, Any]:
        result = {"available": False}
        if "label" not in df.columns or "score" not in df.columns:
            return result

        try:
            df = df.copy()
            df = df.dropna(subset=["label", "score"])

            if isinstance(df.index, pd.DatetimeIndex):
                dates = [str(d)[:10] for d in df.index]
            elif hasattr(df.index, 'get_level_values'):
                try:
                    dates = [str(d)[:10] for d in df.index.get_level_values(0)]
                except Exception:
                    dates = [str(i) for i in range(len(df))]
            else:
                dates = [str(i) for i in range(len(df))]

            ic_values = []
            grouped = df.groupby(level=0 if not isinstance(df.index, pd.DatetimeIndex) and hasattr(df.index, 'get_level_values') else df.index)
            for name, group in grouped:
                if len(group) > 1:
                    ic = group["score"].corr(group["label"], method="spearman")
                    if pd.notna(ic):
                        ic_values.append({"date": str(name)[:10] if hasattr(name, '__str__') else str(name), "ic": float(ic)})

            if ic_values:
                result["available"] = True
                result["ic_series"] = ic_values
                result["ic_mean"] = float(np.mean([v["ic"] for v in ic_values]))
                result["ic_std"] = float(np.std([v["ic"] for v in ic_values]))
                result["icir"] = float(np.mean([v["ic"] for v in ic_values]) / (np.std([v["ic"] for v in ic_values]) + 1e-9))
                result["ic_positive_ratio"] = float(sum(1 for v in ic_values if v["ic"] > 0) / len(ic_values))
        except Exception:
            pass

        return result

    def _process_score_distribution(self, df: pd.DataFrame) -> Dict[str, Any]:
        result = {"available": False}
        if "score" not in df.columns:
            return result

        try:
            scores = df["score"].dropna()
            if len(scores) == 0:
                return result

            result["available"] = True
            result["mean"] = float(scores.mean())
            result["std"] = float(scores.std())
            result["min"] = float(scores.min())
            result["max"] = float(scores.max())
            result["median"] = float(scores.median())
            result["skewness"] = float(scores.skew()) if len(scores) > 2 else 0
            result["kurtosis"] = float(scores.kurtosis()) if len(scores) > 3 else 0

            hist, bin_edges = np.histogram(scores, bins=30)
            result["histogram"] = {
                "counts": hist.tolist(),
                "bins": bin_edges.tolist(),
            }
        except Exception:
            pass

        return result

    def _process_report_data(self, df: pd.DataFrame) -> Dict[str, Any]:
        if not isinstance(df.index, pd.DatetimeIndex):
            try:
                df = df.copy()
                df.index = pd.to_datetime(df.index)
            except Exception:
                pass

        dates = [str(d)[:10] for d in df.index]

        result = {"dates": dates}

        if "return" in df.columns:
            result["return"] = df["return"].tolist()
            cum_ret = (1 + df["return"]).cumprod()
            result["cum_return"] = cum_ret.tolist()

        if "bench" in df.columns:
            result["bench"] = df["bench"].tolist()
            cum_bench = (1 + df["bench"]).cumprod()
            result["cum_bench"] = cum_bench.tolist()

        if "turnover" in df.columns:
            result["turnover"] = df["turnover"].tolist()

        return result

    def _process_pred_label_for_analysis(self, df: pd.DataFrame) -> Dict[str, Any]:
        result = {"available": False}
        if "label" not in df.columns or "score" not in df.columns:
            return result

        labels = df["label"].dropna()
        scores = df["score"].dropna()

        common_idx = labels.index.intersection(scores.index)
        if len(common_idx) == 0:
            return result

        labels = labels.loc[common_idx]
        scores = scores.loc[common_idx]

        result["available"] = True
        result["count"] = int(len(common_idx))
        result["label_mean"] = float(labels.mean())
        result["label_std"] = float(labels.std())
        result["score_mean"] = float(scores.mean())
        result["score_std"] = float(scores.std())

        if len(common_idx) > 1:
            result["correlation"] = float(pd.Series(labels).corr(pd.Series(scores)))
        else:
            result["correlation"] = None

        return result

    def _process_daily_return_distribution(self, df: pd.DataFrame) -> Dict[str, Any]:
        """提取日收益率分布数据

        Args:
            df: portfolio report DataFrame，包含 return 列

        Returns:
            包含日收益率统计和直方图数据的字典
        """
        result = {"available": False}
        if "return" not in df.columns:
            return result

        try:
            returns = df["return"].dropna()
            if len(returns) == 0:
                return result

            result["available"] = True
            result["count"] = int(len(returns))
            result["mean"] = float(returns.mean())
            result["std"] = float(returns.std())
            result["min"] = float(returns.min())
            result["max"] = float(returns.max())
            result["median"] = float(returns.median())
            result["skewness"] = float(returns.skew()) if len(returns) > 2 else 0
            result["kurtosis"] = float(returns.kurtosis()) if len(returns) > 3 else 0
            # 正收益天数比例
            result["positive_ratio"] = float((returns > 0).sum() / len(returns))
            # 负收益天数
            result["negative_days"] = int((returns < 0).sum())

            # 生成直方图数据（使用50个bin以获得更精细的分布）
            hist, bin_edges = np.histogram(returns, bins=50)
            result["histogram"] = {
                "counts": hist.tolist(),
                "bins": bin_edges.tolist(),
                # 计算每个bin的中心点，便于前端显示
                "bin_centers": [float((bin_edges[i] + bin_edges[i + 1]) / 2) for i in range(len(bin_edges) - 1)],
            }

            # 按月度聚合的收益分布
            if isinstance(df.index, pd.DatetimeIndex):
                monthly_returns = returns.resample('M').apply(lambda x: (x + 1).prod() - 1)
                if len(monthly_returns) > 0:
                    result["monthly_returns"] = {
                        "dates": [str(d)[:10] for d in monthly_returns.index],
                        "values": monthly_returns.tolist(),
                    }
        except Exception as e:
            print(f"处理日收益率分布时出错: {e}")

        return result

    def _calculate_model_performance(self, df: pd.DataFrame) -> Dict[str, Any]:
        """计算模型性能指标

        从预测分数和真实标签计算分类性能指标，包括：
        - 准确率（基于方向判断）
        - Precision/Recall/F1（基于阈值分类）
        - AUC近似值（基于排序相关性）

        Args:
            df: 包含 label 和 score 列的 DataFrame

        Returns:
            包含各项模型性能指标的字典
        """
        result = {"available": False}
        if "label" not in df.columns or "score" not in df.columns:
            return result

        try:
            clean_df = df.dropna(subset=["label", "score"])
            if len(clean_df) == 0:
                return result

            labels = clean_df["label"].values
            scores = clean_df["score"].values

            result["available"] = True
            result["sample_count"] = int(len(labels))

            # 1. 基于方向的准确率（预测方向与实际方向是否一致）
            pred_direction = np.sign(scores)
            actual_direction = np.sign(labels)
            direction_accuracy = float(np.mean(pred_direction == actual_direction))
            result["direction_accuracy"] = direction_accuracy

            # 2. 使用不同阈值的分类指标
            thresholds = [0.0]  # 使用中位数作为基准阈值
            threshold_results = []

            for threshold in thresholds:
                pred_binary = (scores >= threshold).astype(int)
                label_binary = (labels > 0).astype(int)

                # 计算 TP, FP, TN, FN
                tp = int(np.sum((pred_binary == 1) & (label_binary == 1)))
                fp = int(np.sum((pred_binary == 1) & (label_binary == 0)))
                tn = int(np.sum((pred_binary == 0) & (label_binary == 0)))
                fn = int(np.sum((pred_binary == 0) & (label_binary == 1)))

                precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
                recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
                specificity = tn / (tn + fp) if (tn + fp) > 0 else 0.0
                f1_score = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0
                accuracy = (tp + tn) / (tp + tn + fp + fn)

                threshold_results.append({
                    "threshold": threshold,
                    "accuracy": float(accuracy),
                    "precision": float(precision),
                    "recall": float(recall),
                    "specificity": float(specificity),
                    "f1_score": float(f1_score),
                    "confusion_matrix": {
                        "tp": tp,
                        "fp": fp,
                        "tn": tn,
                        "fn": fn,
                    },
                })

            result["classification_metrics"] = threshold_results[0]

            # 3. 基于分位数的多空收益分析
            quantile_groups = pd.qcut(scores, q=5, labels=['Q1', 'Q2', 'Q3', 'Q4', 'Q5'], duplicates='drop')
            group_returns = clean_df.groupby(quantile_groups)['label'].mean()

            if len(group_returns) == 5:
                long_short_return = float(group_returns['Q5'] - group_returns['Q1'])
                result["quantile_analysis"] = {
                    "long_short_return": long_short_return,
                    "group_returns": {str(k): float(v) for k, v in group_returns.items()},
                }

            # 4. Rank IC（Spearman相关系数）
            from scipy.stats import spearmanr
            corr, p_value = spearmanr(scores, labels)
            result["rank_ic"] = float(corr)
            result["rank_ic_pvalue"] = float(p_value)

            # 5. MSE 和 MAE
            mse = float(np.mean((scores - labels) ** 2))
            mae = float(np.mean(np.abs(scores - labels)))
            result["mse"] = mse
            result["mae"] = mae

        except Exception as e:
            print(f"计算模型性能指标时出错: {e}")

        return result


mlflow_reader = MLFlowReader()
