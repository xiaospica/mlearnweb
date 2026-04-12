# -*- coding: utf-8 -*-
"""
模型可解释性分析服务

提供特征重要性分析和 SHAP 值计算功能
"""

import pickle
import sys
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

from app.core.config import settings
from app.utils.mlflow_reader import mlflow_reader


class ModelInterpretabilityService:
    """模型可解释性分析服务"""

    @staticmethod
    def _detect_provider_uri(run_path: Path) -> Optional[str]:
        """从 MLflow Run 的 params 文件中自动检测 provider_uri

        Args:
            run_path: MLflow run 目录路径

        Returns:
            检测到的 provider_uri，未找到则返回 None
        """
        import re

        params_dir = run_path / "params"
        if params_dir.exists():
            for param_file in params_dir.iterdir():
                if not param_file.is_file():
                    continue
                if "factor_store" not in param_file.name or "instruments" not in param_file.name:
                    continue
                try:
                    value = param_file.read_text(encoding="utf-8").strip()
                    if "qlib_data_bin" in value:
                        match = re.search(r"(.+?qlib_data_bin)", value)
                        if match:
                            detected = match.group(1)
                            print(f"[SHAP] Detected provider_uri from {param_file.name}: {detected}", file=__import__('sys').stderr)
                            return detected
                except Exception:
                    continue

        env_provider = os.environ.get("QLIB_PROVIDER_URI")
        if env_provider and Path(env_provider).exists():
            print(f"[SHAP] Using provider_uri from env: {env_provider}", file=__import__('sys').stderr)
            return env_provider

        project_root = Path(__file__).resolve().parent.parent.parent.parent.parent
        default_paths = [
            str(project_root / "factor_factory" / "qlib_data_bin"),
            r"F:\Quant\code\qlib_strategy_dev\factor_factory\qlib_data_bin",
        ]
        for p in default_paths:
            if Path(p).exists():
                print(f"[SHAP] Using default provider_uri: {p}", file=__import__('sys').stderr)
                return p

        return None

    @staticmethod
    def load_precomputed_shap(experiment_id: str, run_id: str) -> Optional[Dict[str, Any]]:
        """加载预计算的SHAP结果

        Args:
            experiment_id: MLflow experiment ID
            run_id: MLflow run ID

        Returns:
            预计算的SHAP结果，不存在则返回 None
        """
        mlruns_dir = Path(settings.mlruns_dir)
        run_path = mlruns_dir / experiment_id / run_id
        shap_path = run_path / "artifacts" / "shap_analysis.pkl"

        if shap_path.exists():
            print(f"[SHAP] Found precomputed SHAP at {shap_path}", file=__import__('sys').stderr)
            try:
                with open(shap_path, "rb") as f:
                    result = pickle.load(f)
                result["precomputed"] = True
                print(f"[SHAP] Loaded precomputed SHAP with {result.get('sample_size', '?')} samples", file=__import__('sys').stderr)
                return result
            except Exception as e:
                print(f"[SHAP] Failed to load precomputed SHAP: {e}", file=__import__('sys').stderr)

        return None

    @staticmethod
    def get_feature_importance(experiment_id: str, run_id: str) -> Dict[str, Any]:
        """获取模型特征重要性

        从 LightGBM 模型中提取：
        1. feature_importance(importance_type='split') - 分裂次数
        2. feature_importance(importance_type='gain') - 信息增益

        Args:
            experiment_id: MLflow experiment ID
            run_id: MLflow run ID

        Returns:
            包含特征重要性数据的字典
        """
        mlruns_dir = Path(settings.mlruns_dir)
        run_path = mlruns_dir / experiment_id / run_id

        if not run_path.exists():
            return {"available": False, "error": f"Run 目录不存在: {run_path}"}

        params_pkl = run_path / "artifacts" / "params.pkl"
        dataset_path = run_path / "artifacts" / "dataset"

        if not params_pkl.exists():
            return {"available": False, "error": "params.pkl 不存在"}

        try:
            with open(params_pkl, "rb") as f:
                model = pickle.load(f)
        except Exception as e:
            return {"available": False, "error": f"加载模型失败: {e}"}

        if not hasattr(model, "model") or model.model is None:
            return {"available": False, "error": "模型对象无效"}

        booster = model.model
        model_type = type(booster).__name__

        if not hasattr(booster, "feature_importance"):
            return {"available": False, "error": f"模型类型 {model_type} 不支持特征重要性"}

        try:
            feature_names = booster.feature_name()
            importance_split = booster.feature_importance(importance_type="split")
            importance_gain = booster.feature_importance(importance_type="gain")
        except Exception as e:
            return {"available": False, "error": f"获取特征重要性失败: {e}"}

        if len(feature_names) == 0:
            return {"available": False, "error": "无特征名称"}

        real_feature_names = None
        if dataset_path.exists():
            try:
                project_root = Path(__file__).resolve().parent.parent.parent.parent.parent
                strategy_dev_dir = project_root / "strategy_dev"
                factor_factory_dir = project_root / "factor_factory"

                path_changed = False
                if str(strategy_dev_dir) not in sys.path:
                    sys.path.insert(0, str(strategy_dev_dir))
                    path_changed = True
                if str(factor_factory_dir) not in sys.path:
                    sys.path.insert(0, str(factor_factory_dir))
                    path_changed = True
                if str(project_root) not in sys.path:
                    sys.path.insert(0, str(project_root))
                    path_changed = True

                with open(dataset_path, "rb") as f:
                    dataset = pickle.load(f)

                if hasattr(dataset, "handler") and hasattr(dataset.handler, "get_feature_config"):
                    feat_config = dataset.handler.get_feature_config()
                    print(f"[ModelInterpretability] feat_config type: {type(feat_config)}, len: {len(feat_config) if isinstance(feat_config, tuple) else 'N/A'}", file=__import__('sys').stderr)
                    if isinstance(feat_config, tuple) and len(feat_config) >= 2:
                        names_list = feat_config[1]
                        print(f"[ModelInterpretability] names_list len: {len(names_list)}, feature_names len: {len(feature_names)}", file=__import__('sys').stderr)
                        if isinstance(names_list, list) and len(names_list) == len(feature_names):
                            real_feature_names = names_list
                            print(f"[ModelInterpretability] Got real feature names: {real_feature_names[:5]}", file=__import__('sys').stderr)

                if not real_feature_names:
                    from qlib.data.dataset.handler import DataHandlerLP

                    for segment in ["test", "valid", "train"]:
                        if not hasattr(dataset, "segments") or segment not in dataset.segments:
                            continue
                        for data_key in [DataHandlerLP.DK_L, DataHandlerLP.DK_I, DataHandlerLP.DK_R]:
                            try:
                                X = dataset.prepare(segment, col_set="feature", data_key=data_key)
                                if not X.empty and len(X.columns) == len(feature_names):
                                    real_feature_names = X.columns.tolist()
                                    break
                            except Exception:
                                continue
                        if real_feature_names:
                            break
            except Exception as e:
                print(f"[ModelInterpretability] Error getting feature names: {e}", file=__import__('sys').stderr)

        if real_feature_names and len(real_feature_names) == len(feature_names):
            feature_names = real_feature_names

        features = []
        for i, name in enumerate(feature_names):
            features.append({
                "name": name,
                "importance_split": float(importance_split[i]) if i < len(importance_split) else 0.0,
                "importance_gain": float(importance_gain[i]) if i < len(importance_gain) else 0.0,
                "rank": i + 1,
            })

        features_sorted_by_gain = sorted(features, key=lambda x: x["importance_gain"], reverse=True)
        for i, f in enumerate(features_sorted_by_gain):
            f["rank"] = i + 1

        return {
            "available": True,
            "features": features_sorted_by_gain[:50],
            "total_features": len(features),
            "model_type": model_type,
        }

    @staticmethod
    def compute_shap_values(
        experiment_id: str,
        run_id: str,
        sample_size: int = 1000,
        segment: str = "test",
    ) -> Dict[str, Any]:
        """计算 SHAP 值

        使用 shap.TreeExplainer 计算：
        1. 全局特征重要性（mean(|shap_value|)）
        2. SHAP summary plot 数据
        3. 单个特征的依赖图数据

        Args:
            experiment_id: MLflow experiment ID
            run_id: MLflow run ID
            sample_size: 采样数量（减少计算量）
            segment: 数据段（train/valid/test）

        Returns:
            包含 SHAP 分析数据的字典
        """
        print(f"[SHAP] Starting SHAP analysis for experiment={experiment_id}, run={run_id}", file=__import__('sys').stderr)

        precomputed = ModelInterpretabilityService.load_precomputed_shap(experiment_id, run_id)
        if precomputed:
            return precomputed

        try:
            import shap
            print(f"[SHAP] shap version: {shap.__version__}", file=__import__('sys').stderr)
        except ImportError as e:
            print(f"[SHAP] Error: shap library not installed: {e}", file=__import__('sys').stderr)
            return {"available": False, "error": "shap 库未安装，请运行: pip install shap"}

        mlruns_dir = Path(settings.mlruns_dir)
        run_path = mlruns_dir / experiment_id / run_id

        if not run_path.exists():
            print(f"[SHAP] Error: Run path not found: {run_path}", file=__import__('sys').stderr)
            return {"available": False, "error": f"Run 目录不存在: {run_path}"}

        params_pkl = run_path / "artifacts" / "params.pkl"
        dataset_path = run_path / "artifacts" / "dataset"

        if not params_pkl.exists():
            print(f"[SHAP] Error: params.pkl not found", file=__import__('sys').stderr)
            return {"available": False, "error": "params.pkl 不存在"}

        print(f"[SHAP] Loading model from {params_pkl}", file=__import__('sys').stderr)

        project_root = Path(__file__).resolve().parent.parent.parent.parent.parent
        strategy_dev_dir = project_root / "strategy_dev"
        factor_factory_dir = project_root / "factor_factory"

        if str(strategy_dev_dir) not in sys.path:
            sys.path.insert(0, str(strategy_dev_dir))
        if str(factor_factory_dir) not in sys.path:
            sys.path.insert(0, str(factor_factory_dir))
        if str(project_root) not in sys.path:
            sys.path.insert(0, str(project_root))

        os.environ.setdefault("LOKY_PICKLER", "pickle")
        os.environ.setdefault("JOBLIB_START_METHOD", "spawn")
        os.environ.setdefault("MKL_NUM_THREADS", "1")
        os.environ.setdefault("OMP_NUM_THREADS", "1")

        try:
            with open(params_pkl, "rb") as f:
                model = pickle.load(f)
        except Exception as e:
            print(f"[SHAP] Error loading model: {e}", file=__import__('sys').stderr)
            return {"available": False, "error": f"加载模型失败: {e}"}

        if not hasattr(model, "model") or model.model is None:
            print(f"[SHAP] Error: model object invalid", file=__import__('sys').stderr)
            return {"available": False, "error": "模型对象无效"}

        booster = model.model
        print(f"[SHAP] Model type: {type(booster).__name__}", file=__import__('sys').stderr)

        print(f"[SHAP] Preparing feature data for segment={segment}", file=__import__('sys').stderr)

        try:
            X = None

            task_path = run_path / "artifacts" / "task"
            if task_path.exists():
                print(f"[SHAP] Method 0: Rebuilding dataset from task config at {task_path}", file=__import__('sys').stderr)
                try:
                    with open(task_path, "rb") as f:
                        task_config = pickle.load(f)

                    if "dataset" in task_config:
                        dataset_config = task_config["dataset"]
                        print(f"[SHAP] Task config dataset class: {dataset_config.get('class')}", file=__import__('sys').stderr)

                        provider_uri = ModelInterpretabilityService._detect_provider_uri(run_path)

                        if provider_uri:
                            print(f"[SHAP] Using provider_uri: {provider_uri}", file=__import__('sys').stderr)
                            try:
                                import qlib
                                from qlib.config import REG_CN
                                if not getattr(qlib, "_init_done", False):
                                    qlib.init(provider_uri=provider_uri, region=REG_CN)
                                    qlib._init_done = True
                                    print(f"[SHAP] QLib initialized", file=__import__('sys').stderr)

                                from qlib.utils import init_instance_by_config
                                from qlib.data.dataset import DatasetH
                                from qlib.data.dataset.handler import DataHandlerLP

                                rebuilt_dataset = init_instance_by_config(dataset_config, accept_types=DatasetH)
                                print(f"[SHAP] Rebuilt dataset type: {type(rebuilt_dataset).__name__}", file=__import__('sys').stderr)

                                if hasattr(rebuilt_dataset, "segments") and segment in rebuilt_dataset.segments:
                                    for data_key, key_name in [
                                        (DataHandlerLP.DK_L, "learn"),
                                        (DataHandlerLP.DK_I, "infer"),
                                        (DataHandlerLP.DK_R, "raw"),
                                    ]:
                                        try:
                                            X = rebuilt_dataset.prepare(segment, col_set="feature", data_key=data_key)
                                            if X is not None and not X.empty:
                                                print(f"[SHAP] Got data from rebuilt dataset with data_key={key_name}, shape={X.shape}", file=__import__('sys').stderr)
                                                break
                                        except Exception as prep_e:
                                            print(f"[SHAP] Rebuilt dataset prepare with {key_name} failed: {prep_e}", file=__import__('sys').stderr)
                            except Exception as rebuild_e:
                                print(f"[SHAP] Failed to rebuild dataset: {rebuild_e}", file=__import__('sys').stderr)
                except Exception as e:
                    print(f"[SHAP] Method 0 failed: {e}", file=__import__('sys').stderr)

            if (X is None or X.empty) and dataset_path.exists():
                print(f"[SHAP] Method 1: Loading dataset from pickle...", file=__import__('sys').stderr)
                try:
                    with open(dataset_path, "rb") as f:
                        dataset = pickle.load(f)

                    print(f"[SHAP] Dataset type: {type(dataset).__name__}", file=__import__('sys').stderr)
                    if hasattr(dataset, "segments"):
                        print(f"[SHAP] Available segments: {list(dataset.segments.keys())}", file=__import__('sys').stderr)

                    if hasattr(dataset, "segments") and segment in dataset.segments:
                        from qlib.data.dataset.handler import DataHandlerLP

                        if hasattr(dataset, "handler"):
                            handler = dataset.handler
                            print(f"[SHAP] Handler type: {type(handler).__name__}", file=__import__('sys').stderr)
                            print(f"[SHAP] Handler has _data: {hasattr(handler, '_data')}", file=__import__('sys').stderr)
                            print(f"[SHAP] Handler has _infer: {hasattr(handler, '_infer')}", file=__import__('sys').stderr)
                            print(f"[SHAP] Handler has _learn: {hasattr(handler, '_learn')}", file=__import__('sys').stderr)

                        for data_key, key_name in [
                            (DataHandlerLP.DK_L, "learn"),
                            (DataHandlerLP.DK_I, "infer"),
                            (DataHandlerLP.DK_R, "raw"),
                        ]:
                            try:
                                X = dataset.prepare(segment, col_set="feature", data_key=data_key)
                                if X is not None and not X.empty:
                                    print(f"[SHAP] Got data from pickle dataset with data_key={key_name}, shape={X.shape}", file=__import__('sys').stderr)
                                    break
                            except Exception as prep_e:
                                print(f"[SHAP] Failed to prepare with data_key={key_name}: {prep_e}", file=__import__('sys').stderr)
                                continue
                except Exception as e:
                    print(f"[SHAP] Method 1 failed: {e}", file=__import__('sys').stderr)

            if X is None or X.empty:
                error_msg = "无法获取特征数据。建议：确保训练时正确保存数据集，或检查 provider_uri 配置。"
                print(f"[SHAP] ERROR: {error_msg}", file=__import__('sys').stderr)
                return {"available": False, "error": error_msg}

        except Exception as e:
            print(f"[SHAP] Error preparing feature data: {e}", file=__import__('sys').stderr)
            import traceback
            traceback.print_exc(file=__import__('sys').stderr)
            return {"available": False, "error": f"准备特征数据失败: {e}"}

        if X.empty:
            print(f"[SHAP] Error: feature data is empty", file=__import__('sys').stderr)
            return {"available": False, "error": "特征数据为空"}

        feature_names = X.columns.tolist()
        print(f"[SHAP] Feature count: {len(feature_names)}, sample count: {len(X)}", file=__import__('sys').stderr)

        if len(X) > sample_size:
            try:
                X_sample = X.sample(n=sample_size, random_state=42)
            except Exception:
                X_sample = X.iloc[:sample_size]
            print(f"[SHAP] Sampled to {len(X_sample)} rows", file=__import__('sys').stderr)
        else:
            X_sample = X

        X_values = X_sample.values

        print(f"[SHAP] Computing SHAP values...", file=__import__('sys').stderr)
        try:
            explainer = shap.TreeExplainer(booster)
            shap_values = explainer.shap_values(X_values, check_additivity=False)
            print(f"[SHAP] SHAP values computed successfully", file=__import__('sys').stderr)
        except Exception as e:
            print(f"[SHAP] Error computing SHAP values: {e}", file=__import__('sys').stderr)
            import traceback
            traceback.print_exc(file=__import__('sys').stderr)
            return {"available": False, "error": f"计算 SHAP 值失败: {e}"}

        if isinstance(shap_values, list):
            shap_values = shap_values[0]
            print(f"[SHAP] Using first element of shap_values list", file=__import__('sys').stderr)

        base_value = explainer.expected_value
        if isinstance(base_value, (list, np.ndarray)):
            base_value = float(base_value[0])
        else:
            base_value = float(base_value)

        feature_stats = {}
        for i, name in enumerate(feature_names):
            shap_col = shap_values[:, i]
            feature_stats[name] = {
                "mean_abs_shap": float(np.mean(np.abs(shap_col))),
                "min_shap": float(np.min(shap_col)),
                "max_shap": float(np.max(shap_col)),
            }

        print(f"[SHAP] Returning SHAP analysis with {len(feature_names)} features", file=__import__('sys').stderr)
        return {
            "available": True,
            "feature_names": feature_names,
            "shap_values": shap_values.tolist(),
            "feature_values": X_values.tolist(),
            "base_value": base_value,
            "sample_size": len(X_sample),
            "feature_stats": feature_stats,
        }

    @staticmethod
    def get_full_analysis(experiment_id: str, run_id: str) -> Dict[str, Any]:
        """获取完整的模型可解释性分析

        Args:
            experiment_id: MLflow experiment ID
            run_id: MLflow run ID

        Returns:
            包含特征重要性和 SHAP 分析的完整数据
        """
        feature_importance = ModelInterpretabilityService.get_feature_importance(
            experiment_id, run_id
        )

        shap_analysis = ModelInterpretabilityService.compute_shap_values(
            experiment_id, run_id, sample_size=500, segment="test"
        )

        return {
            "feature_importance": feature_importance,
            "shap_analysis": shap_analysis,
        }
